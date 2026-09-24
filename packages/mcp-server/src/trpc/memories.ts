// Memory tRPC procedures.
//
// Typed read/write surface for the dashboard: list/get/recall/aggregates,
// create/update/delete memories, proposal approve/reject, and
// related-memory similarity. All procedures are admin-gated EXCEPT the four
// browse-slice reads spec 065 SC 7 deliberately moved to `memberProcedure`
// WITH principal-scoped store surfaces in the same change (`list`,
// `distinctValues`, `tagCounts`, `recall` — the fifth slice procedure is
// `vault.searchReferences`); post-ADR-0008-P3 the gate is the network
// boundary — this surface is served only on the trusted internal tRPC
// listener, which the default provider resolves to the admin role.
//
// Note on `as Record<string, unknown>` casts: the store APIs in
// @librarian/core (createMemory, listMemories, updateMemory, …) still
// accept loose record inputs because the JS-era surface hasn't been
// tightened yet. Tightening core's signatures is tracked as a Phase 4
// follow-up; the casts at this boundary are safe because the Zod input
// schemas validate before the cast runs.

import {
  type LibrarianStore,
  type MemoryCorrectionWork,
  type Principal,
  type ProposalDrift,
  type Shelf,
  MemoryAlreadyOnShelfError,
  MemoryMoveDestinationExistsError,
  MemoryMoveUnsafePathError,
  MemoryNotFoundForPrincipalError,
  ShelfNotWritableError,
  type SplitReplacement,
  augmentBody,
  driftedSources,
  mergeMemory,
  normaliseCallerId,
  preservesOriginal,
  proposalDrift,
  redactSecrets,
  splitMemory,
  unifiedMemoryDiff,
  validateShelfSet,
} from "@librarian/core";
import { MemoryInputSchema, MemoryPatchSchema, MemoryStatusSchema } from "@librarian/core/schemas";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { resolveActorDisplays } from "./actor-displays.js";
import { adminProcedure, memberProcedure, router } from "./trpc.js";

// `MemoryShape` mirrors `Memory` from `@librarian/core/store-internal`
// without re-using the exported name. Inlining keeps the inferred
// `memoriesRouter` / `appRouter` types portable — after sessions-rethink
// PR 7 narrowed `LibrarianStore`, the only path TS could find for `Memory`
// was the deep `@librarian/core/dist/store/memory-store.js` import, which
// fires TS2742. Casting every store result through this local shape keeps
// the named type out of the inferred chain.
export interface MemoryShape {
  id: string;
  agent_id: string;
  status: string;
  tags: string[];
  applies_to: string[];
  supersedes: string[];
  conflicts_with: string[];
  // Open agent flags routing this memory to review (spec 047 / ADR 0006).
  // Surfaced so the dashboard's flagged-review queue can show the reason +
  // flagger for each open flag.
  flags: { agent_id: string; reason: string; created_at: string }[];
  title: string;
  body: string;
  confidence: string;
  updated_at: string;
  curator_note?: Record<string, unknown> | null;
  is_global: boolean;
  requires_approval: boolean;
  shelfId?: string;
  shelfLabel?: string;
  shelfWritable?: boolean;
  correction_work?: MemoryCorrectionWork[];
  correction_proposal?: MemoryShape | null;
  [key: string]: unknown;
}

// Admin dashboard writes attribute to the CONTEXT PRINCIPAL's actor (spec 061 SC 5) —
// `ctx.principal.actorId`, which the internal listener resolves to the reserved
// `dashboard-admin` actor by isolation (ADR 0008 P3), so stored frontmatter is
// unchanged. The former per-file hardcode of that reserved actor is retired (§6/§7.5,
// the acceptance grep).
const RECALL_DEFAULT_LIMIT = 12;

const SortFieldSchema = z.enum(["created_at", "updated_at", "title"]);
const SortOrderSchema = z.enum(["asc", "desc"]);

const ListMemoriesInputSchema = z.object({
  status: MemoryStatusSchema.optional(),
  agent_id: z.string().optional(),
  tags: z.array(z.string()).optional(),
  shelf: z.string().min(1).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  sort: SortFieldSchema.optional(),
  order: SortOrderSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
});

const IdInputSchema = z.object({ id: z.string().min(1) });
const MoveMemoryInputSchema = z.object({
  id: z.string().min(1),
  shelf: z.string().min(1),
});
const ProposeMoveInputSchema = MoveMemoryInputSchema.extend({
  rationale: z.string().max(2_000).optional(),
});

const UpdateMemoryInputSchema = z.object({
  id: z.string().min(1),
  patch: MemoryPatchSchema,
  agent_id: z.string().optional(),
});

const ArchiveMemoryInputSchema = z.object({
  id: z.string().min(1),
  agent_id: z.string().optional(),
});

// Adjudicate one flagged memory (spec 048 PR-2). `dismiss` clears the open
// flags and leaves the memory active; `archive` archives it then clears the
// flags (so it drops out of both the active list and the review queue).
const ResolveFlagInputSchema = z.object({
  id: z.string().min(1),
  shelf_id: z.string().min(1),
  action: z.enum(["dismiss", "archive"]),
  agent_id: z.string().optional(),
});

// D1.1 — bulk-update + distinctValues input shapes for the dashboard's
// re-home flow and data-driven filter dropdowns. (Memories are project-less,
// so re-home is agent-only now.)
const BulkUpdateMemoryInputSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
  patch: z.object({
    agent_id: z.string().min(1),
  }),
  agent_id: z.string().optional(),
});

// Permanent delete (irreversible from the app): hard-delete ARCHIVED memories.
const PurgeMemoriesInputSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
  agent_id: z.string().optional(),
});

// Mirrors the store's own whitelist — the markdown store throws on any other field.
const DistinctValuesFieldSchema = z.enum(["agent_id"]);
const DistinctValuesInputSchema = z.object({
  field: DistinctValuesFieldSchema,
  include_archived: z.boolean().optional(),
});

// Admin mutation primitives (spec 044 D-5a). merge/split let an admin fix the
// corpus OUTSIDE a curation run, calling the SAME shared store primitives
// (mergeMemory / splitMemory) the curator run path uses. The replacement(s) carry
// the curator's MemoryInput shape (title/body/tags/…); ownership + provenance
// are stamped server-side, never taken from the request.
const MergeMemoryInputSchema = z.object({
  // ≥2 sources — merging fewer than two is a no-op/rename, not a merge.
  source_ids: z.array(z.string().min(1)).min(2),
  replacement: MemoryInputSchema,
  agent_id: z.string().optional(),
});

const SplitMemoryInputSchema = z.object({
  source_id: z.string().min(1),
  // ≥2 replacements — splitting into one is a no-op/rename, not a split.
  replacements: z.array(MemoryInputSchema).min(2),
  agent_id: z.string().optional(),
});

// unmerge (spec 044 D-5b) — `id` is the MERGED target whose merge to reverse.
const UnmergeMemoryInputSchema = z.object({
  id: z.string().min(1),
  agent_id: z.string().optional(),
});

const ApproveProposalInputSchema = z.object({
  id: z.string().min(1),
  shelf_id: z.string().min(1).optional(),
  patch: MemoryPatchSchema.optional(),
  agent_id: z.string().optional(),
});

