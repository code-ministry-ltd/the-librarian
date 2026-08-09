// Intake (intake) admin tRPC procedures (spec 043 PR-5a / Task C5a).
//
// The parallel of the grooming `groomingRouter` (curator.ts), adapted for intake —
// so the unified curator dashboard (C5b) can render an Intake section with the
// same shape it already has for grooming: enablement + the per-consumer
// operational view (read-only here), run + per-operation observability over the
// C1 intake decision log, and an admin run-now.
//
// All admin-gated — there is deliberately NO consumer-agent surface for intake
// control. This router is read-only aggregation for the dashboard's Intake
// section; the provider/model WRITE surface is the existing `llm.setConsumerConfig`
// (not duplicated here). The writes `setConfig` owns are the intake enablement toggle
// (`curator.intake.enabled`) and the sweep cadence (`curator.intake.interval_minutes`,
// spec 045 D-3).

import type { IntakeTickResult, LibrarianStore, ListIntakeRunsInput } from "@librarian/core";
import {
  isIntakeEnabled,
  readConsumerConfig,
  readIntakeInterval,
  runIntakeTick,
  setIntakeEnabled,
  writeIntakeInterval,
} from "@librarian/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

// Mirror grooming's `runs` input (curator.ts ListRunsInputSchema), matching the
// C1 ListIntakeRunsInput shape. All optional; the store clamps `limit`.
const ListRunsInputSchema = z.strictObject({
  status: z.string().optional(),
  trigger: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

// Intake's configured state in one read: the enablement flag (authoritative
// `curator.intake.enabled` setting) + the sweep cadence (`curator.intake.interval_minutes`,
// folded in from the core readIntakeInterval pair, spec 045 D-3) + the per-consumer
// operational view (provider/model/operational flags). The token is never part of this
// — `readConsumerConfig` returns presence-only `hasToken`, never the secret.
function gatherIntakeConfig(store: LibrarianStore) {
  return {
    enabled: isIntakeEnabled(store),
    intervalMinutes: readIntakeInterval(store).intervalMinutes,
    consumer: readConsumerConfig(store, "intake"),
  };
}

export const intakeRouter = router({
  // Intake's configured state (enablement + the read-only per-consumer view).
  config: adminProcedure.query(({ ctx }) => gatherIntakeConfig(ctx.store)),

  // Update intake's NON-LLM config: the enablement toggle and/or the sweep cadence
  // (spec 045 D-3). Both fields are optional so the dashboard can patch one without
  // the other. The enable setting is authoritative (spec 043 D-E) — toggling off
  // actually disables the job. `intervalMinutes` defers its validation to the core
  // `writeIntakeInterval` (the single source of truth: integer ≥ 1); its teaching
  // error is surfaced as a BAD_REQUEST tRPC error rather than a 500. Returns the
  // fresh readable config.
  setConfig: adminProcedure
    .input(
      z.strictObject({ enabled: z.boolean().optional(), intervalMinutes: z.number().optional() }),
    )
    .mutation(({ ctx, input }) => {
      if (input.enabled !== undefined) setIntakeEnabled(ctx.store, input.enabled);
      if (input.intervalMinutes !== undefined) {
        try {
          writeIntakeInterval(ctx.store, { intervalMinutes: input.intervalMinutes });
        } catch (error) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: error instanceof Error ? error.message : String(error),
            cause: error,
          });
        }
      }
      return gatherIntakeConfig(ctx.store);
    }),

  // Observability: intake run history (most recent first) + per-run ops,
  // over the C1 decision log (LibrarianStore extends IntakeStore).
  runs: adminProcedure
    .input(ListRunsInputSchema.optional())
    .query(({ ctx, input }) => ctx.store.listIntakeRuns((input ?? {}) as ListIntakeRunsInput)),

  runOperations: adminProcedure
    .input(z.strictObject({ runId: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.store.getIntakeOperations(input.runId)),

  // Admin run-now: force one inbox sweep. ADMIN OVERRIDE (spec 045 D-4) — it runs
  // even when intake is DISABLED (`allowDisabled: true` drops the enable gate that
  // the scheduled tick still applies). The LLM-config/token gates inside the tick
  // still apply, so a disabled-but-unconfigured job surfaces `incomplete_config` /
  // `no_token` (never "disabled") for the dashboard (T11) to display. Unlike grooming
  // there is no input-hash/debounce skip inside the intake sweep to bypass (it always
  // processes the whole inbox), so a run-now is a forced sweep — it files queued items
  // even though intake's scheduler never starts while disabled. NB: an intake sweep
  // can also fire the C3 post-intake grooming trigger (runIntakeTick's default),
  // so an admin run-now may, like a scheduled tick, arm a groom if the threshold/
  // debounce allow — intentional and consistent with the scheduled path.
  runNow: adminProcedure.mutation(({ ctx }): Promise<IntakeTickResult> =>
    runIntakeTick({ store: ctx.store, allowDisabled: true }),
  ),
});
