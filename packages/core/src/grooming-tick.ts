// Grooming tick (spec §12 + §14) — the config-driven entrypoint for grooming.
// Grooming runs on its revived wall-clock schedule (spec 045 D-3 / plan 046 PR-1:
// the boot grooming scheduler in http.ts polls runScheduledGrooming, which gates
// on the curator.grooming.{interval_days,schedule_time} due-check and tags this
// pass "schedule") AND from two on-demand triggers: the admin run-now action
// ("manual" trigger) and the post-intake threshold trigger ("post_intake"; see
// grooming-trigger.ts).
// Reads the admin config, gates on it, builds the LLM client from it, and runs
// all due slices via runDueCuration as the system-memory-curator actor. It never
// runs unless grooming is enabled AND the LLM config is complete AND the token
// can be decrypted (it must never run on an incomplete config, §7.1) — except an
// admin run-now passes `allowDisabled` to bypass ONLY the enable gate (spec 045
// D-4); the LLM-config/token gates still apply.
//
// The LLM client builder is injectable for testing; in production it defaults to
// the OpenAI-compatible client.

import { type Principal, SYSTEM_ACTOR_IDS } from "./caller-identity.js";
import { migrateCuratorAddendum, readJobAddendum } from "./curator-addendum.js";
import { readApplyConfidenceThreshold } from "./curator-apply-policy.js";
import {
  migrateLegacyCuratorLlm,
  readConsumerConfig,
  resolveConsumerToken,
} from "./curator-consumers.js";
import { isCuratorPausedForRestore } from "./curator-pause.js";
import {
  migrateJobEnablement,
  migrateGroomingSchedule,
  readGroomingConfig,
  readLastScheduledGroomAt,
  writeLastScheduledGroomAt,
} from "./grooming-config.js";
import {
  type GroomingTrigger,
  type RunDueCurationSummary,
  runDueCuration,
} from "./grooming-enqueue.js";
import { type LlmClient, createGroomingLlmClient } from "./grooming-llm-client.js";
import { isScheduleDue } from "./grooming-schedule.js";
import type { RunCurationCaps } from "./grooming-worker.js";
import type { LibrarianStore } from "./store/librarian-store.js";
import { validateShelfSet } from "./vault-router.js";

export type GroomingTickSkipReason = "paused" | "disabled" | "incomplete_config" | "no_token";

export type GroomingTickResult =
  { ran: true; summary: RunDueCurationSummary } | { ran: false; reason: GroomingTickSkipReason };

export interface GroomingTickOptions {
  store: LibrarianStore;
  now?: Date;
  /** Default "schedule"; admin run-now passes "manual". */
  trigger?: GroomingTrigger;
  /** KEPT for run-now (spec §5.3): admin run-now bypasses the input-hash idempotency skip so it re-grooms even unchanged slices. */
  bypassSkip?: boolean;
  /** KEPT for run-now (spec §5.3): admin run-now bypasses the enable gate so a disabled-but-configured job still grooms on demand. */
  allowDisabled?: boolean;
  caps?: RunCurationCaps;
  /** Injectable LLM client builder (defaults to the OpenAI-compatible client). */
  buildClient?: (
    conn: { endpoint: string; model: string; timeoutMs: number },
    token: string,
  ) => LlmClient;
}

