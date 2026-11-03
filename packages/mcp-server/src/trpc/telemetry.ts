// Usage-stats tRPC procedures (spec 085). Admin-only.
//
//   telemetry.status        → the switch, why nothing would be sent now, the last payload and
//                             when it went, when the next is due, and a preview of the next one
//   telemetry.setEnabled    → the switch
//   telemetry.resetInstallId → a new random id; the next ping counts as a new install

import { z } from "zod";
import { TELEMETRY_ENABLED_KEY, resetInstallId, telemetryStatus } from "../telemetry.js";
import { adminProcedure, router } from "./trpc.js";

export const telemetryRouter = router({
  status: adminProcedure.query(({ ctx }) => telemetryStatus(ctx.store)),

  setEnabled: adminProcedure
    .input(z.strictObject({ enabled: z.boolean() }))
    .mutation(({ ctx, input }) => {
      ctx.store.setSetting(TELEMETRY_ENABLED_KEY, input.enabled ? "true" : "false");
      return telemetryStatus(ctx.store);
    }),

  resetInstallId: adminProcedure.mutation(({ ctx }) => {
    resetInstallId(ctx.store);
    return telemetryStatus(ctx.store);
  }),
});
