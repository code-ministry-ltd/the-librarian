// Intake apply step (spec 035 §F5 + rethink D13). Routes a parsed judgment
// through the ONE apply rule (decideApplication) and pins the verdict × action
// → store mutation mapping, the no-clobber guard on augment, and that a store
// rejection becomes a `rejected` outcome rather than a throw.

import { type IntakeJudgment, type IntakeApplyStore, applyIntakeJudgment } from "@librarian/core";
import { describe, expect, it } from "vitest";

interface SeedDoc {
  title: string;
  body: string;
  requires_approval?: boolean;
  flags?: { agent_id: string }[];
  project_keys?: string[];
}

function fakeStore(seed: Record<string, SeedDoc> = {}) {
  const docs = new Map(Object.entries(seed));
  const calls = {
    create: [] as { input: Record<string, unknown>; options?: Record<string, unknown> }[],
    update: [] as { id: string; patch?: Record<string, unknown> }[],
    archive: [] as string[],
    flag: [] as { id: string; reason: string; agent_id?: string }[],
  };
  let n = 0;
  const store: IntakeApplyStore = {
    createMemory: (input, options) => {
      const id = `mem_new_${n++}`;
      calls.create.push({ input, ...(options ? { options } : {}) });
      docs.set(id, {
        title: String(input.title ?? ""),
        body: String(input.body ?? ""),
        ...(Array.isArray(input.project_keys)
          ? { project_keys: input.project_keys as string[] }
          : {}),
      });
      return { memory: { id } };
    },
    updateMemory: (id, patch) => {
      calls.update.push({ id, ...(patch ? { patch } : {}) });
      const d = docs.get(id);
      if (d) docs.set(id, { ...d, ...(patch as Partial<typeof d>) });
      return null;
    },
    archiveMemory: (id) => {
      calls.archive.push(id);
      return null;
    },
    flagMemory: (id, reason, agent_id) => {
      calls.flag.push({ id, reason, ...(agent_id ? { agent_id } : {}) });
      const d = docs.get(id);
      if (d) docs.set(id, { ...d, flags: [...(d.flags ?? []), { agent_id: agent_id ?? "?" }] });
      return null;
    },
    getMemory: (id) => docs.get(id) ?? null,
  };
  return { store, calls, docs };
}

// Confidence 0.9 sits above the default 0.8 threshold → an "apply" verdict for
// create/augment/supersede unless a guard reroutes it.
function judgment(j: Partial<IntakeJudgment> & { action: string }): IntakeJudgment {
  return { rationale: "r", confidence: 0.9, ...j } as IntakeJudgment;
}

const deps = (store: IntakeApplyStore, submissionText = "A new fact about Elaine.") => ({
  store,
  submissionText,
  actorId: "system-consolidator",
});

