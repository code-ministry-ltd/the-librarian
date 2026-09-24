// Memory store — shared type contract.
//
// The memory types (`Memory`, `MemoryStore`) the markdown store implements.
// The store modules re-export these from their old paths for back-compat.
//
// `Memory` is a CLOSED object type — it lists exactly the fields the markdown
// store persists and reads, with no `Record<string, unknown>` escape hatch (so
// a stale fixture setting a removed field is a typecheck error, not a silent
// pass). It deliberately does NOT equal the Zod-derived `Memory` from
// @librarian/core/schemas — the two have diverged: the store type carries
// `flags`, the schema does not; the schema makes `agent_id` nullable, the
// store does not. The few by-name dynamic field reads in the store (e.g.
// `getAggregates`'s `tally(field)`, the `listMemories` sort key) narrow `field`
// to a `keyof Memory` union at the call site rather than reopening the type.

import type { MemoryStatus } from "../schemas/common.js";
import type { MemoryCorrectionSpan } from "../memory-correction.js";

/**
 * An agent's open flag against a memory (spec 047 / ADR 0006). A flag is a
 * negative-only signal — "this memory is incorrect / misleading / outdated" —
 * stored as a list on the memory doc (same storage method `proposed` uses, no
 * separate ledger). A flag never changes the memory's status; it routes the
 * memory to review and soft-demotes it in recall. Multiple agents may flag.
 */
export interface MemoryFlag {
  agent_id: string;
  reason: string;
  created_at: string;
}

/**
 * Server-owned work marker for one reviewed flag snapshot. It stores digests and
 * routing metadata only—never the source body or flag reasons—so recovery can
 * resume without copying private content into an operational queue.
 */
export type MemoryCorrectionWorkStatus =
  "pending" | "processing" | "proposal_pending" | "manual_review" | "applied" | "cancelled";
export type CorrectionManualReviewReasonCode =
  "no_admin_scope" | "no_worker_scope" | "custom_router_unverified";

export interface MemoryCorrectionWork {
  snapshot_digest: string;
  source_digest: string;
  flags_digest: string;
  principal_id: string;
  shelf_id: string;
  status: MemoryCorrectionWorkStatus;
  attempt_count: number;
  queued_at: string;
  next_attempt_at?: string;
  lease_expires_at?: string;
  applied_at?: string;
  proposal_id?: string;
  reason_code?: string;
}

export interface MemoryCorrectionWorkItem {
  memory_id: string;
  work: MemoryCorrectionWork;
}

export interface MemoryCorrectionProposalReview {
  source_memory_id: string | null;
  shelf_id: string;
  status: "ready" | "blocked";
  reason_code?: string;
}

export interface MemoryCorrectionProposalInput {
  source_memory_id: string;
  snapshot_digest: string;
  source_digest: string;
  flags_digest: string;
  claim_attempt: number;
  shelf_id: string;
  proposed_body: string;
  spans: readonly MemoryCorrectionSpan[];
  confidence: number;
  rationale: string;
  agent_id: string;
}

export interface Memory {
  id: string;
  agent_id: string;
  status: string;
  tags: string[];
  applies_to: string[];
  supersedes: string[];
  conflicts_with: string[];
  // Open agent flags routing this memory to review (spec 047 / ADR 0006).
  // Default []. A non-empty list soft-demotes the memory in recall but never
  // changes its status.
  flags: MemoryFlag[];
  /** Durable targeted-correction work/history; absent on memories with no new work. */
  correction_work?: MemoryCorrectionWork[];
  title: string;
  body: string;
  confidence: string;
  created_at: string;
  updated_at: string;
  /**
   * The LAST principal to mutate this memory (spec 064 SC 4 / Q2: last-writer, not a
   * history array — git holds the full chain). Optional + additive: absent on creation
   * (the creator is `agent_id`) and on any anonymous write, set to the acting principal on
   * every attributed mutation. Only trailer-eligible actors are stamped (never
   * `unknown-agent`), so it matches the commit's `Librarian-Actor` trailer.
   */
  updated_by?: string;
  curator_note?: Record<string, unknown> | null;
  // Routing booleans — set only by admin/curator via the trusted options
  // channel (the classifier was deleted, rethink T4), surfaced for the
  // proposal flow + dashboard. (Domain scoping was removed in D16.)
  is_global: boolean;
  requires_approval: boolean;
}

