// The journal's admin surface (spec 077 §4.7, §4.11): its settings, the structured
// view the dashboard's Journal page reads, and the owner's permanent deletes. Every
// procedure works on the admin principal's own shelf — the same shelf its agents'
// entries are written to and GET /journal.md serves.
import type { JournalConfigPatch } from "@librarian/core";
import {
  JournalConfigPatchSchema,
  JournalQueryError,
  deleteEpisode,
  deletePeriod,
  isJournalActive,
  journalView,
  localDate,
  parseJournalQueryArgs,
  readJournalConfig,
  searchJournal,
  writeJournalConfig,
} from "@librarian/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

const DayLabel = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected the day as YYYY-MM-DD, e.g. 2026-11-02");
const EpisodeKey = z.string().min(1).max(300);
const PeriodPath = z
  .string()
  .regex(
    /^(days\/\d{4}-\d{2}-\d{2}|weeks\/\d{4}-W\d{2}|months\/\d{4}-\d{2})\.md$/,
    "Expected a journal path like days/2026-11-02.md, weeks/2026-W44.md or months/2026-10.md",
  );

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

  /** Every period on the admin's shelf, newest first, plus whether the journal is live. */
  entries: adminProcedure.query(({ ctx }) => {
    const shelf = ctx.store.resolveWriteTarget(ctx.principal);
    return {
      active: isJournalActive(ctx.store),
      periods: journalView(ctx.store.systemJournal(shelf)),
    };
  }),

  /**
   * Search the journal exactly as the `journal` MCP tool does (spec 077 §4.5): the same
   * argument validation, range defaults, filters, BM25 ranking and tie-break — returned
   * as structured hits for the Journal page instead of agent text.
   */
  search: adminProcedure
    .input(
      z.strictObject({
        query: z.string(),
        from: z.string().optional(),
        to: z.string().optional(),
        project: z.string().optional(),
        harness: z.string().optional(),
        limit: z.number().optional(),
      }),
    )
    .query(({ ctx, input }) => {
      let parsed;
      try {
        parsed = parseJournalQueryArgs(input);
        if (parsed.query === undefined) throw new JournalQueryError("Type something to search for");
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const shelf = ctx.store.resolveWriteTarget(ctx.principal);
      return searchJournal(ctx.store.systemJournal(shelf), parsed, localDate(new Date()));
    }),

  /** Permanently delete one conversation's entry from a day. */
  deleteEpisode: adminProcedure
    .input(z.strictObject({ date: DayLabel, key: EpisodeKey }))
    .mutation(({ ctx, input }) => {
      const shelf = ctx.store.resolveWriteTarget(ctx.principal);
      const deleted = deleteEpisode(ctx.store.systemJournal(shelf), input.date, input.key);
      if (!deleted) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No journal entry ${input.key} on ${input.date} — it may already be deleted.`,
        });
      }
      return { deleted: true as const };
    }),

  /** Permanently delete a whole day, week summary or month summary. */
  deletePeriod: adminProcedure
    .input(z.strictObject({ path: PeriodPath }))
    .mutation(({ ctx, input }) => {
      const shelf = ctx.store.resolveWriteTarget(ctx.principal);
      if (!deletePeriod(ctx.store.systemJournal(shelf), input.path)) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No journal file ${input.path} — it may already be deleted.`,
        });
      }
      return { deleted: true as const };
    }),
});
