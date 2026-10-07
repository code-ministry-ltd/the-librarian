// Fixture schema for intake evaluation samples (plan 036 Phase 4 / the
// C6 checkpoint; scenarios from spec 035 §F5 + the brainstorm-mvp §9 list).
//
// Each entry is a SUBMISSION the intake must file, plus the existing
// memories it can see (the `corpus`), plus the GROUND-TRUTH outcome a correct
// intake should reach: the judge `action` and the routing `decision`
// (and, for a targeted action, which corpus doc it must touch). The harness
// runs every entry through navigate→judge→route and reports agreement against
// these expectations.
//
// `category: "straight"` is a clear case; `category: "boundary"` flags a case
// where the right answer needs judgement (ambiguous entity, contradiction,
// hand-authored prose that must not be clobbered). The harness can filter to
// boundary-only to surface the hard evaluations.
//
// The five scenarios:
//   S1  — new fact on a novel topic → create.
//   S2  — multi-entity fact (the "co-mention problem") → augment the primary entity.
//   S4  — updated/conflicting fact → supersede, not blind augment.
//   S12 — ambiguous entity (two "Elaine"s) → an uncertain merge must NOT silently
//         under-merge: a low-confidence augment routes to a proposal (D13).
//   S18 — augmenting a hand-authored doc → never clobber the existing prose.

import { z } from "zod";

export const INTAKE_SCENARIOS = ["S1", "S2", "S4", "S12", "S18"] as const;
export type IntakeScenario = (typeof INTAKE_SCENARIOS)[number];

/** A judge action (the discriminated-union actions of IntakeJudgment). */
export const JUDGE_ACTIONS = ["create", "augment", "supersede", "archive", "noop"] as const;
/** The verdicts the unified D13 apply rule (`decideApplication`) can emit. */
export const ROUTING_DECISIONS = ["apply", "propose", "skip"] as const;

// Which verdicts each action can actually reach (mirrors `decideApplication`
// in @librarian/core: noop skips, everything else gates on the single
// confidence threshold — ADR 0014). A fixture pairing an action with an
// unreachable decision is an authoring error — reject it at parse time.
const REACHABLE: Record<
  (typeof JUDGE_ACTIONS)[number],
  readonly (typeof ROUTING_DECISIONS)[number][]
> = {
  noop: ["skip"],
  create: ["apply", "propose"],
  augment: ["apply", "propose"],
  supersede: ["apply", "propose"],
  archive: ["apply", "propose"],
};

const CorpusDocSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
});
export type IntakeCorpusDoc = z.infer<typeof CorpusDocSchema>;

const ExpectedSchema = z.strictObject({
  action: z.enum(JUDGE_ACTIONS),
  decision: z.enum(ROUTING_DECISIONS),
  // Required for augment/supersede/archive — the corpus doc the judge must
  // touch. Validated to exist in the corpus by the cross-field refinement.
  target_id: z.string().min(1).optional(),
  // S18: when augmenting, the targeted doc's existing body must survive intact
  // (minimal-edit / no-clobber). The harness asserts `preservesOriginal`.
  preserves_corpus: z.boolean().optional(),
  // S12: set false when the RIGHT behaviour is "don't pick a target
  // confidently" — the named target_id is then an arbitrary tiebreak the
  // harness must not grade (the apply layer files the raw submission as a
  // proposal and drops the judgment's target anyway).
  grade_target: z.boolean().optional(),
});

const SubmissionSchema = z.strictObject({
  text: z.string().min(1),
  hints: z
    .strictObject({
      agent_id: z.string().optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
});

export const IntakeFixtureEntrySchema = z
  .strictObject({
    id: z.string().min(1),
    scenario: z.enum(INTAKE_SCENARIOS),
    category: z.enum(["straight", "boundary"]),
    submission: SubmissionSchema,
    corpus: z.array(CorpusDocSchema),
    expect: ExpectedSchema,
    notes: z.string().optional(),
  })
  .superRefine((entry, ctx) => {
    const { action, decision, target_id } = entry.expect;

    if (!REACHABLE[action].includes(decision)) {
      ctx.addIssue({
        code: "custom",
        path: ["expect", "decision"],
        message: `routing: action '${action}' can never route to decision '${decision}' (reachable: ${REACHABLE[action].join(", ")})`,
      });
    }

    const needsTarget = action === "augment" || action === "supersede" || action === "archive";
    if (needsTarget && !target_id) {
      ctx.addIssue({
        code: "custom",
        path: ["expect", "target_id"],
        message: `action '${action}' requires expect.target_id`,
      });
    }
    if (target_id && !entry.corpus.some((doc) => doc.id === target_id)) {
      ctx.addIssue({
        code: "custom",
        path: ["expect", "target_id"],
        message: `expect.target_id '${target_id}' must exist in the corpus`,
      });
    }
  });

export type IntakeFixtureEntry = z.infer<typeof IntakeFixtureEntrySchema>;

export const IntakeFixtureFileSchema = z.array(IntakeFixtureEntrySchema);
export type IntakeFixtureFile = z.infer<typeof IntakeFixtureFileSchema>;
