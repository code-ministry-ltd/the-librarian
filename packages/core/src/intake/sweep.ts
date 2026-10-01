// Intake — inbox sweep (spec 035 §F5 / Open-Q #2). Processes the whole
// inbox once: reclaim crashed-worker claims, then walk the pending items in FIFO
// order through `intakeInboxItem` one at a time (serial — batching is
// deferred). This is the single entry point the boot scan, the 5-minute
// safety-net tick, and the chokidar watcher all call; the scheduler that wires
// those triggers is a separate increment.
//
// One item's failure never fails the sweep: a thrown LLM/transport error leaves
// that item's claim in `.processing/` for a later sweep's reaper to retry, and the
// reaper parks an item in `inbox/.failed/` once it has failed three times. When the
// provider itself is struggling (a timeout, a dropped connection, a 429 or 5xx),
// the sweep stops there instead of sending the next item into the same queue: on a
// serial local model a timed-out request can keep generating after we hang up, so
// firing the next one just stacks work behind it. The next tick picks up the rest.

import { isProviderUnavailableError } from "../grooming-llm-client.js";
import { listInbox, reapStaleClaims } from "../store/corpus/inbox.js";
import { type IntakeLogger, completeIntakeRun, openIntakeRun } from "./decision-log.js";
import { type IntakeInboxItemDeps, intakeInboxItem } from "./intake.js";

// A claim still in `.processing/` past this age is treated as a crashed worker
// and reclaimed (matches the curator's lock TTL). With a serial single-process
// sweep, this only fires after a real crash.
const DEFAULT_LOCK_TTL_MS = 60 * 60_000; // 60 minutes

export interface IntakeSweepDeps extends IntakeInboxItemDeps {
  /** Claims older than this are reclaimed before the sweep (default 60 min). */
  lockTtlMs?: number;
  /** Failed attempts before an item is parked in `inbox/.failed/` (default 3). */
  maxAttempts?: number;
  /**
   * Optional intake decision-log writer (spec 043 C1). When present, the sweep
   * opens a run, records each item's outcome, and completes the run with the
   * summary. Purely observational + fully fail-soft — a throwing logger never
   * blocks or fails the sweep (see decision-log.ts). Omit it (the default) and
   * filing behaviour is byte-identical to before this log existed.
   */
  intakeLog?: IntakeLogger;
  /** What opened this sweep (boot | tick | watcher | manual); recorded on the run. */
  intakeTrigger?: string;
  intakeShelfId?: string;
  intakeShelfLabel?: string | null;
  intakeModelProvider?: string | null;
  intakeModelName?: string | null;
}

export interface SweepSummary {
  /** Stale claims returned to the pending queue before processing. */
  reclaimed: number;
  /** Items applied + completed. */
  consolidated: number;
  /** Items left claimed because the model output was unusable (reaper retries). */
  judgeErrors: number;
  /** Items a concurrent worker had already claimed. */
  claimedByOther: number;
  /** Items whose processing threw (LLM/transport); claim left for retry. */
  errored: number;
  /** Items that used up their attempts and were parked in `inbox/.failed/`. */
  parked: number;
  /** True when a provider failure stopped the sweep before the inbox was empty. */
  stoppedEarly: boolean;
}

