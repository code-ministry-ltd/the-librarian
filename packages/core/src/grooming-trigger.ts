// Post-intake grooming trigger (spec 043 D-A/D-D). One of grooming's two automatic
// triggers (the other is the revived wall-clock schedule, spec 045 D-3, polled by
// the boot grooming scheduler in http.ts); besides those, the admin `runNow`
// (manual) runs a pass on demand. This trigger fires after an intake (intake)
// sweep completes and its decision log is written: count the memories intake
// created/augmented/superseded since the last groom; if that count ≥
// `curator.grooming.trigger_threshold` AND we are outside the
// `curator.grooming.debounce_minutes` window of the last groom, enqueue EXACTLY ONE
// grooming run tagged `trigger:"post_intake"`.
//
// `runGroomingTick` + the due-slice input-hash idempotency are unchanged, so a
// triggered groom only runs the slices whose input actually changed — repeated
// triggers on unchanged input are cheap no-ops. The debounce is a rate-limit (a
// floor between auto-groom enqueues), NOT a scheduler.
//
// This module is the pure decision (`evaluateGroomingTrigger`) plus a fail-soft
// driver (`maybeTriggerGroomingAfterIntake`) the intake tick calls. The hook
// is fail-soft by contract: per AGENTS.md intake is the hot path, so a trigger or
// enqueue failure must NEVER fail the sweep — it logs and moves on.

import { readGroomingConfig } from "./grooming-config.js";
import { runGroomingTick } from "./grooming-tick.js";
import type { CurationStore } from "./store/curation-store.js";
import type { LibrarianStore } from "./store/librarian-store.js";

/** The reference time of the last groom (the newest curation run's created_at). */
type LastGroomReader = Pick<CurationStore, "listCurationRuns">;

export interface GroomingTriggerInputs {
  /** curator.grooming.trigger_threshold — the armed count (≥ 1). */
  threshold: number;
  /** curator.grooming.debounce_minutes — the auto-trigger floor (≥ 1). */
  debounceMinutes: number;
  /** Created_at of the most recent grooming run, or null if none ever ran. */
  lastGroomAt: string | null;
  /** Applied intake ops recorded since `lastGroomAt` (exclusive). */
  appliedSinceLastGroom: number;
  /** The moment we're evaluating at (the just-finished sweep's completion time). */
  now: Date;
}

export type GroomingTriggerDecision =
  { trigger: true } | { trigger: false; reason: "below_threshold" | "debounced" };

/**
 * The pure threshold + debounce arithmetic. Triggers iff the applied-op count has
 * reached the threshold AND we are outside the debounce window of the last groom.
 * Debounce is checked first only for a clearer `reason`; both must hold.
 *
 * Debounce boundary: a groom exactly `debounceMinutes` after the last is allowed
 * (the window is `[lastGroomAt, lastGroomAt + debounceMinutes)` — `<` not `≤`), so
 * the floor is "at least N minutes apart". No prior groom (`lastGroomAt === null`)
 * means the debounce never applies.
 */
export function evaluateGroomingTrigger(input: GroomingTriggerInputs): GroomingTriggerDecision {
  if (input.appliedSinceLastGroom < input.threshold) {
    return { trigger: false, reason: "below_threshold" };
  }
  if (input.lastGroomAt !== null) {
    const elapsedMs = input.now.getTime() - new Date(input.lastGroomAt).getTime();
    const windowMs = input.debounceMinutes * 60_000;
    // Guard a malformed timestamp (NaN) by treating it as "outside the window" —
    // failing open here is safe (the threshold already gated us) and avoids
    // suppressing a legitimate groom on a corrupt log entry.
    if (Number.isFinite(elapsedMs) && elapsedMs < windowMs) {
      return { trigger: false, reason: "debounced" };
    }
  }
  return { trigger: true };
}

export interface MaybeTriggerGroomingOptions {
  store: LibrarianStore;
  /** Evaluation time; defaults to now. The sweep just completed, so ~now is correct. */
  now?: Date;
  /** Surfaced for debug only — never rethrown (the hook is fail-soft). */
  onError?: (error: unknown) => void;
  /** Injectable groom runner (defaults to runGroomingTick) — for tests. */
  runGroom?: (store: LibrarianStore) => Promise<unknown>;
}

export type MaybeTriggerGroomingResult =
  { triggered: true } | { triggered: false; reason: "below_threshold" | "debounced" | "error" };

/**
 * Fail-soft post-intake hook: read the config + the last-groom time + the applied-op
 * count, decide via `evaluateGroomingTrigger`, and enqueue ONE grooming run when
 * armed. Any failure (read, decide, or enqueue) is swallowed → `{triggered:false,
 * reason:"error"}` so it can NEVER fail the intake sweep that called it.
 *
 * The groom is awaited so a synchronous test sees the run; in production the
 * intake tick already awaits the whole sweep, and the groom's own due-slice
 * idempotency keeps it cheap.
 */
export async function maybeTriggerGroomingAfterIntake(
  options: MaybeTriggerGroomingOptions,
): Promise<MaybeTriggerGroomingResult> {
  const { store } = options;
  try {
    const config = readGroomingConfig(store);
    const lastGroomAt = lastGroomTimestamp(store);
    const appliedSinceLastGroom = store.countAppliedOperationsSince(lastGroomAt);

    const decision = evaluateGroomingTrigger({
      threshold: config.triggerThreshold,
      debounceMinutes: config.debounceMinutes,
      lastGroomAt,
      appliedSinceLastGroom,
      now: options.now ?? new Date(),
    });
    if (!decision.trigger) return { triggered: false, reason: decision.reason };

    const runGroom =
      options.runGroom ??
      ((s: LibrarianStore) => runGroomingTick({ store: s, trigger: "post_intake" }));
    await runGroom(store);
    return { triggered: true };
  } catch (error) {
    options.onError?.(error);
    return { triggered: false, reason: "error" };
  }
}

/** Newest grooming run's created_at, or null when none has ever run. */
function lastGroomTimestamp(store: LastGroomReader): string | null {
  return store.listCurationRuns({ limit: 1 })[0]?.created_at ?? null;
}