describe("applyIntakeJudgment — apply lane (confidence at/above the threshold)", () => {
  it("noop → skipped, nothing touched", () => {
    const { store, calls } = fakeStore();
    expect(applyIntakeJudgment(judgment({ action: "noop", confidence: 1 }), deps(store))).toEqual({
      kind: "skipped",
    });
    expect(calls.create.length + calls.update.length + calls.archive.length).toBe(0);
  });

  it("create → createMemory with the judged title/body/tags", () => {
    const { store, calls } = fakeStore();
    const out = applyIntakeJudgment(
      judgment({ action: "create", title: "Elaine", body: "Lives in Paris.", tags: ["person"] }),
      deps(store),
    );
    expect(out).toMatchObject({ kind: "created" });
    expect(calls.create[0]?.input).toMatchObject({
      title: "Elaine",
      body: "Lives in Paris.",
      tags: ["person"],
      agent_id: "system-consolidator",
    });
  });

  it("augment → updateMemory with an appended body that preserves the original", () => {
    const { store, calls } = fakeStore({
      mem_elaine: { title: "Elaine", body: "Lives in Paris." },
    });
    const out = applyIntakeJudgment(
      judgment({ action: "augment", target_id: "mem_elaine", addition: "Now works at [[Acme]]." }),
      deps(store),
    );
    expect(out).toEqual({ kind: "augmented", id: "mem_elaine" });
    const body = String(calls.update[0]?.patch?.body ?? "");
    expect(body.startsWith("Lives in Paris.")).toBe(true); // no-clobber
    expect(body).toContain("[[Acme]]");
  });

  it("augment with a missing target → rejected", () => {
    const { store } = fakeStore();
    expect(
      applyIntakeJudgment(
        judgment({ action: "augment", target_id: "ghost", addition: "x" }),
        deps(store),
      ),
    ).toEqual({ kind: "rejected", reason: "augment target missing" });
  });

  it("supersede → updateMemory replacing title + body", () => {
    const { store, calls } = fakeStore({
      mem_elaine: { title: "Elaine", body: "Works at Globex." },
    });
    const out = applyIntakeJudgment(
      judgment({
        action: "supersede",
        target_id: "mem_elaine",
        title: "Elaine",
        body: "Works at Acme (was Globex).",
      }),
      deps(store),
    );
    expect(out).toEqual({ kind: "superseded", id: "mem_elaine" });
    expect(calls.update[0]?.patch).toMatchObject({
      title: "Elaine",
      body: "Works at Acme (was Globex).",
    });
  });

  it("an explicit confidenceThreshold overrides the 0.8 default", () => {
    const { store } = fakeStore({ mem_elaine: { title: "Elaine", body: "x" } });
    // 0.9 clears the default but NOT a stricter 0.95 knob → proposed.
    const out = applyIntakeJudgment(
      judgment({ action: "augment", target_id: "mem_elaine", addition: "y" }),
      { ...deps(store), confidenceThreshold: 0.95 },
    );
    expect(out).toMatchObject({ kind: "proposed" });
  });

  it("redacts a secret-shaped rationale before persisting it (parity with the curator)", () => {
    const { store, calls } = fakeStore();
    // Assemble the keyword at runtime so no literal secret-assignment sits in source.
    const kw = "to" + "ken";
    applyIntakeJudgment(
      judgment({
        action: "create",
        title: "t",
        body: "b",
        tags: [],
        rationale: `${kw} = "leakvalue123"`,
      }),
      deps(store),
    );
    const note = calls.create[0]?.options?.curator_note as { rationale?: string };
    expect(note.rationale).not.toContain("leakvalue123");
    expect(note.rationale).toContain("[REDACTED:secret]");
  });

  it("create inherits the submitter's owner but keeps the judge's tags", () => {
    const { store, calls } = fakeStore();
    applyIntakeJudgment(judgment({ action: "create", title: "T", body: "B", tags: ["judged"] }), {
      store,
      submissionText: "x",
      actorId: "system-consolidator",
      submissionHints: {
        agentId: "agent-a",
        tags: ["ignored"],
        projectKeys: ["the-librarian"],
      },
    });
    expect(calls.create[0]?.input).toMatchObject({
      agent_id: "agent-a",
      tags: ["judged"], // the judge curated these; the submission's tags don't override
      project_keys: ["the-librarian"],
    });
  });

  it("an augment ignores submissionHints — it edits the target's body only", () => {
    const { store, calls } = fakeStore({
      mem_elaine: { title: "Elaine", body: "Lives in Paris." },
    });
    applyIntakeJudgment(
      judgment({ action: "augment", target_id: "mem_elaine", addition: "moved" }),
      {
        store,
        submissionText: "x",
        actorId: "system-consolidator",
        submissionHints: { agentId: "agent-a", projectKeys: ["other-project"] },
      },
    );
    expect(Object.keys(calls.update[0]?.patch ?? {})).toEqual(["body"]); // no agent_id
  });

  it("a proposed split inherits the source project keys", () => {
    const { store, calls } = fakeStore({
      mem_mixed: { title: "Mixed", body: "Two facts", project_keys: ["the-librarian"] },
    });
    const out = applyIntakeJudgment(
      judgment({
        action: "split",
        target_id: "mem_mixed",
        replacements: [
          { title: "A", body: "A fact", tags: [] },
          { title: "B", body: "B fact", tags: [] },
        ],
      }),
      deps(store),
    );
    expect(out).toMatchObject({ kind: "proposed" });
    expect(calls.create.map((call) => call.input.project_keys)).toEqual([
      ["the-librarian"],
      ["the-librarian"],
    ]);
  });

  it("a store rejection (e.g. protected target) becomes a rejected outcome, not a throw", () => {
    const { store } = fakeStore({ mem_p: { title: "P", body: "x" } });
    store.updateMemory = () => {
      throw new Error("Protected memories must be changed through a proposal workflow.");
    };
    const out = applyIntakeJudgment(
      judgment({ action: "augment", target_id: "mem_p", addition: "y" }),
      deps(store),
    );
    expect(out.kind).toBe("rejected");
    expect(out).toMatchObject({ reason: expect.stringContaining("Protected") });
  });
});

