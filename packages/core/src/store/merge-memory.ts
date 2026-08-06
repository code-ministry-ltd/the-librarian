// Shared "merge" store primitive (spec 044 D-5a). The mechanics of merging N
// source memories into ONE replacement live HERE, in one place, so the curator
// run path (`curator-apply.ts`) and a NEW admin path (`memories.merge` tRPC) that
// both perform a merge produce byte-identical results. It is the sibling of
// `splitMemory` (split-memory.ts): split is 1→N, merge is N→1.
//
// What the primitive owns (the invariant both paths share):
//   1. Create the merged replacement FIRST, capturing its id.
//   2. ONLY THEN, optionally, archive every source.
// This create-then-archive ordering is the data-loss-safe one (it mirrors split's,
// and the inline merge it replaces): on a partial failure the merged duplicate
// stays active (recoverable next run) rather than losing a source before its
// replacement exists.
//
// What the primitive does NOT own (deliberately left to the caller, because the
// two paths differ here): how the replacement's `createMemory` input + options are
// built — the curator_note shape (run path: { run_id, supersedes }; admin:
// { source: "admin-chat", supersedes }), ownership/agent_id, and whether the new
// row lands active or `requires_approval` (proposed). Each caller pre-builds that
// `{ input, options }` pair; the primitive only sequences the writes. The
// `supersedes = sourceIds` note belongs on the replacement and so is the caller's
// responsibility — same as split.
//
// Whether the sources are archived is the propose-vs-apply switch: pass
// `archiveActorId` to archive them (an auto-applied merge supersedes its sources);
// omit it to leave them active (a PROPOSED merge — a human accepts and archives the
// sources later).

import type { SplitMemoryStore, SplitReplacement } from "./split-memory.js";

/** The narrow store surface the merge primitive mutates through (same as split). */
export type MergeMemoryStore = SplitMemoryStore;

export interface MergeMemoryRequest {
  /** The merged target to create — a ready-to-write createMemory call. */
  replacement: SplitReplacement;
  /** The source memories being merged away (carried on the replacement's supersedes). */
  sourceIds: string[];
  /**
   * When set, archive every source AFTER the replacement is created (an auto-
   * applied merge). When omitted, the sources are left active — a PROPOSED merge,
   * where a human archives the sources after accepting the replacement.
   */
  archiveActorId?: string;
}

/**
 * Execute a merge: create the merged replacement, then (optionally) archive every
 * source. Returns the new merged memory id. The ordering (create-then-archive) is
 * the shared data-loss-safe invariant; the replacement's `input`/`options` are the
 * caller's (so the run path + admin path stay independent in what they file,
 * identical in how they file it).
 */
export function mergeMemory(store: MergeMemoryStore, request: MergeMemoryRequest): string {
  const hasExplicitKeys = Object.prototype.hasOwnProperty.call(
    request.replacement.input,
    "project_keys",
  );
  const sourceKeys = hasExplicitKeys
    ? undefined
    : stableUnion(...request.sourceIds.map((id) => store.getMemory?.(id)?.project_keys ?? []));
  const input =
    sourceKeys && sourceKeys.length > 0
      ? { ...request.replacement.input, project_keys: sourceKeys }
      : request.replacement.input;
  const target = store.createMemory(input, request.replacement.options).memory.id;
  if (request.archiveActorId !== undefined) {
    for (const id of request.sourceIds) store.archiveMemory(id, request.archiveActorId);
  }
  return target;
}

function stableUnion(...groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}
