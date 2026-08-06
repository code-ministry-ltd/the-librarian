// Vault-backed GroomingMemorySource (plan 036 Phase 4). Optional project
// associations do not restore project slices: grooming runs over one
// common_global slice and every live memory feeds it.

import { type Memory, createVaultGroomingMemorySource } from "@librarian/core";
import { describe, expect, it } from "vitest";

const GLOBAL = { kind: "common_global" as const };

function mem(over: Partial<Memory> & { id: string }): Memory {
  return {
    agent_id: "agent-a",
    title: "t",
    body: "b",
    status: "active",
    confidence: "working",
    tags: [],
    applies_to: [],
    supersedes: [],
    conflicts_with: [],
    is_global: false,
    requires_approval: false,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

/** A source over a fixed in-memory memory list (mirrors the markdown store's listAll). */
function sourceOf(memories: Memory[]) {
  return createVaultGroomingMemorySource({ listAll: () => memories });
}

describe("createVaultGroomingMemorySource — listSlices", () => {
  it("returns the single global slice when any active/proposed memory exists", () => {
    const source = sourceOf([
      mem({ id: "a" }),
      mem({ id: "b", status: "proposed", requires_approval: true }),
    ]);
    expect(source.listSlices()).toEqual([GLOBAL]);
  });

  it("returns no slice when the only memory is archived", () => {
    const source = sourceOf([mem({ id: "dead", status: "archived" })]);
    expect(source.listSlices()).toEqual([]);
  });

  it("returns exactly one global slice regardless of how many memories exist", () => {
    const source = sourceOf([mem({ id: "1" }), mem({ id: "2" }), mem({ id: "3" })]);
    expect(source.listSlices()).toEqual([GLOBAL]);
  });
});

describe("createVaultGroomingMemorySource — selectMemories (global slice)", () => {
  it("the global slice returns every active memory", () => {
    const source = sourceOf([mem({ id: "one" }), mem({ id: "two" }), mem({ id: "three" })]);
    expect(
      source
        .selectMemories(GLOBAL, "active", 50)
        .map((m) => m.id)
        .sort(),
    ).toEqual(["one", "three", "two"]);
  });

  it("partitions active vs proposed", () => {
    const source = sourceOf([
      mem({ id: "active-one" }),
      mem({ id: "proposed-one", status: "proposed" }),
    ]);
    expect(source.selectMemories(GLOBAL, "active", 50).map((m) => m.id)).toEqual(["active-one"]);
    expect(source.selectMemories(GLOBAL, "proposed", 50).map((m) => m.id)).toEqual([
      "proposed-one",
    ]);
  });

  it("orders newest-first and respects the limit", () => {
    const source = sourceOf([
      mem({ id: "old", updated_at: "2026-06-01T00:00:00.000Z" }),
      mem({ id: "new", updated_at: "2026-06-03T00:00:00.000Z" }),
      mem({ id: "mid", updated_at: "2026-06-02T00:00:00.000Z" }),
    ]);
    expect(source.selectMemories(GLOBAL, "active", 50).map((m) => m.id)).toEqual([
      "new",
      "mid",
      "old",
    ]);
    expect(source.selectMemories(GLOBAL, "active", 2).map((m) => m.id)).toEqual(["new", "mid"]);
  });

  it("maps the verdict booleans onto the record", () => {
    const source = sourceOf([
      mem({
        id: "p",
        requires_approval: true,
        is_global: true,
        project_keys: ["the-librarian"],
      }),
    ]);
    const [rec] = source.selectMemories(GLOBAL, "active", 50);
    expect(rec?.requiresApproval).toBe(true);
    expect(rec?.isGlobal).toBe(true);
    expect(rec?.projectKeys).toEqual(["the-librarian"]);
  });

  it("marks hasOpenCuratorFlag only for an open flag from the curator actor (review F2)", () => {
    const flag = (agent_id: string) => [{ agent_id, reason: "r", created_at: "2026-06-01" }];
    const source = sourceOf([
      mem({ id: "curator-flagged", flags: flag("system-memory-curator") }),
      mem({ id: "agent-flagged", flags: flag("codex") }),
      mem({ id: "unflagged" }),
    ]);
    const byId = new Map(source.selectMemories(GLOBAL, "active", 50).map((rec) => [rec.id, rec]));
    expect(byId.get("curator-flagged")?.hasOpenCuratorFlag).toBe(true);
    expect(byId.get("agent-flagged")?.hasOpenCuratorFlag).toBe(false);
    expect(byId.get("unflagged")?.hasOpenCuratorFlag).toBe(false);
  });
});

describe("createVaultGroomingMemorySource — selectTombstones", () => {
  it("returns archived memories with archivedAt=updated_at, a null reason, and the raw body for fingerprinting", () => {
    const source = sourceOf([
      mem({
        id: "dead",
        status: "archived",
        title: "deleted thing",
        body: "the original body",
        updated_at: "2026-06-05T00:00:00.000Z",
      }),
      mem({ id: "live" }),
    ]);
    const tombs = source.selectTombstones(GLOBAL, 50);
    expect(tombs.map((t) => t.id)).toEqual(["dead"]);
    expect(tombs[0]?.archivedAt).toBe("2026-06-05T00:00:00.000Z");
    expect(tombs[0]?.archiveReason).toBeNull();
    // The raw body is carried on the record (gatherMemoryEvidence fingerprints
    // it then drops it); it must be present here so the resurrection key is real.
    expect(tombs[0]?.body).toBe("the original body");
  });
});