const RejectProposalInputSchema = z.object({
  id: z.string().min(1),
  shelf_id: z.string().min(1).optional(),
  agent_id: z.string().optional(),
});

const RecallInputSchema = z.object({
  agent_id: z.string().optional(),
  query: z.string().optional(),
  // Any-match tag narrowing — the same knob the recall MCP tool exposes.
  tags: z.array(z.string()).optional(),
  include_private: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

// The legacy store throws plain Error with this prefix when a row is missing;
// principal-scoped store paths use MemoryNotFoundForPrincipalError so an
// off-shelf id is indistinguishable from an absent one. Rewrap either as a
// tRPC NOT_FOUND. Any other error propagates as INTERNAL_SERVER_ERROR.
function rethrowAsNotFound<T>(fn: () => T, message: string): T {
  try {
    return fn();
  } catch (error) {
    if (
      error instanceof MemoryNotFoundForPrincipalError ||
      (error instanceof Error && /No memory found/i.test(error.message))
    ) {
      throw new TRPCError({ code: "NOT_FOUND", message });
    }
    throw error;
  }
}

/**
 * Canonicalise a principal-derived default actor before it lands in frontmatter (spec 061 review
 * fix 4). `ctx.store.createMemory` only trims the id downstream, so a substitute provider's raw
 * `member:sarah` `actorId` would split off `member-sarah`; run it through the SAME normaliser
 * every bound/body id uses. `dashboard-admin` (the default internal-listener actor) is already
 * canonical (no-op). An empty/blank actorId is left AS-IS — the recorded doc-only contract
 * violation, never validated here.
 */
function canonicalActor(actorId: string): string {
  return actorId.trim() ? normaliseCallerId(actorId) : actorId;
}

function moveRefusal(error: unknown): never {
  if (error instanceof MemoryNotFoundForPrincipalError) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Memory or shelf not found" });
  }
  if (error instanceof MemoryAlreadyOnShelfError) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Memory is already on shelf ${error.shelf.id} — choose a different destination.`,
    });
  }
  if (error instanceof ShelfNotWritableError) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Shelf ${error.shelf.id} is not writable for this move — both source and destination must be writable.`,
    });
  }
  if (error instanceof MemoryMoveDestinationExistsError) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Shelf ${error.shelf.id} already has a file at the destination path — nothing was overwritten.`,
    });
  }
  if (error instanceof MemoryMoveUnsafePathError) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Shelf ${error.shelf.id} cannot be moved through safely — check the vault for symbolic links.`,
    });
  }
  throw error;
}

// The judge's persisted plan, enriched for the review card (proposal-review
// rework 2026-07-01, F2). Read defensively from the free-form curator_note —
// legacy proposals have none of these keys and yield null. The guessed target
// resolves to {id, title, status} (status so the card can downgrade the
// apply-plan affordance); `guessed_target_reason` is machine-readable:
// "not_found" when the id no longer resolves, "archived" when it resolves but
// can't be mutated. The preview diff shows what EXECUTING the plan would do —
// augment weaves the addition (same augmentBody the apply path uses), supersede
// diffs old → planned. All of it is display-only enrichment: the authoritative
// targets/diff path (curator_note.supersedes) is untouched (D10).
export interface ReviewPlan {
  action: string;
  confidence: number | null;
  guessed_target: { id: string; title: string; status: string } | null;
  guessed_target_reason: string | null;
  planned_addition: string | null;
  planned_title: string | null;
  planned_body: string | null;
  planned_tags: string[] | null;
  preview_diff: string | null;
}

export interface ReviewMove {
  target: { id: string; title: string; status: string } | null;
  source_shelf: { id: string; label?: string } | null;
  destination_shelf: { id: string; label?: string } | null;
  failure_reason: "target_not_found" | "target_not_active" | "destination_not_found" | null;
}

function locateMemoryForPrincipal(
  store: LibrarianStore,
  principal: Principal,
  id: string,
): { memory: MemoryShape; shelf: Shelf } | null {
  for (const shelf of store.shelvesForPrincipal(principal)) {
    // SAFETY: the shelf comes from the principal's validated recall set, and the scoped read
    // cannot return a memory from another prefix; this cast only projects its wire DTO fields.
    const memory = store.forShelf(shelf, principal).getMemory(id) as unknown as MemoryShape | null;
    if (memory) return { memory, shelf };
  }
  return null;
}

function destinationForId(shelves: readonly Shelf[], shelfId: string): Shelf | null {
  const bearers = shelves.filter((shelf) => shelf.id === shelfId);
  return bearers.find((shelf) => shelf.writable) ?? bearers[0] ?? null;
}

function reviewShelf(shelf: Shelf): { id: string; label?: string } {
  return { id: shelf.id, ...(shelf.label !== undefined ? { label: shelf.label } : {}) };
}

function exactWritableShelfForPrincipal(
  store: LibrarianStore,
  principal: Principal,
  shelfId: string,
): Shelf | null {
  try {
    const recall = store.shelvesForPrincipal(principal).filter((shelf) => shelf.id === shelfId);
    const writeSet = store.vaultRouter.shelves(principal, "write");
    validateShelfSet(writeSet);
    const writable = writeSet.filter((shelf) => shelf.id === shelfId);
    if (recall.length !== 1 || writable.length !== 1) return null;
    const [recallShelf] = recall;
    const [writeShelf] = writable;
    if (
      !recallShelf ||
      !writeShelf ||
      !recallShelf.writable ||
      !writeShelf.writable ||
      recallShelf.prefix !== writeShelf.prefix
    ) {
      return null;
    }
    return writeShelf;
  } catch {
    // An unmaterializable or invalid router response is not evidence of authority.
    return null;
  }
}

function isFlaggedCorrectionProposal(note: Record<string, unknown> | null | undefined): boolean {
  return note?.source === "flagged_correction" || Object.hasOwn(note ?? {}, "correction");
}

function enrichMove(
  store: LibrarianStore,
  principal: Principal,
  note: Record<string, unknown>,
  action: string | null,
): ReviewMove | null {
  if (action !== "move") return null;
  const targetId = typeof note.guessed_target_id === "string" ? note.guessed_target_id : null;
  const destinationId = typeof note.planned_shelf === "string" ? note.planned_shelf : null;
  const target = targetId ? locateMemoryForPrincipal(store, principal, targetId) : null;
  const destination = destinationId
    ? destinationForId(store.shelvesForPrincipal(principal), destinationId)
    : null;
  const failureReason =
    target === null
      ? "target_not_found"
      : target.memory.status !== "active"
        ? "target_not_active"
        : destination === null
          ? "destination_not_found"
          : null;
  return {
    target: target
      ? { id: target.memory.id, title: target.memory.title, status: target.memory.status }
      : null,
    source_shelf: target ? reviewShelf(target.shelf) : null,
    destination_shelf: destination ? reviewShelf(destination) : null,
    failure_reason: failureReason,
  };
}