describe("applyIntakeJudgment — propose lane (below threshold / guarded)", () => {
  it("a below-threshold judgment files the SUBMISSION as a proposed doc, target untouched", () => {
    const { store, calls } = fakeStore({ mem_elaine: { title: "Elaine", body: "x" } });
    const out = applyIntakeJudgment(
      judgment({
        action: "supersede",
        target_id: "mem_elaine",
        title: "t",
        body: "b",
        confidence: 0.7,
      }),
      deps(store, "Possibly Elaine changed jobs."),
    );
    expect(out).toMatchObject({ kind: "proposed" });
    expect(calls.create[0]?.input).toMatchObject({ body: "Possibly Elaine changed jobs." });
    expect(calls.create[0]?.options?.curator_note).toMatchObject({ proposed_action: "supersede" });
    // The load-bearing bit: requires_approval is what lands it at status=proposed
    // (awaiting human review) instead of live/active recall.
    expect(calls.create[0]?.options?.requires_approval).toBe(true);
    expect(calls.update.length).toBe(0);
  });

  it("a low-confidence augment proposes the raw submission rather than touching the target (S12)", () => {
    const { store, calls } = fakeStore({
      mem_elaine: { title: "Elaine", body: "Lives in Paris." },
    });
    const out = applyIntakeJudgment(
      judgment({ action: "augment", target_id: "mem_elaine", addition: "unused", confidence: 0.5 }),
      deps(store, "Elaine moved to Berlin.\nMore detail."),
    );
    expect(out).toMatchObject({ kind: "proposed" });
    expect(calls.create[0]?.input).toMatchObject({
      title: "Elaine moved to Berlin.",
      body: "Elaine moved to Berlin.\nMore detail.",
    });
    // The target was NOT touched.
    expect(calls.update.length).toBe(0);
  });

  it("a low-confidence create proposes too (D13: no confidence-free create lane)", () => {
    const { store, calls } = fakeStore();
    const out = applyIntakeJudgment(
      judgment({ action: "create", title: "T", body: "B", tags: [], confidence: 0.4 }),
      deps(store, "A tentative fact."),
    );
    expect(out).toMatchObject({ kind: "proposed" });
    expect(calls.create[0]?.options?.requires_approval).toBe(true);
    expect(calls.create[0]?.options?.curator_note).toMatchObject({ proposed_action: "create" });
  });

  // Phase 1 review F3: an intake archive rides the flag-review queue (mirroring
  // grooming, D13/D4) — it FLAGS the judged target so the admin sees an
  // actionable review item, instead of filing the raw submission as a proposed
  // doc that points at nothing.
  it("archive ALWAYS proposes — even at confidence 1.0 — by flagging the TARGET, never archiving", () => {
    const { store, calls } = fakeStore({ mem_old: { title: "Old", body: "Stale." } });
    const out = applyIntakeJudgment(
      judgment({ action: "archive", target_id: "mem_old", confidence: 1 }),
      deps(store, "The standup doc is stale."),
    );
    expect(out).toEqual({ kind: "flagged_for_archive", id: "mem_old" });
    expect(calls.archive.length).toBe(0); // never archives live content
    expect(calls.create.length).toBe(0); // no proposed doc filed from the submission
    expect(calls.flag[0]).toMatchObject({
      id: "mem_old",
      agent_id: "system-consolidator",
    });
    expect(calls.flag[0]?.reason).toContain("curator proposes archive:");
  });

  it("redacts a secret-shaped rationale in the archive flag reason", () => {
    const { store, calls } = fakeStore({ mem_old: { title: "Old", body: "Stale." } });
    const kw = "to" + "ken";
    applyIntakeJudgment(
      judgment({
        action: "archive",
        target_id: "mem_old",
        confidence: 1,
        rationale: `${kw} = "leakvalue123"`,
      }),
      deps(store),
    );
    const reason = calls.flag[0]?.reason ?? "";
    expect(reason).not.toContain("leakvalue123");
    expect(reason).toContain("[REDACTED:secret]");
  });

  it("does not stack a second flag when the curator already has one open on the target", () => {
    const { store, calls } = fakeStore({
      mem_old: { title: "Old", body: "Stale.", flags: [{ agent_id: "system-consolidator" }] },
    });
    const out = applyIntakeJudgment(
      judgment({ action: "archive", target_id: "mem_old", confidence: 1 }),
      deps(store),
    );
    expect(out).toEqual({ kind: "skipped" });
    expect(calls.flag.length).toBe(0); // no duplicate flag
  });

  it("another agent's open flag does not block the curator's own archive flag", () => {
    const { store, calls } = fakeStore({
      mem_old: { title: "Old", body: "Stale.", flags: [{ agent_id: "codex" }] },
    });
    const out = applyIntakeJudgment(
      judgment({ action: "archive", target_id: "mem_old", confidence: 1 }),
      deps(store),
    );
    expect(out).toEqual({ kind: "flagged_for_archive", id: "mem_old" });
    expect(calls.flag.length).toBe(1);
  });

  it("an archive whose target is missing from the store → rejected (fail-soft, never throws)", () => {
    const { store, calls } = fakeStore(); // no mem_old
    const out = applyIntakeJudgment(
      judgment({ action: "archive", target_id: "mem_ghost", confidence: 1 }),
      deps(store),
    );
    expect(out).toEqual({ kind: "rejected", reason: "archive target missing" });
    expect(calls.flag.length + calls.create.length + calls.archive.length).toBe(0);
  });

  it("a requires_approval target proposes regardless of confidence (D13)", () => {
    const { store, calls } = fakeStore({
      mem_p: { title: "P", body: "x", requires_approval: true },
    });
    const out = applyIntakeJudgment(
      judgment({ action: "augment", target_id: "mem_p", addition: "y", confidence: 1 }),
      deps(store),
    );
    expect(out).toMatchObject({ kind: "proposed" });
    expect(calls.update.length).toBe(0);
    expect(calls.create[0]?.options?.curator_note).toMatchObject({ proposed_action: "augment" });
  });

  it("the proposed doc inherits the submitter's owner from submissionHints", () => {
    const { store, calls } = fakeStore();
    applyIntakeJudgment(
      judgment({ action: "augment", target_id: "x", addition: "a", confidence: 0.5 }),
      {
        store,
        submissionText: "A fact.",
        actorId: "system-consolidator",
        submissionHints: {
          agentId: "agent-a",
          tags: ["t1"],
          appliesTo: ["Elaine"],
        },
      },
    );
    expect(calls.create[0]?.input).toMatchObject({
      agent_id: "agent-a",
      tags: ["t1"],
      applies_to: ["Elaine"], // the caller's targeting signal the judge can't re-derive
    });
  });
});

