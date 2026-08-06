// Markdown MemoryStore — listAll / listMemories / getAggregates (Phase 2).
//
// The read surface: status/agent/project filtering
// (project = NULL-or-match), updated_at DESC ordering, paginated
// listMemories with tag-OR + boolean + date filters and sort/order, and the
// aggregates tallies (agent/project/status). Memory docs are
// seeded directly into the vault so field values are controlled.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type Memory,
  createMarkdownMemoryStore,
  createVault,
  serializeMemoryDocument,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-md-reads-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function setup() {
  const vault = createVault({ dataDir });
  const store = createMarkdownMemoryStore({ vault });
  const seed = (over: Partial<Memory> & { id: string }): Memory => {
    const memory: Memory = {
      id: over.id,
      title: over.title ?? over.id,
      body: over.body ?? "body",
      agent_id: over.agent_id ?? "codex",
      confidence: over.confidence ?? "working",
      tags: over.tags ?? [],
      applies_to: over.applies_to ?? [],
      ...(over.project_keys !== undefined ? { project_keys: over.project_keys } : {}),
      supersedes: [],
      conflicts_with: [],
      status: over.status ?? "active",
      is_global: over.is_global ?? false,
      requires_approval: over.requires_approval ?? false,
      created_at: over.created_at ?? "2026-06-01T00:00:00.000Z",
      updated_at: over.updated_at ?? "2026-06-01T00:00:00.000Z",
      curator_note: over.curator_note ?? null,
    };
    vault.writeText(`memories/${memory.id}.md`, serializeMemoryDocument(memory));
    return memory;
  };
  return { vault, store, seed };
}

describe("markdown MemoryStore — listAll", () => {
  it("orders by updated_at DESC", () => {
    const { store, seed } = setup();
    seed({ id: "a", updated_at: "2026-06-03T00:00:00.000Z" });
    seed({ id: "b", updated_at: "2026-06-01T00:00:00.000Z" });
    seed({ id: "c", updated_at: "2026-06-05T00:00:00.000Z" });
    expect(store.listAll().map((m) => m.id)).toEqual(["c", "a", "b"]);
  });

  it("filters by status and agent_id", () => {
    const { store, seed } = setup();
    seed({ id: "a", agent_id: "codex", status: "active" });
    seed({ id: "b", agent_id: "claude", status: "active" });
    seed({ id: "c", agent_id: "codex", status: "archived" });
    expect(
      store
        .listAll({ status: "active" })
        .map((m) => m.id)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(
      store
        .listAll({ agent_id: "codex" })
        .map((m) => m.id)
        .sort(),
    ).toEqual(["a", "c"]);
  });
});

describe("markdown MemoryStore — listMemories", () => {
  it("paginates with total/limit/offset", () => {
    const { store, seed } = setup();
    for (let i = 0; i < 5; i++) {
      seed({ id: `m${i}`, updated_at: `2026-06-0${i + 1}T00:00:00.000Z` });
    }
    const page = store.listMemories({ limit: 2, offset: 1 });
    expect(page.total).toBe(5);
    expect(page.limit).toBe(2);
    expect(page.offset).toBe(1);
    expect(page.memories).toHaveLength(2);
  });

  it("filters by tags (OR), is_global, and requires_approval", () => {
    const { store, seed } = setup();
    seed({ id: "a", tags: ["x"] });
    seed({ id: "b", tags: ["y"], is_global: true });
    seed({ id: "c", tags: ["z"], requires_approval: true });
    expect(
      store
        .listMemories({ tags: ["x", "z"] })
        .memories.map((m) => m.id)
        .sort(),
    ).toEqual(["a", "c"]);
    expect(store.listMemories({ is_global: true }).memories.map((m) => m.id)).toEqual(["b"]);
    expect(store.listMemories({ requires_approval: true }).memories.map((m) => m.id)).toEqual([
      "c",
    ]);
  });

  it("filters project_keys by exact membership, with any requested key matching", () => {
    const { store, seed } = setup();
    seed({ id: "exact", project_keys: ["lib"] });
    seed({ id: "longer", project_keys: ["the-lib"] });
    seed({ id: "other", project_keys: ["website"] });
    seed({ id: "absent" });

    expect(store.listMemories({ project_keys: ["lib"] }).memories.map((m) => m.id)).toEqual([
      "exact",
    ]);
    expect(
      store
        .listMemories({ project_keys: ["lib", "website"] })
        .memories.map((m) => m.id)
        .sort(),
    ).toEqual(["exact", "other"]);
  });

  it("filters by created_at from/to (to is end-of-day inclusive)", () => {
    const { store, seed } = setup();
    seed({ id: "old", created_at: "2026-05-20T12:00:00.000Z" });
    seed({ id: "mid", created_at: "2026-06-01T12:00:00.000Z" });
    seed({ id: "new", created_at: "2026-06-10T12:00:00.000Z" });
    const r = store.listMemories({ from: "2026-06-01", to: "2026-06-01" });
    expect(r.memories.map((m) => m.id)).toEqual(["mid"]);
  });

  it("sorts by title ascending when asked", () => {
    const { store, seed } = setup();
    seed({ id: "a", title: "banana" });
    seed({ id: "b", title: "apple" });
    seed({ id: "c", title: "cherry" });
    expect(
      store.listMemories({ sort: "title", order: "asc" }).memories.map((m) => m.title),
    ).toEqual(["apple", "banana", "cherry"]);
  });

  it("sorts titles by BINARY collation, not locale-aware (uppercase before lowercase)", () => {
    // Pins BINARY (code-point) collation: 'Z' (0x5A) < 'a' (0x61).
    // localeCompare would instead order 'apple' before 'Zebra' — this
    // guards against a future cmpStr → localeCompare regression.
    const { store, seed } = setup();
    seed({ id: "a", title: "Zebra" });
    seed({ id: "b", title: "apple" });
    expect(
      store.listMemories({ sort: "title", order: "asc" }).memories.map((m) => m.title),
    ).toEqual(["Zebra", "apple"]);
  });

  it("defaults to updated_at DESC", () => {
    const { store, seed } = setup();
    seed({ id: "old", updated_at: "2026-06-01T00:00:00.000Z" });
    seed({ id: "new", updated_at: "2026-06-09T00:00:00.000Z" });
    expect(store.listMemories().memories.map((m) => m.id)).toEqual(["new", "old"]);
  });

  it("clamps limit to 1..200 and offset to >= 0", () => {
    const { store, seed } = setup();
    for (let i = 0; i < 3; i++) seed({ id: `m${i}` });
    expect(store.listMemories({ limit: 0 }).limit).toBe(1);
    expect(store.listMemories({ limit: 500 }).limit).toBe(200);
    expect(store.listMemories({ offset: -5 }).offset).toBe(0);
  });
});

describe("markdown MemoryStore — getAggregates", () => {
  it("tallies active memories by agent/project/status", () => {
    const { store, seed } = setup();
    seed({ id: "a", agent_id: "codex", status: "active" });
    seed({ id: "b", agent_id: "codex", status: "active" });
    seed({ id: "c", agent_id: "claude", status: "archived" });
    const agg = store.getAggregates();
    expect(agg.total).toBe(2); // archived excluded
    expect(agg.agents).toEqual([{ value: "codex", count: 2 }]);
    expect(agg.statuses).toEqual([{ value: "active", count: 2 }]);
  });
});
