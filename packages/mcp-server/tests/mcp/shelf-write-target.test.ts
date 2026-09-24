// Write-target enforcement at the MCP boundary (spec 062 T3 / SC 6). A `remember` routed through
// a two-shelf router lands the memory under the principal's `writeTarget` shelf — asserted from the
// WRITTEN FILE — and a router whose `writeTarget` is a read-only shelf surfaces the typed
// ShelfNotWritableError as a clean JSON-RPC error, not a crash. With the default router this is
// byte-identical (proven by the existing remember suites).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type Principal,
  type Shelf,
  type VaultRouter,
  createLibrarianStore,
} from "@librarian/core";
import { handleMcpPayload } from "@librarian/mcp-server";
import { afterEach, describe, expect, it } from "vitest";

const MEMBERS_X: Shelf = { id: "members-x", prefix: "members/x/", writable: true };
const TEAM: Shelf = { id: "team", prefix: "team/", writable: false };

const sarah: Principal = {
  kind: "agent",
  actorId: "sarah",
  boundActorId: "sarah",
  roles: ["agent"],
};

interface CallResponse {
  result?: { content: { text: string }[] };
  error?: { message: string };
}

const dataDirs: string[] = [];
const stores: LibrarianStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      /* ignore */
    }
  }
  for (const dir of dataDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function freshStore(router: VaultRouter): { store: LibrarianStore; vault: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-wt-"));
  dataDirs.push(dataDir);
  const store = createLibrarianStore({ dataDir, vaultRouter: router });
  stores.push(store);
  return { store, vault: path.join(dataDir, "vault") };
}

function remember(store: LibrarianStore, args: Record<string, unknown>): Promise<CallResponse> {
  return callTool(store, "remember", args);
}

function callTool(
  store: LibrarianStore,
  name: string,
  args: Record<string, unknown>,
  principal: Principal = sarah,
): Promise<CallResponse> {
  return handleMcpPayload(
    store,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    { principal },
  ) as unknown as Promise<CallResponse>;
}

const HANDOFF_DOC = [
  "## Start & intent",
  "Pick up the migration for the platform service.",
  "",
  "## Journey",
  "Mapped the legacy token claims and scaffolded the provider config.",
  "",
  "## Current state",
  "The auth code path compiles; rotation is stubbed.",
  "",
  "## What's left",
  "Wire rotation and cut over staging.",
  "",
  "## Open questions",
  "Keep the legacy cookie for one release?",
].join("\n");

describe("remember — write-target routing (spec 062 SC 6, MCP half)", () => {
  it("lands the memory under the principal's writeTarget shelf (members/x/memories/…)", async () => {
    const router: VaultRouter = {
      shelves: (_p, op) => (op === "write" ? [MEMBERS_X] : [MEMBERS_X, TEAM]),
      writeTarget: () => MEMBERS_X,
    };
    const { store, vault } = freshStore(router);

    const res = await remember(store, {
      title: "Deploy runbook",
      body: "Roll back with plat rollback.",
      agent_id: "sarah",
    });
    expect(res.error).toBeUndefined();
    expect(res.result?.content[0]?.text).toMatch(/Memory saved/);

    // Asserted from the file: the memory lands under the writeTarget shelf, not the vault root.
    const shelfMemDir = path.join(vault, "members/x/memories");
    const files = fs.readdirSync(shelfMemDir).filter((f) => f.endsWith(".md"));
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(path.join(shelfMemDir, files[0]!), "utf8")).toMatch(
      /^agent_id: sarah$/m,
    );
    expect(fs.existsSync(path.join(vault, "memories"))).toBe(false); // nothing at the root shelf
  });

  it("a non-writable writeTarget surfaces the typed error as a clean JSON-RPC error (no crash)", async () => {
    const router: VaultRouter = {
      shelves: () => [MEMBERS_X, TEAM],
      writeTarget: () => TEAM, // read-only
    };
    const { store, vault } = freshStore(router);

    const res = await remember(store, {
      title: "Nope",
      body: "read-only shelf",
      agent_id: "sarah",
    });
    // A clean JSON-RPC error (the -32000 boundary), not a thrown 500.
    expect(res.result).toBeUndefined();
    expect(res.error?.message).toMatch(/read-only/i);
    // Nothing was written to either shelf.
    expect(fs.existsSync(path.join(vault, "team/memories"))).toBe(false);
    expect(fs.existsSync(path.join(vault, "members/x/memories"))).toBe(false);
  });
});

