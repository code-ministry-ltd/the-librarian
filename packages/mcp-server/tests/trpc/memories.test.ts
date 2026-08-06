// Memory tRPC procedure integration tests (T4.4).
//
// Spawns the real HTTP bin and exercises the typed surface end-to-end:
// admin gating, list/aggregates, related (incl. 404), full CRUD
// (create/update/delete), proposal approve/reject, and recall.

import { spawnSync } from "node:child_process";
import { createLibrarianStore } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

// The data dir's vault is a git repo; every store mutation lands a commit. Read
// the subject lines so a test can assert a mutation was committed (revertable).
function gitLog(dataDir: string): string[] {
  const result = spawnSync("git", ["-C", `${dataDir}/vault`, "log", "--format=%s"], {
    encoding: "utf8",
  });
  return result.stdout.split("\n").filter((l) => l.length > 0);
}

// The `Librarian-Actor` trailer of the newest commit whose subject contains `needle` — the
// audit "who" for that mutation (spec 064 F3: it must be the acting principal, never a body id).
function trailerOf(dataDir: string, needle: string): string {
  const result = spawnSync(
    "git",
    [
      "-C",
      `${dataDir}/vault`,
      "log",
      "--format=%s\x1f%(trailers:key=Librarian-Actor,valueonly,separator=,)",
    ],
    { encoding: "utf8" },
  );
  for (const line of result.stdout.split("\n")) {
    const [subject, trailer] = line.split("\x1f");
    if (subject?.includes(needle)) return (trailer ?? "").trim();
  }
  return "<no such commit>";
}

// Read a memory's curator_note (the provenance record) from the data dir, by
// opening a fresh store — the HTTP server runs in a separate process.
function curatorNote(dataDir: string, id: string): Record<string, unknown> | null | undefined {
  const store = createLibrarianStore({ dataDir });
  try {
    return store.getMemory(id)?.curator_note as Record<string, unknown> | null | undefined;
  } finally {
    store.close();
  }
}

function memoryStatus(dataDir: string, id: string): string | undefined {
  const store = createLibrarianStore({ dataDir });
  try {
    return store.getMemory(id)?.status;
  } finally {
    store.close();
  }
}

// Append an open flag to a memory by opening a fresh store — the HTTP server
// runs in a separate process, so the review-queue tests seed flags directly.
function flagMemory(dataDir: string, id: string, reason: string, agent_id = "scribe"): void {
  const store = createLibrarianStore({ dataDir });
  try {
    store.flagMemory(id, reason, agent_id);
  } finally {
    store.close();
  }
}

function openFlagCount(dataDir: string, id: string): number {
  const store = createLibrarianStore({ dataDir });
  try {
    const flags = store.getMemory(id)?.flags;
    return Array.isArray(flags) ? flags.length : 0;
  } finally {
    store.close();
  }
}

interface TrpcOk<T> {
  result: { data: T };
}

interface TrpcErr {
  error: { code?: number; message?: string; data?: { httpStatus?: number; code?: string } };
}

interface MemoryRow {
  id: string;
  title: string;
  body: string;
  status: string;
  project_keys?: string[];
}

interface ListMemoriesResult {
  memories: MemoryRow[];
  total: number;
  limit: number;
  offset: number;
}

interface CreateMemoryResult {
  status: string;
  memory?: MemoryRow;
}

interface ServerHandle {
  url: string;
  token: string;
  stop: () => Promise<void>;
}

