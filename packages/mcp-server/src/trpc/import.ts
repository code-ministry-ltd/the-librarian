// Import limits for the dashboard (spec 079 §5): Settings → Curator → Import. The cutoffs
// are shown read-only — they are frozen by the server and never edited.

import {
  ImportConfigError,
  MAX_IMPORT_ALLOWANCE,
  MAX_IMPORT_MAX_AGE_DAYS,
  freezeImportCutoffs,
  ledgerSize,
  readImportConfig,
  writeImportConfig,
} from "@librarian/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

const ImportConfigPatchSchema = z.strictObject({
  maxAgeDays: z.number().int().min(1).max(MAX_IMPORT_MAX_AGE_DAYS).optional(),
  allowanceRemaining: z.number().int().min(0).max(MAX_IMPORT_ALLOWANCE).optional(),
});

export const importRouter = router({
  config: adminProcedure.query(({ ctx }) => {
    freezeImportCutoffs(ctx.store);
    return { ...readImportConfig(ctx.store), conversationsRecorded: ledgerSize(ctx.store.dataDir) };
  }),
  setConfig: adminProcedure.input(ImportConfigPatchSchema).mutation(({ ctx, input }) => {
    try {
      writeImportConfig(ctx.store, input);
    } catch (error) {
      if (error instanceof ImportConfigError) {
        throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
      }
      throw error;
    }
    return readImportConfig(ctx.store);
  }),
});