export async function runGroomingTick(options: GroomingTickOptions): Promise<GroomingTickResult> {
  const { store } = options;
  // A whole-vault restore is rewriting the working tree (rethink T21):
  // nothing may write through it until the restore resumes the curator. This
  // outranks even the `allowDisabled` run-now override below.
  if (isCuratorPausedForRestore(store, options.now)) {
    return { ran: false, reason: "paused" };
  }
  // Preserve a pre-existing curator.llm.* install: seed the per-consumer config
  // from it on first run (idempotent — a no-op once any provider exists).
  migrateLegacyCuratorLlm(store);
  // Seed grooming's unified enablement key from the legacy curator.enabled
  // setting (idempotent, no-clobber). Intake's env→setting seed runs at the http
  // boot where LIBRARIAN_CONSOLIDATOR is available; this tick migrates grooming.
  migrateJobEnablement(store);
  // Seed the grooming schedule pair + moved auto-apply policy keys from their
  // legacy locations once (spec 045 D-8; idempotent, no-clobber).
  migrateGroomingSchedule(store);
  // Move the legacy curator.prompt_addendum setting into the committed
  // grooming-addendum.md vault file once (spec 044 D-1; idempotent, no-clobber).
  migrateCuratorAddendum(store);
  const config = readGroomingConfig(store);
  const llm = readConsumerConfig(store, "grooming");

  // Self-gate on the dashboard-managed enable flag, unless the admin run-now caller
  // passes `allowDisabled` to override it (spec 045 D-4; mirrors the intake tick).
  if (!options.allowDisabled && !config.enabled) return { ran: false, reason: "disabled" };
  if (!llm.isOperational) return { ran: false, reason: "incomplete_config" };

  // The token is configured (isOperational ⇒ hasToken); decryption can still fail
  // if the server is missing the master key — treat that as "not runnable".
  let token: string | null;
  try {
    token = resolveConsumerToken(store, "grooming");
  } catch {
    return { ran: false, reason: "no_token" };
  }
  if (!token) return { ran: false, reason: "no_token" };

  const buildClient =
    options.buildClient ??
    ((conn, secret) =>
      createGroomingLlmClient({
        endpoint: conn.endpoint,
        token: secret,
        model: conn.model,
        timeoutMs: conn.timeoutMs,
      }));

  // Build the LLM client ONCE and reuse it across every shelf pass (the client is
  // stateless per call); the caps/actor/addendum/threshold are the same for each shelf.
  const llmClient = buildClient(
    { endpoint: llm.endpoint, model: llm.model, timeoutMs: llm.timeoutMs },
    token,
  );
  const caps: RunCurationCaps = { maxMemories: config.maxMemoriesPerRun, ...options.caps };
  const baseRun = {
    now: options.now ?? new Date(),
    llmClient,
    actorId: SYSTEM_ACTOR_IDS.memoryCurator,
    // The ONE apply rule's single knob (D13), shared with intake.
    confidenceThreshold: readApplyConfidenceThreshold(store),
    // The grooming addendum now lives in a git-committed vault file (spec 044
    // D-1); read it from there (fail-soft "" when the file is absent).
    promptAddendum: readJobAddendum(store, "grooming").content,
    model: { provider: llm.providerId, name: llm.model },
    trigger: options.trigger ?? "schedule",
    ...(options.bypassSkip !== undefined ? { bypassSkip: options.bypassSkip } : {}),
    // Bounded grooming runs (ADR 0005): the configured per-run memory cap
    // (curator.grooming.max_memories) flows into every run's evidence gather so a
    // single oversized slice can't exceed the LLM timeout. ADR 0005's budget is
    // PER SHELF RUN (spec 062 SC 7): each shelf's pass gets the SAME cap, and the
    // passes run sequentially — so N active shelves multiply LLM spend by ~N (the
    // §4 flagged assumption; the per-instance spend budget is the enforcement).
    // An explicit options.caps (manual/maintenance, tests) overrides it.
    caps,
  } as const;

  // Grooming iterates the SYSTEM principal's "groom" shelves SEQUENTIALLY (spec 062 SC 7).
  // The system principal is the honest grooming actor — kind "system", the canonical
  // memory-curator id (SYSTEM_ACTOR_IDS.memoryCurator, the same actor grooming already
  // attributes its writes to). Each pass runs against that shelf's SCOPED grooming store
  // (reads/proposals/writes confined to the shelf), NOT via writeTarget (spec 062 §4). Under
  // the DEFAULT router this materialises the single main shelf → exactly today's ONE run.
  const systemPrincipal: Principal = {
    kind: "system",
    actorId: SYSTEM_ACTOR_IDS.memoryCurator,
    roles: ["system"],
  };
  const shelves = store.vaultRouter.shelves(systemPrincipal, "groom");
  // Validate whatever a SUPPLIED router materialises, at first use — the same first-use validation
  // point every other op-path applies (recall/search/write/intake). Without it the groom path was
  // the one op that trusted an unvalidated set, so a disjointness / canonical-shadow violation only
  // surfaced later (or not at all); now "a violation throws on first use" is true for groom too
  // (review A4).
  validateShelfSet(shelves);
  const summary: RunDueCurationSummary = {
    due: 0,
    ran: 0,
    skippedLocked: 0,
    skippedIdempotent: 0,
    reclaimedStaleLocks: 0,
    errored: 0,
  };
  for (const shelf of shelves) {
    const shelfSummary = await runDueCuration({
      store: store.groomingStoreForShelf(shelf),
      ...baseRun,
    });
    summary.due += shelfSummary.due;
    summary.ran += shelfSummary.ran;
    summary.skippedLocked += shelfSummary.skippedLocked;
    summary.skippedIdempotent += shelfSummary.skippedIdempotent;
    summary.reclaimedStaleLocks += shelfSummary.reclaimedStaleLocks;
    summary.errored += shelfSummary.errored;
  }
  return { ran: true, summary };
}

