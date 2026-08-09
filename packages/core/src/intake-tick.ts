// Intake tick (spec 035 §F5) — the config-driven entrypoint the
// server-side scheduler calls on a (serial) timer, and an admin run-now action
// can call directly. It uses the `intake` consumer's own LLM connection (042 2A
// — intake and grooming each pick their own provider+model), builds the client
// from it, and runs one inbox sweep via store.runIntakeSweep.
//
// Enablement (the `curator.intake.enabled` setting, spec 043 D-E): the tick
// SELF-GATES on it first thing (spec 045 D-1), mirroring grooming's curator.enabled
// gate — a disabled intake returns {ran:false,reason:"disabled"} before the
// LLM-config/token gates, so flipping the setting takes effect on the next tick
// with no restart. A future manual/run-now caller passes `allowDisabled` to bypass
// it (admin override). Past the gate, the tick still gates on a complete +
// decryptable LLM connection and a supporting backend. The LLM client builder is
// injectable for testing; production defaults to the OpenAI-compatible client.

import { readJobAddendum } from "./curator-addendum.js";
import { readApplyConfidenceThreshold } from "./curator-apply-policy.js";
import {
  migrateLegacyCuratorLlm,
  readConsumerConfig,
  resolveConsumerToken,
} from "./curator-consumers.js";
import { readIntakeExamples } from "./curator-examples.js";
import { isCuratorPausedForRestore } from "./curator-pause.js";
import { type LlmClient, createGroomingLlmClient } from "./grooming-llm-client.js";
import { maybeTriggerGroomingAfterIntake } from "./grooming-trigger.js";
import type { SweepSummary } from "./intake/index.js";
import { isIntakeEnabled } from "./intake-config.js";
import type { LibrarianStore } from "./store/librarian-store.js";

export type IntakeTickSkipReason = "paused" | "disabled" | "incomplete_config" | "no_token";

export type IntakeTickResult =
  { ran: true; summary: SweepSummary } | { ran: false; reason: IntakeTickSkipReason };

export interface IntakeTickOptions {
  store: LibrarianStore;
  /** Override for the single D13 knob; defaults to the stored setting. */
  confidenceThreshold?: number;
  /** Stale-claim TTL passed through to the sweep reaper. */
  lockTtlMs?: number;
  /** Injectable LLM client builder (defaults to the OpenAI-compatible client). */
  buildClient?: (
    conn: { endpoint: string; model: string; timeoutMs: number },
    token: string,
  ) => LlmClient;
  /**
   * Post-intake grooming trigger (spec 043 D-A). After the sweep + decision log,
   * check the threshold/debounce and enqueue a `post_intake` groom if armed. Default
   * on; set false to suppress (e.g. when a separate process owns grooming). The hook
   * is fail-soft — it can never fail the sweep. Injectable for tests.
   */
  triggerGrooming?: boolean | ((store: LibrarianStore) => Promise<unknown>);
  /** Trigger evaluation time (debounce math); defaults to now. Mostly for tests. */
  now?: Date;
  /** KEPT for run-now (spec §5.3): admin run-now bypasses the enable gate so a disabled-but-configured job still sweeps on demand. */
  allowDisabled?: boolean;
}

export async function runIntakeTick(options: IntakeTickOptions): Promise<IntakeTickResult> {
  const { store } = options;
  // A whole-vault restore is rewriting the working tree (rethink T21):
  // nothing may write through it until the restore resumes the curator. This
  // outranks even the `allowDisabled` run-now override below — an admin
  // override must not race the restore either.
  if (isCuratorPausedForRestore(store, options.now)) {
    return { ran: false, reason: "paused" };
  }
  // Self-gate on the dashboard-managed enable flag FIRST (spec 045 D-1), mirroring
  // grooming's `curator.enabled` gate — so toggling `curator.intake.enabled` takes
  // effect on the next tick with no restart. A manual run-now caller passes
  // `allowDisabled` to bypass this (admin override; plan 046 T8).
  if (!options.allowDisabled && !isIntakeEnabled(store)) {
    return { ran: false, reason: "disabled" };
  }
  // Preserve a pre-existing curator.llm.* install (idempotent once migrated).
  migrateLegacyCuratorLlm(store);
  // The intake job's own LLM connection (its enablement was gated just above).
  const llm = readConsumerConfig(store, "intake");
  if (!llm.isOperational) return { ran: false, reason: "incomplete_config" };

  let token: string | null;
  try {
    token = resolveConsumerToken(store, "intake");
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

  // The intake prompt addendum lives in a git-committed vault file (spec 044 D-1);
  // read it ONCE here (the sweep level), not per inbox item — intake is the hot
  // path. Fail-soft "" when the file is absent → today's behaviour (no guidance).
  const promptAddendum = readJobAddendum(store, "intake").content;
  // Same once-per-sweep read for the intake examples doc (proposal-review
  // rework F4/D3) — the curator-distilled rejected-submission examples.
  const intakeExamples = readIntakeExamples(store).content;

  const summary = await store.runIntakeSweep({
    llmClient: buildClient(
      { endpoint: llm.endpoint, model: llm.model, timeoutMs: llm.timeoutMs },
      token,
    ),
    modelProvider: llm.providerId,
    modelName: llm.model,
    // The ONE apply rule's single knob (D13), shared with grooming.
    confidenceThreshold: options.confidenceThreshold ?? readApplyConfidenceThreshold(store),
    ...(options.lockTtlMs !== undefined ? { lockTtlMs: options.lockTtlMs } : {}),
    ...(promptAddendum ? { promptAddendum } : {}),
    ...(intakeExamples ? { intakeExamples } : {}),
  });

  // Post-intake grooming trigger (spec 043 D-A) — the natural seam: the sweep is done
  // and its C1 decision log is written, so the applied-op count is complete. Fail-soft
  // by contract (intake is the hot path — AGENTS.md "never block the user's turn"): the
  // hook swallows its own errors, and we still guard the call so nothing here can fail
  // the sweep that already succeeded.
  if (options.triggerGrooming !== false) {
    try {
      await maybeTriggerGroomingAfterIntake({
        store,
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(typeof options.triggerGrooming === "function"
          ? { runGroom: options.triggerGrooming }
          : {}),
      });
    } catch {
      /* unreachable — maybeTriggerGroomingAfterIntake is itself fail-soft — but the
         sweep must never fail on the trigger, belt-and-braces. */
    }
  }

  return { ran: true, summary };
}
