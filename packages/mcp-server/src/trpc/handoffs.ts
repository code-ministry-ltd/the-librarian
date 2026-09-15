// Handoff tRPC procedures (sessions-rethink spec §6.7).
//
// Dashboard surface: the reads render the markdown document + metadata;
// claim is an agent-only operation via the MCP layer; `purge` is the
// admin-only permanent delete the v1 header deferred ("batch purge is YAGNI
// for v1") — it is the backing procedure for the dashboard's delete buttons.
// Each purge hard-deletes the handoff document; the deletion is a git commit
// in the vault, so it is recoverable from history but not from the app.

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

const ListInputSchema = z.object({
  project_key: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  harness: z.string().nullable().optional(),
  include_claimed: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const ByIdInputSchema = z.object({
  handoff_id: z.string().min(1),
});

export const handoffsRouter = router({
  list: adminProcedure.input(ListInputSchema.optional()).query(({ ctx, input }) => {
    const { include_claimed, limit, project_key, cwd, harness } = input ?? {};
    const details = ctx.store.handoffs.listDetails(
      { project_key, cwd, harness, limit: limit ?? 50 },
      { includeClaimed: include_claimed ?? false },
    );
    return details.map((d) => ({
      handoff_id: d.handoff_id,
      title: d.title,
      project_key: d.project_key,
      source_ref: d.source_ref,
      cwd: d.cwd,
      created_by_agent_id: d.created_by_agent_id,
      created_in_harness: d.created_in_harness,
      tags: d.tags,
      created_at: d.created_at,
      claimed_at: d.claimed_at,
      claimed_by: d.claimed_by,
    }));
  }),

  byId: adminProcedure.input(ByIdInputSchema).query(({ ctx, input }) => {
    const detail = ctx.store.handoffs.getById(input.handoff_id);
    if (!detail) throw new TRPCError({ code: "NOT_FOUND", message: "Handoff not found" });
    return detail;
  }),

  // Permanent delete (the dashboard's delete buttons). Hard-deletes regardless
  // of claim status; the actor is the CONTEXT PRINCIPAL (spec 061 SC 5) so the
  // vault commit carries the `Librarian-Actor` trailer, never a body-supplied id.
  purge: adminProcedure.input(ByIdInputSchema).mutation(({ ctx, input }) => {
    const actor = ctx.principal.actorId;
    const purged = ctx.store.handoffs.purge(input.handoff_id, actor);
    if (!purged) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Handoff not found: ${input.handoff_id}`,
      });
    }
    return { purged: true, handoff_id: input.handoff_id };
  }),
});