// Proposal-review rework F1 (spec 2026-07-01, D1/D10): the propose path persists
// the judge's full PLAN in curator_note — new additive keys, never `supersedes` —
// so the dashboard can show what the curator wanted to do and offer to execute it.
describe("applyIntakeJudgment — propose lane persists the judge's plan (D1)", () => {
  it("a proposed augment carries guessed_target_id + planned_addition + confidence, never supersedes", () => {
    const { store, calls } = fakeStore({ mem_elaine: { title: "Elaine", body: "x" } });
    applyIntakeJudgment(
      judgment({
        action: "augment",
        target_id: "mem_elaine",
        addition: "Now works at [[Acme]].",
        confidence: 0.6,
      }),
      deps(store),
    );
    const note = calls.create[0]?.options?.curator_note as Record<string, unknown>;
    expect(note).toMatchObject({
      proposed_action: "augment",
      guessed_target_id: "mem_elaine",
      planned_addition: "Now works at [[Acme]].",
      confidence: 0.6,
    });
    // D10: the guess is NOT a resolved target — badge/archive semantics untouched.
    expect(note.supersedes).toBeUndefined();
  });

  it("a proposed supersede carries guessed_target_id + planned_title/planned_body + confidence", () => {
    const { store, calls } = fakeStore({ mem_elaine: { title: "Elaine", body: "x" } });
    applyIntakeJudgment(
      judgment({
        action: "supersede",
        target_id: "mem_elaine",
        title: "Elaine — updated",
        body: "Works at Globex now.",
        confidence: 0.7,
      }),
      deps(store),
    );
    const note = calls.create[0]?.options?.curator_note as Record<string, unknown>;
    expect(note).toMatchObject({
      proposed_action: "supersede",
      guessed_target_id: "mem_elaine",
      planned_title: "Elaine — updated",
      planned_body: "Works at Globex now.",
      confidence: 0.7,
    });
    expect(note.supersedes).toBeUndefined();
  });

  it("a proposed create carries planned_title/planned_body/planned_tags + confidence, no guessed target", () => {
    const { store, calls } = fakeStore();
    applyIntakeJudgment(
      judgment({
        action: "create",
        title: "Elaine",
        body: "Lives in Paris.",
        tags: ["person"],
        confidence: 0.4,
      }),
      deps(store),
    );
    const note = calls.create[0]?.options?.curator_note as Record<string, unknown>;
    expect(note).toMatchObject({
      proposed_action: "create",
      planned_title: "Elaine",
      planned_body: "Lives in Paris.",
      planned_tags: ["person"],
      confidence: 0.4,
    });
    expect(note.guessed_target_id).toBeUndefined();
  });

  it("planned text rides the same redaction as rationale (untrusted model output)", () => {
    // Zero-entropy synthetic token (repeated X) — keeps GitGuardian quiet while
    // still matching the sk- provider-key redaction rule.
    const syntheticKey = `sk-${"X".repeat(24)}`;
    const { store, calls } = fakeStore({ mem_cfg: { title: "Config", body: "x" } });
    applyIntakeJudgment(
      judgment({
        action: "augment",
        target_id: "mem_cfg",
        addition: `Set the key ${syntheticKey} in the env.`,
        confidence: 0.5,
      }),
      deps(store),
    );
    const note = calls.create[0]?.options?.curator_note as Record<string, unknown>;
    expect(String(note.planned_addition)).not.toContain(syntheticKey);
    expect(String(note.planned_addition)).toContain("[REDACTED");
  });

  it("a forced proposal above the threshold still carries the plan", () => {
    const { store, calls } = fakeStore({ mem_elaine: { title: "Elaine", body: "x" } });
    applyIntakeJudgment(
      judgment({ action: "augment", target_id: "mem_elaine", addition: "a", confidence: 0.95 }),
      { ...deps(store), forceProposal: true },
    );
    const note = calls.create[0]?.options?.curator_note as Record<string, unknown>;
    expect(note).toMatchObject({ guessed_target_id: "mem_elaine", planned_addition: "a" });
  });
});