async function trpcGet<T>(server: ServerHandle, path: string, input?: unknown): Promise<T> {
  const url = new URL(`${server.trpcUrl}/trpc/${path}`);
  if (input !== undefined) url.searchParams.set("input", JSON.stringify(input));
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${server.token}` },
  });
  const json = (await response.json()) as TrpcOk<T> | TrpcErr;
  if (response.status >= 400 || "error" in json) {
    throw new Error(`trpc GET ${path} failed: ${JSON.stringify(json)}`);
  }
  return (json as TrpcOk<T>).result.data;
}

async function trpcPost<T>(server: ServerHandle, path: string, input?: unknown): Promise<T> {
  const response = await fetch(`${server.trpcUrl}/trpc/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${server.token}`,
    },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const json = (await response.json()) as TrpcOk<T> | TrpcErr;
  if (response.status >= 400 || "error" in json) {
    throw new Error(`trpc POST ${path} failed: ${JSON.stringify(json)}`);
  }
  return (json as TrpcOk<T>).result.data;
}

function seedMemory(
  dataDir: string,
  overrides: Partial<{
    title: string;
    body: string;
    agent_id: string;
    requires_approval: boolean;
    project_keys: string[];
  }> = {},
): MemoryRow {
  const store = createLibrarianStore({ dataDir });
  try {
    const opts: Record<string, unknown> = {};
    if (overrides.requires_approval === true) opts.requires_approval = true;
    const result = store.createMemory(
      {
        agent_id: overrides.agent_id || "bede",
        title: overrides.title || "Seeded memory",
        body: overrides.body || "Body text",
        ...(overrides.project_keys !== undefined ? { project_keys: overrides.project_keys } : {}),
      },
      opts,
    );
    return result.memory as MemoryRow;
  } finally {
    store.close();
  }
}

// Seed a PROPOSED memory carrying a self-describing curator_note (spec
// 2026-06-20 proposal-review-ux, D2) — the shape intake/grooming stamp so the
// review endpoint can badge it. `requires_approval` lands it at `proposed`;
// `curator_note` rides the trusted options channel.
function seedProposal(
  dataDir: string,
  curatorNote: Record<string, unknown>,
  overrides: Partial<{ title: string; body: string; agent_id: string }> = {},
): MemoryRow {
  const store = createLibrarianStore({ dataDir });
  try {
    const result = store.createMemory(
      {
        agent_id: overrides.agent_id || "scribe",
        title: overrides.title || "Proposed memory",
        body: overrides.body || "Proposed body",
      },
      { requires_approval: true, curator_note: curatorNote },
    );
    return result.memory as MemoryRow;
  } finally {
    store.close();
  }
}

describe("tRPC memories surface", () => {
  it("memories.list is unreachable from the public (network) listener (ADR 0008 P3)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      // Post-P3 the admin gate is the network boundary, not a token: the admin
      // tRPC surface is served only on the internal listener and 404s on the
      // public port — even for a network agent's bearer (ADR 0008 P1/P3).
      const response = await fetch(`${server.url}/trpc/memories.list`, {
        headers: { authorization: "Bearer agent-token" },
      });
      expect(response.status).toBe(404);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.list returns paginated memories", async () => {
    const dataDir = makeTempDir();
    seedMemory(dataDir, { title: "Alpha" });
    seedMemory(dataDir, { title: "Beta" });
    const server = await startHttpServer({ dataDir });
    try {
      const data = await trpcGet<ListMemoriesResult>(server, "memories.list");
      expect(data.total).toBe(2);
      expect(data.memories.map((m) => m.title).sort()).toEqual(["Alpha", "Beta"]);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.list applies status filters", async () => {
    const dataDir = makeTempDir();
    seedMemory(dataDir, { title: "Alpha" });
    seedMemory(dataDir, { title: "Beta" });
    const server = await startHttpServer({ dataDir });
    try {
      const data = await trpcGet<ListMemoriesResult>(server, "memories.list", {
        status: "active",
      });
      expect(data.total).toBe(2);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.list returns and exactly filters plural project associations", async () => {
    const dataDir = makeTempDir();
    seedMemory(dataDir, { title: "Exact", project_keys: ["lib"] });
    seedMemory(dataDir, { title: "Longer", project_keys: ["the-lib"] });
    const server = await startHttpServer({ dataDir });
    try {
      const data = await trpcGet<ListMemoriesResult>(server, "memories.list", {
        project_keys: ["lib"],
      });
      expect(data.memories).toEqual([
        expect.objectContaining({ title: "Exact", project_keys: ["lib"] }),
      ]);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("the removed admin verbs stay reachable over tRPC (ADR 0006 PR-4 equivalence)", async () => {
    // PR-4 removed the `archive_memory`, `approve_proposal`, `update_memory`,
    // and `list_proposals` MCP tool wrappers from the agent surface. Their admin
    // capabilities must remain reachable over the dashboard tRPC surface — this
    // pins all four end-to-end so the removal is a surface change, not a loss of
    // capability.
    const dataDir = makeTempDir();
    // A proposal (replaces list_proposals + approve_proposal) and an active
    // memory (replaces update_memory + archive_memory).
    const proposal = seedMemory(dataDir, {
      title: "Awaiting review",
      requires_approval: true,
    });
    expect(proposal.status).toBe("proposed");
    const active = seedMemory(dataDir, { title: "Editable + archivable" });
    const server = await startHttpServer({ dataDir });
    try {
      // list_proposals -> memories.list({ status: "proposed" })
      const proposed = await trpcGet<ListMemoriesResult>(server, "memories.list", {
        status: "proposed",
      });
      expect(proposed.total).toBe(1);
      expect(proposed.memories.map((m) => m.id)).toEqual([proposal.id]);

      // approve_proposal -> memories.approve
      const approved = await trpcPost<MemoryRow>(server, "memories.approve", { id: proposal.id });
      expect(approved.status).toBe("active");

      // update_memory -> memories.update
      const updated = await trpcPost<MemoryRow>(server, "memories.update", {
        id: active.id,
        patch: { body: "edited via tRPC" },
      });
      expect(updated.body).toBe("edited via tRPC");

      // archive_memory -> memories.archive
      const archived = await trpcPost<MemoryRow>(server, "memories.archive", { id: active.id });
      expect(archived.status).toBe("archived");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.aggregates returns tallies", async () => {
    const dataDir = makeTempDir();
    seedMemory(dataDir, { title: "Alpha" });
    seedMemory(dataDir, { title: "Beta" });
    const server = await startHttpServer({ dataDir });
    try {
      const data = await trpcGet<{
        total: number;
        agents: { value: unknown; count: number }[];
      }>(server, "memories.aggregates");
      expect(data.total).toBe(2);
      expect(Array.isArray(data.agents)).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.related returns 404 for unknown id", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(
        `${server.trpcUrl}/trpc/memories.related?input=${encodeURIComponent(
          JSON.stringify({ id: "mem_nope" }),
        )}`,
        {
          headers: { authorization: `Bearer ${server.token}` },
        },
      );
      expect(response.status).toBe(404);
      const body = (await response.json()) as TrpcErr;
      expect(body.error?.data?.code).toBe("NOT_FOUND");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.create then memories.update mutates the row", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const created = await trpcPost<CreateMemoryResult>(server, "memories.create", {
        agent_id: "bede",
        title: "Created via tRPC",
        body: "Original body",
      });
      expect(created.status).toBe("active");
      const id = created.memory?.id;
      expect(id).toBeTypeOf("string");

      const updated = await trpcPost<MemoryRow>(server, "memories.update", {
        id,
        patch: { body: "Patched body" },
      });
      expect(updated.body).toBe("Patched body");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("a body-supplied agent_id cannot forge the audit actor on update (spec 064 F3)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const created = await trpcPost<CreateMemoryResult>(server, "memories.create", {
        agent_id: "bede",
        title: "Attributable",
        body: "Original",
      });
      const id = created.memory?.id;
      // The attack: an admin (or a compromised admin token) tries to pin the mutation on a victim.
      await trpcPost<MemoryRow>(server, "memories.update", {
        id,
        patch: { body: "Patched" },
        agent_id: "impersonated-victim",
      });
      // The internal listener resolves the admin-by-isolation principal `dashboard-admin`. The
      // audit actor (commit trailer) is that principal — the body `agent_id` never reaches it.
      expect(trailerOf(dataDir, "memory: update")).toBe("dashboard-admin");
      // …and the same is true of the persisted `updated_by` last-writer stamp.
      const store = createLibrarianStore({ dataDir });
      try {
        expect(store.getMemory(id!)?.updated_by).toBe("dashboard-admin");
      } finally {
        store.close();
      }
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("a body-supplied agent_id sets the OWNER but cannot forge the audit actor on create (spec 064 F3)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      // An admin creates a memory ON BEHALF of another agent: `agent_id` legitimately names the
      // OWNER, but must NOT become the commit trailer (the "who" the audit export reports).
      const created = await trpcPost<CreateMemoryResult>(server, "memories.create", {
        agent_id: "impersonated-victim",
        title: "Created on behalf of another",
        body: "body",
      });
      const id = created.memory?.id;
      const store = createLibrarianStore({ dataDir });
      try {
        // OWNER = the body-supplied agent_id (settable) …
        expect(store.getMemory(id!)?.agent_id).toBe("impersonated-victim");
      } finally {
        store.close();
      }
      // … AUDIT actor = the acting principal (`dashboard-admin`), never the body id.
      expect(trailerOf(dataDir, "memory: store")).toBe("dashboard-admin");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.archive marks the memory as archived", async () => {
    const dataDir = makeTempDir();
    const memory = seedMemory(dataDir, { title: "Disposable" });
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<MemoryRow>(server, "memories.archive", { id: memory.id });
      expect(result.status).toBe("archived");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.approve transitions a proposal to active", async () => {
    const dataDir = makeTempDir();
    const proposal = seedMemory(dataDir, {
      title: "Who",
      requires_approval: true,
    });
    expect(proposal.status).toBe("proposed");
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<MemoryRow>(server, "memories.approve", { id: proposal.id });
      expect(result.status).toBe("active");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.reject archives a proposal under the three-state model", async () => {
    const dataDir = makeTempDir();
    const proposal = seedMemory(dataDir, {
      title: "Reject me",
      requires_approval: true,
    });
    expect(proposal.status).toBe("proposed");
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<MemoryRow>(server, "memories.reject", { id: proposal.id });
      // V1.2 collapsed `rejected` into `archived` — the event log still
      // emits `memory.rejected`, but the projection rolls it forward.
      expect(result.status).toBe("archived");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.recall returns matching memories and records the recall", async () => {
    const dataDir = makeTempDir();
    seedMemory(dataDir, { title: "Coffee preferences", body: "Espresso, no sugar." });
    seedMemory(dataDir, { title: "Other", body: "Unrelated." });
    const server = await startHttpServer({ dataDir });
    try {
      const data = await trpcPost<{ memories: MemoryRow[] }>(server, "memories.recall", {
        agent_id: "bede",
        query: "coffee",
        limit: 5,
      });
      expect(data.memories.length).toBeGreaterThanOrEqual(1);
      expect(data.memories.some((m) => m.title === "Coffee preferences")).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.recall against an empty store returns no memories", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const data = await trpcPost<{ memories: MemoryRow[] }>(server, "memories.recall", {
        agent_id: "bede",
        query: "nothing here",
      });
      expect(data.memories).toEqual([]);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.create always saves and surfaces duplicates as an informational signal", async () => {
    const dataDir = makeTempDir();
    seedMemory(dataDir, {
      title: "API style preference",
      body: "Prefer typed tRPC APIs over hand-rolled REST.",
    });
    const server = await startHttpServer({ dataDir });
    try {
      // V1.2: createMemory no longer refuses writes. The duplicates list is
      // returned alongside the saved row so the agent can decide whether to
      // file manually.
      const created = await trpcPost<{
        status: string;
        memory: { id: string };
        duplicates: { id: string }[];
      }>(server, "memories.create", {
        agent_id: "bede",
        title: "API style preference",
        body: "Prefer typed tRPC APIs over hand-rolled REST endpoints.",
      });
      expect(created.status).toBe("active");
      expect(created.memory.id).toBeTruthy();
      expect(Array.isArray(created.duplicates)).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.list status filter excludes proposals from the active view", async () => {
    const dataDir = makeTempDir();
    seedMemory(dataDir, { title: "Active lesson" });
    seedMemory(dataDir, { title: "Active tool" });
    const proposal = seedMemory(dataDir, {
      title: "Proposed",
      requires_approval: true,
    });
    expect(proposal.status).toBe("proposed");
    const server = await startHttpServer({ dataDir });
    try {
      const data = await trpcGet<ListMemoriesResult>(server, "memories.list", {
        status: "active",
      });
      // The status=active filter returns both active rows and excludes the proposal.
      expect(data.total).toBe(2);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.bulkUpdate re-homes a set of memories with one round-trip (D1.1)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const a = seedMemory(dataDir, { title: "A" });
      const b = seedMemory(dataDir, { title: "B" });
      const c = seedMemory(dataDir, { title: "C" });
      const result = await trpcPost<{ transaction_id: string; updated: number }>(
        server,
        "memories.bulkUpdate",
        { ids: [a.id, b.id, c.id], patch: { agent_id: "new-home" } },
      );
      expect(result.updated).toBe(3);
      expect(result.transaction_id).toMatch(/^txn_/);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.bulkUpdate rejects an empty patch (D1.1)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const m = seedMemory(dataDir, { title: "X" });
      const response = await fetch(`${server.trpcUrl}/trpc/memories.bulkUpdate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${server.token}`,
        },
        body: JSON.stringify({ ids: [m.id], patch: {} }),
      });
      expect(response.status).toBe(400);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.distinctValues returns deduplicated values for the named field (D1.1)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      seedMemory(dataDir, { agent_id: "alpha" });
      seedMemory(dataDir, { agent_id: "alpha" });
      seedMemory(dataDir, { agent_id: "beta" });
      const values = await trpcGet<string[]>(server, "memories.distinctValues", {
        field: "agent_id",
      });
      expect([...values].sort()).toEqual(["alpha", "beta"]);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.distinctValues rejects fields outside the whitelist (D1.1)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const url = new URL(`${server.trpcUrl}/trpc/memories.distinctValues`);
      url.searchParams.set("input", JSON.stringify({ field: "body" }));
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${server.token}` },
      });
      expect(response.status).toBe(400);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.update / archive / approve / reject return NOT_FOUND for unknown ids", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      for (const [path, body] of [
        ["memories.update", { id: "mem_nope", patch: { body: "x" } }],
        ["memories.archive", { id: "mem_nope" }],
        ["memories.approve", { id: "mem_nope" }],
        ["memories.reject", { id: "mem_nope" }],
      ] as const) {
        const response = await fetch(`${server.trpcUrl}/trpc/${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${server.token}`,
          },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(404);
        const json = (await response.json()) as TrpcErr;
        expect(json.error?.data?.code).toBe("NOT_FOUND");
      }
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});

