// Notices tRPC procedures (spec 084). Admin-only: notices are for whoever runs the install.
//
//   notices.list      → { notices, unread, remote: { enabled, status } }
//   notices.markRead  → records ids as read (opening the popover marks what it showed)
//   notices.config    → { enabled, forcedOff } for the switch, without fetching
//   notices.setFetch  → switches the remote fetch on or off (Settings → Dashboard)

import { z } from "zod";
import {
  NOTICES_FETCH_ENABLED_KEY,
  TELEMETRY_NOTICE_ID,
  assembleNotices,
  fetchEnabledSetting,
  getRemoteNotices,
  markRead,
} from "../notices.js";
import { forcedOff, markDisclosed, telemetryEnabled } from "../telemetry.js";
import { PACKAGE_VERSION } from "../version.js";
import { adminProcedure, router } from "./trpc.js";

export const noticesRouter = router({
  list: adminProcedure.query(async ({ ctx }) => {
    const remote = await getRemoteNotices(ctx.store);
    const telemetryOn = telemetryEnabled(ctx.store) && forcedOff() === null;
    const notices = assembleNotices(ctx.store, remote.notices, {
      version: PACKAGE_VERSION,
      telemetryOn,
    });
    // The dashboard has now been shown the usage-stats disclosure (spec 085): the 24-hour wait
    // before the first ping starts here.
    if (notices.some((n) => n.id === TELEMETRY_NOTICE_ID)) markDisclosed(ctx.store);
    return {
      notices,
      unread: notices.filter((n) => !n.read).length,
      remote: {
        enabled: fetchEnabledSetting(ctx.store),
        forcedOff: process.env.LIBRARIAN_DISABLE_NOTICES === "true",
        status: remote.status,
      },
    };
  }),

  markRead: adminProcedure
    .input(z.strictObject({ ids: z.array(z.string().min(1).max(100)).max(200) }))
    .mutation(({ ctx, input }) => {
      markRead(ctx.store, input.ids);
      return { ok: true as const };
    }),

  config: adminProcedure.query(({ ctx }) => ({
    enabled: fetchEnabledSetting(ctx.store),
    forcedOff: process.env.LIBRARIAN_DISABLE_NOTICES === "true",
  })),

  setFetch: adminProcedure
    .input(z.strictObject({ enabled: z.boolean() }))
    .mutation(({ ctx, input }) => {
      ctx.store.setSetting(NOTICES_FETCH_ENABLED_KEY, input.enabled ? "true" : "false");
      return { enabled: input.enabled };
    }),
});
