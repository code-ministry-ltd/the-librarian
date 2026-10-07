// Grooming proposal suppression — spec 072 T2 (SC 8).
//
// Grooming had no dedup at all: every sweep that reached the same judgment
// filed another proposal about the same memory. T2b removes most of the
// pressure (a filed proposal no longer re-triggers the next sweep), so this is
// the backstop for the runs that happen anyway — a manual/bypass trigger, or a
// neighbouring memory changing and pulling this one back into the slice.
//
// D6 keeps the rule TIGHT: suppress only an exact repeat — same action over the
// same set of source ids. A pending update{A} must NOT block a merge{A,B};
// those are different judgments and the operator should see both. Two live
// proposals about A are fine, because approving either withdraws the other
// (T1's cascade).
//
// The scan reads the store UNCAPPED, not the evidence bundle: evidence shares a
// 200-memory budget that fills with ACTIVE memories first, so on a large vault
// no proposal reaches evidence at all and suppression would silently never fire.

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
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Scope {
  store: LibrarianStore;
  dataDir: string;
  runId: string;
}

let s: Scope | null = null;

beforeEach(() => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-apply-dedup-"));
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

function context(): ValidationContext {
  const slice = { kind: "common_project" as const, projectKey: "proj-x" };
  return {
    slice,
    memory: gatherMemoryEvidence(createVaultGroomingMemorySource(s!.store), slice, {
      maxMemories: 100,
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

/** Below the 0.8 knob, so every op here routes to a proposal rather than an apply. */
const PROPOSE_CONFIDENCE = 0.5;

function updateOp(id: string, title = "Corrected"): ValidatedOperation {
  return {
    operation: {
      type: "update",
      source_memory_id: id,
      patch: { title },
      rationale: "fix",
      confidence: PROPOSE_CONFIDENCE,
    },
    outcome: accept(),
  } as ValidatedOperation;
}

function mergeOp(ids: string[]): ValidatedOperation {
  return {
    operation: {
      type: "merge",
      source_memory_ids: ids,
      replacement: {
        title: "Merged",
        body: "merged body",
        tags: [],
        applies_to: [],
        confidence: "working",
      },
      rationale: "dedupe",
      confidence: PROPOSE_CONFIDENCE,
    },
    outcome: accept(),
  } as ValidatedOperation;
}

const proposedCount = () => s!.store.listMemories({ status: "proposed" }).total;

const skippedForDuplicate = () =>
  s!.store
    .getCurationOperations(s!.runId)
    .filter((o) => o.status === "skipped" && /open proposal already covers/.test(o.rationale));

describe("grooming proposal suppression (spec 072 SC 8)", () => {
  it("suppresses an exact repeat and says so in the audit", () => {
    const m = seed({ title: "Fact" });

    applyOperations([updateOp(m.id)], context(), deps());
    expect(proposedCount()).toBe(1);

    // The same judgment again — one sweep later, or after a manual trigger.
    const summary = applyOperations([updateOp(m.id)], context(), deps());

    expect(proposedCount()).toBe(1); // no second proposal
    expect(summary.proposed).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(skippedForDuplicate()).toHaveLength(1);
  });

  it("does not suppress a different action over the same source", () => {
    const a = seed({ title: "A" });
    const b = seed({ title: "B" });

    applyOperations([updateOp(a.id)], context(), deps());
    const summary = applyOperations([mergeOp([a.id, b.id])], context(), deps());

    expect(summary.proposed).toBe(1);
    expect(proposedCount()).toBe(2); // update{A} and merge{A,B} coexist
  });

  it("does not suppress the same action over a different source set", () => {
    const a = seed({ title: "A" });
    const b = seed({ title: "B" });
    const c = seed({ title: "C" });

    applyOperations([mergeOp([a.id, b.id])], context(), deps());
    const summary = applyOperations([mergeOp([a.id, c.id])], context(), deps());

    expect(summary.proposed).toBe(1);
    expect(proposedCount()).toBe(2);
  });

  it("matches the source set regardless of order", () => {
    const a = seed({ title: "A" });
    const b = seed({ title: "B" });

    applyOperations([mergeOp([a.id, b.id])], context(), deps());
    const summary = applyOperations([mergeOp([b.id, a.id])], context(), deps());

    expect(summary.skipped).toBe(1);
    expect(proposedCount()).toBe(1);
  });

  it("leaves a first-time proposal alone", () => {
    const m = seed({ title: "Fact" });

    const summary = applyOperations([updateOp(m.id)], context(), deps());

    expect(summary.proposed).toBe(1);
    expect(skippedForDuplicate()).toHaveLength(0);
  });

  it("does not suppress the sibling replacements of a single split operation", () => {
    const m = seed({ title: "Two facts", body: "first. second." });
    const splitOp = {
      operation: {
        type: "split",
        source_memory_id: m.id,
        replacements: [
          { title: "First", body: "first.", tags: [], applies_to: [], confidence: "working" },
          { title: "Second", body: "second.", tags: [], applies_to: [], confidence: "working" },
        ],
        rationale: "two facts in one memory",
        confidence: PROPOSE_CONFIDENCE,
      },
      outcome: accept(),
    } as ValidatedOperation;

    const summary = applyOperations([splitOp], context(), deps());

    // One operation, N proposals — the replacements must not suppress each other.
    expect(summary.proposed).toBe(1);
    expect(proposedCount()).toBe(2);
  });
});
