// Intake decision-log writer (spec 043 C1). The fail-soft seam between the
// intake pipeline (sweep + apply) and the `IntakeStore` sidecar.
//
// CRUCIAL CONTRACT: intake is the perf-sensitive ingestion path, and this log is
// purely observational. A log-write failure must NEVER block or fail the sweep.
// Every write goes through `safe()` here, which swallows ANY throw (surfacing it
// only via the optional `onError` debug sink) and returns a sentinel. The sweep
// proceeds and returns its normal summary even if the store throws on every call.
//
// The pipeline depends only on this narrow `IntakeLogger` surface (a
// subset of `IntakeStore`'s write methods), so a test can inject a
// throwing logger to pin the fail-soft guarantee without a real store.

import { redactSecrets } from "../grooming-redaction.js";
import type {
  CompleteIntakeRunInput,
  IntakeOperation,
  IntakeRun,
  CreateIntakeRunInput,
  FailIntakeRunInput,
  RecordIntakeOperationInput,
} from "../store/intake-store.js";
import type { IntakeOutcome } from "./apply.js";
import type { IntakeJudgment } from "./judge.js";

/** The write-only subset of `IntakeStore` the intake pipeline records to. */
export interface IntakeLogger {
  createIntakeRun: (input: CreateIntakeRunInput) => IntakeRun;
  recordIntakeOperation: (input: RecordIntakeOperationInput) => IntakeOperation;
  startIntakeRun: (id: string) => IntakeRun;
  completeIntakeRun: (id: string, input?: CompleteIntakeRunInput) => IntakeRun;
  failIntakeRun: (id: string, input: FailIntakeRunInput) => IntakeRun;
}

/** Optional debug sink for a swallowed log-write error (never thrown onward). */
export type LogErrorSink = (error: unknown) => void;

/**
 * Run `fn`, swallowing ANY throw so a log-write failure can never escape into the
 * sweep. Returns `fn`'s result, or `undefined` when it threw. This is the single
 * choke point that makes the decision log fail-soft — keep all writes behind it.
 */
function safe<T>(fn: () => T, onError?: LogErrorSink): T | undefined {
  try {
    return fn();
  } catch (error) {
    onError?.(error);
    return undefined;
  }
}

/**
 * Open a intake run + mark it running, fail-soft. Returns the run id (for
 * subsequent per-op + completion writes) or `undefined` if logging is off / the
 * store threw — callers MUST treat `undefined` as "logging unavailable, skip it".
 */
export function openIntakeRun(
  logger: IntakeLogger | undefined,
  input: CreateIntakeRunInput,
  onError?: LogErrorSink,
): string | undefined {
  if (!logger) return undefined;
  const run = safe(() => logger.createIntakeRun(input), onError);
  if (!run) return undefined;
  safe(() => logger.startIntakeRun(run.id), onError);
  return run.id;
}

/** Complete a intake run with its sweep summary, fail-soft (best-effort). */
export function completeIntakeRun(
  logger: IntakeLogger | undefined,
  runId: string | undefined,
  input: CompleteIntakeRunInput,
  onError?: LogErrorSink,
): void {
  if (!logger || !runId) return;
  safe(() => logger.completeIntakeRun(runId, input), onError);
}

/** Fail a intake run with a value-free label, fail-soft (best-effort). */
export function failIntakeRun(
  logger: IntakeLogger | undefined,
  runId: string | undefined,
  error: string,
  onError?: LogErrorSink,
): void {
  if (!logger || !runId) return;
  safe(() => logger.failIntakeRun(runId, { error }), onError);
}

/** Map an apply `IntakeOutcome` to a decision-log `outcome` (the realised D13 verdict). */
function outcomeOf(outcome: IntakeOutcome): RecordIntakeOperationInput["outcome"] {
  switch (outcome.kind) {
    case "created":
    case "augmented":
    case "superseded":
    case "archived":
    case "split":
      return "applied";
    // A flagged-for-archive target IS the archive proposal (review F3: it rides
    // the flag-review queue) — log it under the realised "proposed" verdict.
    case "proposed":
    case "flagged_for_archive":
      return "proposed";
    case "skipped":
      return "skipped";
    case "rejected":
      return "failed";
  }
}

/** The target memory id an outcome touched, when it has one. */
function targetOf(outcome: IntakeOutcome): string | null {
  return "id" in outcome ? outcome.id : null;
}

/**
 * Record ONE per-item decision (the judged action + realised outcome + confidence
 * + rationale + source/target id), fail-soft. Called for EVERY applied item — not
 * just auto-applies — so skipped/proposed/failed rows are logged too (full
 * coverage). The model's rationale is UNTRUSTED, so it is redacted before logging
 * (same posture as apply.ts persisting it into the vault). The whole write —
 * redaction included — is inside `safe`, so even a redaction throw can't escape.
 */
export function recordIntakeDecision(
  logger: IntakeLogger | undefined,
  runId: string | undefined,
  judgment: IntakeJudgment,
  outcome: IntakeOutcome,
  sourceId: string | null,
  onError?: LogErrorSink,
): void {
  if (!logger || !runId) return;
  // Everything that could throw — the outcome/target mapping, redaction, and the
  // store write — is inside `safe`, so no part of recording an op can escape.
  safe(
    () =>
      logger.recordIntakeOperation({
        run_id: runId,
        action: judgment.action,
        outcome: outcomeOf(outcome),
        confidence: judgment.confidence,
        rationale: redactSecrets(judgment.rationale).redacted,
        source_id: sourceId,
        target_id: targetOf(outcome),
      }),
    onError,
  );
}
