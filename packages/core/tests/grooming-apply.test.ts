// Curator apply execution (spec §11 + §11.1) — the live-memory mutation layer,
// now driven by the ONE apply rule (rethink D13). Integration test against a
// real store: seed memories, open a curation run, run applyOperations over
// validated operations, and assert both the resulting store state and the
// recorded audit operations.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ApplyStore,
  type LibrarianStore,
  type ValidatedOperation,
  type ValidationContext,
  applyOperations,
  createLibrarianStore,
  createVaultGroomingMemorySource,
  gatherMemoryEvidence,
  parseMemoryDocument,
  serializeMemoryDocument,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NOW = "2026-06-20T00:00:00.000Z";

interface Scope {
  store: LibrarianStore;
  dataDir: string;
  runId: string;
}

let s: Scope | null = null;

beforeEach(() => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-apply-"));
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

function seed(over: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  return s!.store.createMemory(
    {
      agent_id: "agent-a",
      title: "title",
      body: "body",
      visibility: "common",
      project_key: "proj-x",
      confidence: "working",
      ...over,
    },
    options,
  ).memory;
}

function context(prepass: ValidationContext["prepass"] = { findings: [] }): ValidationContext {
  const slice = { kind: "common_project" as const, projectKey: "proj-x" };
  return {
    slice,
    memory: gatherMemoryEvidence(createVaultGroomingMemorySource(s!.store), slice, {
      maxMemories: 100,
    }),
    prepass,
  };
}

// The shipped default knob (spec §15.3).
function deps(confidenceThreshold = 0.8) {
  return {
    store: s!.store,
    runId: s!.runId,
    actorId: "system-memory-curator",
    confidenceThreshold,
  };
}

const accept = (targetRequiresApproval = false) =>
  ({ decision: "accept", targetRequiresApproval }) as ValidatedOperation["outcome"];

function ops(...validated: ValidatedOperation[]): ValidatedOperation[] {
  return validated;
}

function recorded() {
  return s!.store.getCurationOperations(s!.runId);
}

describe("applyOperations — auto-apply (confidence at/above the threshold)", () => {
  it("creates a new active memory with curator-note provenance", () => {
    const summary = applyOperations(
      ops({
        operation: {
          type: "create",
          memory: {
            title: "New fact",
            body: "the body",
            visibility: "common",
            project_key: "proj-x",
          },
          rationale: "durable",
          confidence: 0.95,
        },
        outcome: accept(),
      }),
      context(),
      deps(),
    );
    expect(summary.applied).toBe(1);
    const targetId = recorded()[0]!.target_memory_ids[0]!;
    const created = s!.store.getMemory(targetId)!;
    expect(created.status).toBe("active");
    expect(created.title).toBe("New fact");
    expect(created.curator_note?.run_id).toBe(s!.runId);
  });

  // Regression (spec 044 D-5a): the grooming merge path routes through the
  // shared `mergeMemory` store primitive. Its behaviour must be UNCHANGED —
  // create the merged replacement (superseding the sources, carrying the
  // run_id), then archive every source.
  it("merges: creates the replacement and archives the sources atomically", () => {
    const a = seed({ title: "A", body: "same", project_keys: ["alpha", "shared"] });
    const b = seed({ title: "B", body: "same", project_keys: ["shared", "beta"] });
    const summary = applyOperations(
      ops({
        operation: {
          type: "merge",
          source_memory_ids: [a.id, b.id],
          replacement: {
            title: "Merged",
            body: "merged body",
            visibility: "common",
            project_key: "proj-x",
          },
          rationale: "merge dups",
          confidence: 0.95,
        },
        outcome: accept(),
      }),
      context(),
      deps(),
    );
    expect(summary.applied).toBe(1);
    expect(s!.store.getMemory(a.id)?.status).toBe("archived");
    expect(s!.store.getMemory(b.id)?.status).toBe("archived");
    const merged = s!.store.getMemory(recorded()[0]!.target_memory_ids[0]!)!;
    expect(merged.status).toBe("active");
    expect(merged.curator_note?.supersedes).toEqual([a.id, b.id]);
    expect(merged.curator_note?.run_id).toBe(s!.runId); // provenance unchanged by the refactor
    expect(merged.project_keys).toEqual(["alpha", "shared", "beta"]);
  });

  it("applies an at-threshold update in place", () => {
    const m = seed({ title: "Old title" });
    const summary = applyOperations(
      ops({
        operation: {
          type: "update",
          source_memory_id: m.id,
          patch: { title: "New title" },
          rationale: "fix",
          confidence: 0.8, // exactly at the 0.8 knob → apply
        },
        outcome: accept(),
      }),
      context(),
      deps(),
    );
    expect(summary.applied).toBe(1);
    expect(s!.store.getMemory(m.id)?.title).toBe("New title");
  });
});

describe("applyOperations — archive/split ALWAYS propose (D13)", () => {
  it("routes an archive to the flag-review queue — sources flagged, never archived", () => {
    const m = seed();
    const summary = applyOperations(
      ops({
        operation: {
          type: "archive",
          source_memory_ids: [m.id],
          rationale: "dup",
          confidence: 1, // even fully confident, archive never auto-applies
        },
        outcome: accept(),
      }),
      context(),
      deps(),
    );
    expect(summary.proposed).toBe(1);
    expect(summary.applied).toBe(0);
    const after = s!.store.getMemory(m.id)!;
    expect(after.status).toBe("active"); // NOT archived
    expect(after.flags.length).toBe(1); // routed to the review queue
    expect(after.flags[0]?.reason).toContain("curator proposes archive");
    expect(recorded()[0]).toMatchObject({ operation_type: "archive", status: "proposed" });
  });

  it("redacts a secret-shaped rationale in the archive-proposal flag reason", () => {
    const m = seed();
    const kw = "to" + "ken";
    applyOperations(
      ops({
        operation: {
          type: "archive",
          source_memory_ids: [m.id],
          rationale: `${kw} = "leakvalue123"`,
          confidence: 1,
        },
        outcome: accept(),
      }),
      context(),
      deps(),
    );
    const reason = s!.store.getMemory(m.id)!.flags[0]?.reason ?? "";
    expect(reason).not.toContain("leakvalue123");
    expect(reason).toContain("[REDACTED:secret]");
  });

  // Regression (Phase 1 review F2): every groom re-proposed the same archive,
  // stacking duplicate curator flags on the target run after run. An open flag
  // from the curator actor now makes the re-proposal a recorded skip.
  it("a second groom does not duplicate the curator's archive flag", () => {
    const m = seed();
    const archiveOp = (): ValidatedOperation => ({
      operation: {
        type: "archive",
        source_memory_ids: [m.id],
        rationale: "dup",
        confidence: 1,
      },
      outcome: accept(),
    });
    const first = applyOperations(ops(archiveOp()), context(), deps());
    expect(first.proposed).toBe(1);
    expect(s!.store.getMemory(m.id)!.flags.length).toBe(1);

    // Second groom over the same slice — a fresh run, same verdict from the model.
    const secondRun = s!.store.createCurationRun({
      trigger: "manual",
      visibility: "common",
      input_hash: "hash-2",
      project_key: "proj-x",
    });
    const second = applyOperations(ops(archiveOp()), context(), {
      ...deps(),
      runId: secondRun.id,
    });
    expect(second.proposed).toBe(0);
    expect(second.skipped).toBe(1);
    expect(s!.store.getMemory(m.id)!.flags.length).toBe(1); // NOT stacked
    const audit = s!.store.getCurationOperations(secondRun.id)[0]!;
    expect(audit.status).toBe("skipped");
    expect(audit.rationale).toContain("already flagged by curator");
  });

  // The inverse guard: an admin dismissing the flag (resolveFlags empties the
  // doc's flags list) is a human decision, but it does not gag the curator
  // forever — a LATER groom that still believes the memory is stale may flag
  // it afresh (resolved flags are not open flags).
  it("an admin-dismissed (resolved) flag allows a fresh archive flag", () => {
    const m = seed();
    const archiveOp = (): ValidatedOperation => ({
      operation: {
        type: "archive",
        source_memory_ids: [m.id],
        rationale: "stale",
        confidence: 1,
      },
      outcome: accept(),
    });
    applyOperations(ops(archiveOp()), context(), deps());
    s!.store.resolveFlags(m.id, "dashboard-admin"); // admin dismisses the flag
    expect(s!.store.getMemory(m.id)!.flags.length).toBe(0);

    const secondRun = s!.store.createCurationRun({
      trigger: "manual",
      visibility: "common",
      input_hash: "hash-2",
      project_key: "proj-x",
    });
    const second = applyOperations(ops(archiveOp()), context(), {
      ...deps(),
      runId: secondRun.id,
    });
    expect(second.proposed).toBe(1);
    expect(second.skipped).toBe(0);
    expect(s!.store.getMemory(m.id)!.flags.length).toBe(1); // a FRESH flag
  });

  // The split path routes through the shared `splitMemory` store primitive
  // (spec 043 D-B). Under D13 a split is ALWAYS proposed: replacements land at
  // status=proposed and the source stays ACTIVE — the admin archives it after
  // accepting (§11.1).
  it("proposes a split's replacements and leaves the source active, even at confidence 1.0", () => {
    const src = seed({
      title: "Mixed",
      body: "facts about Elaine and Bob",
      project_keys: ["the-librarian"],
    });
    const replacement = (title: string, body: string) => ({
      title,
      body,
      visibility: "common" as const,
      project_key: "proj-x",
    });
    const summary = applyOperations(
      ops({
        operation: {
          type: "split",
          source_memory_id: src.id,
          replacements: [replacement("Elaine", "about Elaine"), replacement("Bob", "about Bob")],
          rationale: "two distinct entities",
          confidence: 1,
        },
        outcome: accept(),
      }),
      context(),
      deps(),
    );
    expect(summary.proposed).toBe(1);
    const targets = recorded().find(
      (operation) => operation.status === "proposed",
    )!.target_memory_ids;
    expect(targets.map((id) => s!.store.getMemory(id)?.project_keys)).toEqual([
      ["the-librarian"],
      ["the-librarian"],
    ]);
    expect(summary.applied).toBe(0);
    expect(s!.store.getMemory(src.id)?.status).toBe("active"); // source NOT archived
    expect(targets.length).toBe(2);
    for (const id of targets) {
      const t = s!.store.getMemory(id)!;
      expect(t.status).toBe("proposed");
      expect(t.curator_note?.supersedes).toEqual([src.id]);
      expect(t.curator_note?.run_id).toBe(s!.runId);
    }
  });
});

describe("applyOperations — requires_approval routing", () => {
  it("routes a requires-approval create to a proposal, not an active memory", () => {
    const summary = applyOperations(
      ops({
        operation: {
          type: "create",
          memory: {
            title: "Identity fact",
            body: "who they are",
            visibility: "common",
            project_key: "proj-x",
          },
          rationale: "identity",
          confidence: 0.95,
        },
        outcome: accept(true),
      }),
      context(),
      deps(),
    );
    expect(summary.proposed).toBe(1);
    expect(summary.applied).toBe(0);
    const proposedOp = recorded().find((o) => o.status === "proposed")!;
    expect(s!.store.getMemory(proposedOp.target_memory_ids[0]!)?.status).toBe("proposed");
  });

  it("never applies an update touching a requires_approval source, even at confidence 1.0", () => {
    const m = seed();
    const summary = applyOperations(
      ops({
        operation: {
          type: "update",
          source_memory_id: m.id,
          patch: { title: "Changed" },
          rationale: "fix",
          confidence: 1,
        },
        outcome: accept(true),
      }),
      context(),
      deps(),
    );
    expect(summary.proposed).toBe(1);
    expect(s!.store.getMemory(m.id)?.title).toBe("title"); // the live doc is untouched
  });
});

describe("applyOperations — protected update reconstruction (data integrity)", () => {
  it("proposes the corrected memory from the authoritative record, preserving untouched fields", () => {
    // Active requires-approval memory with a body longer than the evidence
    // truncation cap, plus tags — both must survive a title-only patch.
    const fullBody = "X".repeat(5000);
    const m = seed({ body: fullBody, tags: ["keep"], project_keys: ["the-librarian"] });

    const summary = applyOperations(
      ops({
        operation: {
          type: "update",
          source_memory_id: m.id,
          patch: { title: "Corrected title" },
          rationale: "fix",
          confidence: 0.95,
        },
        outcome: accept(true),
      }),
      context(),
      deps(),
    );

    expect(summary.proposed).toBe(1);
    const proposalId = recorded().find((o) => o.status === "proposed")!.target_memory_ids[0]!;
    const proposal = s!.store.getMemory(proposalId)!;
    expect(proposal.status).toBe("proposed");
    expect(proposal.title).toBe("Corrected title");
    expect(proposal.body).toBe(fullBody); // full, untruncated, unredacted
    expect(proposal.tags).toContain("keep"); // preserved, not dropped
    expect(proposal.project_keys).toEqual(["the-librarian"]);
    expect(proposal.curator_note?.supersedes).toEqual([m.id]);
  });
});

describe("applyOperations — merge partial failure (no data loss)", () => {
  it("keeps the created replacement and records failed when a source archive throws", () => {
    const created: string[] = [];
    const recordedOps: { status: string }[] = [];
    let archiveCalls = 0;
    const onError = vi.fn();
    const mockStore: ApplyStore = {
      createMemory: () => {
        const id = `mem_new_${created.length}`;
        created.push(id);
        return { memory: { id } };
      },
      updateMemory: () => null,
      archiveMemory: () => {
        archiveCalls++;
        if (archiveCalls === 2) throw new Error("archive boom");
        return null;
      },
      flagMemory: () => null,
      getMemory: () => null,
      // Spec 072 D6's suppression scan. This operation auto-applies, so the scan
      // is never reached — but the mock must satisfy the interface it claims.
      listMemoriesUncapped: () => ({ memories: [] }),
      recordCurationOperation: (op) => {
        recordedOps.push({ status: op.status });
        return op;
      },
    };
    const slice = { kind: "common_project" as const, projectKey: "proj-x" };
    const minimalContext: ValidationContext = {
      slice,
      memory: {
        slice,
        activeMemories: [],
        proposedMemories: [],
        tombstones: [],
        truncatedMemories: false,
        truncatedFields: false,
        redactionCount: 0,
      },
      prepass: { findings: [] },
    };

    const summary = applyOperations(
      ops({
        operation: {
          type: "merge",
          source_memory_ids: ["a", "b"],
          replacement: {
            title: "Merged",
            body: "merged",
            visibility: "common",
            project_key: "proj-x",
          },
          rationale: "merge",
          confidence: 0.95,
        },
        outcome: accept(),
      }),
      minimalContext,
      {
        store: mockStore,
        runId: "run_x",
        actorId: "system-memory-curator",
        confidenceThreshold: 0.8,
        onError,
      },
    );

    expect(summary.failed).toBe(1);
    expect(created).toHaveLength(1); // replacement created → no data loss
    expect(recordedOps[0]?.status).toBe("failed");
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

// T1 (spec 2026-06-20 proposal-review-ux, D2): grooming proposals self-describe
// in curator_note like intake already does — source:"grooming", the op type as
// proposed_action, and a redacted rationale — so the dashboard has ONE read path
// for the action badge / source chip / rationale, and approve can tell a split
// (don't auto-archive) from an update (do). Scoped to the PROPOSE path only; the
// auto-apply path's curator_note shape is unchanged (asserted above).
describe("applyOperations — proposals self-describe their provenance (D2)", () => {
  it("stamps a proposed update with source, proposed_action and the redacted rationale", () => {
    const m = seed({ title: "Old title" });
    applyOperations(
      ops({
        operation: {
          type: "update",
          source_memory_id: m.id,
          patch: { title: "New title" },
          rationale: "tighten the wording",
          confidence: 0.5, // below threshold → propose
        },
        outcome: accept(),
      }),
      context(),
      deps(),
    );
    const proposalId = recorded().find((o) => o.status === "proposed")!.target_memory_ids[0]!;
    const note = s!.store.getMemory(proposalId)!.curator_note!;
    expect(note.source).toBe("grooming");
    expect(note.proposed_action).toBe("update");
    expect(note.rationale).toBe("tighten the wording");
    expect(note.supersedes).toEqual([m.id]);
    expect(note.run_id).toBe(s!.runId); // existing provenance still present
  });

  it("redacts a secret-shaped rationale on a proposed update's curator_note", () => {
    const m = seed({ title: "Old title" });
    const kw = "to" + "ken";
    applyOperations(
      ops({
        operation: {
          type: "update",
          source_memory_id: m.id,
          patch: { title: "New title" },
          rationale: `${kw} = "leakvalue123"`,
          confidence: 0.5,
        },
        outcome: accept(),
      }),
      context(),
      deps(),
    );
    const proposalId = recorded().find((o) => o.status === "proposed")!.target_memory_ids[0]!;
    const rationale = String(s!.store.getMemory(proposalId)!.curator_note!.rationale ?? "");
    expect(rationale).not.toContain("leakvalue123");
    expect(rationale).toContain("[REDACTED:secret]");
  });

  it("stamps a proposed merge replacement with proposed_action merge and the source ids", () => {
    const a = seed({ title: "A", body: "same" });
    const b = seed({ title: "B", body: "same" });
    applyOperations(
      ops({
        operation: {
          type: "merge",
          source_memory_ids: [a.id, b.id],
          replacement: {
            title: "Merged",
            body: "merged body",
            visibility: "common",
            project_key: "proj-x",
          },
          rationale: "same fact stated twice",
          confidence: 0.5, // below threshold → propose (sources stay active)
        },
        outcome: accept(),
      }),
      context(),
      deps(),
    );
    const proposalId = recorded().find((o) => o.status === "proposed")!.target_memory_ids[0]!;
    const note = s!.store.getMemory(proposalId)!.curator_note!;
    expect(note.source).toBe("grooming");
    expect(note.proposed_action).toBe("merge");
    expect(note.rationale).toBe("same fact stated twice");
    expect(note.supersedes).toEqual([a.id, b.id]);
  });

  it("stamps each proposed split replacement with proposed_action split and the source id", () => {
    const src = seed({ title: "Mixed", body: "facts about Elaine and Bob" });
    const replacement = (title: string, body: string) => ({
      title,
      body,
      visibility: "common" as const,
      project_key: "proj-x",
    });
    applyOperations(
      ops({
        operation: {
          type: "split",
          source_memory_id: src.id,
          replacements: [replacement("Elaine", "about Elaine"), replacement("Bob", "about Bob")],
          rationale: "two distinct entities",
          confidence: 1,
        },
        outcome: accept(),
      }),
      context(),
      deps(),
    );
    const targets = recorded().find((o) => o.status === "proposed")!.target_memory_ids;
    expect(targets.length).toBe(2);
    for (const id of targets) {
      const note = s!.store.getMemory(id)!.curator_note!;
      expect(note.source).toBe("grooming");
      expect(note.proposed_action).toBe("split");
      expect(note.rationale).toBe("two distinct entities");
      expect(note.supersedes).toEqual([src.id]);
    }
  });

  it("stamps a proposed create with proposed_action create and no supersedes", () => {
    applyOperations(
      ops({
        operation: {
          type: "create",
          memory: {
            title: "Identity fact",
            body: "who they are",
            visibility: "common",
            project_key: "proj-x",
          },
          rationale: "durable identity fact",
          confidence: 0.95,
        },
        outcome: accept(true), // requires-approval target → propose
      }),
      context(),
      deps(),
    );
    const proposalId = recorded().find((o) => o.status === "proposed")!.target_memory_ids[0]!;
    const note = s!.store.getMemory(proposalId)!.curator_note!;
    expect(note.source).toBe("grooming");
    expect(note.proposed_action).toBe("create");
    expect(note.rationale).toBe("durable identity fact");
    expect(note.supersedes).toBeUndefined();
  });

  it("leaves the auto-apply path's curator_note free of a proposed_action", () => {
    const m = seed({ title: "Old title" });
    applyOperations(
      ops({
        operation: {
          type: "update",
          source_memory_id: m.id,
          patch: { title: "New title" },
          rationale: "fix",
          confidence: 0.95, // above threshold → auto-apply, not propose
        },
        outcome: accept(),
      }),
      context(),
      deps(),
    );
    // The applied update mutates the source in place — no new proposal doc, and
    // the source's own curator_note is untouched (no proposed_action stamped).
    const after = s!.store.getMemory(m.id)!;
    expect(after.curator_note?.proposed_action).toBeUndefined();
  });

  it("round-trips the new provenance fields through the markdown document", () => {
    const note = {
      source: "grooming",
      proposed_action: "update",
      rationale: "tighten the wording",
      run_id: "run_1",
      supersedes: ["mem_src"],
    };
    const p = parseMemoryDocument(
      serializeMemoryDocument({
        id: "mem_p",
        agent_id: "system-memory-curator",
        status: "proposed",
        tags: [],
        applies_to: [],
        supersedes: [],
        conflicts_with: [],
        flags: [],
        title: "T",
        body: "B",
        confidence: "working",
        created_at: NOW,
        updated_at: NOW,
        curator_note: note,
        is_global: false,
        requires_approval: true,
      }),
    );
    expect(p.curator_note).toEqual(note);
  });
});

describe("applyOperations — skips, rejects and below-threshold proposals", () => {
  it("records a rejected operation as skipped without mutating", () => {
    const m = seed();
    const summary = applyOperations(
      ops({
        operation: { type: "archive", source_memory_ids: [m.id], rationale: "x", confidence: 0.9 },
        outcome: { decision: "reject", reason: "references a memory not in the evidence" },
      }),
      context(),
      deps(),
    );
    expect(summary.skipped).toBe(1);
    expect(s!.store.getMemory(m.id)?.status).toBe("active");
    expect(recorded()[0]?.status).toBe("skipped");
  });

  it("skips a noop (nothing to apply or propose)", () => {
    const summary = applyOperations(
      ops({
        operation: { type: "noop", source_memory_ids: [], rationale: "x", confidence: 1 },
        outcome: accept(),
      }),
      context(),
      deps(),
    );
    expect(summary.skipped).toBe(1);
    expect(recorded()[0]).toMatchObject({ operation_type: "noop", status: "skipped" });
  });

  it("proposes (never applies, never silently skips) a below-threshold update", () => {
    const m = seed();
    const summary = applyOperations(
      ops({
        operation: {
          type: "update",
          source_memory_id: m.id,
          patch: { title: "Maybe" },
          rationale: "x",
          confidence: 0.5,
        },
        outcome: accept(),
      }),
      context(),
      deps(),
    );
    expect(summary.proposed).toBe(1);
    expect(s!.store.getMemory(m.id)?.title).toBe("title"); // live doc untouched
    expect(recorded()[0]?.status).toBe("proposed");
  });
});
