// The ONE curator apply rule (rethink D13, spec §5.3, amended by ADR 0014). Every
// apply/propose/skip verdict in the system — intake apply (intake/apply.ts) and
// grooming apply (grooming-apply.ts) — is produced HERE and nowhere else.
//
// The rule is the operator's confidence threshold and nothing else (ADR 0014):
//   - noop changes nothing → skip;
//   - every other operation — create, update, merge, split and archive alike —
//     auto-applies at confidence ≥ threshold, else proposes.
// There are no operation-type, protected-memory or submission-level exceptions:
// a threshold of 0 means the curator never asks, and 1 means it (nearly) always
// does. Archive and split delete nothing: an archived memory stays in the vault,
// and its git history keeps every earlier body.

import type { LlmConnectionReader, LlmConnectionWriter } from "./llm-connection.js";

/**
 * The unified curator operation vocabulary (rethink D6). Intake's judge actions
 * map onto it at the call site (augment/supersede are both `update`).
 */
export type CuratorOperationType = "create" | "update" | "merge" | "split" | "archive" | "noop";

export type ApplyDecision = "apply" | "propose" | "skip";

export interface ApplyDecisionInput {
  operation: CuratorOperationType;
  /** The model's operation confidence in [0,1]. */
  confidence: number;
  /** The single curator.apply.confidence_threshold knob (default 0.8). */
  threshold: number;
}

/** The one apply rule (D13, ADR 0014). See the module comment. */
export function decideApplication(input: ApplyDecisionInput): ApplyDecision {
  if (input.operation === "noop") return "skip";
  return input.confidence >= input.threshold ? "apply" : "propose";
}

// ── The single settings knob ─────────────────────────────────────────────────

/** The ONE confidence threshold shared by intake and grooming (spec §5.3). */
export const APPLY_CONFIDENCE_THRESHOLD_KEY = "curator.apply.confidence_threshold";

/** Spec §15.3 ships 0.8 as the default. */
export const DEFAULT_APPLY_CONFIDENCE_THRESHOLD = 0.8;

function parseThreshold(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  // A corrupt or out-of-range stored value must never widen auto-apply — fall
  // back to the default rather than honouring it.
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

/**
 * Read the shared apply-confidence threshold (plain setting — works without the
 * master key). Reads ONLY `curator.apply.confidence_threshold`, else the 0.8
 * default. The pre-rethink keys (`curator.grooming.auto_apply_confidence`,
 * `curator.auto_apply_confidence`) are deliberately NOT migrated-on-read — spec
 * §15.3 ships 0.8 as a behaviour reset regardless of the prior setting
 * (owner-confirmed, called out in the v1.0.0-rc.1 CHANGELOG); T26's
 * migrate-data-dir reports the stale keys.
 */
export function readApplyConfidenceThreshold(store: LlmConnectionReader): number {
  return (
    parseThreshold(store.getSetting(APPLY_CONFIDENCE_THRESHOLD_KEY)) ??
    DEFAULT_APPLY_CONFIDENCE_THRESHOLD
  );
}

/**
 * Persist the shared apply-confidence threshold. Validates [0,1] with a teaching
 * error before touching the store (single source of truth for the bound).
 */
export function writeApplyConfidenceThreshold(store: LlmConnectionWriter, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("confidence threshold must be a number between 0 and 1");
  }
  store.setSetting(APPLY_CONFIDENCE_THRESHOLD_KEY, String(value));
}
