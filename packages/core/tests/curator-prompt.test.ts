// The unified curator prompt (rethink T8, spec §5.3). ONE system-prompt core
// shared by both curator invocations — intake (one submission + navigate
// evidence) and grooming (a corpus slice) — with mode sections on top. The
// output-contract assertions are DERIVED from the parse schemas
// (IntakeJudgmentSchema / GroomingOperationSchema), so the prompt can never
// teach a wire shape the parser rejects without a test failing here.

import {
  type IntakeCandidates,
  type Memory,
  type MemoryEvidenceBundle,
  type PrepassResult,
  CURATOR_PROMPT_VERSION,
  GroomingOperationSchema,
  IntakeJudgmentSchema,
  buildBaseCuratorPrompt,
  buildCuratorPrompt,
} from "@librarian/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// ── fixtures ─────────────────────────────────────────────────────────────────

function mem(over: Partial<Memory> & { id: string }): Memory {
  return {
    agent_id: "agent-a",
    title: `title ${over.id}`,
    body: "body",
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

const intakeEvidence: IntakeCandidates = {
  candidates: [mem({ id: "mem_elaine", title: "Elaine", body: "Elaine lives in Paris." })],
  toc: [{ id: "mem_elaine", title: "Elaine", tags: ["person"] }],
};

function memBundle(parts: Partial<MemoryEvidenceBundle> = {}): MemoryEvidenceBundle {
  return {
    slice: { kind: "common_global" },
    activeMemories: [],
    proposedMemories: [],
    tombstones: [],
    truncatedMemories: false,
    truncatedFields: false,
    redactionCount: 0,
    ...parts,
  };
}

const noPrepass: PrepassResult = { findings: [] };

function activeMem(
  id: string,
  title: string,
  body: string,
): MemoryEvidenceBundle["activeMemories"][number] {
  return {
    id,
    title,
    body,
    agentId: null,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    requiresApproval: false,
    isGlobal: false,
  };
}

function intakePrompt(addendum?: string) {
  return buildCuratorPrompt({
    mode: "intake",
    submissionText: "Elaine moved to Berlin",
    evidence: intakeEvidence,
    ...(addendum !== undefined ? { promptAddendum: addendum } : {}),
  });
}

function groomingPrompt(addendum?: string) {
  return buildCuratorPrompt({
    mode: "grooming",
    memory: memBundle(),
    prepass: noPrepass,
    ...(addendum !== undefined ? { promptAddendum: addendum } : {}),
  });
}

const intakeSystem = intakePrompt()[0]!.content;
const groomingSystem = groomingPrompt()[0]!.content;

// The discriminator value + the wire field names of one schema option.
function wireShape(option: z.ZodObject, discriminator: string) {
  const shape = option.shape as Record<string, z.ZodType>;
  const literal = shape[discriminator] as z.ZodLiteral<string>;
  return { value: literal.value, keys: Object.keys(shape) };
}

// ── shared core ───────────────────────────────────────────────────────────────

describe("buildBaseCuratorPrompt — read-only base prompt", () => {
  it("matches the system message buildCuratorPrompt sends (no addendum, no evidence)", () => {
    expect(buildBaseCuratorPrompt("intake")).toBe(intakeSystem);
    expect(buildBaseCuratorPrompt("grooming")).toBe(groomingSystem);
  });

  it("carries no operator-addendum framing and differs by mode", () => {
    for (const mode of ["intake", "grooming"] as const) {
      expect(buildBaseCuratorPrompt(mode).length).toBeGreaterThan(100);
      expect(buildBaseCuratorPrompt(mode)).not.toMatch(/OPERATOR GUIDANCE/i);
    }
    expect(buildBaseCuratorPrompt("intake")).not.toBe(buildBaseCuratorPrompt("grooming"));
  });
});

describe("buildCuratorPrompt — shared core", () => {
  it("emits a system message then a user message in both modes", () => {
    for (const messages of [intakePrompt(), groomingPrompt()]) {
      expect(messages).toHaveLength(2);
      expect(messages[0]!.role).toBe("system");
      expect(messages[1]!.role).toBe("user");
    }
  });

  it("both modes share ONE identical core before the mode section (single prompt source)", () => {
    const coreOf = (system: string) => system.split("MODE:")[0]!;
    expect(coreOf(intakeSystem)).toBe(coreOf(groomingSystem));
    // The shared part is the substance (role + principles), not a token header.
    expect(coreOf(intakeSystem).length).toBeGreaterThan(1000);
  });

  it("carries the hard-won v4 curation principles in BOTH modes", () => {
    for (const system of [intakeSystem, groomingSystem]) {
      const lower = system.toLowerCase();
      expect(lower).toContain("preserve"); // preserve, don't destroy
      expect(lower).toContain("score low"); // calibrate confidence on ambiguity
      expect(lower).toContain("cautiously"); // resolve entities cautiously
      expect(lower).toContain("retrieval"); // file for retrieval, not just storage
      expect(lower).toContain("[[wikilink"); // the knowledge-graph mechanism
      expect(lower).toContain("also its filename"); // title-craft (title == filename)
      expect(lower).toContain("transient or low-value"); // discard obvious noise
      expect(lower).toContain("do not split"); // anti-over-fragmentation gate
    }
  });

  it("teaches the ONE D13 apply rule: threshold gate + archive/split always propose", () => {
    for (const system of [intakeSystem, groomingSystem]) {
      const lower = system.toLowerCase();
      expect(lower).toContain("threshold");
      expect(lower).toContain("proposal");
      expect(lower).toMatch(/archive and split[^.]*always/i);
    }
  });

  it("frames the user-message data sections as untrusted, in both modes", () => {
    for (const system of [intakeSystem, groomingSystem]) {
      expect(system).toMatch(/untrusted DATA/);
      expect(system).toMatch(/NOT instructions/);
    }
  });

  it("pins the v6.0 prompt version (v6.0 makes grooming correct flagged memories, ADR 0013)", () => {
    expect(CURATOR_PROMPT_VERSION).toBe("v6.0");
  });
});

// ── intake mode ───────────────────────────────────────────────────────────────

describe("buildCuratorPrompt — intake mode", () => {
  it("teaches exactly the wire shapes IntakeJudgmentSchema parses (derived, not string-twinned)", () => {
    for (const option of IntakeJudgmentSchema.options) {
      const { value, keys } = wireShape(option, "action");
      expect(intakeSystem).toContain(`"action": "${value}"`);
      for (const key of keys) expect(intakeSystem).toContain(`"${key}"`);
    }
  });

  it("does not teach grooming wire shapes (the parser would reject them)", () => {
    expect(intakeSystem).not.toContain('"type"');
    expect(intakeSystem).not.toContain('"operations"');
    expect(intakeSystem).not.toContain('"source_memory_ids"');
    expect(intakeSystem).not.toContain('"patch"');
  });

  it("pins the NARROW split gate: only un-overload an existing candidate, never over-fragment", () => {
    const lower = intakeSystem.toLowerCase();
    expect(lower).toContain("overloaded");
    expect(lower).toContain('"target_id" must be one of the candidate');
    expect(lower).toContain("do not split a single-entity");
    expect(lower).toContain("always proposed");
  });

  it("carries the rules-rechecked-in-code notice", () => {
    expect(intakeSystem).toMatch(/re-checked in code/i);
  });

  it("forbids fields outside an intake action's exact wire shape", () => {
    expect(intakeSystem).toMatch(/use exactly the fields shown for that action/i);
    expect(intakeSystem).toMatch(/a "supersede" judgment never has "tags"/i);
    expect(intakeSystem).toMatch(/existing target's tags are preserved/i);
  });

  it("qualifies tagging by the exact output shape instead of requiring tags everywhere", () => {
    expect(intakeSystem).toMatch(/tag only when the exact output shape includes "tags"/i);
    expect(intakeSystem).toMatch(/never invent a "tags" field for a shape that omits it/i);
  });

  it("rechecks novelty, target choice, and lossless supersession at the end of intake", () => {
    expect(intakeSystem).toMatch(/compare the submission claim-by-claim/i);
    expect(intakeSystem).toMatch(/primary future recall question/i);
    expect(intakeSystem).toMatch(/review date into an expiry date/i);

    const user = intakePrompt()[1]!.content;
    expect(user).toContain("INTAKE FINAL CHECK");
    expect(user).toContain("INTAKE FINAL ROUTING AND CONTENT AUDIT");
    expect(user).toMatch(/genuinely new durable claim/i);
    expect(user).toMatch(/name the submission's primary durable subject/i);
    expect(user).toMatch(/a statement explicitly scoped to a launch, trial, former plan/i);
    expect(user).toMatch(/make a claim ledger before writing/i);
    expect(user).toMatch(/if any durable claim vanished, add it/i);
    expect(user).toMatch(/remove internal contradictions/i);
  });

  it("frames the untrusted submission + evidence in the user message", () => {
    const user = intakePrompt()[1]!.content;
    expect(user).toContain("Elaine moved to Berlin");
    expect(user).toContain("mem_elaine"); // candidate id is available to reference
    expect(user.toLowerCase()).toContain("untrusted");
  });

  it("redacts secrets from every untrusted field (submission, candidate title+body, toc title+tags, addendum)", () => {
    // redactSecrets catches the `<keyword> = "value"` assignment shape. Assemble
    // those strings at RUNTIME from a bare keyword + a low-entropy fake value, so
    // no literal secret-assignment sits in the committed source (GitGuardian
    // scans source; redactSecrets scans the runtime string). Each field proves
    // redaction is applied there — the tag case guards the fix that tags reach
    // the provider redacted, not raw.
    const assign = (keyword: string, label: string): string => `${keyword} = "fake-${label}"`;
    const messages = buildCuratorPrompt({
      mode: "intake",
      submissionText: assign("token", "submission"),
      evidence: {
        candidates: [
          mem({
            id: "m",
            title: assign("api_key", "cand-title"),
            body: assign("secret", "cand-body"),
          }),
        ],
        toc: [
          {
            id: "m",
            title: assign("password", "toc-title"),
            tags: [assign("auth_token", "toc-tag")],
          },
        ],
      },
      promptAddendum: assign("credentials", "addendum"),
    });
    const user = messages[1]!.content;
    for (const label of [
      "submission",
      "cand-title",
      "cand-body",
      "toc-title",
      "toc-tag",
      "addendum",
    ]) {
      expect(user).not.toContain(`fake-${label}`);
    }
    expect(user).toContain("[REDACTED:secret]");
  });

  it("appends the operator addendum as advisory-only, AFTER the evidence; omits it when unset", () => {
    const user = intakePrompt("prefer the lessons folder")[1]!.content;
    expect(user).toContain("prefer the lessons folder");
    expect(user.toLowerCase()).toContain("advisory");
    expect(user.indexOf("OPERATOR GUIDANCE")).toBeGreaterThan(user.indexOf("EVIDENCE"));

    expect(intakePrompt()[1]!.content).not.toContain("OPERATOR GUIDANCE");
  });

  // Proposal-review rework F4 (D3/D7): the intake examples document — rejected
  // submissions the curator distilled — rides the intake prompt whole, framed
  // as advisory teaching data, and is absent when empty.
  it("appends the intake examples doc when non-empty; omits the block when unset/empty", () => {
    const withExamples = buildCuratorPrompt({
      mode: "intake",
      submissionText: "Elaine moved to Berlin",
      evidence: intakeEvidence,
      intakeExamples: "- One-off TODO notes: noop them.",
    })[1]!.content;
    expect(withExamples).toContain("- One-off TODO notes: noop them.");
    expect(withExamples).toContain("REJECTED-SUBMISSION EXAMPLES");
    expect(withExamples.indexOf("REJECTED-SUBMISSION EXAMPLES")).toBeGreaterThan(
      withExamples.indexOf("EVIDENCE"),
    );

    expect(intakePrompt()[1]!.content).not.toContain("REJECTED-SUBMISSION EXAMPLES");
    const withEmpty = buildCuratorPrompt({
      mode: "intake",
      submissionText: "x",
      evidence: intakeEvidence,
      intakeExamples: "   ",
    })[1]!.content;
    expect(withEmpty).not.toContain("REJECTED-SUBMISSION EXAMPLES");
  });

  it("redacts the intake examples doc before it can reach the provider", () => {
    // Runtime-assembled secret shape (GitGuardian scans source; see the
    // redaction test above for the pattern's rationale).
    const secretish = `${"api_key"} = "fake-examples-secret-value"`;
    const user = buildCuratorPrompt({
      mode: "intake",
      submissionText: "x",
      evidence: intakeEvidence,
      intakeExamples: secretish,
    })[1]!.content;
    expect(user).not.toContain("fake-examples-secret-value");
  });
});

// ── grooming mode ─────────────────────────────────────────────────────────────

describe("buildCuratorPrompt — grooming mode", () => {
  it("teaches exactly the wire shapes GroomingOperationSchema parses (derived, not string-twinned)", () => {
    expect(groomingSystem).toContain('{ "operations": Operation[] }');
    for (const option of GroomingOperationSchema.options) {
      const { value, keys } = wireShape(option, "type");
      expect(groomingSystem).toContain(`"type": "${value}"`);
      for (const key of keys) expect(groomingSystem).toContain(`"${key}"`);
    }
  });

  it("states the exact MemoryInput and MemoryPatch field types, including array-only fields", () => {
    expect(groomingSystem).toContain(
      'MemoryInput = { "title": string, "body": string, "visibility": "common", "applies_to"?: string[], "confidence"?: "tentative" | "working" | "strong", "tags"?: string[] }',
    );
    expect(groomingSystem).toContain(
      "MemoryPatch has the same fields and types, with every field optional.",
    );
    expect(groomingSystem).toMatch(/"applies_to" and "tags" are arrays even for one value/i);
  });

  it("requires common visibility on every complete nested memory but not on patches", () => {
    expect(groomingSystem).toMatch(/every MemoryInput must include "visibility": "common"/i);
    expect(groomingSystem).toMatch(/MemoryPatch may omit "visibility"/i);
  });

  it("distinguishes numeric operation confidence from enum stored-memory confidence", () => {
    expect(groomingSystem).toMatch(/operation confidence.*number in \[0, 1\]/i);
    expect(groomingSystem).toMatch(/stored-memory confidence.*"tentative".*"working".*"strong"/i);
    expect(groomingSystem).toMatch(/never copy.*numeric operation confidence.*nested memory/i);
  });

  it("grooms related memories into a coherent corpus without crossing source boundaries", () => {
    expect(groomingSystem).toMatch(/coherent corpus/i);
    expect(groomingSystem).toMatch(/same real project, person, or subject/i);
    expect(groomingSystem).toMatch(/one coherent, navigable memory/i);
    expect(groomingSystem).toMatch(/combined memory.*unwieldy/i);
    expect(groomingSystem).toMatch(/shared word or ambiguous name is not enough/i);
    expect(groomingSystem).toMatch(/code-only memory.*archive.*never.*merge/is);
    expect(groomingSystem).toMatch(/entailment ledger/i);
    expect(groomingSystem).toMatch(/every sentence.*supported.*body.*source_memory_ids/is);
    expect(groomingSystem).toMatch(/never borrow.*neighbouring memory.*remains active/is);
    expect(groomingSystem).toMatch(/include that memory as a source.*otherwise omit/is);
    expect(groomingSystem).toMatch(/source memory may be consumed by at most one/i);
    expect(groomingSystem).toMatch(/createdAt and updatedAt.*metadata only.*never event dates/is);
    expect(groomingSystem).toMatch(/preserve.*proposed.*rejected.*current.*open/is);
    expect(groomingSystem).toMatch(/source-by-source preservation audit/i);
  });

  it("ends grooming with a source-bound coherent-corpus audit", () => {
    const user = groomingPrompt()[1]!.content;
    expect(user).toContain("GROOMING FINAL CHECK");
    expect(user).toMatch(/one broad recall.*coherent, non-duplicated story/is);
    expect(user).toMatch(/every sentence.*listed source/is);
    expect(user).toMatch(/no source is consumed twice/i);
    expect(user).toMatch(/no replacement copies claims from a memory left active/i);
    expect(user).toMatch(/no material corruption, duplication, fragmentation/i);
  });

  it("does not teach intake wire shapes (the parser would reject them)", () => {
    expect(groomingSystem).not.toContain('"action"');
    // Match the quoted action literals, not bare words: the shared CORE prose
    // legitimately uses the English "supersedes" (value hierarchy, HISTORY), which
    // is not the intake `"action": "supersede"` wire shape.
    expect(groomingSystem).not.toContain('"augment"');
    expect(groomingSystem).not.toContain('"supersede"');
    expect(groomingSystem).not.toContain("SUBMISSION");
  });

  it("enforces the code-side rules: ids, slice boundary, proposed sources, requires_approval, tombstones, secrets", () => {
    const lower = groomingSystem.toLowerCase();
    expect(lower).toMatch(/re-checked in code/);
    expect(lower).toContain("never invent an id");
    expect(lower).toContain("visibility");
    // project_key was dropped from the grooming contract (memories are project-less).
    expect(lower).not.toContain("project_key");
    // priority was dropped from the grooming contract (the memory field was retired).
    expect(lower).not.toContain("priority");
    expect(lower).toContain("proposed_memories");
    expect(lower).toContain("requires_approval");
    expect(lower).toContain("tombstones");
    expect(lower).toMatch(/secret|credential/);
    expect(groomingSystem).toContain('{ "operations": [] }'); // the empty-slice answer
  });

  it("teaches the open-curator-flag rule: an already-flagged memory is a noop, not a re-proposal (review F2)", () => {
    expect(groomingSystem).toContain('"has_open_curator_flag"');
    expect(groomingSystem).toMatch(/do not propose archiving it again/i);
  });

  it("has no session framing after the rethink", () => {
    expect(groomingSystem).not.toMatch(/session/i);
    expect(groomingSystem).not.toContain("source_session_ids");
  });

  it("carries the evidence ids, tombstones, pre-pass findings and truncation notes", () => {
    const messages = buildCuratorPrompt({
      mode: "grooming",
      memory: memBundle({
        activeMemories: [activeMem("mem_a", "Title A", "Body A")],
        tombstones: [
          {
            id: "mem_dead",
            title: "Old",
            agentId: null,
            archivedAt: "2026-01-01T00:00:00.000Z",
            archiveReason: null,
            contentFingerprint: "f".repeat(64),
            normalizedTitle: "old",
          },
        ],
        truncatedMemories: true,
      }),
      prepass: { findings: [{ kind: "exact_duplicate", memoryIds: ["mem_a"], rationale: "dup" }] },
    });
    const user = messages[1]!.content;
    expect(user).toContain("mem_a");
    expect(user).toContain("Body A");
    expect(user).toContain("mem_dead"); // tombstone surfaced (resurrection avoidance)
    expect(user).toContain("exact_duplicate");
    expect(user).toMatch(/truncat/i);
  });

  it("appends the operator addendum as advisory-only and redacted; omits it when unset", () => {
    const user = groomingPrompt('prefer merging; token = "FAKEADDENDUMSECRET"')[1]!.content;
    expect(user).toContain("prefer merging");
    expect(user.toLowerCase()).toContain("advisory");
    expect(user).not.toContain("FAKEADDENDUMSECRET");
    expect(user).toContain("[REDACTED:secret]");
    expect(user.indexOf("OPERATOR GUIDANCE")).toBeGreaterThan(user.indexOf("EVIDENCE"));

    expect(groomingPrompt()[1]!.content).not.toContain("OPERATOR GUIDANCE");
  });
});