function enrichPlan(
  note: Record<string, unknown>,
  action: string | null,
  getMemory: (id: string) => MemoryShape | null,
): ReviewPlan | null {
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const guessedTargetId = str(note.guessed_target_id);
  const plannedAddition = str(note.planned_addition);
  const plannedTitle = str(note.planned_title);
  const plannedBody = str(note.planned_body);
  const plannedTags = Array.isArray(note.planned_tags)
    ? note.planned_tags.filter((t): t is string => typeof t === "string")
    : null;
  // No plan keys at all → a legacy (or grooming-sourced) proposal: plan is null
  // and the row is exactly what it was before the rework.
  if (!guessedTargetId && !plannedAddition && !plannedTitle && !plannedBody) return null;

  const confidence = typeof note.confidence === "number" ? note.confidence : null;
  let guessedTarget: ReviewPlan["guessed_target"] = null;
  let reason: string | null = null;
  if (guessedTargetId) {
    const target = getMemory(guessedTargetId);
    if (!target) {
      reason = "not_found";
    } else {
      guessedTarget = { id: target.id, title: target.title, status: target.status };
      if (target.status !== "active") reason = target.status;
    }
  }

  // Preview what applying the plan would do, when the target is present to
  // preview against. Archived targets still get a preview (informative); a
  // missing one can't.
  let previewDiff: string | null = null;
  const target = guessedTarget ? getMemory(guessedTarget.id) : null;
  if (target && action === "augment" && plannedAddition) {
    previewDiff = unifiedMemoryDiff(target, {
      title: target.title,
      body: augmentBody(target.body, plannedAddition),
    });
  } else if (target && action === "supersede" && plannedBody) {
    previewDiff = unifiedMemoryDiff(target, {
      title: plannedTitle ?? target.title,
      body: plannedBody,
    });
  }

  return {
    action: action ?? "unknown",
    confidence,
    guessed_target: guessedTarget,
    guessed_target_reason: reason,
    planned_addition: plannedAddition,
    planned_title: plannedTitle,
    planned_body: plannedBody,
    planned_tags: plannedTags,
    preview_diff: previewDiff,
  };
}

// Build the createMemory `{ input, options }` for one memory an admin merge/split
// writes (spec 044 D-5a) — the admin analogue of curator-apply.ts's
// `buildCreateCall`. Owner + curator_note (provenance source="admin-chat" +
// supersedes) are stamped server-side. The note's `source` key marks these as
// admin-initiated (not a curation run); `supersedes` records what the new memory
// replaces, so the corpus's provenance graph stays intact.
function adminCreateCall(
  memory: Record<string, unknown>,
  supersedes: string[],
  owner: string,
  auditActor: string,
): SplitReplacement {
  const curatorNote: Record<string, unknown> = { source: "admin-chat" };
  if (supersedes.length > 0) curatorNote.supersedes = supersedes;
  // OWNER vs AUDIT ACTOR (spec 064 F3). The created memory may be OWNED by anyone the admin names
  // (`agent_id`), but the commit TRAILER must be the ACTING principal, never a body-supplied id —
  // so `audit_actor_id` threads the audit actor to createMemory (which reads it for the trailer,
  // falling back to the owner when absent). Without this an admin merge/split forges the "who".
  return {
    input: { ...memory, agent_id: owner },
    options: { curator_note: curatorNote, audit_actor_id: auditActor },
  };
}

/**
 * Type-visible review row. The optional display is additive chrome beside the
 * stable `proposal.agent_id`; declaring it here prevents inference from
 * erasing the field on the provider-absent return branch.
 */
export interface CorrectionHistoryRow {
  source_memory_id: string;
  title: string;
  shelf_id: string;
  shelf_label: string | null;
  applied_at: string;
  outcome: "direct_apply" | "proposal_approved";
  proposal_id: string | null;
}

export interface ProposalReviewRow {
  proposal: MemoryShape;
  action: string | null;
  source: string | null;
  rationale: string | null;
  targets: MemoryShape[];
  diff: string | null;
  plan: ReviewPlan | null;
  move: ReviewMove | null;
  correctionReview?: {
    source_memory_id: string | null;
    shelf_id: string;
    status: "ready" | "blocked";
    reason_code?: string;
  };
  // Whether the memories this proposal supersedes have changed since it was
  // drafted (spec 072 SC 5). `drifted` refuses approve; `unknown` (a legacy row
  // with no recorded digests) never does.
  drift: ProposalDrift;
  actorDisplay?: string;
}

