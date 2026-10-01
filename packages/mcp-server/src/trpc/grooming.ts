// Grooming admin tRPC procedures (memory-curator spec §7.1 / §13). This is the
// `grooming` router (was the misnamed `curator` router, plan 046 R2); the memory
// chat lives here too — it is a grooming feature (spec 045 Vocabulary).
//
// The admin cockpit's typed surface: read/update the grooming job's NON-LLM config
// (enable flag, schedule, auto-apply posture), read-only run + operation
// observability, and the run-now control. All admin-gated — there is
// deliberately NO consumer-agent surface for curation (§12). The LLM connection
// is no longer part of this surface — named providers + per-consumer model
// selection live under the `llm` router (042 §4). The prompt addendum left this
// surface in spec 044 D-1 — it's a committed vault file now (its dashboard editor
// is D7); this router no longer reads or writes it.

import type {
  ChatGroomingOp,
  ChatIntakeOp,
  ChatJob,
  ChatMemoryGrounding,
  ChatProposalGrounding,
  ChatResponse,
  GroomingConfigPatch,
  LibrarianStore,
  ListCurationRunsInput,
  LlmClient,
  ConsumerConnection,
} from "@librarian/core";
import {
  GroomingConfigPatchSchema,
  consumerConnection,
  createGroomingLlmClient,
  inferChatJob,
  readConsumerConfig,
  readGroomingConfig,
  readJobAddendum,
  resolveConsumerToken,
  runChatTurn,
  runGroomingTick,
  writeGroomingConfig,
} from "@librarian/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { logger } from "../logging.js";
import { adminProcedure, router } from "./trpc.js";

