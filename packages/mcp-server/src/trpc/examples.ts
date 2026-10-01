// Intake examples-document admin tRPC procedures (proposal-review rework
// 2026-07-01, F4 / D3).
//
// ONE curator-distilled, git-committed document (`.curator/intake-examples.md`)
// of rejected-submission examples that rides the intake prompt whole (D7) — a
// SIBLING of the addendum (separate provenance: curator-distilled teaching
// material, not operator steering; separate budget: the
// curator.intake.examples_max_bytes knob, default 4096). Edits apply
// immediately; git history is the version trail and rollback is a new
// revertable commit — the same simplified lifecycle as the addendum (D4).
//
//   - get:      the committed examples text + its git version.
//   - set:      commit a new document (the byte cap is enforced in core —
//     setIntakeExamples throws a teaching error over-cap).
//   - rollback: restore the prior committed version as a new commit.
//
// The `distill` mutation (the "Reject & make an example" flow's curator call)
// is added by its own slice (spec task 7). All admin-gated; deliberately no
// consumer-agent surface.

import {
  type LlmClient,
  createGroomingLlmClient,
  distillIntakeExamples,
  readConsumerConfig,
  readExamplesMaxBytes,
  readIntakeExamples,
  resolveConsumerToken,
  setIntakeExamples,
  unifiedMemoryDiff,
  type ConsumerConnection,
  consumerConnection,
} from "@librarian/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

const SetExamplesInputSchema = z.strictObject({ content: z.string() });

// Distill input: the rejected proposal being made an example of, plus the
// admin's optional note on why. The submission text is read server-side from
// the proposal — never trusted from the client.
const DistillInputSchema = z.strictObject({
  proposalId: z.string().min(1),
  note: z.string().optional(),
});

export const examplesRouter = router({
  // The committed examples text + its git version. The dashboard viewer/teach
  // dialog populates from this.
  get: adminProcedure.query(({ ctx }) => readIntakeExamples(ctx.store)),

  // Commit a new examples document — applies on the next intake sweep. The
  // byte cap (curator.intake.examples_max_bytes, default 4096) is enforced by
  // core's setIntakeExamples, which throws a teaching error over-cap.
  set: adminProcedure
    .input(SetExamplesInputSchema)
    .mutation(({ ctx, input }) =>
      setIntakeExamples(ctx.store, input.content, ctx.principal.actorId),
    ),

  // Roll the document back to its prior committed version (a new, revertable
  // roll-back commit — never history rewrite). Returns the outcome plus the
  // fresh document state, mirroring addendum.rollback.
  rollback: adminProcedure.mutation(({ ctx }) => {
    const rollback = ctx.store.rollbackIntakeExamples(ctx.principal.actorId);
    return {
      ...readIntakeExamples(ctx.store),
      restored: rollback.restored,
      restoredVersion: rollback.version,
    };
  }),

  // The "Reject & make an example" flow's curator call (F4, scenario C): the
  // curator receives the CURRENT document + the rejected submission + the
  // admin's note and returns the updated WHOLE document within the cap. PURE —
  // nothing is written and the proposal is untouched; the dialog previews the
  // returned diff and only an explicit confirm commits (examples.set) and then
  // rejects. Uses the same `chat` LLM consumer (+ injectable builder) as the
  // curator chat — an interactive admin-facing call, not an intake sweep.
  distill: adminProcedure.input(DistillInputSchema).mutation(async ({ ctx, input }) => {
    const proposal = ctx.store.getMemory(input.proposalId);
    if (!proposal) throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
    if (proposal.status !== "proposed") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Memory ${input.proposalId} is ${proposal.status}, not proposed — only an open proposal can be made an example.`,
      });
    }

    const llm = readConsumerConfig(ctx.store, "chat");
    if (!llm.isOperational) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "The chat LLM is not configured. Set the chat (or grooming) provider, model, and token first.",
      });
    }
    let token: string | null;
    try {
      token = resolveConsumerToken(ctx.store, "chat");
    } catch {
      token = null;
    }
    if (!token) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "The chat LLM provider has no decryptable token.",
      });
    }
    const buildClient =
      ctx.buildChatClient ??
      ((conn: ConsumerConnection, secret: string): LlmClient =>
        createGroomingLlmClient({ ...conn, token: secret }));
    const client = buildClient(consumerConnection(llm), token);

    const current = readIntakeExamples(ctx.store).content;
    const { content: candidate } = await distillIntakeExamples({
      client,
      currentDoc: current,
      submission: { title: proposal.title, body: proposal.body },
      ...(input.note ? { adminNote: input.note } : {}),
      maxBytes: readExamplesMaxBytes(ctx.store),
    });

    // Server-side diff (the dashboard's "server makes the diff" posture).
    const diff = unifiedMemoryDiff(
      { title: "intake examples", body: current },
      { title: "intake examples", body: candidate },
    );
    return { current, candidate, diff };
  }),
});