// The two-shelf shape used by the handoff/flag routing tests: Sarah writes to members/x/ and
// recalls/searches across [members/x/, team/]; team/ is read-only.
const twoShelfRouter: VaultRouter = {
  shelves: (_p, op) => (op === "write" ? [MEMBERS_X] : [MEMBERS_X, TEAM]),
  writeTarget: () => MEMBERS_X,
};

describe("handoff routing across the principal's shelves (spec 062 review F)", () => {
  it("store → list → claim round-trips as the member in the two-shelf shape", async () => {
    const { store, vault } = freshStore(twoShelfRouter);

    // store_handoff lands under the member's writeTarget shelf (members/x/handoffs/), NOT the root.
    const stored = await callTool(store, "store_handoff", {
      title: "OAuth migration handoff",
      document_md: HANDOFF_DOC,
      project_key: "platform",
    });
    expect(stored.error).toBeUndefined();
    const handoffId = stored.result?.content[0]?.text.match(/handoff_id: (\S+)/)?.[1];
    expect(handoffId).toBeTruthy();
    expect(fs.existsSync(path.join(vault, "members/x/handoffs"))).toBe(true);

    // list_handoffs merges the member's recall shelves — it FINDS the handoff under members/x/ (a
    // root-only list would have returned nothing: the pre-fix break).
    const listed = await callTool(store, "list_handoffs", {});
    expect(listed.error).toBeUndefined();
    const listBody = JSON.parse(listed.result!.content[0]!.text) as {
      handoffs: { handoff_id: string }[];
    };
    expect(listBody.handoffs.map((h) => h.handoff_id)).toContain(handoffId);

    // claim_handoff locates the id across the recall shelves and claims through members/x/ (writable).
    const claimed = await callTool(store, "claim_handoff", { handoff_id: handoffId });
    expect(claimed.error).toBeUndefined();
    const claimBody = JSON.parse(claimed.result!.content[0]!.text) as { handoff_id?: string };
    expect(claimBody.handoff_id).toBe(handoffId);
  });
});

describe("flag_memory routing across the principal's shelves (spec 062 review F)", () => {
  it("flags an OWN-shelf memory (succeeds) and refuses a recalled TEAM memory with a clean typed error", async () => {
    const { store } = freshStore(twoShelfRouter);

    // Own memory on the writable members/x/ shelf.
    const own = store
      .forShelf(MEMBERS_X)
      .createMemory({ title: "Own note", body: "sarah's own memory", agent_id: "sarah" }, {});
    // Team memory seeded via a WRITABLE view of team/ (out-of-band); the router serves it read-only.
    const team = store
      .forShelf({ id: "team", prefix: "team/", writable: true })
      .createMemory({ title: "Team note", body: "team memory", agent_id: "team" }, {});

    // Flag on the OWN memory → routed to members/x/ (writable) → succeeds.
    const ownFlag = await callTool(store, "flag_memory", {
      memory_id: own.memory.id,
      reason: "outdated",
    });
    expect(ownFlag.error).toBeUndefined();
    expect(ownFlag.result?.content[0]?.text).toMatch(/Flag recorded/);

    // Flag on the recalled TEAM memory → located on the READ-ONLY team shelf → gate-respecting typed
    // refusal, surfaced as a clean JSON-RPC error (review F: flag is a principal-attributed mutation).
    const teamFlag = await callTool(store, "flag_memory", {
      memory_id: team.memory.id,
      reason: "wrong",
    });
    expect(teamFlag.result).toBeUndefined();
    expect(teamFlag.error?.message).toMatch(/read-only/i);
    const stillUnflagged = store.forShelf(TEAM).getMemory(team.memory.id);
    expect(stillUnflagged?.flags ?? []).toEqual([]);
    expect(stillUnflagged?.correction_work ?? []).toEqual([]);
  });
});
