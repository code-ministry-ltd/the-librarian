// Markdown-vault-backed GroomingMemorySource (plan 036 Phase 4).
//
// Reads memory docs from the git vault (via the markdown memory store's
// `listAll`). Optional plural project associations are evidence metadata only:
// grooming still operates over a SINGLE `common_global` slice (the retired
// `common_project` slice is not revived).
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

function toRecord(memory: Memory): GroomingMemoryRecord {
  return {
    id: memory.id,
    title: String(memory.title ?? ""),
    body: String(memory.body ?? ""),
    agentId: memory.agent_id ?? null,
    requiresApproval: memory.requires_approval === true,
    isGlobal: memory.is_global === true,
    ...(memory.project_keys !== undefined ? { projectKeys: memory.project_keys } : {}),
    createdAt: String(memory.created_at ?? memory.updated_at),
    updatedAt: String(memory.updated_at),
    // An OPEN flag from the canonical curator actor means an archive proposal
    // is already in the flag-review queue (review F2) — surfaced so the prompt
    // can tell the model to noop instead of re-proposing.
    hasOpenCuratorFlag: (memory.flags ?? []).some(
      (flag) => flag.agent_id === SYSTEM_ACTOR_IDS.memoryCurator,
    ),
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
    // Project associations do not partition grooming: a single global slice
    // exists iff any live (active|proposed) memory exists.
    const hasLive = reader.listAll({}).some((m) => m.status !== MemoryStatus.Archived);
    return hasLive ? [{ kind: "common_global" }] : [];
  }

  // Read the vault, keep what `predicate` accepts, then newest-first + cap + map
  // — the shared shape of both evidence reads.
  function selectNewest<T>(
    predicate: (memory: Memory) => boolean,
    limit: number,
    map: (memory: Memory) => T,
  ): T[] {
    return reader.listAll({}).filter(predicate).sort(byUpdatedDesc).slice(0, limit).map(map);
  }

  // The single global slice matches every memory, so the slice descriptor is
  // accepted for interface parity but does not filter.
  function selectMemories(
    _slice: EvidenceSlice,
    status: "active" | "proposed",
    limit: number,
  ): GroomingMemoryRecord[] {
    return selectNewest((m) => m.status === status, limit, toRecord);
  }

  function selectTombstones(_slice: EvidenceSlice, limit: number): GroomingTombstoneRecord[] {
    return selectNewest((m) => m.status === MemoryStatus.Archived, limit, toTombstoneRecord);
  }

  return { listSlices, selectMemories, selectTombstones };
}
