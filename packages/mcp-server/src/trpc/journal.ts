// The journal's admin surface (spec 077 §4.7). Config only for now; the dashboard's
// read + delete procedures land with the Journal page (spec 077 PR D).
import type { JournalConfigPatch } from "@librarian/core";
import { JournalConfigPatchSchema, readJournalConfig, writeJournalConfig } from "@librarian/core";
import { TRPCError } from "@trpc/server";
import { adminProcedure, router } from "./trpc.js";

export const journalRouter = router({
  config: adminProcedure.query(({ ctx }) => readJournalConfig(ctx.store)),

  setConfig: adminProcedure.input(JournalConfigPatchSchema).mutation(({ ctx, input }) => {
    try {
      writeJournalConfig(ctx.store, input as JournalConfigPatch);
      return readJournalConfig(ctx.store);
    } catch (error) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }
  }),
});