// Permanent delete (irreversible from the app): hard-delete ARCHIVED memories.
// Archived-only (active/proposed must be archived first); each purge is a git
// commit (recoverable from history); admin-gated.
describe("tRPC memories.purge (permanent delete of archived memories)", () => {
  it("hard-deletes archived memories, commits, and reports the count", async () => {
    const dataDir = makeTempDir();
    const a = seedMemory(dataDir, { title: "Trash A" });
    const b = seedMemory(dataDir, { title: "Trash B" });
    const server = await startHttpServer({ dataDir });
    try {
      // Purge is archived-only — archive both first.
      await trpcPost(server, "memories.archive", { id: a.id });
      await trpcPost(server, "memories.archive", { id: b.id });

      const result = await trpcPost<{ purged: number }>(server, "memories.purge", {
        ids: [a.id, b.id],
      });
      expect(result.purged).toBe(2);

      // Gone from the corpus entirely.
      expect(memoryStatus(dataDir, a.id)).toBeUndefined();
      expect(memoryStatus(dataDir, b.id)).toBeUndefined();

      // Committed (recoverable from git history).
      const log = gitLog(dataDir);
      expect(log.some((s) => s.includes(`purge ${a.id}`))).toBe(true);
      expect(log.some((s) => s.includes(`purge ${b.id}`))).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("refuses to purge a non-archived (active) memory and leaves it untouched", async () => {
    const dataDir = makeTempDir();
    const m = seedMemory(dataDir, { title: "Still live" });
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.trpcUrl}/trpc/memories.purge`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${server.token}`,
        },
        body: JSON.stringify({ ids: [m.id] }),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      const json = (await response.json()) as TrpcErr;
      expect(json.error?.message).toMatch(/archived/i);
      expect(memoryStatus(dataDir, m.id)).toBe("active");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.purge is unreachable from the public (network) listener (ADR 0008 P3)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      // Post-P3 the admin gate is the network boundary, not a token: purge is
      // served only on the internal listener and 404s on the public port — even
      // for a network agent's bearer (ADR 0008 P1/P3).
      const response = await fetch(`${server.url}/trpc/memories.purge`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer agent-token" },
        body: JSON.stringify({ ids: ["mem_x"] }),
      });
      expect(response.status).toBe(404);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});

// Admin mutation primitives (spec 044 D-5a). merge/split/update run OUTSIDE a
// curation run (an admin fixing the corpus directly), call the SAME shared store
// primitives the curator run path uses, tag provenance `curator_note.source =
// "admin-chat"`, and each lands a git commit (revertable). Admin-gated.
describe("tRPC admin mutation primitives (spec 044 D-5a)", () => {
  it("memories.merge merges N sources into one target, tags admin-chat, commits", async () => {
    const dataDir = makeTempDir();
    const a = seedMemory(dataDir, { title: "Dup A", body: "same fact" });
    const b = seedMemory(dataDir, { title: "Dup B", body: "same fact" });
    const server = await startHttpServer({ dataDir });
    try {
      const merged = await trpcPost<MemoryRow>(server, "memories.merge", {
        source_ids: [a.id, b.id],
        replacement: { title: "Merged fact", body: "the merged fact" },
      });
      expect(merged.title).toBe("Merged fact");
      expect(merged.status).toBe("active");
      // Sources archived (an admin merge auto-applies — there's no run to defer to).
      expect(memoryStatus(dataDir, a.id)).toBe("archived");
      expect(memoryStatus(dataDir, b.id)).toBe("archived");
      // Provenance: supersedes the sources + tagged admin-chat.
      const note = curatorNote(dataDir, merged.id);
      expect(note?.supersedes).toEqual([a.id, b.id]);
      expect(note?.source).toBe("admin-chat");
      // Committed (revertable): the create + both archives are in git history.
      const log = gitLog(dataDir);
      expect(log.some((s) => s.includes(`store ${merged.id}`))).toBe(true);
      expect(log.some((s) => s.includes(`archive ${a.id}`))).toBe(true);
      expect(log.some((s) => s.includes(`archive ${b.id}`))).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.split spins one source into N replacements, tags admin-chat, commits", async () => {
    const dataDir = makeTempDir();
    const src = seedMemory(dataDir, { title: "Overloaded", body: "facts about Elaine and Bob" });
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<{ ids: string[] }>(server, "memories.split", {
        source_id: src.id,
        replacements: [
          { title: "Elaine", body: "about Elaine" },
          { title: "Bob", body: "about Bob" },
        ],
      });
      expect(result.ids).toHaveLength(2);
      // Source archived (an admin split auto-applies).
      expect(memoryStatus(dataDir, src.id)).toBe("archived");
      for (const id of result.ids) {
        expect(memoryStatus(dataDir, id)).toBe("active");
        const note = curatorNote(dataDir, id);
        expect(note?.supersedes).toEqual([src.id]);
        expect(note?.source).toBe("admin-chat");
      }
      const log = gitLog(dataDir);
      expect(log.some((s) => s.includes(`archive ${src.id}`))).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.update patches a memory in place (the shared update routine), commits", async () => {
    const dataDir = makeTempDir();
    const m = seedMemory(dataDir, { title: "Stale", body: "old body" });
    const server = await startHttpServer({ dataDir });
    try {
      const updated = await trpcPost<MemoryRow>(server, "memories.update", {
        id: m.id,
        patch: { body: "corrected body" },
      });
      expect(updated.body).toBe("corrected body");
      expect(updated.status).toBe("active"); // in place, not superseded
      const log = gitLog(dataDir);
      expect(log.some((s) => s.includes(`update ${m.id}`))).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("merge / split are unreachable from the public (network) listener (ADR 0008 P3)", async () => {
    const dataDir = makeTempDir();
    const m = seedMemory(dataDir, { title: "Protected by gate" });
    const server = await startHttpServer({ dataDir });
    try {
      // Post-P3 the admin gate is the network boundary, not a token: these admin
      // primitives are served only on the internal listener and 404 on the public
      // port — even for a network agent's bearer (ADR 0008 P1/P3).
      for (const [path, body] of [
        ["memories.merge", { source_ids: [m.id, m.id], replacement: { title: "X", body: "y" } }],
        ["memories.split", { source_id: m.id, replacements: [{ title: "A" }, { title: "B" }] }],
      ] as const) {
        const response = await fetch(`${server.url}/trpc/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer agent-token" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(404);
      }
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});

// unmerge / reverse-a-groom (spec 044 D-5b). Given a merged target, read its
// curator_note.supersedes (the source ids it replaced), un-archive those sources
// (restore them to active), and archive the merged target — reversing a bad merge.
// Restore-sources-before-archive-target is the data-loss-safe ordering. Each
// transition lands a git commit (revertable). Admin-gated.
describe("tRPC unmerge / reverse-a-groom (spec 044 D-5b)", () => {
  it("reverses a merge: restores the sources to active and archives the target", async () => {
    const dataDir = makeTempDir();
    const a = seedMemory(dataDir, { title: "Dup A", body: "same fact" });
    const b = seedMemory(dataDir, { title: "Dup B", body: "same fact" });
    const server = await startHttpServer({ dataDir });
    try {
      // Merge first (the bad merge): sources archived, target active.
      const merged = await trpcPost<MemoryRow>(server, "memories.merge", {
        source_ids: [a.id, b.id],
        replacement: { title: "Merged fact", body: "the merged fact" },
      });
      expect(memoryStatus(dataDir, a.id)).toBe("archived");
      expect(memoryStatus(dataDir, b.id)).toBe("archived");
      expect(memoryStatus(dataDir, merged.id)).toBe("active");

      // Now unmerge it.
      const result = await trpcPost<{ restored: string[]; archived: string }>(
        server,
        "memories.unmerge",
        { id: merged.id },
      );
      expect(result.restored).toEqual([a.id, b.id]);
      expect(result.archived).toBe(merged.id);

      // Sources are active again; the merged target is archived.
      expect(memoryStatus(dataDir, a.id)).toBe("active");
      expect(memoryStatus(dataDir, b.id)).toBe("active");
      expect(memoryStatus(dataDir, merged.id)).toBe("archived");

      // Each transition is committed (revertable): the un-archives, then the archive.
      const log = gitLog(dataDir);
      expect(log.some((s) => s.includes(`unarchive ${a.id}`))).toBe(true);
      expect(log.some((s) => s.includes(`unarchive ${b.id}`))).toBe(true);
      expect(log.some((s) => s.includes(`archive ${merged.id}`))).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("restores sources BEFORE archiving the target (no data loss on partial failure)", async () => {
    const dataDir = makeTempDir();
    const a = seedMemory(dataDir, { title: "Dup A", body: "same fact" });
    const b = seedMemory(dataDir, { title: "Dup B", body: "same fact" });
    const server = await startHttpServer({ dataDir });
    try {
      const merged = await trpcPost<MemoryRow>(server, "memories.merge", {
        source_ids: [a.id, b.id],
        replacement: { title: "Merged fact", body: "the merged fact" },
      });
      await trpcPost(server, "memories.unmerge", { id: merged.id });
      // The data-loss-safe invariant: at no point are ALL of {sources, target}
      // archived. After unmerge the sources are restored; even if the final
      // archive of the target had failed, the sources would already be active —
      // so a partial failure can never leave the whole group archived.
      const sourcesActive =
        memoryStatus(dataDir, a.id) === "active" && memoryStatus(dataDir, b.id) === "active";
      expect(sourcesActive).toBe(true);
      // The un-archive commits land before the target's archive commit (ordering).
      const log = gitLog(dataDir); // newest-first
      const archiveTargetIdx = log.findIndex((s) => s.includes(`archive ${merged.id}`));
      const unarchiveAIdx = log.findIndex((s) => s.includes(`unarchive ${a.id}`));
      const unarchiveBIdx = log.findIndex((s) => s.includes(`unarchive ${b.id}`));
      // newest-first → a smaller index is a LATER commit; the target archive is
      // the newest of the three (smallest index).
      expect(archiveTargetIdx).toBeLessThan(unarchiveAIdx);
      expect(archiveTargetIdx).toBeLessThan(unarchiveBIdx);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("returns a clear error for a memory with no superseded sources (not a merge result)", async () => {
    const dataDir = makeTempDir();
    const m = seedMemory(dataDir, { title: "Plain memory", body: "not a merge result" });
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.trpcUrl}/trpc/memories.unmerge`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${server.token}`,
        },
        body: JSON.stringify({ id: m.id }),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      const json = (await response.json()) as TrpcErr;
      expect(json.error?.message).toMatch(/not a merge result|no superseded sources/i);
      // No corpus change: the memory is untouched (still active).
      expect(memoryStatus(dataDir, m.id)).toBe("active");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("returns NOT_FOUND for an unknown id", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.trpcUrl}/trpc/memories.unmerge`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${server.token}`,
        },
        body: JSON.stringify({ id: "mem_does_not_exist" }),
      });
      const json = (await response.json()) as TrpcErr;
      expect(json.error?.data?.code).toBe("NOT_FOUND");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.unmerge is unreachable from the public (network) listener (ADR 0008 P3)", async () => {
    const dataDir = makeTempDir();
    const m = seedMemory(dataDir, { title: "Protected by gate" });
    const server = await startHttpServer({ dataDir });
    try {
      // Post-P3 the admin gate is the network boundary, not a token: unmerge is
      // served only on the internal listener and 404s on the public port — even
      // for a network agent's bearer (ADR 0008 P1/P3).
      const response = await fetch(`${server.url}/trpc/memories.unmerge`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer agent-token" },
        body: JSON.stringify({ id: m.id }),
      });
      expect(response.status).toBe(404);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});

// Flagged-memory review queue (spec 048 PR-2). `listFlagged` surfaces every
// memory with ≥1 open flag (its `flags` carried along for the reviewer);
// `resolveFlag` adjudicates one — `dismiss` clears the flags + keeps the memory
// active, `archive` archives it THEN clears its flags. Admin-gated.
describe("tRPC flagged-memory review queue (spec 048 PR-2)", () => {
  interface FlaggedRow extends MemoryRow {
    flags: { agent_id: string; reason: string; created_at: string }[];
  }

  it("memories.listFlagged returns only memories with open flags, carrying their flags", async () => {
    const dataDir = makeTempDir();
    const flagged = seedMemory(dataDir, { title: "Stale fact" });
    seedMemory(dataDir, { title: "Clean fact" });
    flagMemory(dataDir, flagged.id, "outdated since the rewrite", "scribe");
    const server = await startHttpServer({ dataDir });
    try {
      const data = await trpcGet<{ memories: FlaggedRow[]; total: number }>(
        server,
        "memories.listFlagged",
      );
      expect(data.memories.map((m) => m.id)).toEqual([flagged.id]);
      expect(data.memories[0].flags).toHaveLength(1);
      expect(data.memories[0].flags[0]).toMatchObject({
        agent_id: "scribe",
        reason: "outdated since the rewrite",
      });
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.listFlagged returns an empty queue when nothing is flagged", async () => {
    const dataDir = makeTempDir();
    seedMemory(dataDir, { title: "Clean fact" });
    const server = await startHttpServer({ dataDir });
    try {
      const data = await trpcGet<{ memories: FlaggedRow[]; total: number }>(
        server,
        "memories.listFlagged",
      );
      expect(data.memories).toEqual([]);
      expect(data.total).toBe(0);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.resolveFlag dismiss clears the flags and keeps the memory active", async () => {
    const dataDir = makeTempDir();
    const m = seedMemory(dataDir, { title: "Disputed" });
    flagMemory(dataDir, m.id, "looks wrong", "scribe");
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<MemoryRow>(server, "memories.resolveFlag", {
        id: m.id,
        action: "dismiss",
      });
      expect(result.status).toBe("active");
      expect(openFlagCount(dataDir, m.id)).toBe(0);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.resolveFlag archive archives the memory and clears its flags", async () => {
    const dataDir = makeTempDir();
    const m = seedMemory(dataDir, { title: "Genuinely wrong" });
    flagMemory(dataDir, m.id, "incorrect", "scribe");
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<MemoryRow>(server, "memories.resolveFlag", {
        id: m.id,
        action: "archive",
      });
      expect(result.status).toBe("archived");
      expect(openFlagCount(dataDir, m.id)).toBe(0);
      expect(memoryStatus(dataDir, m.id)).toBe("archived");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("memories.resolveFlag returns NOT_FOUND for an unknown id", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.trpcUrl}/trpc/memories.resolveFlag`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${server.token}`,
        },
        body: JSON.stringify({ id: "mem_nope", action: "dismiss" }),
      });
      expect(response.status).toBe(404);
      const json = (await response.json()) as TrpcErr;
      expect(json.error?.data?.code).toBe("NOT_FOUND");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("listFlagged / resolveFlag are unreachable from the public (network) listener (ADR 0008 P3)", async () => {
    const dataDir = makeTempDir();
    const m = seedMemory(dataDir, { title: "Protected by gate" });
    flagMemory(dataDir, m.id, "wrong", "scribe");
    const server = await startHttpServer({ dataDir });
    try {
      // Post-P3 the admin gate is the network boundary, not a token: the review
      // queue is served only on the internal listener and 404s on the public port
      // — even for a network agent's bearer (ADR 0008 P1/P3).
      const listResponse = await fetch(`${server.url}/trpc/memories.listFlagged`, {
        headers: { authorization: "Bearer agent-token" },
      });
      expect(listResponse.status).toBe(404);

      const resolveResponse = await fetch(`${server.url}/trpc/memories.resolveFlag`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer agent-token" },
        body: JSON.stringify({ id: m.id, action: "dismiss" }),
      });
      expect(resolveResponse.status).toBe(404);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});

// Proposal review endpoint (spec 2026-06-20 proposal-review-ux, T3). For every
// proposed memory, surface its self-describing provenance (action/source/
// rationale from curator_note), resolve the memories it supersedes (targets),
// and — for a single-target replacement — a server-rendered old→new diff. The
// dashboard renders the diff with the existing DiffView. Admin-gated, additive
// (the pinned list/approve/reject surface is untouched).
describe("tRPC memories.proposalsForReview (review endpoint + server diff)", () => {
  interface ReviewRow {
    proposal: MemoryRow;
    action: string | null;
    source: string | null;
    rationale: string | null;
    targets: MemoryRow[];
    diff: string | null;
  }

  it("returns action, source, rationale, the resolved target, and a diff for a grooming update", async () => {
    const dataDir = makeTempDir();
    // The active memory the grooming update supersedes.
    const target = seedMemory(dataDir, { title: "Coffee", body: "Espresso, no sugar." });
    // The proposed replacement carrying self-describing provenance + the target id.
    const proposal = seedProposal(
      dataDir,
      {
        proposed_action: "update",
        source: "grooming",
        rationale: "Corrected the sugar preference",
        supersedes: [target.id],
      },
      { title: "Coffee", body: "Espresso, one sugar." },
    );
    const server = await startHttpServer({ dataDir });
    try {
      const rows = await trpcGet<ReviewRow[]>(server, "memories.proposalsForReview");
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.proposal.id).toBe(proposal.id);
      expect(row.action).toBe("update");
      expect(row.source).toBe("grooming");
      expect(row.rationale).toBe("Corrected the sugar preference");
      // The superseded source resolves into `targets`.
      expect(row.targets.map((t) => t.id)).toEqual([target.id]);
      // Exactly one target → a non-empty old→new diff (the DiffView string).
      expect(row.diff).toBeTruthy();
      const diffLines = (row.diff ?? "").split("\n");
      expect(diffLines.some((l) => l.startsWith("+"))).toBe(true);
      expect(diffLines.some((l) => l.startsWith("-"))).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("returns no targets and no diff for an intake create (no superseded source)", async () => {
    const dataDir = makeTempDir();
    const proposal = seedProposal(
      dataDir,
      {
        proposed_action: "create",
        source: "intake",
        rationale: "A new fact worth keeping",
      },
      { title: "New fact", body: "Worth keeping." },
    );
    const server = await startHttpServer({ dataDir });
    try {
      const rows = await trpcGet<ReviewRow[]>(server, "memories.proposalsForReview");
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.proposal.id).toBe(proposal.id);
      expect(row.action).toBe("create");
      expect(row.source).toBe("intake");
      expect(row.targets).toEqual([]);
      // A create has no target — no diff.
      expect(row.diff).toBeNull();
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("resolves both sources but emits no diff for a merge (≠1 target)", async () => {
    const dataDir = makeTempDir();
    const a = seedMemory(dataDir, { title: "Dup A", body: "same fact, phrasing A" });
    const b = seedMemory(dataDir, { title: "Dup B", body: "same fact, phrasing B" });
    const proposal = seedProposal(
      dataDir,
      {
        proposed_action: "merge",
        source: "grooming",
        rationale: "Collapsed two duplicates",
        supersedes: [a.id, b.id],
      },
      { title: "Merged fact", body: "the merged fact" },
    );
    const server = await startHttpServer({ dataDir });
    try {
      const rows = await trpcGet<ReviewRow[]>(server, "memories.proposalsForReview");
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.proposal.id).toBe(proposal.id);
      expect(row.action).toBe("merge");
      // Both superseded sources resolve.
      expect(row.targets.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
      // Two targets → no single old→new diff.
      expect(row.diff).toBeNull();
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("skips supersedes ids that don't resolve (fail-soft)", async () => {
    const dataDir = makeTempDir();
    const target = seedMemory(dataDir, { title: "Real", body: "real body" });
    const proposal = seedProposal(
      dataDir,
      {
        proposed_action: "update",
        source: "grooming",
        rationale: "supersedes a real and a phantom id",
        supersedes: [target.id, "mem_does_not_exist"],
      },
      { title: "Real", body: "updated body" },
    );
    const server = await startHttpServer({ dataDir });
    try {
      const rows = await trpcGet<ReviewRow[]>(server, "memories.proposalsForReview");
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.proposal.id).toBe(proposal.id);
      // The phantom id is dropped; only the real target survives → still a diff.
      expect(row.targets.map((t) => t.id)).toEqual([target.id]);
      expect(row.diff).toBeTruthy();
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("is unreachable from the public (network) listener (ADR 0008 P3)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.url}/trpc/memories.proposalsForReview`, {
        headers: { authorization: "Bearer agent-token" },
      });
      expect(response.status).toBe(404);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});

// Plan enrichment (proposal-review rework 2026-07-01, F2). A plan-carrying
// intake proposal (curator_note plan keys, D1) is enriched with the resolved
// guessed target {id,title,status} and a server-rendered preview diff of what
// executing the plan would do. Legacy rows (no plan keys) get `plan: null` and
// are otherwise byte-identical to before. The plan NEVER feeds `targets`/`diff`
// (D10 — a guessed target is not a resolved one).
describe("tRPC memories.proposalsForReview — plan enrichment (F2)", () => {
  interface PlanTarget {
    id: string;
    title: string;
    status: string;
  }
  interface ReviewPlan {
    action: string;
    confidence: number | null;
    guessed_target: PlanTarget | null;
    guessed_target_reason: string | null;
    planned_addition: string | null;
    planned_title: string | null;
    planned_body: string | null;
    planned_tags: string[] | null;
    preview_diff: string | null;
  }
  interface ReviewRow {
    proposal: MemoryRow;
    action: string | null;
    targets: MemoryRow[];
    diff: string | null;
    plan: ReviewPlan | null;
  }

  function archiveMemoryDirect(dataDir: string, id: string): void {
    const store = createLibrarianStore({ dataDir });
    try {
      store.archiveMemory(id, "test");
    } finally {
      store.close();
    }
  }

  it("an augment plan resolves the guessed target and previews the woven addition", async () => {
    const dataDir = makeTempDir();
    const target = seedMemory(dataDir, { title: "Elaine", body: "Lives in Paris." });
    seedProposal(
      dataDir,
      {
        proposed_action: "augment",
        source: "intake",
        rationale: "extends the Elaine doc",
        guessed_target_id: target.id,
        planned_addition: "Now works at [[Acme]].",
        confidence: 0.7,
      },
      { title: "Elaine works at Acme", body: "Elaine now works at Acme." },
    );
    const server = await startHttpServer({ dataDir });
    try {
      const rows = await trpcGet<ReviewRow[]>(server, "memories.proposalsForReview");
      expect(rows).toHaveLength(1);
      const { plan, targets, diff } = rows[0];
      expect(plan).not.toBeNull();
      expect(plan?.action).toBe("augment");
      expect(plan?.confidence).toBe(0.7);
      expect(plan?.guessed_target).toMatchObject({ id: target.id, title: "Elaine" });
      expect(plan?.guessed_target_reason).toBeNull();
      expect(plan?.planned_addition).toBe("Now works at [[Acme]].");
      // The preview shows the target body with the addition woven in — an
      // added line, and the original preserved (no-clobber by construction).
      const previewLines = (plan?.preview_diff ?? "").split("\n");
      expect(previewLines.some((l) => l.startsWith("+") && l.includes("[[Acme]]"))).toBe(true);
      expect(plan?.preview_diff).toContain("Lives in Paris.");
      // D10: the guess must not leak into the authoritative target/diff path.
      expect(targets).toEqual([]);
      expect(diff).toBeNull();
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("a supersede plan previews old → planned replacement", async () => {
    const dataDir = makeTempDir();
    const target = seedMemory(dataDir, { title: "Coffee", body: "Espresso, no sugar." });
    seedProposal(
      dataDir,
      {
        proposed_action: "supersede",
        source: "intake",
        rationale: "the preference changed",
        guessed_target_id: target.id,
        planned_title: "Coffee",
        planned_body: "Espresso, one sugar.",
        confidence: 0.65,
      },
      { title: "Coffee update", body: "One sugar now." },
    );
    const server = await startHttpServer({ dataDir });
    try {
      const rows = await trpcGet<ReviewRow[]>(server, "memories.proposalsForReview");
      const { plan } = rows[0];
      expect(plan?.action).toBe("supersede");
      expect(plan?.planned_title).toBe("Coffee");
      expect(plan?.planned_body).toBe("Espresso, one sugar.");
      const lines = (plan?.preview_diff ?? "").split("\n");
      expect(lines.some((l) => l.startsWith("-") && l.includes("no sugar"))).toBe(true);
      expect(lines.some((l) => l.startsWith("+") && l.includes("one sugar"))).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("a create plan carries the curated fields with no target and no diff", async () => {
    const dataDir = makeTempDir();
    seedProposal(
      dataDir,
      {
        proposed_action: "create",
        source: "intake",
        rationale: "novel fact",
        planned_title: "Elaine — Piano Teacher",
        planned_body: "Teaches on Tuesdays.",
        planned_tags: ["person"],
        confidence: 0.5,
      },
      { title: "Raw submission", body: "elaine teaches piano tuesdays" },
    );
    const server = await startHttpServer({ dataDir });
    try {
      const rows = await trpcGet<ReviewRow[]>(server, "memories.proposalsForReview");
      const { plan } = rows[0];
      expect(plan).toMatchObject({
        action: "create",
        planned_title: "Elaine — Piano Teacher",
        planned_body: "Teaches on Tuesdays.",
        planned_tags: ["person"],
        confidence: 0.5,
        guessed_target: null,
        guessed_target_reason: null,
        preview_diff: null,
      });
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("an unresolvable guessed target yields guessed_target: null with reason not_found", async () => {
    const dataDir = makeTempDir();
    seedProposal(
      dataDir,
      {
        proposed_action: "augment",
        source: "intake",
        rationale: "target has since been purged",
        guessed_target_id: "mem_ghost",
        planned_addition: "orphaned addition",
        confidence: 0.6,
      },
      { title: "Orphan", body: "orphaned" },
    );
    const server = await startHttpServer({ dataDir });
    try {
      const rows = await trpcGet<ReviewRow[]>(server, "memories.proposalsForReview");
      const { plan } = rows[0];
      expect(plan?.guessed_target).toBeNull();
      expect(plan?.guessed_target_reason).toBe("not_found");
      expect(plan?.preview_diff).toBeNull();
      // The plan itself still renders (the card shows what the curator wanted).
      expect(plan?.planned_addition).toBe("orphaned addition");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("an archived guessed target still resolves, flagged with reason archived", async () => {
    const dataDir = makeTempDir();
    const target = seedMemory(dataDir, { title: "Retired doc", body: "old body" });
    archiveMemoryDirect(dataDir, target.id);
    seedProposal(
      dataDir,
      {
        proposed_action: "augment",
        source: "intake",
        rationale: "target archived since judgment",
        guessed_target_id: target.id,
        planned_addition: "too late",
        confidence: 0.6,
      },
      { title: "Late addition", body: "too late" },
    );
    const server = await startHttpServer({ dataDir });
    try {
      const rows = await trpcGet<ReviewRow[]>(server, "memories.proposalsForReview");
      const { plan } = rows[0];
      expect(plan?.guessed_target).toMatchObject({ id: target.id, status: "archived" });
      expect(plan?.guessed_target_reason).toBe("archived");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("a legacy plan-less proposal gets plan: null and is otherwise unchanged", async () => {
    const dataDir = makeTempDir();
    seedProposal(
      dataDir,
      { proposed_action: "create", source: "intake", rationale: "pre-rework proposal" },
      { title: "Legacy", body: "no plan keys" },
    );
    const server = await startHttpServer({ dataDir });
    try {
      const rows = await trpcGet<ReviewRow[]>(server, "memories.proposalsForReview");
      const row = rows[0];
      expect(row.plan).toBeNull();
      expect(row.action).toBe("create");
      expect(row.targets).toEqual([]);
      expect(row.diff).toBeNull();
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});

// Apply-the-plan (proposal-review rework 2026-07-01, F3 / D2 / D8): execute the
// judge's PERSISTED plan through the existing guards — never re-running the
// curator — then consume the proposal (mutate target FIRST, then archive the
// proposal stamped resolution: "applied_plan"). Guard failures teach and
// mutate nothing.
describe("tRPC memories.applyProposalPlan (F3)", () => {
  function seedPlanProposal(
    dataDir: string,
    note: Record<string, unknown>,
    overrides: Partial<{ title: string; body: string }> = {},
  ): MemoryRow {
    return seedProposal(
      dataDir,
      { source: "intake", rationale: "test plan", ...note },
      { title: overrides.title ?? "Raw submission", body: overrides.body ?? "raw body" },
    );
  }

  it("augment: updates the target body and archives the proposal with resolution applied_plan", async () => {
    const dataDir = makeTempDir();
    const target = seedMemory(dataDir, { title: "Elaine", body: "Lives in Paris." });
    const proposal = seedPlanProposal(dataDir, {
      proposed_action: "augment",
      guessed_target_id: target.id,
      planned_addition: "Now works at [[Acme]].",
      confidence: 0.7,
    });
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<{ target: MemoryRow; proposal: MemoryRow }>(
        server,
        "memories.applyProposalPlan",
        { id: proposal.id },
      );
      // The target was mutated: original preserved, addition woven in.
      expect(result.target.body.startsWith("Lives in Paris.")).toBe(true);
      expect(result.target.body).toContain("[[Acme]]");
      // The proposal was consumed (D8): archived, stamped applied_plan.
      expect(memoryStatus(dataDir, proposal.id)).toBe("archived");
      expect(curatorNote(dataDir, proposal.id)).toMatchObject({ resolution: "applied_plan" });
      // Exactly one active memory holds the fact — no duplicate.
      expect(memoryStatus(dataDir, target.id)).toBe("active");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("supersede: replaces the target's title/body and consumes the proposal", async () => {
    const dataDir = makeTempDir();
    const target = seedMemory(dataDir, { title: "Coffee", body: "Espresso, no sugar." });
    const proposal = seedPlanProposal(dataDir, {
      proposed_action: "supersede",
      guessed_target_id: target.id,
      planned_title: "Coffee",
      planned_body: "Espresso, one sugar.",
      confidence: 0.8,
    });
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<{ target: MemoryRow; proposal: MemoryRow }>(
        server,
        "memories.applyProposalPlan",
        { id: proposal.id },
      );
      expect(result.target.body).toBe("Espresso, one sugar.");
      expect(memoryStatus(dataDir, proposal.id)).toBe("archived");
      expect(curatorNote(dataDir, proposal.id)).toMatchObject({ resolution: "applied_plan" });
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("teaches and mutates nothing when the guessed target no longer exists", async () => {
    const dataDir = makeTempDir();
    const proposal = seedPlanProposal(dataDir, {
      proposed_action: "augment",
      guessed_target_id: "mem_ghost",
      planned_addition: "orphaned",
      confidence: 0.7,
    });
    const server = await startHttpServer({ dataDir });
    try {
      await expect(
        trpcPost(server, "memories.applyProposalPlan", { id: proposal.id }),
      ).rejects.toThrow(/no longer exists/);
      // Nothing moved: the proposal is still proposed.
      expect(memoryStatus(dataDir, proposal.id)).toBe("proposed");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("teaches and mutates nothing when the guessed target was archived since judgment", async () => {
    const dataDir = makeTempDir();
    const target = seedMemory(dataDir, { title: "Retired", body: "old" });
    {
      const store = createLibrarianStore({ dataDir });
      try {
        store.archiveMemory(target.id, "test");
      } finally {
        store.close();
      }
    }
    const proposal = seedPlanProposal(dataDir, {
      proposed_action: "augment",
      guessed_target_id: target.id,
      planned_addition: "too late",
      confidence: 0.7,
    });
    const server = await startHttpServer({ dataDir });
    try {
      await expect(
        trpcPost(server, "memories.applyProposalPlan", { id: proposal.id }),
      ).rejects.toThrow(/archived/);
      expect(memoryStatus(dataDir, proposal.id)).toBe("proposed");
      expect(memoryStatus(dataDir, target.id)).toBe("archived");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("rejects a proposal with no executable plan (legacy / create)", async () => {
    const dataDir = makeTempDir();
    const proposal = seedPlanProposal(dataDir, { proposed_action: "create" });
    const server = await startHttpServer({ dataDir });
    try {
      await expect(
        trpcPost(server, "memories.applyProposalPlan", { id: proposal.id }),
      ).rejects.toThrow(/plan/);
      expect(memoryStatus(dataDir, proposal.id)).toBe("proposed");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("returns NOT_FOUND for an unknown proposal id", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      await expect(
        trpcPost(server, "memories.applyProposalPlan", { id: "mem_ghost" }),
      ).rejects.toThrow(/failed/);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("is unreachable from the public (network) listener (ADR 0008 P3)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.url}/trpc/memories.applyProposalPlan`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer agent-token" },
        body: JSON.stringify({ id: "mem_x" }),
      });
      expect(response.status).toBe(404);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});

// D11 (proposal-review rework): the approve mutation's dormant `patch`
// parameter carries the judge's curated title/body/tags when the admin
// approves a create-plan proposal's curated version. Pin that the patch is
// applied on activation — the wire path the dashboard's default Approve uses.
describe("tRPC memories.approve with a patch (D11)", () => {
  it("applies the curated title/body/tags when approving", async () => {
    const dataDir = makeTempDir();
    const proposal = seedProposal(
      dataDir,
      {
        proposed_action: "create",
        source: "intake",
        rationale: "novel fact",
        planned_title: "Elaine — Piano Teacher",
        planned_body: "Teaches on Tuesdays.",
        planned_tags: ["person"],
        confidence: 0.5,
      },
      { title: "raw first line", body: "raw submission" },
    );
    const server = await startHttpServer({ dataDir });
    try {
      const approved = await trpcPost<MemoryRow & { tags: string[] }>(server, "memories.approve", {
        id: proposal.id,
        patch: {
          title: "Elaine — Piano Teacher",
          body: "Teaches on Tuesdays.",
          tags: ["person"],
        },
      });
      expect(approved.status).toBe("active");
      expect(approved.title).toBe("Elaine — Piano Teacher");
      expect(approved.body).toBe("Teaches on Tuesdays.");
      expect(approved.tags).toEqual(["person"]);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});

// D9 (proposal-review rework): confirming a chat-proposed action from a
// proposal-grounded chat consumes the proposal — memories.resolveViaChat
// archives it stamped resolution: "resolved_via_chat". The corpus mutation
// itself already ran through the generic admin mutations.
describe("tRPC memories.resolveViaChat (D9)", () => {
  it("archives the proposal stamped resolved_via_chat", async () => {
    const dataDir = makeTempDir();
    const proposal = seedProposal(
      dataDir,
      { proposed_action: "augment", source: "intake", rationale: "r", guessed_target_id: "x" },
      { title: "Chat-resolved", body: "b" },
    );
    const server = await startHttpServer({ dataDir });
    try {
      await trpcPost(server, "memories.resolveViaChat", { id: proposal.id });
      expect(memoryStatus(dataDir, proposal.id)).toBe("archived");
      expect(curatorNote(dataDir, proposal.id)).toMatchObject({
        resolution: "resolved_via_chat",
      });
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("returns NOT_FOUND for an unknown id and is public-listener-unreachable", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      await expect(
        trpcPost(server, "memories.resolveViaChat", { id: "mem_ghost" }),
      ).rejects.toThrow(/failed/);
      const response = await fetch(`${server.url}/trpc/memories.resolveViaChat`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer agent-token" },
        body: JSON.stringify({ id: "mem_x" }),
      });
      expect(response.status).toBe(404);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