export type ScheduledGroomingSkipReason = "disabled" | "not_due";

export type ScheduledGroomingResult =
  // A scheduled pass was attempted; the inner result is the pass runner's verdict
  // (ran:true with its summary, or ran:false with the pass's own skip reason).
  | GroomingTickResult
  // The schedule gate refused before any pass ran.
  | { ran: false; reason: ScheduledGroomingSkipReason };

export interface ScheduledGroomingOptions {
  store: LibrarianStore;
  /** Evaluation time; injected so the due-check is deterministic in tests. */
  now?: Date;
  /**
   * Injectable pass runner (defaults to `runGroomingTick` tagged `"schedule"`). The
   * scheduled entry owns the WHEN (the wall-clock due-check); the pass runner owns
   * the WHICH (input-hash idempotency per slice) and the actual LLM work. Injectable
   * for tests so the schedule gate can be exercised network-free.
   */
  runPass?: (store: LibrarianStore, now: Date) => Promise<GroomingTickResult>;
}

/**
 * The schedulable grooming entry (spec 045 D-3, plan 046 T6). The boot scheduler
 * (T7) polls this on a fixed internal cadence; it decides WHETHER a full grooming
 * pass is due and runs one when it is.
 *
 * Order of gates:
 *  1. **Enable gate** — self-gates on `config.enabled` (returns `disabled`).
 *     Run-now never comes through here — it calls `runGroomingTick` directly with
 *     its own `allowDisabled` override.
 *  2. **Schedule gate** — reads the grooming schedule (`intervalDays`,
 *     `scheduleTime`) and the LAST SCHEDULED-PASS timestamp
 *     (`curator.grooming.last_scheduled_run_at`); runs a pass only when
 *     `isScheduleDue(now, lastScheduledRunAt, …)`, else returns `not_due`.
 *
 * On a COMPLETED scheduled pass (the runner returns `ran:true`) the pass timestamp
 * is stamped so the next due-check advances. A pass that could not run (incomplete
 * config / no token) does NOT advance the schedule — the next poll retries once the
 * config is fixed. The timestamp is owned by SCHEDULED passes only: the post-intake
 * trigger and run-now never write it, so the nightly cadence stays predictable
 * regardless of ad-hoc grooms.
 */
export async function runScheduledGrooming(
  options: ScheduledGroomingOptions,
): Promise<ScheduledGroomingResult> {
  const { store } = options;
  const now = options.now ?? new Date();

  // Mirror the tick's migrations so a first poll on a freshly-upgraded install reads
  // the seeded schedule keys (idempotent, no-clobber).
  migrateJobEnablement(store);
  migrateGroomingSchedule(store);
  const config = readGroomingConfig(store);

  // 1. Enable gate — a disabled job never grooms on schedule.
  if (!config.enabled) {
    return { ran: false, reason: "disabled" };
  }

  // 2. Schedule gate — days-only wall-clock due-check against the last scheduled run.
  const due = isScheduleDue(now, readLastScheduledGroomAt(store), {
    intervalDays: config.intervalDays,
    time: config.scheduleTime,
  });
  if (!due) return { ran: false, reason: "not_due" };

  const runPass =
    options.runPass ?? ((s: LibrarianStore, at: Date) => runGroomingTick({ store: s, now: at }));
  const result = await runPass(store, now);

  // Advance the schedule ONLY on a completed pass. A pass that couldn't run leaves
  // the timestamp untouched so the next poll retries this window.
  if (result.ran) writeLastScheduledGroomAt(store, now);
  return result;
}
