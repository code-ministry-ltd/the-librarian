// Markdown-vault-backed GroomingMemorySource (plan 036 Phase 4).
//
// Reads memory docs from the git vault (via the markdown memory store's
// `listAll`). Memories no longer carry a project_key, so grooming operates over
// a SINGLE `common_global` slice (the per-project `common_project` slice was
// retired with the memory project_key field).
// Active/proposed feed slice enumeration + evidence; archived feed tombstones.
//
// The event ledger is retired on markdown, so a tombstone's `archiveReason` is
// null and `archivedAt` is the doc's `updatedAt` (which equals archive time —
// archiveMemory stamps updated_at when it flips status).
//
// The curator runs infrequently over a small corpus, so each public call reads
// the vault afresh (consistent with out-of-band vault edits) rather than caching.

import { SYSTEM_ACTOR_IDS } from "./caller-identity.js";
import type {
  GroomingMemoryRecord,
  GroomingMemorySource,
  GroomingTombstoneRecord,
  EvidenceSlice,
} from "./grooming-evidence.js";
import { MemoryStatus } from "./schemas/common.js";
import type { Memory } from "./store/memory-store.js";

/** The minimal memory read surface the vault curator source needs. */
export interface GroomingVaultMemoryReader {
  listAll(filters?: Record<string, unknown>): Memory[];
  /** Keyword recall, used to find a flagged memory's neighbours (ADR 0013). */
  searchMemories?(input?: Record<string, unknown>): Memory[];
}

// Bounds on what one flag can put in front of the model (ADR 0013). flag_memory
// already caps a reason at 2,000 characters; this also covers hand-edited docs.
const MAX_FLAGS_SHOWN = 10;
const MAX_FLAG_REASON_CHARS = 2_000;

// The agent flags grooming should act on: not the curator's own archive flags,
// and not ones it already reviewed (those wait for a new flag, an edit, or a
// person asking it to look again).
function unreviewedAgentFlags(memory: Memory): { reason: string; flaggedAt: string }[] {
  return (memory.flags ?? [])
    .filter((flag) => flag.agent_id !== SYSTEM_ACTOR_IDS.memoryCurator && !flag.review)
    .slice(0, MAX_FLAGS_SHOWN)
    .map((flag) => ({
      reason: flag.reason.slice(0, MAX_FLAG_REASON_CHARS),
      flaggedAt: flag.created_at,
    }));
}

function hasUnreviewedAgentFlag(memory: Memory): boolean {
  return unreviewedAgentFlags(memory).length > 0;
}

