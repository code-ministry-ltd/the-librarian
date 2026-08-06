// Slice-scoped memory evidence gathering for the curator (spec §9).
//
// Project associations are metadata, so grooming still runs over a SINGLE
// common_global slice and every live memory feeds it. The load-bearing guard is
// SECURITY guard — redaction-before-return: secret-looking material is scrubbed
// from evidence BEFORE it can be handed to the prompt builder (§9, §10.4); by
// output-validation time the value would already have left the building.
//
// Tombstones carry metadata + a content fingerprint (no body) for the §10.3
// resurrection pre-pass. Caps + truncation keep the bundle bounded (§9 caps).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  createLibrarianStore,
  createVaultGroomingMemorySource,
  gatherMemoryEvidence,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const GLOBAL = { kind: "common_global" as const };

interface Scope {
  store: LibrarianStore;
  dataDir: string;
}

let s: Scope | null = null;

beforeEach(() => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-evidence-"));
  s = { store: createLibrarianStore({ dataDir }), dataDir };
});
afterEach(() => {
  if (!s) return;
  try {
    s.store.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(s.dataDir, { recursive: true, force: true });
  s = null;
});

/** Seed a memory; defaults to a common active memory. */
function seed(overrides: Record<string, unknown> = {}) {
  return s!.store.createMemory({
    agent_id: "agent-a",
    title: "title",
    body: "body text",
    visibility: "common",
    confidence: "working",
    ...overrides,
  });
}

function gather(caps: { maxMemories: number; maxBodyChars?: number }) {
  return gatherMemoryEvidence(createVaultGroomingMemorySource(s!.store), GLOBAL, caps);
}

describe("gatherMemoryEvidence — the single global slice", () => {
  it("the global slice gathers every active memory regardless of project associations", () => {
    const one = seed({ title: "one" }).memory;
    const two = seed({ title: "two" }).memory;

    const bundle = gather({ maxMemories: 50 });

    const ids = bundle.activeMemories.map((m) => m.id);
    expect(ids).toContain(one.id);
    expect(ids).toContain(two.id);
  });

  it("keeps an agent-authored common memory in the slice (agent_id no longer privatises)", () => {
    const m = seed({ title: "common-by-agent", agent_id: "agent-z" }).memory;
    const bundle = gather({ maxMemories: 50 });
    expect(bundle.activeMemories.map((x) => x.id)).toContain(m.id);
  });

  it("carries project associations as evidence without changing the model output contract", () => {
    const memory = seed({ title: "project fact", project_keys: ["the-librarian"] }).memory;
    const item = gather({ maxMemories: 50 }).activeMemories.find((row) => row.id === memory.id);
    expect(item?.projectKeys).toEqual(["the-librarian"]);
  });
});

describe("gatherMemoryEvidence — redaction (security)", () => {
  it("redacts secret-looking material from bodies before returning", () => {
    seed({ title: "with-secret", body: 'deploy notes — token = "FAKETOKENFAKETOKEN" — ok' });

    const bundle = gather({ maxMemories: 50 });

    const body = bundle.activeMemories[0]!.body;
    expect(body).not.toContain("FAKETOKENFAKETOKEN");
    expect(body).toContain("[REDACTED:secret]");
    expect(bundle.redactionCount).toBeGreaterThan(0);
  });
});

describe("gatherMemoryEvidence — status partition + tombstones", () => {
  it("splits active and proposed memories", () => {
    const active = seed({ title: "active-one" }).memory;
    // The curator's apply layer (and direct callers) opt into the proposal flow
    // via `options.requires_approval: true`.
    const proposed = s!.store.createMemory(
      {
        agent_id: "agent-a",
        title: "proposed-one",
        body: "body text",
        visibility: "common",
        confidence: "working",
      },
      { requires_approval: true },
    ).memory;

    const bundle = gather({ maxMemories: 50 });

    expect(bundle.activeMemories.map((m) => m.id)).toContain(active.id);
    expect(bundle.activeMemories.every((m) => m.status === "active")).toBe(true);
    expect(bundle.proposedMemories.map((m) => m.id)).toContain(proposed.id);
    expect(bundle.proposedMemories.every((m) => m.status === "proposed")).toBe(true);
  });

  it("returns archived memories as metadata-only tombstones with a fingerprint and no body", () => {
    const m = seed({ title: "deleted thing", body: "the original body" }).memory;
    s!.store.archiveMemory(m.id);

    const bundle = gather({ maxMemories: 50 });

    expect(bundle.activeMemories.map((x) => x.id)).not.toContain(m.id);
    const tomb = bundle.tombstones.find((t) => t.id === m.id);
    expect(tomb).toBeDefined();
    expect(tomb!.contentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(tomb!.normalizedTitle).toContain("deleted thing");
    expect(typeof tomb!.archivedAt).toBe("string");
    // The deleted body must NOT be re-exposed.
    expect((tomb as unknown as Record<string, unknown>).body).toBeUndefined();
    expect(JSON.stringify(tomb)).not.toContain("the original body");
  });

  it("reports a null reason for a plain archive (none recorded at source)", () => {
    const m = seed({ title: "plain-archive", body: "x" }).memory;
    s!.store.archiveMemory(m.id);

    const bundle = gather({ maxMemories: 50 });
    expect(bundle.tombstones.find((t) => t.id === m.id)?.archiveReason).toBeNull();
  });
});

describe("gatherMemoryEvidence — caps + truncation", () => {
  it("caps the combined memory budget, prioritising active over proposed", () => {
    seed({ title: "a1" });
    seed({ title: "a2" });
    seed({ title: "a3" });
    s!.store.createMemory(
      {
        agent_id: "agent-a",
        title: "p1",
        body: "body text",
        visibility: "common",
        confidence: "working",
      },
      { requires_approval: true },
    ); // proposed

    const bundle = gather({ maxMemories: 2 });

    expect(bundle.activeMemories).toHaveLength(2);
    expect(bundle.proposedMemories).toHaveLength(0);
    expect(bundle.truncatedMemories).toBe(true);
  });

  it("truncates an oversized body with a marker and flags it", () => {
    seed({ title: "long", body: "abcdefghijklmnopqrstuvwxyz" });

    const bundle = gather({ maxMemories: 50, maxBodyChars: 10 });

    const body = bundle.activeMemories[0]!.body;
    expect(body.startsWith("abcdefghij")).toBe(true);
    expect(body).not.toBe("abcdefghijklmnopqrstuvwxyz");
    expect(body).toMatch(/truncated/i);
    expect(bundle.truncatedFields).toBe(true);
  });
});

describe("gatherMemoryEvidence — open curator flag surfacing (review F2)", () => {
  it("surfaces has_open_curator_flag: true only when the curator actor holds an open flag", () => {
    const flagged = seed({ title: "flagged" }).memory;
    const otherAgent = seed({ title: "agent-flagged" }).memory;
    const clean = seed({ title: "clean" }).memory;
    s!.store.flagMemory(flagged.id, "curator proposes archive: dup", "system-memory-curator");
    s!.store.flagMemory(otherAgent.id, "looks outdated", "codex");

    const items = gather({ maxMemories: 50 }).activeMemories;
    const byId = new Map(items.map((m) => [m.id, m]));

    expect(byId.get(flagged.id)?.has_open_curator_flag).toBe(true);
    // Omitted (not false) when absent — the evidence JSON stays lean and the
    // prompt only ever sees the marker on genuinely curator-flagged memories.
    expect("has_open_curator_flag" in byId.get(otherAgent.id)!).toBe(false);
    expect("has_open_curator_flag" in byId.get(clean.id)!).toBe(false);
  });

  it("an admin-resolved flag no longer marks the memory (resolved flags are not open)", () => {
    const m = seed({ title: "resolved" }).memory;
    s!.store.flagMemory(m.id, "curator proposes archive: dup", "system-memory-curator");
    s!.store.resolveFlags(m.id, "dashboard-admin");

    const items = gather({ maxMemories: 50 }).activeMemories;
    expect("has_open_curator_flag" in items.find((i) => i.id === m.id)!).toBe(false);
  });
});