export async function runIntakeSweep(deps: IntakeSweepDeps): Promise<SweepSummary> {
  const nowMs = (deps.now ?? Date.now)();
  const reaped = reapStaleClaims(deps.vault, {
    olderThanMs: deps.lockTtlMs ?? DEFAULT_LOCK_TTL_MS,
    now: nowMs,
    ...(deps.maxAttempts !== undefined ? { maxAttempts: deps.maxAttempts } : {}),
  });

  const summary: SweepSummary = {
    reclaimed: reaped.restored.length,
    consolidated: 0,
    judgeErrors: 0,
    claimedByOther: 0,
    errored: 0,
    parked: reaped.parked.length,
    stoppedEarly: false,
  };

  // Open the decision-log run LAZILY (chore/quiet-empty-intake-runs): a sweep that
  // processes 0 inbox items — an empty inbox, or one holding only another worker's
  // claims — is the cadence's cheap no-op, and recording a `consolidated 0` run for
  // it just spams the dashboard's intake-runs list. So we defer `openIntakeRun`
  // until the FIRST item is actually HANDLED (claimed + judged: a consolidated,
  // judge-error or errored item — NOT a `claimed_by_other`, which we never touched,
  // and NOT a bare stale-claim reclaim, which is housekeeping, not LLM work). On the
  // truly-empty no-op the run is never opened, so no row is written. `ensureRun`
  // opens-once and caches the id; it stays fail-soft (undefined if logging is off or
  // the store threw), so a throwing logger still never blocks or fails the sweep.
  let runId: string | undefined;
  let runOpened = false;
  let usageInputTokens = 0;
  let usageOutputTokens = 0;
  let observedModel: string | null = deps.intakeModelName ?? null;
  const measuredClient = {
    async complete(request: Parameters<typeof deps.llmClient.complete>[0]) {
      const completion = await deps.llmClient.complete(request);
      observedModel = completion.model || observedModel;
      usageInputTokens += completion.usage?.promptTokens ?? 0;
      usageOutputTokens += completion.usage?.completionTokens ?? 0;
      return completion;
    },
  };
  const ensureRun = (): string | undefined => {
    if (!runOpened) {
      runOpened = true;
      runId = openIntakeRun(
        deps.intakeLog,
        {
          trigger: deps.intakeTrigger ?? "manual",
          shelf_id: deps.intakeShelfId ?? null,
          shelf_label: deps.intakeShelfLabel ?? null,
          model_provider: deps.intakeModelProvider ?? null,
          model_name: observedModel,
        },
        deps.logError,
      );
    }
    return runId;
  };

  // The per-item deps carry the lazy resolver: `intakeInboxItem` records its per-op
  // row against `ensureRun()`, which opens the run on the first call and reuses it
  // after — so by the time the consolidated path records an op, the run exists.
  const itemDeps: IntakeInboxItemDeps = {
    ...deps,
    llmClient: measuredClient,
    getIntakeRunId: ensureRun,
  };

  // Parking an item is not housekeeping: the operator needs to see that a
  // submission was given up on, so a sweep that parks something records its run.
  if (summary.parked > 0) ensureRun();

  // Serial FIFO over the (reclaimed-inclusive) pending snapshot. One item at a time.
  // The run is opened lazily by the first handled item; a sweep that only sees
  // `claimed_by_other` items (or an empty inbox) never opens one — no real work.
  for (const pendingPath of listInbox(deps.vault)) {
    try {
      const result = await intakeInboxItem(pendingPath, itemDeps);
      if (result.status === "consolidated") summary.consolidated++;
      else if (result.status === "judge_error") {
        // Claimed + judged but the model output was unusable — real work, so the run
        // IS recorded (auditable) even though no per-op row is written for it.
        ensureRun();
        summary.judgeErrors++;
      } else summary.claimedByOther++;
    } catch (error) {
      // A thrown LLM/transport error leaves the claim in `.processing/` (the
      // next sweep's reaper retries); never abort the rest of the batch. The item
      // was claimed + handed to the model, so this run is recorded too.
      ensureRun();
      deps.onError?.(error);
      summary.errored++;
      if (isProviderUnavailableError(error)) {
        summary.stoppedEarly = true;
        break;
      }
    }
  }

  // Complete the run with the sweep summary (fail-soft, best-effort). A no-op when
  // logging is off, the open failed, OR the sweep handled 0 items (the run was never
  // opened) — that empty no-op is intentionally NOT recorded.
  completeIntakeRun(
    deps.intakeLog,
    runId,
    {
      summary: `consolidated ${summary.consolidated}, judgeErrors ${summary.judgeErrors}, claimedByOther ${summary.claimedByOther}, errored ${summary.errored}, reclaimed ${summary.reclaimed}${summary.parked ? `, parked ${summary.parked}` : ""}${summary.stoppedEarly ? ", stopped early: provider unavailable" : ""}`,
      consolidated: summary.consolidated,
      judge_errors: summary.judgeErrors,
      errored: summary.errored,
      reclaimed: summary.reclaimed,
      usage_input_tokens: usageInputTokens,
      usage_output_tokens: usageOutputTokens,
    },
    deps.logError,
  );
  return summary;
}