// updated_at DESC, with id DESC as a deterministic tiebreak. The curator's
// input hash is set-based (it sorts the evidence ids before hashing —
// curator-worker.ts), so this only decides which record survives the
// maxMemories cap on an exact updated_at tie at the boundary. It buys the vault's
// own run-to-run determinism.
function byUpdatedDesc(a: Memory, b: Memory): number {
  if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

// Oldest unreviewed agent flag first, so a long-waiting flag is never starved.
function cmpFirstFlag(a: Memory, b: Memory): number {
  const first = (m: Memory) => unreviewedAgentFlags(m)[0]?.flaggedAt ?? "";
  return first(a) < first(b) ? -1 : first(a) > first(b) ? 1 : 0;
}

function toRecord(memory: Memory): GroomingMemoryRecord {
  const openFlags = unreviewedAgentFlags(memory);
  return {
    id: memory.id,
    title: String(memory.title ?? ""),
    body: String(memory.body ?? ""),
    agentId: memory.agent_id ?? null,
    isGlobal: memory.is_global === true,
    createdAt: String(memory.created_at ?? memory.updated_at),
    updatedAt: String(memory.updated_at),
    // An OPEN flag from the canonical curator actor means an archive proposal
    // is already in the flag-review queue (review F2) — surfaced so the prompt
    // can tell the model to noop instead of re-proposing.
    hasOpenCuratorFlag: (memory.flags ?? []).some(
      (flag) => flag.agent_id === SYSTEM_ACTOR_IDS.memoryCurator,
    ),
    ...(openFlags.length > 0 ? { openFlags } : {}),
  };
}

function toTombstoneRecord(memory: Memory): GroomingTombstoneRecord {
  return {
    id: memory.id,
    title: String(memory.title ?? ""),
    body: String(memory.body ?? ""),
    agentId: memory.agent_id ?? null,
    archivedAt: String(memory.updated_at),
    archiveReason: null,
  };
}

export function createVaultGroomingMemorySource(
  reader: GroomingVaultMemoryReader,
): GroomingMemorySource {
  function listSlices(): EvidenceSlice[] {
    // Memories are project-less: a single global slice exists iff any live
    // (active|proposed) memory exists. Nothing live → no slice to groom.
    const hasLive = reader.listAll({}).some((m) => m.status !== MemoryStatus.Archived);
    return hasLive ? [{ kind: "common_global" }] : [];
  }

  // Read the vault, keep what `predicate` accepts, then newest-first + cap + map
  // — the shared shape of both evidence reads.
  function selectNewest<T>(
    predicate: (memory: Memory) => boolean,
    limit: number,
    map: (memory: Memory) => T,
    pinFlagged = false,
  ): T[] {
    // ADR 0013: a scheduled or manual groom puts memories with unreviewed agent
    // flags first, so a flag is never starved by the newest-first cap.
    const order = pinFlagged
      ? (a: Memory, b: Memory) =>
          Number(hasUnreviewedAgentFlag(b)) - Number(hasUnreviewedAgentFlag(a)) ||
          byUpdatedDesc(a, b)
      : byUpdatedDesc;
    return reader.listAll({}).filter(predicate).sort(order).slice(0, limit).map(map);
  }

  // The single global slice matches every memory, so the slice descriptor is
  // accepted for interface parity but does not filter.
  function selectMemories(
    _slice: EvidenceSlice,
    status: "active" | "proposed",
    limit: number,
  ): GroomingMemoryRecord[] {
    return selectNewest((m) => m.status === status, limit, toRecord, status === "active");
  }

  function selectTombstones(_slice: EvidenceSlice, limit: number): GroomingTombstoneRecord[] {
    return selectNewest((m) => m.status === MemoryStatus.Archived, limit, toTombstoneRecord);
  }

  // The targeted flag groom (ADR 0013): the oldest-flagged memories first, each
  // followed by the active memories recall ranks closest to it (searched by its
  // title and flag reasons), so the curator can see what is true now.
  function selectFlagFocus(maxFlagged: number, neighbours: number): GroomingMemoryRecord[] {
    const active = reader.listAll({}).filter((m) => m.status === MemoryStatus.Active);
    const flagged = active
      .filter(hasUnreviewedAgentFlag)
      .sort((a, b) => cmpFirstFlag(a, b) || byUpdatedDesc(a, b))
      .slice(0, maxFlagged);
    const seen = new Set<string>();
    const out: GroomingMemoryRecord[] = [];
    const take = (memory: Memory) => {
      if (seen.has(memory.id)) return;
      seen.add(memory.id);
      out.push(toRecord(memory));
    };
    for (const memory of flagged) take(memory);
    if (!reader.searchMemories) return out;
    for (const memory of flagged) {
      const query = [memory.title, ...unreviewedAgentFlags(memory).map((flag) => flag.reason)].join(
        " ",
      );
      let related: Memory[] = [];
      try {
        related = reader.searchMemories({
          query,
          status: MemoryStatus.Active,
          limit: neighbours + 1,
        });
      } catch {
        // Neighbours are context, not a precondition: the flagged memory still runs.
      }
      for (const neighbour of related.filter((m) => m.id !== memory.id).slice(0, neighbours)) {
        take(neighbour);
      }
    }
    return out;
  }

  return { listSlices, selectMemories, selectTombstones, selectFlagFocus };
}