describe("applyIntakeJudgment — intake split (always proposed, never auto-applied)", () => {
  const splitJudgment = {
    action: "split" as const,
    target_id: "mem_overloaded",
    replacements: [
      { title: "Elaine", body: "About Elaine.", tags: ["person"] },
      { title: "Bob", body: "About Bob.", tags: [] },
    ],
  };

  it("routes a split to PROPOSED replacements (requires_approval), source left active", () => {
    const { store, calls } = fakeStore({
      mem_overloaded: { title: "Elaine and Bob", body: "mixed" },
    });
    const out = applyIntakeJudgment(judgment(splitJudgment), deps(store));
    expect(out.kind).toBe("proposed");
    // Two replacement docs were created, each requiring approval (status=proposed).
    expect(calls.create.length).toBe(2);
    for (const c of calls.create) {
      expect(c.options?.requires_approval).toBe(true);
      expect(c.options?.curator_note).toMatchObject({ proposed_action: "split" });
      expect((c.options?.curator_note as { supersedes?: string[] }).supersedes).toEqual([
        "mem_overloaded",
      ]);
    }
    // The source candidate is NOT archived — a human archives it after accepting.
    expect(calls.archive.length).toBe(0);
  });

  it("never auto-applies a split, even at confidence 1.0", () => {
    const { store, calls } = fakeStore({
      mem_overloaded: { title: "Elaine and Bob", body: "mixed" },
    });
    const out = applyIntakeJudgment(judgment({ ...splitJudgment, confidence: 1 }), deps(store));
    expect(out.kind).toBe("proposed");
    expect(calls.archive.length).toBe(0); // never mutates the live source
    for (const c of calls.create) expect(c.options?.requires_approval).toBe(true);
  });

  it("rejects a split whose target is missing from the store (target ∈ candidates guard)", () => {
    const { store, calls } = fakeStore(); // no mem_overloaded
    const out = applyIntakeJudgment(judgment(splitJudgment), deps(store));
    expect(out).toEqual({ kind: "rejected", reason: "split target missing" });
    expect(calls.create.length).toBe(0);
    expect(calls.archive.length).toBe(0);
  });

  it("the split's proposed replacements carry the judge's title/body/tags + submitter scope", () => {
    const { store, calls } = fakeStore({
      mem_overloaded: { title: "Elaine and Bob", body: "mixed" },
    });
    applyIntakeJudgment(judgment(splitJudgment), {
      store,
      submissionText: "x",
      actorId: "system-consolidator",
      submissionHints: { agentId: "agent-a" },
    });
    expect(calls.create[0]?.input).toMatchObject({
      title: "Elaine",
      body: "About Elaine.",
      tags: ["person"],
      agent_id: "agent-a",
    });
  });

  it("redacts a secret-shaped rationale on the split's proposed replacements", () => {
    const { store, calls } = fakeStore({
      mem_overloaded: { title: "Elaine and Bob", body: "mixed" },
    });
    const kw = "to" + "ken";
    applyIntakeJudgment(
      judgment({ ...splitJudgment, rationale: `${kw} = "leakvalue123"` }),
      deps(store),
    );
    const note = calls.create[0]?.options?.curator_note as { rationale?: string };
    expect(note.rationale).not.toContain("leakvalue123");
    expect(note.rationale).toContain("[REDACTED:secret]");
  });
});