export const memoriesRouter = router({
  // spec 065 SC 7: member tier + principal-scoped in the SAME change (SC 6's rule). The store
  // merges the principal's "recall" shelves by the requested sort key (offset/limit AFTER the
  // merge, duplicate ids resolved by router precedence) and attributes each row's shelf when the
  // set has >1 shelf;
  // with the default router it DELEGATES to the main listMemories — byte-identical (SC 4).
  list: memberProcedure.input(ListMemoriesInputSchema.optional()).query(({ ctx, input }) => {
    // SAFETY: Zod validates filters before the principal-scoped store returns its memory rows;
    // this projection preserves the existing dashboard response envelope.
    return ctx.store.listMemoriesForPrincipal(
      ctx.principal,
      (input ?? {}) as Record<string, unknown>,
    ) as unknown as {
      memories: MemoryShape[];
      total: number;
    };
  }),

  // Active tag catalogue for Browse. The store applies the principal's validated recall-shelf
  // boundary and router-order duplicate resolution before counting, so this read cannot reveal
  // tag names or corpus sizes from an unreadable shelf.
  tagCounts: memberProcedure.query(({ ctx }) => ctx.store.tagCountsForPrincipal(ctx.principal)),

  // Flagged-memory review queue (spec 048 PR-2): every memory with ≥1 open
  // flag, each row carrying its `flags` so the dashboard can show the reason +
  // flagger. A flag never changes status, so these stay `active` until an admin
  // dismisses or archives them via `resolveFlag`.
  listFlagged: adminProcedure.query(({ ctx }) => {
    const { memories } = ctx.store.listMemoriesForPrincipal(ctx.principal, {
      has_open_flags: true,
      limit: 200,
    });
    const rows: MemoryShape[] = [];
    for (const row of /* SAFETY: this query is principal-scoped; each id is re-resolved in its shelf below. */ memories as unknown as MemoryShape[]) {
      const located = locateMemoryForPrincipal(ctx.store, ctx.principal, row.id);
      if (!located) continue;
      const shelfStore = ctx.store.forShelf(located.shelf, ctx.principal);
      const pendingWork = (located.memory.correction_work ?? [])
        .filter((work) => work.status === "proposal_pending" && work.shelf_id === located.shelf.id)
        .at(-1);
      // SAFETY: the id was located in the principal's validated recall shelves, then the
      // correction proposal lookup is confined to that exact shelf-scoped store.
      const correctionProposal = pendingWork
        ? // SAFETY: this lookup is bound to the source id + snapshot and runs on the exact shelf store.
          (shelfStore.getMemoryCorrectionProposal({
            source_memory_id: located.memory.id,
            snapshot_digest: pendingWork.snapshot_digest,
          }) as unknown as MemoryShape | null)
        : null;
      rows.push({
        ...located.memory,
        shelfId: located.shelf.id,
        ...(located.shelf.label !== undefined ? { shelfLabel: located.shelf.label } : {}),
        shelfWritable:
          exactWritableShelfForPrincipal(ctx.store, ctx.principal, located.shelf.id) !== null,
        correction_proposal: correctionProposal,
      });
    }
    return { memories: rows, total: rows.length };
  }),

  // Proposal review enrichment (spec 2026-06-20 proposal-review-ux, T3). For
  // every proposed memory, surface its self-describing provenance + the
  // memories it supersedes, so the dashboard's /proposals queue can badge the
  // action, show the curator's rationale, and render an old→new diff. The
  // diff is built SERVER-SIDE (unifiedMemoryDiff) — the dashboard's posture is
  // "server makes the diff, client renders it" (DiffView). Additive: the pinned
  // list/approve/reject surface is untouched.
  //
  // Per row:
  //   - action/source/rationale: read defensively from curator_note (D2);
  //     intake + grooming both stamp these, but older/agent proposals may not.
  //   - targets: each id in curator_note.supersedes resolved via getMemory;
  //     ids that don't resolve are skipped (fail-soft). Targets stay active
  //     until approval (D4), so a live replacement's target resolves.
  //   - diff: unifiedMemoryDiff(targets[0], proposal) ONLY for a single-target
  //     replacement (update/supersede). create has no target; merge/split have
  //     ≠1 target → diff is null.
  proposalsForReview: adminProcedure.query(({ ctx }): ProposalReviewRow[] => {
    const { memories } = ctx.store.listMemoriesForPrincipal(ctx.principal, {
      status: "proposed",
      limit: 200,
    });
    // SAFETY: principal-scoped proposal rows have the stable memory fields consumed by this DTO.
    const rows: ProposalReviewRow[] = (memories as unknown as MemoryShape[]).flatMap(
      (listedProposal) => {
        const located = locateMemoryForPrincipal(ctx.store, ctx.principal, listedProposal.id);
        if (!located) return [];
        const proposal = located.memory;
        const shelfStore = ctx.store.forShelf(located.shelf, ctx.principal);
        const note = (proposal.curator_note ?? {}) as Record<string, unknown>;
        const action = typeof note.proposed_action === "string" ? note.proposed_action : null;
        const source = typeof note.source === "string" ? note.source : null;
        const rationale = typeof note.rationale === "string" ? note.rationale : null;
        const isCorrection = isFlaggedCorrectionProposal(note);
        const correctionReview = isCorrection
          ? shelfStore.inspectMemoryCorrectionProposal({
              proposal_id: proposal.id,
              shelf_id: located.shelf.id,
            })
          : undefined;
        const readMemory = (id: string): MemoryShape | null => {
          if (isCorrection) {
            // SAFETY: correction source reads must remain in the proposal's exact shelf.
            return shelfStore.getMemory(id) as unknown as MemoryShape | null;
          }
          // SAFETY: principal-scoped lookup refuses ids outside the caller's validated recall set.
          return ctx.store.getMemoryForPrincipal(
            ctx.principal,
            id,
          ) as unknown as MemoryShape | null;
        };

        const supersedes = Array.isArray(note.supersedes)
          ? note.supersedes.filter((s): s is string => typeof s === "string" && s.length > 0)
          : [];
        const targets = supersedes
          .map(readMemory)
          .filter((memory): memory is MemoryShape => memory !== null);
        const [singleTarget] = targets;
        const diff =
          targets.length === 1 && singleTarget ? unifiedMemoryDiff(singleTarget, proposal) : null;
        const plan = isCorrection ? null : enrichPlan(note, action, readMemory);
        const move = enrichMove(ctx.store, ctx.principal, note, action);
        const drift = proposalDrift(note, readMemory);

        return [
          {
            proposal: {
              ...proposal,
              shelfId: located.shelf.id,
              ...(located.shelf.label !== undefined ? { shelfLabel: located.shelf.label } : {}),
              shelfWritable:
                exactWritableShelfForPrincipal(ctx.store, ctx.principal, located.shelf.id) !== null,
            },
            action,
            source,
            rationale,
            targets,
            diff,
            plan,
            move,
            drift,
            ...(correctionReview ? { correctionReview } : {}),
          },
        ];
      },
    );
    const actorDisplays = resolveActorDisplays(
      ctx.actorDisplayProvider,
      rows.map((row) => row.proposal.agent_id),
    );
    if (actorDisplays === undefined) return rows;
    return rows.map((row) => {
      const actorDisplay = Object.hasOwn(actorDisplays, row.proposal.agent_id)
        ? actorDisplays[row.proposal.agent_id]
        : undefined;
      return actorDisplay === undefined ? row : { ...row, actorDisplay };
    });
  }),

  correctionHistory: adminProcedure.query(
    ({ ctx }): { corrections: CorrectionHistoryRow[]; total: number } => {
      const nowMs = Date.now();
      const cutoffMs = nowMs - 30 * 24 * 60 * 60 * 1_000;
      const corrections: CorrectionHistoryRow[] = [];
      for (const shelf of ctx.store.shelvesForPrincipal(ctx.principal)) {
        const shelfStore = ctx.store.forShelf(shelf, ctx.principal);
        for (const memory of shelfStore.listAll()) {
          for (const work of memory.correction_work ?? []) {
            if (work.status !== "applied" || work.shelf_id !== shelf.id || !work.applied_at)
              continue;
            const appliedAtMs = Date.parse(work.applied_at);
            if (!Number.isFinite(appliedAtMs) || appliedAtMs < cutoffMs || appliedAtMs > nowMs)
              continue;
            corrections.push({
              source_memory_id: memory.id,
              title: memory.title,
              shelf_id: shelf.id,
              shelf_label: shelf.label ?? null,
              applied_at: work.applied_at,
              outcome: work.proposal_id ? "proposal_approved" : "direct_apply",
              proposal_id: work.proposal_id ?? null,
            });
          }
        }
      }
      corrections.sort((a, b) => b.applied_at.localeCompare(a.applied_at));
      return { corrections: corrections.slice(0, 200), total: corrections.length };
    },
  ),

  aggregates: adminProcedure.query(({ ctx }) => ctx.store.getAggregates()),

  related: adminProcedure.input(IdInputSchema).query(({ ctx, input }) => {
    const result = ctx.store.getRelated(input.id);
    if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "Memory not found" });
    return /* SAFETY: the admin-only store read returns the stable memory/relationship fields consumed by this DTO. */ result as unknown as {
      memory: MemoryShape;
      related: { memory: MemoryShape; ratio: number; isDuplicate: boolean }[];
    };
  }),

  // A dashboard-created memory is OWNED by the acting principal (spec 061 SC 5/SC 6):
  // an unset `agent_id` attributes to `ctx.principal.actorId` (the internal listener's
  // `dashboard-admin`) rather than the store's `unknown-agent` default — this is the
  // only memories.ts write whose actor lands in persisted frontmatter (the mutation
  // paths pass the actor to store methods that ignore it). An explicit `agent_id`
  // still wins, so an agent-owned create is unchanged. The principal-derived default is
  // CANONICALISED (spec 061 review fix 4) — createMemory only trims downstream, so a
  // substitute provider's raw `member:sarah` actorId would otherwise split off `member-sarah`;
  // `dashboard-admin` is already canonical (no-op), and an empty actorId is left as the recorded
  // doc-only contract violation.
  create: adminProcedure.input(MemoryInputSchema).mutation(
    ({ ctx, input }) =>
      // Write-target enforcement (spec 062 SC 6): the dashboard-created memory lands under the
      // acting principal's `writeTarget` shelf, via the scoped handle. Default router → the main
      // shelf → byte-identical to the old top-level createMemory.
      /* SAFETY: createMemory returns the normalized MemoryStore result projected to this dashboard DTO. */
      ctx.store.forShelf(ctx.store.resolveWriteTarget(ctx.principal), ctx.principal).createMemory(
        {
          ...input,
          agent_id: input.agent_id ?? canonicalActor(ctx.principal.actorId),
        } as Record<string, unknown>,
        // OWNER (frontmatter `agent_id`, a body-supplied id may legitimately own the memory) vs
        // AUDIT ACTOR (the commit trailer — ALWAYS the acting principal, never a body-forged id;
        // spec 064 F3, mirroring merge/split). A default dashboard create leaves `agent_id` unset →
        // owner === actor === the principal, byte-identical to before; but an admin passing
        // `agent_id: "alice"` now records alice as the OWNER while the trailer stays the admin.
        { audit_actor_id: canonicalActor(ctx.principal.actorId) },
      ) as unknown as {
        status: string;
        memory: MemoryShape;
        duplicates: MemoryShape[];
      },
  ),

  // First member-tier write (spec 067 SC 5): every read and the eventual proposal write are
  // scoped to the acting principal. The target/destination resolve only through the principal's
  // recall set; the thin proposal itself lands only on that principal's validated write target.
  proposeMove: memberProcedure.input(ProposeMoveInputSchema).mutation(({ ctx, input }) => {
    const shelves = ctx.store.shelvesForPrincipal(ctx.principal);
    const located = locateMemoryForPrincipal(ctx.store, ctx.principal, input.id);
    if (!located) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Memory or shelf not found" });
    }
    const { memory: target, shelf: sourceShelf } = located;
    if (target.status !== "active") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Memory ${input.id} is ${target.status}, not active — only active memories can be moved.`,
      });
    }

    // Match the primitive's destination identity whenever a writable bearer exists; otherwise the
    // first visible bearer is the proposal's destination. Writability is intentionally NOT
    // required to propose.
    const destinationShelf = destinationForId(shelves, input.shelf);
    if (destinationShelf === null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Memory or shelf not found" });
    }
    if (sourceShelf.id === destinationShelf.id && sourceShelf.prefix === destinationShelf.prefix) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Memory ${input.id} is already on shelf ${input.shelf} — choose a different destination.`,
      });
    }

    const writeTarget = ctx.store.resolveWriteTarget(ctx.principal);
    const proposalStore = ctx.store.forShelf(writeTarget, ctx.principal);
    const openProposals =
      /* SAFETY: the scoped store filters proposal status and returns Memory rows. */ proposalStore.listMemoriesUncapped(
        {
          status: "proposed",
        } as Record<string, unknown>,
      ).memories as unknown as MemoryShape[];
    const duplicate = openProposals.some((proposal) => {
      const note = (proposal.curator_note ?? {}) as Record<string, unknown>;
      return (
        note.proposed_action === "move" &&
        note.guessed_target_id === input.id &&
        note.planned_shelf === input.shelf
      );
    });
    if (duplicate) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `An open proposal already moves ${input.id} to ${input.shelf} — review that proposal instead.`,
      });
    }

    const rawRationale =
      input.rationale?.trim() || `Move “${target.title}” to shelf “${input.shelf}”.`;
    const rationale = redactSecrets(rawRationale).redacted;
    return /* SAFETY: createMemory returns the normalized MemoryStore result projected to this dashboard DTO. */ proposalStore.createMemory(
      {
        title: `Move: ${target.title}`,
        body: rationale,
        agent_id: canonicalActor(ctx.principal.actorId),
      },
      {
        requires_approval: true,
        audit_actor_id: canonicalActor(ctx.principal.actorId),
        curator_note: {
          source: "dashboard",
          proposed_action: "move",
          guessed_target_id: input.id,
          planned_shelf: input.shelf,
          rationale,
        },
      },
    ) as unknown as {
      status: string;
      memory: MemoryShape;
      duplicates: MemoryShape[];
    };
  }),

  // Solo-admin fast path (spec 067 SC 6): the same scoped primitive, with every typed refusal
  // translated into an intentional wire code and teaching message.
  move: adminProcedure.input(MoveMemoryInputSchema).mutation(({ ctx, input }) => {
    try {
      return /* SAFETY: the principal-scoped move returns a Memory row from the selected destination shelf. */ ctx.store.moveMemoryForPrincipal(
        ctx.principal,
        input.id,
        input.shelf,
      ) as unknown as MemoryShape;
    } catch (error) {
      return moveRefusal(error);
    }
  }),

  // The AUDIT ACTOR (the commit trailer + `updated_by`) is ALWAYS the acting principal, never the
  // body-supplied `input.agent_id` (spec 064 F3): the store's `agent_id` param on these verbs is
  // the audit actor, and a body field must not forge the "who". (An owner CHANGE rides `patch`.)
  update: adminProcedure.input(UpdateMemoryInputSchema).mutation(({ ctx, input }) => {
    const located = locateMemoryForPrincipal(ctx.store, ctx.principal, input.id);
    if (
      located?.memory.status === "proposed" &&
      isFlaggedCorrectionProposal(located.memory.curator_note)
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "Flagged-correction proposals are immutable while under review; use the correction approve or reject action.",
      });
    }
    return /* SAFETY: updateMemory throws for missing ids; validated patch + principal actor preserve the Memory DTO. */ rethrowAsNotFound(
      () =>
        ctx.store.updateMemory(
          input.id,
          input.patch as Record<string, unknown>,
          ctx.principal.actorId,
          { allowProtected: true },
        ),
      "Memory not found",
    ) as unknown as MemoryShape;
  }),

  archive: adminProcedure.input(ArchiveMemoryInputSchema).mutation(
    ({ ctx, input }) =>
      /* SAFETY: archiveMemory throws for missing ids and returns the stored Memory document. */
      rethrowAsNotFound(
        () => ctx.store.archiveMemory(input.id, ctx.principal.actorId),
        "Memory not found",
      ) as unknown as MemoryShape,
  ),

  // Adjudicate one flagged memory on the exact shelf shown in the review row.
  // Whole-memory archival remains an explicit human action; archive/dismiss each
  // resolve flags and cancel correction work through one scoped store write.
  resolveFlag: adminProcedure.input(ResolveFlagInputSchema).mutation(({ ctx, input }) => {
    const shelf = exactWritableShelfForPrincipal(ctx.store, ctx.principal, input.shelf_id);
    if (!shelf) throw new TRPCError({ code: "NOT_FOUND", message: "Memory not found" });
    const shelfStore = ctx.store.forShelf(shelf, ctx.principal);
    const result =
      input.action === "archive"
        ? shelfStore.archiveFlaggedMemory(input.id, ctx.principal.actorId)
        : shelfStore.resolveFlags(input.id, ctx.principal.actorId);
    if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "Memory not found" });
    return /* SAFETY: the null-checked result is read/written only in the exact writable shelf above. */ result as unknown as MemoryShape;
  }),

  // Admin merge (spec 044 D-5a): collapse N sources into one target OUTSIDE a
  // curation run. Calls the SAME shared `mergeMemory` primitive the curator run
  // path uses (curator-apply.ts) — create the merged target (superseding the
  // sources, tagged provenance source="admin-chat"), then archive every source.
  // Passing the actor archives the sources (an admin merge auto-applies — there's
  // no run to defer to). Each store mutation lands a git commit (revertable).
  merge: adminProcedure.input(MergeMemoryInputSchema).mutation(({ ctx, input }) => {
    // OWNER (the merged memory's frontmatter agent_id — legitimately settable) vs AUDIT ACTOR (the
    // trailer on the create + on each source archive — ALWAYS the acting principal, spec 064 F3).
    const owner = input.agent_id ?? ctx.principal.actorId;
    const auditActor = ctx.principal.actorId;
    const id = rethrowAsNotFound(
      () =>
        mergeMemory(ctx.store, {
          replacement: adminCreateCall(input.replacement, input.source_ids, owner, auditActor),
          sourceIds: input.source_ids,
          archiveActorId: auditActor,
        }),
      "Memory not found",
    );
    return /* SAFETY: id was just created by mergeMemory in this store. */ ctx.store.getMemory(
      id,
    ) as unknown as MemoryShape;
  }),

  // Admin split (spec 044 D-5a): spin one source into N replacements OUTSIDE a
  // curation run. Calls the SAME shared `splitMemory` primitive the curator run
  // path uses — create every replacement (each superseding the source, tagged
  // source="admin-chat"), then archive the source. Returns the new ids.
  split: adminProcedure.input(SplitMemoryInputSchema).mutation(({ ctx, input }) => {
    // OWNER (each replacement's frontmatter agent_id) vs AUDIT ACTOR (the trailers) — spec 064 F3.
    const owner = input.agent_id ?? ctx.principal.actorId;
    const auditActor = ctx.principal.actorId;
    const ids = rethrowAsNotFound(
      () =>
        splitMemory(ctx.store, {
          sourceId: input.source_id,
          replacements: input.replacements.map((r) =>
            adminCreateCall(r, [input.source_id], owner, auditActor),
          ),
          archiveActorId: auditActor,
        }),
      "Memory not found",
    );
    return { ids };
  }),

  // Admin unmerge / reverse-a-groom (spec 044 D-5b): undo a bad merge. Given the
  // MERGED target's id, read its `curator_note.supersedes` (the source ids the
  // merge collapsed), un-archive every source (restore to active), then archive
  // the merged target. The ordering is data-loss-safe: sources are RESTORED
  // BEFORE the target is archived, so a partial failure can never leave the whole
  // group archived. A memory with no superseded sources is not a merge result —
  // we error rather than silently archive it (which would just lose the row).
  // Each transition lands a git commit (revertable). The provenance of these
  // status transitions is the `dashboard-admin` actor + the commit (curator_note
  // is not patchable in place — same invariant D-5a documented for archive).
  unmerge: adminProcedure.input(UnmergeMemoryInputSchema).mutation(({ ctx, input }) => {
    const actor = ctx.principal.actorId; // audit actor = acting principal, never body-supplied (F3)
    const target =
      /* SAFETY: the explicit not-found check makes this an existing stored Memory. */ rethrowAsNotFound(
        () => {
          const found = ctx.store.getMemory(input.id);
          if (!found) throw new Error(`No memory found for id ${input.id}`);
          return found;
        },
        "Memory not found",
      ) as unknown as MemoryShape;

    const note = (target.curator_note ?? {}) as Record<string, unknown>;
    const rawSupersedes = note.supersedes;
    const supersedes = Array.isArray(rawSupersedes)
      ? rawSupersedes.filter((s): s is string => typeof s === "string" && s.length > 0)
      : [];
    if (supersedes.length === 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Memory ${input.id} is not a merge result — it has no superseded sources to restore.`,
      });
    }

    // Data-loss-safe ordering: restore every source FIRST, then archive the target.
    for (const sourceId of supersedes) {
      rethrowAsNotFound(
        () => ctx.store.unarchiveMemory(sourceId, actor),
        `Superseded source ${sourceId} not found`,
      );
    }
    ctx.store.archiveMemory(input.id, actor);
    return { restored: supersedes, archived: input.id };
  }),

  bulkUpdate: adminProcedure.input(BulkUpdateMemoryInputSchema).mutation(({ ctx, input }) => {
    return ctx.store.bulkUpdateMemory({
      ids: input.ids,
      // The OWNER change is `patch.agent_id`; the AUDIT actor (trailer + updated_by) is the acting
      // principal, never the body-supplied `input.agent_id` (spec 064 F3).
      patch: { agent_id: input.patch.agent_id },
      agent_id: ctx.principal.actorId,
    });
  }),

  // Permanent delete (irreversible from the app). Hard-deletes ARCHIVED memories
  // via store.purgeMemory, which refuses any non-archived memory — so the archive
  // page's bulk delete can never destroy a live memory. Each purge is a git
  // commit (recoverable from history). Returns how many rows were removed; an
  // absent id is a no-op, so a re-run is safe.
  purge: adminProcedure.input(PurgeMemoriesInputSchema).mutation(({ ctx, input }) => {
    const actor = ctx.principal.actorId; // audit actor = acting principal, never body-supplied (F3)
    let purged = 0;
    for (const id of input.ids) {
      if (ctx.store.purgeMemory(id, actor)) purged++;
    }
    return { purged };
  }),

  // spec 065 SC 7: member tier + principal-scoped in the same change — the union of
  // distinctValues over the principal's "recall" shelves (default router: delegation,
  // byte-identical).
  distinctValues: memberProcedure.input(DistinctValuesInputSchema).query(({ ctx, input }) => {
    const args: { field: string; include_archived?: boolean } = { field: input.field };
    if (input.include_archived !== undefined) args.include_archived = input.include_archived;
    return ctx.store.distinctValuesForPrincipal(ctx.principal, args);
  }),

  // Execute a proposal's PERSISTED plan (proposal-review rework 2026-07-01,
  // F3 / D2 / D8): deterministic, guarded application of what the intake judge
  // wanted — never a curator re-run. Guards teach and mutate nothing on
  // failure: the target must still exist and be active, and an augment must
  // preserve the original (the same preservesOriginal no-clobber gate the
  // apply lane uses). On success the TARGET is mutated FIRST, then the
  // proposal is archived stamped `curator_note.resolution: "applied_plan"` —
  // one active home for the fact, no duplicate, no lingering queue entry. The
  // ordering is deliberate: a failure between the two leaves an applied fact
  // plus a still-open proposal (harmless; the admin rejects it), never a
  // consumed proposal whose plan didn't apply.
  applyProposalPlan: adminProcedure.input(IdInputSchema).mutation(({ ctx, input }) => {
    const actor = ctx.principal.actorId;
    const proposalLocation = locateMemoryForPrincipal(ctx.store, ctx.principal, input.id);
    const proposal = proposalLocation?.memory ?? null;
    if (!proposal || !proposalLocation) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
    }
    if (proposal.status !== "proposed") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Memory ${input.id} is ${proposal.status}, not proposed — only an open proposal's plan can be applied.`,
      });
    }
    const note = (proposal.curator_note ?? {}) as Record<string, unknown>;
    if (isFlaggedCorrectionProposal(note)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "Flagged corrections must be reviewed through the exact-shelf approval or rejection action.",
      });
    }
    const action = typeof note.proposed_action === "string" ? note.proposed_action : null;
    const targetId = typeof note.guessed_target_id === "string" ? note.guessed_target_id : null;
    const plannedAddition =
      typeof note.planned_addition === "string" ? note.planned_addition : null;
    const plannedTitle = typeof note.planned_title === "string" ? note.planned_title : null;
    const plannedBody = typeof note.planned_body === "string" ? note.planned_body : null;
    const plannedShelf = typeof note.planned_shelf === "string" ? note.planned_shelf : null;

    const executable =
      (action === "augment" && targetId && plannedAddition) ||
      (action === "supersede" && targetId && plannedBody) ||
      (action === "move" && targetId && plannedShelf);
    if (!executable) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Proposal ${input.id} carries no executable plan — expected augment, supersede, or move plan fields. Use Approve or Discuss instead.`,
      });
    }

    if (action === "move") {
      const targetLocation = locateMemoryForPrincipal(ctx.store, ctx.principal, targetId as string);
      if (!targetLocation) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `The memory this proposal would move (${targetId}) no longer exists — Reject to clear the queue.`,
        });
      }
      if (targetLocation.memory.status !== "active") {
        throw new TRPCError({
          code: "CONFLICT",
          message: `The memory this proposal would move (“${targetLocation.memory.title}”) is ${targetLocation.memory.status}, not active — Reject to clear the queue.`,
        });
      }
      const destination = destinationForId(
        ctx.store.shelvesForPrincipal(ctx.principal),
        plannedShelf as string,
      );
      if (
        destination?.writable &&
        destination.id === targetLocation.shelf.id &&
        destination.prefix === targetLocation.shelf.prefix
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `The memory is already on ${plannedShelf} — Reject to clear the queue.`,
        });
      }

      try {
        ctx.store.moveMemoryForPrincipal(ctx.principal, targetId as string, plannedShelf as string);
      } catch (error) {
        if (
          error instanceof MemoryNotFoundForPrincipalError ||
          error instanceof MemoryAlreadyOnShelfError ||
          error instanceof ShelfNotWritableError ||
          error instanceof MemoryMoveDestinationExistsError ||
          error instanceof MemoryMoveUnsafePathError
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `The move to ${plannedShelf} can no longer be applied (${error.message}) — nothing changed; Reject to clear the queue.`,
          });
        }
        throw error;
      }

      const resolved = rethrowAsNotFound(
        () => ctx.store.resolveProposalForPrincipal(ctx.principal, input.id, "applied_plan", actor),
        "Proposal not found",
      );
      return {
        target:
          /* SAFETY: principal-scoped lookup uses the target id after the successful scoped mutation. */ ctx.store.getMemoryForPrincipal(
            ctx.principal,
            targetId as string,
          ) as unknown as MemoryShape,
        proposal:
          /* SAFETY: resolveProposalForPrincipal returns the proposal row after resolving it. */ resolved as unknown as MemoryShape,
      };
    }

    const targetLocation = locateMemoryForPrincipal(ctx.store, ctx.principal, targetId as string);
    const target = targetLocation?.memory ?? null;
    if (!target || !targetLocation) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `The memory the curator wanted to ${action} (${targetId}) no longer exists — the plan can't be applied. Approve the submission as new, or discuss it with the curator.`,
      });
    }
    if (target.status !== "active") {
      throw new TRPCError({
        code: "CONFLICT",
        message: `The memory the curator wanted to ${action} (“${target.title}”) has since been ${target.status} — the plan can't be applied. Approve the submission as new, or discuss it with the curator.`,
      });
    }

    if (action === "augment") {
      const body = augmentBody(target.body, plannedAddition as string);
      // No-clobber (G5): augmentBody preserves by construction, but verify so a
      // future non-append weave can't slip a clobber through this trusted path.
      if (!preservesOriginal(target.body, body)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Applying the plan would clobber “${target.title}” — the target's content has drifted since the judgment. Discuss it with the curator instead.`,
        });
      }
      try {
        ctx.store
          .forShelf(targetLocation.shelf, ctx.principal)
          .updateMemory(targetId as string, { body }, actor, { allowProtected: true });
      } catch (error) {
        if (error instanceof ShelfNotWritableError) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `The memory the curator wanted to augment is on a read-only shelf — nothing changed.`,
          });
        }
        throw error;
      }
    } else {
      // Supersede: a deliberate replacement (git history holds the prior
      // content) — same semantics as the apply lane, no no-clobber.
      try {
        ctx.store
          .forShelf(targetLocation.shelf, ctx.principal)
          .updateMemory(
            targetId as string,
            { title: plannedTitle ?? target.title, body: plannedBody as string },
            actor,
            { allowProtected: true },
          );
      } catch (error) {
        if (error instanceof ShelfNotWritableError) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `The memory the curator wanted to supersede is on a read-only shelf — nothing changed.`,
          });
        }
        throw error;
      }
    }

    // D8: consume the proposal — archived with provenance, never approve-style
    // (approve would activate it and archive supersedes sources; the fact
    // already lives in the mutated target).
    const resolved = rethrowAsNotFound(
      () => ctx.store.resolveProposalForPrincipal(ctx.principal, input.id, "applied_plan", actor),
      "Proposal not found",
    );
    return {
      target:
        /* SAFETY: this id was resolved in the principal's visible shelf before the mutation. */ ctx.store.getMemoryForPrincipal(
          ctx.principal,
          targetId as string,
        ) as unknown as MemoryShape,
      proposal:
        /* SAFETY: resolveProposalForPrincipal returns this resolved proposal document. */ resolved as unknown as MemoryShape,
    };
  }),

  // Consume a proposal resolved through a proposal-grounded chat (F5 / D9):
  // the confirmed chat action already mutated the corpus (via the generic
  // merge/split/update/unmerge mutations, which know nothing of proposals), so
  // this archives the originating proposal stamped
  // `curator_note.resolution: "resolved_via_chat"` — no lingering queue entry.
  // Chat still proposes, never executes; this runs only after the admin's
  // explicit Confirm.
  resolveViaChat: adminProcedure.input(IdInputSchema).mutation(({ ctx, input }) => {
    const proposal = ctx.store.getMemoryForPrincipal(ctx.principal, input.id);
    if (!proposal) throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
    if (isFlaggedCorrectionProposal(proposal.curator_note)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Flagged corrections must be approved or rejected through exact-shelf review.",
      });
    }
    return /* SAFETY: the guarded principal-scoped resolver returns its proposal row or a mapped not-found error. */ rethrowAsNotFound(
      () =>
        ctx.store.resolveProposalForPrincipal(
          ctx.principal,
          input.id,
          "resolved_via_chat",
          ctx.principal.actorId,
        ),
      "Proposal not found",
    ) as unknown as MemoryShape;
  }),

  approve: adminProcedure.input(ApproveProposalInputSchema).mutation(({ ctx, input }) => {
    const proposalLocation = locateMemoryForPrincipal(ctx.store, ctx.principal, input.id);
    const proposal = proposalLocation?.memory ?? null;
    if (!proposal || !proposalLocation) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
    }
    const note = proposal.curator_note as Record<string, unknown> | null | undefined;
    if (isFlaggedCorrectionProposal(note)) {
      const shelfId = input.shelf_id;
      if (!shelfId || shelfId !== proposalLocation.shelf.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
      }
      const shelf = exactWritableShelfForPrincipal(ctx.store, ctx.principal, shelfId);
      if (!shelf) throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
      const shelfStore = ctx.store.forShelf(shelf, ctx.principal);
      const exactProposal = shelfStore.getMemory(input.id);
      if (!exactProposal || exactProposal.status !== "proposed") {
        throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
      }
      if (input.patch && Object.keys(input.patch).length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A flagged-correction proposal cannot be altered while approving it.",
        });
      }
      const review = shelfStore.inspectMemoryCorrectionProposal({
        proposal_id: exactProposal.id,
        shelf_id: shelf.id,
      });
      if (!review || review.status !== "ready") {
        throw new TRPCError({
          code: "CONFLICT",
          message: `This correction proposal can no longer be approved (${review?.reason_code ?? "not_a_correction_proposal"}); review the current flagged source instead.`,
        });
      }
      const approved = shelfStore.approveMemoryCorrectionProposal({
        proposal_id: exactProposal.id,
        shelf_id: shelf.id,
        agent_id: ctx.principal.actorId,
      });
      if (!approved) throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
      return /* SAFETY: the correction store verified source/flags/content snapshots on this exact shelf. */ approved as unknown as MemoryShape;
    }
    if (proposal.status !== "proposed") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "This proposal is no longer open for review.",
      });
    }
    if (
      proposal?.status === "proposed" &&
      (proposal.curator_note as Record<string, unknown> | null | undefined)?.proposed_action ===
        "move"
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "A move proposal has no content to activate — Apply the move, or Reject.",
      });
    }
    // Drift refusal (spec 072 D3): the memories this proposal supersedes have
    // changed since it was drafted, so activating it would archive the newer
    // text and drop that edit from the active corpus. HARD block — no override
    // input, by decision: an escape hatch that exists is one that gets clicked
    // through, and habituation is what makes a safety gate worthless. The
    // message must carry the re-groom reassurance, or a refusal reads as losing
    // the curator's work and the operator goes looking for a way round it.
    // (`unknown` — a proposal drafted before digests existed — never blocks, D2.)
    if (proposal?.status === "proposed") {
      const drift = proposalDrift(
        proposal.curator_note as Record<string, unknown> | null | undefined,
        (id) =>
          /* SAFETY: each drift source is resolved only through the principal's validated recall set. */ ctx.store.getMemoryForPrincipal(
            ctx.principal,
            id,
          ) as unknown as MemoryShape | null,
      );
      if (drift.status === "drifted") {
        const changed = driftedSources(drift);
        const names = changed.map((s) => (s.title === null ? s.id : `“${s.title}”`));
        const subject =
          names.length === 1
            ? `${names[0]} has changed`
            : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} have changed`;
        const those = names.length === 1 ? "this memory" : "these memories";
        const edits = names.length === 1 ? "that edit" : "those edits";
        throw new TRPCError({
          code: "CONFLICT",
          message:
            `${subject} since this proposal was drafted, so approving it would discard ${edits}. ` +
            `Reject it — the curator re-reads ${those} on its next grooming run and may well ` +
            `propose a similar change against your current version.`,
        });
      }
    }
    const approved = rethrowAsNotFound(
      () =>
        ctx.store.approveProposalForPrincipal(
          ctx.principal,
          input.id,
          "approve",
          (input.patch ?? {}) as Record<string, unknown>,
          input.agent_id ?? ctx.principal.actorId,
        ),
      "Proposal not found",
    );
    if (!approved) throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
    return /* SAFETY: approval was applied by the exact shelf-scoped store and returned its Memory row. */ approved as unknown as MemoryShape;
  }),

  reject: adminProcedure.input(RejectProposalInputSchema).mutation(({ ctx, input }) => {
    const proposalLocation = locateMemoryForPrincipal(ctx.store, ctx.principal, input.id);
    const proposal = proposalLocation?.memory ?? null;
    if (!proposal || !proposalLocation) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
    }
    if (proposal.status !== "proposed") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "This proposal is no longer open for review.",
      });
    }
    const agentId = input.agent_id ?? ctx.principal.actorId;
    let rejected: ReturnType<LibrarianStore["getMemory"]>;
    if (isFlaggedCorrectionProposal(proposal.curator_note)) {
      const shelfId = input.shelf_id;
      if (!shelfId || shelfId !== proposalLocation.shelf.id) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
      }
      const shelf = exactWritableShelfForPrincipal(ctx.store, ctx.principal, shelfId);
      if (!shelf) throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
      const shelfStore = ctx.store.forShelf(shelf, ctx.principal);
      const exactProposal = shelfStore.getMemory(input.id);
      if (!exactProposal || exactProposal.status !== "proposed") {
        throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
      }
      rejected = shelfStore.rejectMemoryCorrectionProposal({
        proposal_id: exactProposal.id,
        shelf_id: shelf.id,
        agent_id: ctx.principal.actorId,
      });
    } else {
      rejected = rethrowAsNotFound(
        () => ctx.store.approveProposalForPrincipal(ctx.principal, input.id, "reject", {}, agentId),
        "Proposal not found",
      );
    }
    if (!rejected) throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
    return /* SAFETY: rejection was applied by the correction-only exact shelf or principal-scoped store above. */ rejected as unknown as MemoryShape;
  }),

  // spec 065 SC 7: member tier + principal-scoped in the same change — delegates to 062's
  // recallForPrincipal (merged multi-shelf recall, provenance labels and all; default router:
  // exactly the old store.recall path, byte-identical).
  recall: memberProcedure.input(RecallInputSchema.optional()).mutation(async ({ ctx, input }) => {
    // Use the SAME hybrid engine the recall MCP tool gives agents (keyword +
    // vector + backlink graph, RRF-fused) — recallForPrincipal, NOT keyword-only
    // store.searchMemories — so the dashboard's Recall tab shows exactly what an
    // agent sees: the principal's own merged shelf view (spec 062 SC 5).
    const memories = await ctx.store.recallForPrincipal(ctx.principal, {
      query: input?.query ?? "",
      ...(input?.tags ? { tags: input.tags } : {}),
      limit: input?.limit ?? RECALL_DEFAULT_LIMIT,
    });
    return {
      memories:
        /* SAFETY: recallForPrincipal returns validated, merged memory rows. */ memories as unknown as MemoryShape[],
    };
  }),
});
