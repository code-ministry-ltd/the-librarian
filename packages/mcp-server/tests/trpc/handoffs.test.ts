// Handoff tRPC procedure integration tests.
//
// Spawns the real HTTP bin (memories.test.ts pattern) and exercises the
// dashboard handoff surface: list/byId reads and the admin-only `purge`
// permanent delete — hard-delete + git commit, NOT_FOUND for an absent id,
// and the admin gate refusing anonymous callers.

import { spawnSync } from "node:child_process";
import { createLibrarianStore } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

// The data dir's vault is a git repo; every store mutation lands a commit.
// Read the subject lines so a test can assert a mutation was committed
// (recoverable from history).
function gitLog(dataDir: string): string[] {
  const result = spawnSync("git", ["-C", `${dataDir}/vault`, "log", "--format=%s"], {
    encoding: "utf8",
  });
  return result.stdout.split("\n").filter((l) => l.length > 0);
}

// The `Librarian-Actor` trailer of the newest commit whose subject contains
// `needle` — the audit "who" for that mutation.
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

// Read a handoff's claim status from the data dir by opening a fresh store —
// the HTTP server runs in a separate process.
function handoffById(dataDir: string, handoffId: string): { claimed_at: string | null } | null {
  const store = createLibrarianStore({ dataDir });
  try {
    const detail = store.handoffs.getById(handoffId);
    return detail ? { claimed_at: detail.claimed_at } : null;
  } finally {
    store.close();
  }
}

// Seed a handoff document directly (valid five-section template, ≥100 chars).
function seedHandoff(dataDir: string, title: string): string {
  const store = createLibrarianStore({ dataDir });
  try {
    const result = store.handoffs.store(
      {
        title,
        document_md:
          "## Start & intent\nResume the vault migration that stalled on the schema step.\n\n" +
          "## Journey\nImplemented the store seam, then hit a flaky fixture while wiring commits.\n\n" +
          "## Current state\nStore seam done; fixture flake is localised but not yet fixed.\n\n" +
          "## What's left\nFix the fixture, re-run the gate, and ship the migration slice.\n\n" +
          "## Open questions\nShould the fixture pin the clock or accept a range?\n",
      },
      { created_by_agent_id: "agent-a" },
    );
    return result.handoff_id;
  } finally {
    store.close();
  }
}

interface ServerHandle {
  url: string;
  token: string;
  trpcUrl: string;
  stop: () => Promise<void>;
}

interface TrpcOk<T> {
  result: { data: T };
}

interface TrpcErr {
  error?: { message?: string; data?: { httpStatus?: number; code?: string } };
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

describe("tRPC handoffs.purge (permanent delete)", () => {
  it("hard-deletes the handoff, commits with the acting principal, and reports the id", async () => {
    const dataDir = makeTempDir();
    const id = seedHandoff(dataDir, "Ready to purge");
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<{ purged: boolean; handoff_id: string }>(
        server,
        "handoffs.purge",
        { handoff_id: id },
      );
      expect(result).toEqual({ purged: true, handoff_id: id });

      // Gone from the corpus entirely.
      expect(handoffById(dataDir, id)).toBeNull();

      // Committed (recoverable from git history) and attributed to the acting
      // principal — the internal listener's reserved dashboard actor.
      expect(gitLog(dataDir).some((s) => s.includes(`purge ${id}`))).toBe(true);
      expect(trailerOf(dataDir, `purge ${id}`)).not.toBe("");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("purges a claimed handoff — delete is claim-status-agnostic", async () => {
    const dataDir = makeTempDir();
    const id = seedHandoff(dataDir, "Claimed but stale");
    const store = createLibrarianStore({ dataDir });
    store.handoffs.claim({ handoff_id: id, claiming_agent_id: "agent-b" });
    store.close();
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<{ purged: boolean; handoff_id: string }>(
        server,
        "handoffs.purge",
        { handoff_id: id },
      );
      expect(result.purged).toBe(true);
      expect(handoffById(dataDir, id)).toBeNull();
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("returns NOT_FOUND naming the id for an absent handoff and touches nothing", async () => {
    const dataDir = makeTempDir();
    const id = seedHandoff(dataDir, "Untouched sibling");
    const server = await startHttpServer({ dataDir });
    try {
      const missing = "hdo_missing";
      const response = await fetch(`${server.trpcUrl}/trpc/handoffs.purge`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${server.token}`,
        },
        body: JSON.stringify({ handoff_id: missing }),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      const json = (await response.json()) as TrpcErr;
      expect(json.error?.message).toMatch(/not found/i);
      expect(json.error?.message).toContain(missing);

      // The sibling handoff is untouched.
      expect(handoffById(dataDir, id)).not.toBeNull();
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("404s on the public port — the admin gate is the network boundary (ADR 0008 P3)", async () => {
    const dataDir = makeTempDir();
    const id = seedHandoff(dataDir, "Admin-only delete");
    const server = await startHttpServer({ dataDir });
    try {
      // Post-P3 the admin gate is the network boundary, not a token: purge is
      // served only on the internal listener and 404s on the public port — even
      // for a network agent's bearer (ADR 0008 P1/P3).
      const response = await fetch(`${server.url}/trpc/handoffs.purge`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer agent-token" },
        body: JSON.stringify({ handoff_id: id }),
      });
      expect(response.status).toBe(404);
      expect(handoffById(dataDir, id)).not.toBeNull();
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