export interface MemoryStore {
  listAll: (filters?: Record<string, unknown>) => Memory[];
  listMemories: (filters?: Record<string, unknown>) => {
    memories: Memory[];
    total: number;
    limit: number;
    offset: number;
  };
  // UNCAPPED filtered + sorted enumeration (spec 065 SC 7): the same filter/sort semantics as
  // `listMemories`, with NO limit clamp and NO internal slice. Exists because the merged
  // principal-scoped list pages AFTER the cross-shelf merge, so it needs every per-shelf row —
  // `listMemories`'s 200-cap would silently truncate any merged page past rank 200 per shelf.
  listMemoriesUncapped: (filters?: Record<string, unknown>) => {
    memories: Memory[];
    total: number;
  };
  getAggregates: () => {
    agents: { value: unknown; count: number }[];
    statuses: { value: unknown; count: number }[];
    total: number;
  };
  getRelated: (id: string) => null | {
    memory: Memory;
    related: { memory: Memory; ratio: number; isDuplicate: boolean }[];
  };
  getMemory: (id: string) => Memory | null;
  searchMemories: (input?: Record<string, unknown>) => Memory[];
  detectRelated: (candidate: Memory, options?: { threshold?: number }) => { duplicates: Memory[] };
  createMemory: (
    input: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => {
    status: MemoryStatus.Active | MemoryStatus.Proposed;
    memory: Memory;
    duplicates: Memory[];
  };
  updateMemory: (
    id: string,
    patch?: Record<string, unknown>,
    agent_id?: string,
    options?: { allowProtected?: boolean },
  ) => Memory | null;
  bulkUpdateMemory: (input: { ids: string[]; patch: { agent_id?: string }; agent_id?: string }) => {
    transaction_id: string;
    updated: number;
  };
  distinctValues: (input: { field: string; include_archived?: boolean }) => string[];
  // Caller-backfill read seam (F0): group memory counts per stored agent id, and
  // list the memory ids owned by one agent — so backfill never touches store.db.
  countMemoriesByAgentId: () => { agent_id: string; count: number }[];
  listMemoryIdsByAgentId: (agentId: string) => string[];
  archiveMemory: (id: string, agent_id?: string) => Memory | null;
  // Dashboard action: archive the whole target, clear its flags, and cancel
  // correction work in the same memory-document persist.
  archiveFlaggedMemory: (id: string, agent_id?: string) => Memory | null;
  // The narrow inverse of archiveMemory (spec 044 D-5b): restore an archived
  // memory to Active (idempotent on an already-active row). Drives admin unmerge.
  unarchiveMemory: (id: string, agent_id?: string) => Memory | null;
  // Permanently delete an ARCHIVED memory: hard-deletes the vault document (the
  // narrow archive=move exception) + commits; the disposable index drops the row
  // on rebuild. Archived-only — throws for an active/proposed memory (archive it
  // first). Idempotent: an already-absent id is a no-op returning null.
  purgeMemory: (id: string, agent_id?: string) => Memory | null;
  // Flag a memory as incorrect/misleading/outdated (spec 047 / ADR 0006).
  // Appends an open flag to the doc's `flags` list; never changes status
  // (route-to-review, never archive). `agent_id` is the calling agent,
  // resolved server-side. Fail-soft: unknown id → null.
  flagMemory: (id: string, reason: string, agent_id?: string) => Memory | null;
  // Atomically persist an agent flag with a digest-only targeted-correction marker.
  flagMemoryForCorrection: (input: {
    id: string;
    reason: string;
    agent_id: string;
    principal_id: string;
    shelf_id: string;
    manual_review_reason_code?: CorrectionManualReviewReasonCode;
  }) => Memory | null;
  // Enumerate pending/expired work and terminal proposal outcomes awaiting source reconciliation.
  listDueMemoryCorrections: (at?: string) => MemoryCorrectionWorkItem[];
  // Claim pending/due work or reclaim an expired lease; attempts are bounded.
  claimMemoryCorrection: (input: {
    id: string;
    snapshot_digest: string;
    lease_ms?: number;
    agent_id?: string;
  }) => MemoryCorrectionWork | null;
  // Update only the currently fenced claim after rechecking its source/flag snapshot.
  updateMemoryCorrectionWork: (input: {
    id: string;
    snapshot_digest: string;
    claim_attempt: number;
    patch: Pick<MemoryCorrectionWork, "status"> &
      Partial<
        Pick<
          MemoryCorrectionWork,
          "next_attempt_at" | "lease_expires_at" | "proposal_id" | "reason_code"
        >
      >;
    agent_id?: string;
  }) => MemoryCorrectionWork | null;
  // Apply server-validated exact spans only if the source, flags, and lease still match.
  applyMemoryCorrection: (input: {
    id: string;
    snapshot_digest: string;
    claim_attempt: number;
    spans: readonly MemoryCorrectionSpan[];
    agent_id?: string;
  }) => Memory | null;
  /** Targeted lookup by exact source + reviewed flag snapshot, uncapped and shelf-local. */
  getMemoryCorrectionProposal: (input: {
    source_memory_id: string;
    snapshot_digest: string;
  }) => Memory | null;
  /** Synchronous snapshot-checked get-or-create of one single-target correction proposal. */
  createMemoryCorrectionProposal: (input: MemoryCorrectionProposalInput) => Memory | null;
  /** Validate the correction-only baseline against this exact shelf and current source snapshot. */
  inspectMemoryCorrectionProposal: (input: {
    proposal_id: string;
    shelf_id: string;
  }) => MemoryCorrectionProposalReview | null;
  /** Approve a correction proposal only when its exact-shelf source/flags/content baseline is current. */
  approveMemoryCorrectionProposal: (input: {
    proposal_id: string;
    shelf_id: string;
    agent_id?: string;
  }) => Memory | null;
  /** Reject a correction proposal and leave its source available for manual review. */
  rejectMemoryCorrectionProposal: (input: {
    proposal_id: string;
    shelf_id: string;
    agent_id?: string;
  }) => Memory | null;
  /** Reconcile a durable terminal proposal outcome after a crash between proposal/source writes. */
  reconcileMemoryCorrectionProposalResolution: (input: {
    source_memory_id: string;
    proposal_id?: string;
    snapshot_digest: string;
    shelf_id: string;
    agent_id?: string;
  }) => MemoryCorrectionWork | null;
  // Clear every open flag on a memory — the dashboard's adjudication
  // primitive. Status is left untouched. Fail-soft: unknown id → null.
  resolveFlags: (id: string, agent_id?: string) => Memory | null;
  approveProposal: (
    id: string,
    action?: string,
    patch?: Record<string, unknown>,
    agent_id?: string,
  ) => Memory | null;
  // Resolve a proposal out of the queue with provenance (proposal-review
  // rework 2026-07-01, D8/D9): archive it + stamp curator_note.resolution
  // ("applied_plan" | "resolved_via_chat"). Never archives supersedes sources —
  // the resolving mutation already happened; this is queue bookkeeping. Throws
  // for an unknown id or a non-proposed memory.
  resolveProposal: (id: string, resolution: string, agent_id?: string) => Memory | null;
  startContext: (input?: { agent_id?: string; task_summary?: string }) => {
    memories: Memory[];
    text: string;
  };
}
