// The read log at the MCP boundary (spec 080): recall, search_references and the primer on
// initialize each append one row when the log is on, and never change what the agent receives.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LibrarianStore, type ReadRecord, createLibrarianStore } from "@librarian/core";
import { handleMcpPayload } from "@librarian/mcp-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let originalSwitch: string | undefined;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  originalSwitch = process.env.LIBRARIAN_READ_LOG;
  process.env.LIBRARIAN_READ_LOG = "on";
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  if (originalSwitch === undefined) delete process.env.LIBRARIAN_READ_LOG;
  else process.env.LIBRARIAN_READ_LOG = originalSwitch;
});

function freshStore(options: { armed: boolean }): LibrarianStore {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-read-mcp-"));
  const store = createLibrarianStore({ dataDir, readLog: { armed: options.armed } });
  cleanups.push(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return store;
}

async function call(store: LibrarianStore, name: string, args: Record<string, unknown>) {
  const response = (await handleMcpPayload(store, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: { agent_id: "codex", ...args } },
  })) as { result: { content: { text: string }[] } };
  return response.result.content[0]?.text ?? "";
}

async function rows(store: LibrarianStore): Promise<ReadRecord[]> {
  await store.flushReads();
  return (await store.readReads()).rows;
}

describe("read log over MCP", () => {
  it("records a search recall's query and the ids it returned, in output order", async () => {
    const store = freshStore({ armed: true });
    const gpu = store.createMemory({
      agent_id: "codex",
      title: "GPU pinning",
      body: "llama-swap pins each GPU by UUID",
    }).memory;
    const text = await call(store, "recall", { query: "llama-swap GPU UUID", tags: ["marvin"] });
    const [row] = await rows(store);
    expect(row).toMatchObject({
      kind: "recall",
      mode: "search",
      query: "llama-swap GPU UUID",
      tags: ["marvin"],
      excerpts: true,
      resultChars: text.length,
    });
    if (row?.kind !== "recall") throw new Error("expected a recall row");
    expect(row.returnedCount).toBe(row.returnedIds.length);
    expect(typeof row.durationMs).toBe("number");
    if (row.returnedIds.length > 0) expect(row.returnedIds[0]).toBe(gpu.id);
  });

  it("records an ids recall with what was asked for and what came back", async () => {
    const store = freshStore({ armed: true });
    const kept = store.createMemory({ agent_id: "codex", title: "Kept", body: "true" }).memory;
    const unknown = "mem_00000000-0000-4000-8000-000000000000";
    await call(store, "recall", { ids: [unknown, kept.id] });
    const [row] = await rows(store);
    expect(row).toMatchObject({
      kind: "recall",
      mode: "ids",
      requestedIds: [unknown, kept.id],
      returnedIds: [kept.id],
      returnedCount: 1,
      excerpts: false,
    });
  });

  it("records an empty recall as zero results, which is the miss signal analysis needs", async () => {
    const store = freshStore({ armed: true });
    await call(store, "recall", { query: "nothing is stored yet" });
    const [row] = await rows(store);
    expect(row).toMatchObject({ kind: "recall", returnedIds: [], returnedCount: 0 });
  });

  it("records a reference search", async () => {
    const store = freshStore({ armed: true });
    const text = await call(store, "search_references", { query: "deployment runbook" });
    const [row] = await rows(store);
    expect(row).toMatchObject({
      kind: "search_references",
      query: "deployment runbook",
      returnedCount: 0,
      resultChars: text.length,
    });
  });

  it("records the primer an initialize delivers, by size and hash", async () => {
    const store = freshStore({ armed: true });
    const response = (await handleMcpPayload(store, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    })) as { result: { instructions?: string } };
    const instructions = response.result.instructions;
    const logged = await rows(store);
    if (instructions === undefined) {
      expect(logged).toHaveLength(0);
      return;
    }
    expect(logged[0]).toMatchObject({ kind: "primer", resultChars: instructions.length });
    if (logged[0]?.kind !== "primer") throw new Error("expected a primer row");
    expect(logged[0].primerHash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("returns exactly the same recall text whether or not the log is on", async () => {
    const logged = freshStore({ armed: true });
    const plain = freshStore({ armed: false });
    for (const store of [logged, plain]) {
      store.createMemory({ agent_id: "codex", title: "Port", body: "the api listens on 3838" });
    }
    expect(await call(logged, "recall", { query: "api port" })).toBe(
      await call(plain, "recall", { query: "api port" }),
    );
    expect(await rows(plain)).toHaveLength(0);
  });
});