// ── Force-proposal routing (ADR 0004 → D13's upstream override) ──────────────
//
// When the submission itself demands review (the `forceProposal` hint), NO op
// auto-applies: the unified decision function proposes everything but a noop
// (which stays skipped). Without the hint (the default) the threshold rules
// apply as normal.
describe("applyIntakeJudgment — forceProposal routing (ADR 0004)", () => {
  const forceDeps = (store: IntakeApplyStore, submissionText = "Elaine moved to Berlin.") => ({
    store,
    submissionText,
    actorId: "system-consolidator",
    forceProposal: true,
  });

  it("a confident create → PROPOSED (not created)", () => {
    const { store, calls } = fakeStore();
    const out = applyIntakeJudgment(
      judgment({ action: "create", title: "Elaine", body: "Lives in Berlin.", tags: [] }),
      forceDeps(store),
    );
    expect(out).toMatchObject({ kind: "proposed" }); // NOT "created"
    expect(calls.create[0]?.options?.requires_approval).toBe(true);
    expect(calls.create[0]?.options?.curator_note).toMatchObject({ proposed_action: "create" });
    // The submission is filed as-is (the judge's curated title/body are dropped on
    // the propose lane — a human decides from the raw submission).
    expect(calls.create[0]?.input).toMatchObject({ body: "Elaine moved to Berlin." });
  });

  it("a confident augment → PROPOSED (target untouched)", () => {
    const { store, calls } = fakeStore({
      mem_elaine: { title: "Elaine", body: "Lives in Paris." },
    });
    const out = applyIntakeJudgment(
      judgment({ action: "augment", target_id: "mem_elaine", addition: "moved" }),
      forceDeps(store),
    );
    expect(out).toMatchObject({ kind: "proposed" });
    expect(calls.update.length).toBe(0); // the existing doc is NOT mutated
    expect(calls.create[0]?.options?.curator_note).toMatchObject({ proposed_action: "augment" });
  });

  it("a confident supersede → PROPOSED (target untouched)", () => {
    const { store, calls } = fakeStore({
      mem_elaine: { title: "Elaine", body: "Works at Globex." },
    });
    const out = applyIntakeJudgment(
      judgment({ action: "supersede", target_id: "mem_elaine", title: "t", body: "b" }),
      forceDeps(store),
    );
    expect(out).toMatchObject({ kind: "proposed" });
    expect(calls.update.length).toBe(0);
    expect(calls.create[0]?.options?.curator_note).toMatchObject({ proposed_action: "supersede" });
  });

  it("archive stays a flag-routed proposal (never archived) under the hint too", () => {
    const { store, calls } = fakeStore({ mem_old: { title: "Old", body: "Stale." } });
    const out = applyIntakeJudgment(
      judgment({ action: "archive", target_id: "mem_old", confidence: 1 }),
      forceDeps(store),
    );
    expect(out).toEqual({ kind: "flagged_for_archive", id: "mem_old" });
    expect(calls.archive.length).toBe(0);
    expect(calls.flag[0]?.reason).toContain("curator proposes archive:");
  });

  it("split stays PROPOSED", () => {
    const { store, calls } = fakeStore({ mem_overloaded: { title: "A and B", body: "mixed" } });
    const out = applyIntakeJudgment(
      judgment({
        action: "split",
        target_id: "mem_overloaded",
        replacements: [
          { title: "A", body: "about a", tags: [] },
          { title: "B", body: "about b", tags: [] },
        ],
      }),
      forceDeps(store),
    );
    expect(out).toMatchObject({ kind: "proposed" });
    expect(calls.archive.length).toBe(0); // source stays active (a proposed split)
    expect(calls.create[0]?.options?.curator_note).toMatchObject({ proposed_action: "split" });
  });

  it("noop stays skipped (nothing proposed)", () => {
    const { store, calls } = fakeStore();
    expect(applyIntakeJudgment(judgment({ action: "noop" }), forceDeps(store))).toEqual({
      kind: "skipped",
    });
    expect(calls.create.length).toBe(0);
  });

  it("even at confidence 1.0 a force-proposed create never auto-applies (defence-in-depth)", () => {
    const { store, calls } = fakeStore();
    const out = applyIntakeJudgment(
      judgment({ action: "create", title: "T", body: "B", tags: [], confidence: 1 }),
      forceDeps(store),
    );
    expect(out).toMatchObject({ kind: "proposed" });
    expect(calls.create[0]?.options?.requires_approval).toBe(true);
  });

  it("default (forceProposal absent): a confident create still applies", () => {
    const { store } = fakeStore();
    const created = applyIntakeJudgment(
      judgment({ action: "create", title: "Elaine", body: "Lives in Paris.", tags: [] }),
      deps(store),
    );
    expect(created).toMatchObject({ kind: "created" });
  });
});
