// Proposal source digests — spec 072 T3 (SC 4).
//
// A proposal stored NOTHING about the memories it was drafted against, so
// approving one silently archived whatever those memories had since become —
// dropping a hand edit from the active corpus with no warning. Every proposal
// that supersedes something now fingerprints those sources as drafted, which is
// what lets review tell later whether the corpus moved underneath it.
//
// D1: a content digest, not a timestamp. Every persist bumps `updated_at`
// (resolving a flag, archiving, a status change), so a timestamp comparison
// would report drift when no content moved — and false "your edit will be lost"
// warnings are worse than none, because they teach the operator to click
// through the gate.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type ValidatedOperation,
  type ValidationContext,
  applyOperations,
  createLibrarianStore,
  createVaultGroomingMemorySource,
  gatherMemoryEvidence,
  memoryContentDigest,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Scope {
  store: LibrarianStore;
  dataDir: string;
  runId: string;
}

let s: Scope | null = null;

beforeEach(() => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-digests-"));
  const store = createLibrarianStore({ dataDir });
  const run = store.createCurationRun({
    trigger: "manual",
    visibility: "common",
    input_hash: "hash",
    project_key: "proj-x",
  });
  s = { store, dataDir, runId: run.id };
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

function seed(over: Record<string, unknown> = {}) {
  return s!.store.createMemory({
    agent_id: "agent-a",
    title: "title",
    body: "body",
    visibility: "common",
    project_key: "proj-x",
    confidence: "working",
    ...over,
  }).memory;
}

function context(maxBodyChars?: number): ValidationContext {
  const slice = { kind: "common_project" as const, projectKey: "proj-x" };
  return {
    slice,
    memory: gatherMemoryEvidence(createVaultGroomingMemorySource(s!.store), slice, {
      maxMemories: 100,
      ...(maxBodyChars !== undefined ? { maxBodyChars } : {}),
    }),
    prepass: { findings: [] },
  };
}

function deps() {
  return {
    store: s!.store,
    runId: s!.runId,
    actorId: "system-memory-curator",
    confidenceThreshold: 0.8,
  };
}

const accept = () => ({ decision: "accept" }) as ValidatedOperation["outcome"];

function updateOp(id: string, confidence: number): ValidatedOperation {
  return {
    operation: {
      type: "update",
      source_memory_id: id,
      patch: { title: "Corrected" },
      rationale: "fix",
      confidence,
    },
    outcome: accept(),
  } as ValidatedOperation;
}

/** The one proposal in the store, with its curator_note. */
function theProposal() {
  const proposals = s!.store.listMemories({ status: "proposed" }).memories;
  expect(proposals).toHaveLength(1);
  return proposals[0]!;
}

const digestsOf = (m: { curator_note?: Record<string, unknown> | null }) =>
  (m.curator_note?.source_digests ?? null) as Record<string, string> | null;

describe("memoryContentDigest (spec 072 D1)", () => {
  it("is deterministic for the same content", () => {
    const a = memoryContentDigest({ title: "T", body: "B" });
    const b = memoryContentDigest({ title: "T", body: "B" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the title or the body changes", () => {
    const base = memoryContentDigest({ title: "T", body: "B" });
    expect(memoryContentDigest({ title: "T2", body: "B" })).not.toBe(base);
    expect(memoryContentDigest({ title: "T", body: "B2" })).not.toBe(base);
  });

  it("does not collide across the title/body boundary", () => {
    expect(memoryContentDigest({ title: "AB", body: "" })).not.toBe(
      memoryContentDigest({ title: "A", body: "B" }),
    );
  });
});

describe("proposals stamp source digests (spec 072 SC 4)", () => {
  it("fingerprints the source of a proposed update", () => {
    const m = seed({ title: "Fact", body: "old value" });

    applyOperations([updateOp(m.id, 0.5)], context(), deps());

    const digests = digestsOf(theProposal());
    expect(digests).not.toBeNull();
    expect(digests![m.id]).toBe(memoryContentDigest({ title: "Fact", body: "old value" }));
  });

  it("recomputing over an unmodified source reproduces the stored digest", () => {
    const m = seed({ title: "Fact", body: "old value" });
    applyOperations([updateOp(m.id, 0.5)], context(), deps());

    const stored = s!.store.getMemory(m.id)!;
    expect(digestsOf(theProposal())![m.id]).toBe(memoryContentDigest(stored));
  });

  it("fingerprints every source of a proposed merge", () => {
    const a = seed({ title: "A", body: "a body" });
    const b = seed({ title: "B", body: "b body" });

    applyOperations(
      [
        {
          operation: {
            type: "merge",
            source_memory_ids: [a.id, b.id],
            replacement: {
              title: "Merged",
              body: "merged",
              tags: [],
              applies_to: [],
              confidence: "working",
            },
            rationale: "dedupe",
            confidence: 0.5,
          },
          outcome: accept(),
        } as ValidatedOperation,
      ],
      context(),
      deps(),
    );

    const digests = digestsOf(theProposal());
    expect(Object.keys(digests ?? {}).sort()).toEqual([a.id, b.id].sort());
  });

  it("digests the authoritative store record, not the truncated evidence", () => {
    const body = "x".repeat(500);
    const m = seed({ title: "Long", body });

    // Evidence trims bodies to maxBodyChars; digesting THAT would never match a
    // later recompute from the store.
    applyOperations([updateOp(m.id, 0.5)], context(10), deps());

    expect(digestsOf(theProposal())![m.id]).toBe(memoryContentDigest({ title: "Long", body }));
  });

  it("stamps nothing on a proposal that supersedes nothing", () => {
    applyOperations(
      [
        {
          operation: {
            type: "create",
            memory: {
              title: "New",
              body: "new body",
              tags: [],
              applies_to: [],
              confidence: "working",
            },
            rationale: "worth keeping",
            confidence: 0.5,
          },
          outcome: accept(),
        } as ValidatedOperation,
      ],
      context(),
      deps(),
    );

    expect(digestsOf(theProposal())).toBeNull();
  });

  it("stamps nothing on an auto-applied update — there is no proposal to go stale", () => {
    const m = seed({ title: "Fact", body: "old value" });

    applyOperations([updateOp(m.id, 0.95)], context(), deps());

    expect(s!.store.listMemories({ status: "proposed" }).total).toBe(0);
    expect(s!.store.getMemory(m.id)!.title).toBe("Corrected");
  });
});