const ListRunsInputSchema = z.strictObject({
  status: z.string().optional(),
  trigger: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

// Input for grooming.chat (spec 044 D-6b). A request/response (NO streaming) chat
// turn: the conversation so far + an optional memory to ground in + an optional job
// override (inferred from the memory's decision history when unset).
const ChatRoleSchema = z.enum(["system", "user", "assistant"]);
const ChatInputSchema = z.strictObject({
  messages: z
    .array(z.strictObject({ role: ChatRoleSchema, content: z.string() }))
    .min(1)
    .max(50),
  memoryId: z.string().min(1).optional(),
  job: z.enum(["intake", "grooming"]).optional(),
});

// How many recent curation/intake runs to scan for a memory's decision
// history. The stores have no per-memory op index, so we scan recent runs and
// filter; a bounded scan keeps a chat turn fast on a large corpus (the history is
// grounding context, not an audit — recent decisions are what matter).
const CHAT_HISTORY_RUN_SCAN = 100;

// Bounds on the superseded sources a proposal-grounded chat carries (spec 072
// D6). A merge can name many memories; the prompt must stay finite. Five is
// enough to reason about a consolidation, and the body cap matches the grooming
// evidence limit so a source reads the same here as it does to the curator.
const MAX_GROUNDED_SOURCES = 5;
const MAX_GROUNDED_SOURCE_BODY_CHARS = 4000;

/**
 * Gather a memory's grounding bundle — the memory itself + its grooming decisions
 * (curation ops whose source/target memory ids include it) + its intake decisions
 * (intake ops whose source/target id is it). Fail-soft: a missing memory or
 * any store hiccup returns null (the chat turn then runs un-grounded rather than
 * throwing — decision D-9 "degrade, never block").
 */
function gatherChatGrounding(store: LibrarianStore, memoryId: string): ChatMemoryGrounding | null {
  try {
    const memory = store.getMemory(memoryId);
    if (!memory) return null;

    const groomingOps: ChatGroomingOp[] = [];
    for (const run of store.listCurationRuns({ limit: CHAT_HISTORY_RUN_SCAN })) {
      for (const op of store.getCurationOperations(run.id)) {
        if (op.source_memory_ids.includes(memoryId) || op.target_memory_ids.includes(memoryId)) {
          groomingOps.push({
            operation_type: op.operation_type,
            status: op.status,
            rationale: op.rationale,
            source_memory_ids: op.source_memory_ids,
            target_memory_ids: op.target_memory_ids,
          });
        }
      }
    }

    const intakeOps: ChatIntakeOp[] = [];
    for (const run of store.listIntakeRuns({ limit: CHAT_HISTORY_RUN_SCAN })) {
      for (const op of store.getIntakeOperations(run.id)) {
        if (op.source_id === memoryId || op.target_id === memoryId) {
          intakeOps.push({
            action: op.action,
            outcome: op.outcome,
            rationale: op.rationale,
            target_id: op.target_id,
          });
        }
      }
    }

    // Proposal-grounded chat (proposal-review rework F5 / D4): when the
    // grounded memory is an OPEN PROPOSAL, extend the grounding with the
    // judge's persisted plan (D1 curator_note keys) + the resolved guessed
    // target — read defensively; legacy plan-less proposals get plan: null.
    let proposal: ChatProposalGrounding | undefined;
    if (memory.status === "proposed") {
      const note = (memory.curator_note ?? {}) as Record<string, unknown>;
      const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
      const guessedTargetId = str(note.guessed_target_id);
      const hasPlan =
        guessedTargetId !== null ||
        str(note.planned_addition) !== null ||
        str(note.planned_title) !== null ||
        str(note.planned_body) !== null;
      const target = guessedTargetId ? store.getMemory(guessedTargetId) : null;
      proposal = {
        proposed_action: str(note.proposed_action),
        rationale: str(note.rationale),
        plan: hasPlan
          ? {
              guessed_target_id: guessedTargetId,
              planned_addition: str(note.planned_addition),
              planned_title: str(note.planned_title),
              planned_body: str(note.planned_body),
              planned_tags: Array.isArray(note.planned_tags)
                ? note.planned_tags.filter((t): t is string => typeof t === "string")
                : null,
              confidence: typeof note.confidence === "number" ? note.confidence : null,
            }
          : null,
        guessed_target: target
          ? { id: target.id, title: target.title, body: target.body, status: target.status }
          : null,
        // The memories this proposal REPLACES, at their CURRENT text (spec 072
        // SC 9). `guessed_target_id` above is an intake-only key, so a grooming
        // merge/update used to reach the model without the very memories under
        // discussion — leaving "Discuss" unable to do the one thing the
        // operator opens it for. Capped and truncated (D6): a wide merge must
        // not blow out the prompt. Ids that no longer resolve are dropped
        // fail-soft, exactly as the review row does.
        superseded_sources: (Array.isArray(note.supersedes) ? note.supersedes : [])
          .filter((id): id is string => typeof id === "string" && id.length > 0)
          .slice(0, MAX_GROUNDED_SOURCES)
          .map((id) => store.getMemory(id))
          .filter((m): m is NonNullable<typeof m> => m !== null)
          .map((m) => ({
            id: m.id,
            title: m.title,
            body: m.body.slice(0, MAX_GROUNDED_SOURCE_BODY_CHARS),
            status: m.status,
          })),
      };
    }

    return {
      memory: { id: memory.id, title: memory.title, body: memory.body, status: memory.status },
      groomingOps,
      intakeOps,
      ...(proposal ? { proposal } : {}),
    };
  } catch (error) {
    // Fail-soft: grounding is best-effort. Never let a missing memory / store error
    // out of the chat turn — log + fall through to an un-grounded turn.
    logger.warn({ err: error, memoryId }, "grooming.chat grounding failed; running un-grounded");
    return null;
  }
}

export const groomingRouter = router({
  // Current NON-LLM grooming config.
  config: adminProcedure.query(({ ctx }) => readGroomingConfig(ctx.store)),

  // Update config; returns the fresh readable config. writeGroomingConfig is the
  // single source of truth for the deeper invariants (confidence range, interval_days
  // ≥ 1, schedule_time HH:MM, etc., spec 045 D-3); its teaching error is surfaced as a
  // BAD_REQUEST tRPC error (a bad cadence is caller input, not a 500).
  setConfig: adminProcedure.input(GroomingConfigPatchSchema).mutation(({ ctx, input }) => {
    try {
      // Cast at the validated boundary: Zod `.optional()` infers `T | undefined`,
      // which the patch type (optional-key, not undefined-value) rejects under
      // exactOptionalPropertyTypes. The schema already validated the shape.
      writeGroomingConfig(ctx.store, input as GroomingConfigPatch);
    } catch (error) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
    }
    return readGroomingConfig(ctx.store);
  }),

  // Observability: run history (most recent first) + per-run operations.
  runs: adminProcedure
    .input(ListRunsInputSchema.optional())
    .query(({ ctx, input }) => ctx.store.listCurationRuns((input ?? {}) as ListCurationRunsInput)),

  runOperations: adminProcedure
    .input(z.strictObject({ runId: z.string().min(1) }))
    .query(({ ctx, input }) => ctx.store.getCurationOperations(input.runId)),

  // Admin run-now: shares the scheduler enqueue path (manual trigger, bypasses the
  // input-hash skip so it re-grooms even unchanged slices). ADMIN OVERRIDE (spec 045
  // D-4) — `allowDisabled: true` drops the `config.enabled` gate so a DISABLED job
  // still grooms on demand; run-now goes through the tick directly so it ALSO bypasses
  // the scheduled due-check. The LLM-config/token gates inside the tick still apply,
  // so a disabled-but-unconfigured job surfaces `incomplete_config` / `no_token` (never
  // "disabled") for the dashboard (T11). Synchronous — the admin awaits the summary.
  runNow: adminProcedure.mutation(({ ctx }) =>
    runGroomingTick({ store: ctx.store, trigger: "manual", bypassSkip: true, allowDisabled: true }),
  ),

  // Grooming chat (spec 044 D-6b / decisions D-5/6/8/9/10): a request/response (NO
  // streaming) admin endpoint to discuss a memory — or chat generally — with the
  // grooming LLM, GROUNDED in the memory + its real decision history, returning prose
  // OR a structured proposed action the admin then CONFIRMS.
  //
  // PROPOSE, NEVER EXECUTE (human-in-the-loop): a fix-now suggestion comes back as a
  // `proposed_action` whose `action` validates against the EXACT D5 memoriesRouter
  // input schema (merge / split / update / unmerge) — the dashboard passes it
  // straight to that mutation. This endpoint touches NO store memory; the admin
  // confirms and the existing mutation runs.
  //
  // LLM = the `chat` consumer (spec 044 D-6a), which falls back WHOLE-CONSUMER to
  // grooming when chat's own config is unset. Resolution mirrors the tick: read the
  // consumer config + decrypt its token + build the OpenAI-compatible client. The
  // bearer token never leaves the client (never logged, never in the prompt/response).
  //
  // Fail-soft throughout: a missing memory / empty history degrades to an un-grounded
  // turn; an unparseable / invalid model completion degrades to a `message`. The only
  // hard error is a non-runnable chat consumer (no provider/token) — there's nothing
  // to talk to, so we surface a clear PRECONDITION_FAILED rather than pretend.
  chat: adminProcedure
    .input(ChatInputSchema)
    .mutation(async ({ ctx, input }): Promise<ChatResponse> => {
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

      // Ground in the memory + its decision history (fail-soft: null → un-grounded).
      const grounding = input.memoryId ? gatherChatGrounding(ctx.store, input.memoryId) : null;

      // Infer-then-ask (decision D-9): use the caller's job if given, else infer it
      // from the memory's decision history, else default (grooming).
      const job: ChatJob =
        input.job ??
        (grounding
          ? inferChatJob({ groomingOps: grounding.groomingOps, intakeOps: grounding.intakeOps })
          : "grooming");

      // The committed addendum for the (inferred) job — advisory grounding, redacted
      // by the prompt builder. Fail-soft "" when absent.
      const addendum = readJobAddendum(ctx.store, job).content;

      return runChatTurn({
        client,
        ...(grounding ? { grounding } : {}),
        job,
        ...(addendum ? { addendum } : {}),
        messages: input.messages,
        // Corpus search for the chat's mid-turn { kind: "search" } requests —
        // the SAME hybrid engine (keyword + vector + backlinks, RRF-fused) the
        // recall MCP verb gives agents, so the curator sees what an agent
        // would. Bounded inside runChatTurn (3 searches/turn, redacted,
        // truncated); a throw degrades the turn, never fails it.
        searchMemories: async (query) => {
          const memories = (await ctx.store.recall({ query, limit: 8 })) as unknown as {
            id: string;
            title: string;
            body: string;
            status: string;
          }[];
          return memories.map((m) => ({
            id: m.id,
            title: m.title,
            body: m.body,
            status: m.status,
          }));
        },
      });
    }),
});
