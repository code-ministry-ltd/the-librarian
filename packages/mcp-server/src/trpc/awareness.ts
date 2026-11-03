// Primer admin tRPC procedures (spec 041 A1, repointed by rethink T11, reshaped by spec 083).
//
// Since spec 083 the primer is the shipped DEFAULT (in code, always sent, not editable) followed
// by the operator's optional ADDENDUM (`vault/primer.md`, git-committed on every save, ≤2 KB).
// The read returns all three views the dashboard shows: the default, the addendum, and the
// complete primer agents receive, plus whether the migration left an addendum for the owner to
// review. The ≤2 KB cap is enforced by core's setPrimerAddendum; the over-cap throw is surfaced
// as BAD_REQUEST so the dashboard shows the teaching message instead of a 500. Admin-gated,
// mirroring the addendum router (`trpc/addendum.ts`). It lives in its own router rather than
// under `curator` because the primer is harness-awareness, not a curator concern.

import {
  DEFAULT_PRIMER,
  PRIMER_REVIEW_PENDING_KEY,
  primerAddendumMaxBytes,
  primerReviewPending,
  readPrimer,
  readPrimerAddendum,
  setPrimerAddendum,
} from "@librarian/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

export interface PrimerView {
  /** The complete primer agents receive: default, then addendum. */
  primer: string;
  /** The shipped default (read-only). */
  defaultPrimer: string;
  /** The operator's addendum ("" when none). */
  addendum: string;
  /** The longest addendum (UTF-8 bytes) that keeps the complete primer within 2 KB. */
  addendumMaxBytes: number;
  /** True while a pre-083 primer, moved into the addendum, awaits the owner's review. */
  reviewPending: boolean;
}

type PrimerViewStore = Parameters<typeof readPrimer>[0] & Parameters<typeof primerReviewPending>[0];

function view(store: PrimerViewStore): PrimerView {
  return {
    primer: readPrimer(store),
    defaultPrimer: DEFAULT_PRIMER,
    addendum: readPrimerAddendum(store),
    addendumMaxBytes: primerAddendumMaxBytes(),
    reviewPending: primerReviewPending(store),
  };
}

export const awarenessRouter = router({
  primer: adminProcedure.query(({ ctx }) => view(ctx.store)),

  // Save the addendum (git-committed; the next MCP initialize and /primer.md fetch carry it).
  // "" clears it, leaving the default alone. Over 2 KB is refused. Saving clears the review
  // notice.
  setAddendum: adminProcedure
    .input(z.strictObject({ addendum: z.string() }))
    .mutation(({ ctx, input }) => {
      try {
        setPrimerAddendum(ctx.store, input.addendum, ctx.principal.actorId);
      } catch (error) {
        throw new TRPCError({ code: "BAD_REQUEST", message: (error as Error).message });
      }
      return view(ctx.store);
    }),

  // Dismiss the migration review notice without changing the addendum.
  dismissReview: adminProcedure.mutation(({ ctx }) => {
    ctx.store.deleteSetting(PRIMER_REVIEW_PENDING_KEY);
    return view(ctx.store);
  }),
});
