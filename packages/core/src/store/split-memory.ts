// Shared "split" store primitive (spec 043 D-B). The mechanics of spinning a
// source memory into N replacements live HERE, in one place, so the two curator
// apply paths that perform a split — grooming (`curator-apply.ts`) and intake
// (`intake/apply.ts`) — produce byte-identical results.
//
// What the primitive owns (the invariant both paths share):
//   1. Create every replacement FIRST, collecting their ids.
//   2. ONLY THEN, optionally, archive the source.
// This create-then-archive ordering is the data-loss-safe one: on a partial
// failure the source stays active (recoverable next run) rather than being lost
// before its replacements exist (cf. the merge note in curator-apply.ts).
//
// What the primitive does NOT own (deliberately left to each caller, because the
// two curators differ here): how each replacement's `createMemory` input + options
// are built — the curator_note shape (grooming: { run_id, supersedes }; intake:
// { source: "intake", rationale, … }), ownership/agent_id, and whether the
// new rows land active or `requires_approval` (proposed). Each caller pre-builds
// those `{ input, options }` pairs; the primitive only sequences the writes.
//
// Whether the source is archived is the propose-vs-apply switch: pass
// `archiveActorId` to archive it (an auto-applied split supersedes its source);
// omit it to leave the source untouched (a PROPOSED split — a human accepts and
// archives the source later). Intake ALWAYS proposes, so it always omits it.

/** The narrow store surface the split primitive mutates through. */
export interface SplitMemoryStore {
  createMemory: (
    input: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => { memory: { id: string } };
  archiveMemory: (id: string, agent_id?: string) => unknown;
  /** Optional read seam used to preserve project associations on replacements. */
  getMemory?: (id: string) => { project_keys?: string[] } | null;
}

/** One replacement to spin out of the source — a ready-to-write createMemory call. */
export interface SplitReplacement {
  input: Record<string, unknown>;
  options?: Record<string, unknown>;
}

export interface SplitMemoryRequest {
  /** The source memory being split. */
  sourceId: string;
  /** The replacements to create (each already scoped + carrying its supersedes note). */
  replacements: SplitReplacement[];
  /**
   * When set, archive the source after ALL replacements are created (an
   * auto-applied split). When omitted, the source is left active — a PROPOSED
   * split, where a human archives the source after accepting the replacements.
   */
  archiveActorId?: string;
}

/**
 * Execute a split: create every replacement, then (optionally) archive the
 * source. Returns the new replacement memory ids, in input order. The ordering
 * (create-all-then-archive) is the shared data-loss-safe invariant; the per-row
 * `input`/`options` are the caller's (so grooming + intake stay independent in
 * what they file, identical in how they file it).
 */
export function splitMemory(store: SplitMemoryStore, request: SplitMemoryRequest): string[] {
  const sourceKeys = store.getMemory?.(request.sourceId)?.project_keys ?? [];
  const targets = request.replacements.map((replacement) => {
    const explicit = Array.isArray(replacement.input.project_keys)
      ? (replacement.input.project_keys as string[])
      : [];
    const projectKeys = stableUnion(sourceKeys, explicit);
    const input =
      projectKeys.length > 0
        ? { ...replacement.input, project_keys: projectKeys }
        : replacement.input;
    return store.createMemory(input, replacement.options).memory.id;
  });
  if (request.archiveActorId !== undefined) {
    store.archiveMemory(request.sourceId, request.archiveActorId);
  }
  return targets;
}

function stableUnion(...groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}
