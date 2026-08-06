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

export interface Memory {
  id: string;
  agent_id: string;
  status: string;
  tags: string[];
  applies_to: string[];
  /** Shelf-local project relevance metadata; never an authorisation boundary. */
  project_keys?: string[];
  supersedes: string[];
  conflicts_with: string[];
  // Open agent flags routing this memory to review (spec 047 / ADR 0006).
  // Default []. A non-empty list soft-demotes the memory in recall but never
  // changes its status.
  flags: MemoryFlag[];
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
