// Intake — judge parsing layer (spec 035 §F5). One PURE piece, independent of
// the LLM: parseIntakeJudgment — the LLM's per-submission decision is
// UNTRUSTED; parse the JSON and strictly validate it (strict objects reject
// smuggled fields, mirroring parseGroomingOutput). One submission → one
// judgment (not a batch like the curator).
//
// The apply/propose/skip verdict is NOT decided here anymore: the old
// three-band routing (≥0.95 auto / 0.85–0.95 proposal / ≤0.85 create_new) died
// with rethink D13 — the apply layer (apply.ts) routes every judgment through
// the ONE decision function (curator-apply-policy.ts) instead.
//
// The prompt + LLM call that produces the raw judgment is a separate increment;
// this layer is what consumes its output.

import { z } from "zod";

const rationale = z.string().min(1);
const confidence = z.number().min(0).max(1);

/** Novel fact with no good existing home → a fresh doc (S1). */
const CreateJudgment = z.strictObject({
  action: z.literal("create"),
  title: z.string().min(1),
  body: z.string().min(1),
  tags: z.array(z.string()).default([]),
  rationale,
  confidence,
});
/** Weave the new fact into an existing doc (S2/S18) — minimal-edit at apply time. */
const AugmentJudgment = z.strictObject({
  action: z.literal("augment"),
  target_id: z.string().min(1),
  addition: z.string().min(1),
  rationale,
  confidence,
});
/** The submission contradicts/updates an existing doc → replace it (S4). */
const SupersedeJudgment = z.strictObject({
  action: z.literal("supersede"),
  target_id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  rationale,
  confidence,
});
/** An existing doc is now stale (no replacement). */
const ArchiveJudgment = z.strictObject({
  action: z.literal("archive"),
  target_id: z.string().min(1),
  rationale,
  confidence,
});
/** Nothing to do — a duplicate or non-actionable submission. */
const NoopJudgment = z.strictObject({
  action: z.literal("noop"),
  rationale,
  confidence,
});
/**
 * Split an overloaded existing doc into ≥2 focused docs (spec 043 D-B). NARROW:
 * proposed only when the submission is primarily about a DIFFERENT, already
 * well-supported entity that is itself among the candidates — so no navigate is
 * needed and the split target is an existing candidate (never a fabricated id).
 * Like every operation it applies at or above the operator's threshold and is
 * proposed below it (ADR 0014) — see apply.ts. `target_id` is the overloaded doc;
 * `replacements` are the focused docs it becomes.
 */
const SplitJudgment = z.strictObject({
  action: z.literal("split"),
  target_id: z.string().min(1),
  replacements: z
    .array(
      z.strictObject({
        title: z.string().min(1),
        body: z.string().min(1),
        tags: z.array(z.string()).default([]),
      }),
    )
    .min(2),
  rationale,
  confidence,
});

export const IntakeJudgmentSchema = z.discriminatedUnion("action", [
  CreateJudgment,
  AugmentJudgment,
  SupersedeJudgment,
  ArchiveJudgment,
  NoopJudgment,
  SplitJudgment,
]);
export type IntakeJudgment = z.infer<typeof IntakeJudgmentSchema>;

export interface ParsedIntakeJudgment {
  judgment?: IntakeJudgment;
  /** Set when the response was unusable (bad JSON or schema-invalid). */
  parseError?: string;
}

export function parseIntakeJudgment(raw: string): ParsedIntakeJudgment {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    return { parseError: "output was not valid JSON" };
  }
  const result = IntakeJudgmentSchema.safeParse(parsed);
  if (!result.success) return { parseError: summarizeIssues(result.error) };
  return { judgment: result.data };
}

// Tolerate a single markdown code fence some providers wrap JSON in.
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/\n?```$/, "")
    .trim();
}

// Build the error from issue CODE + PATH only — never Zod's message text or the
// received value, which echo untrusted (possibly secret-looking) model output.
function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.join(".");
      const detail = issue.code === "unrecognized_keys" ? "unexpected field" : issue.code;
      return path ? `${path}: ${detail}` : detail;
    })
    .join("; ");
}
