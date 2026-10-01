// Slice-scoped memory evidence gathering for the memory curator (spec §9).
//
// A curation run operates on exactly one slice and must never read across a
// slice boundary (§3). This module turns a slice descriptor into a bounded,
// redacted, deterministically-ordered bundle of memory evidence:
//
//   - active + proposed memories for the slice (bodies redacted, §9/§10.4);
//   - archived memories as METADATA-ONLY tombstones (id/title/slice + archive
//     metadata + a normalized content fingerprint, NO body) so the §10.3
//     pre-pass can block resurrection without re-exposing deleted content (§9.1);
//   - caps + truncation so the bundle stays bounded and the prompt knows when
//     evidence was trimmed (§9 evidence caps).
//
// The actual memory reads are delegated to a `GroomingMemorySource` (plan 036
// Phase 4) so this gather/redact/cap logic is storage-agnostic: the markdown
// vault provides one via `createVaultGroomingMemorySource`. This module never
// touches a storage handle — it is pure over the source. The curator is
// memory-only after the sessions rethink (sessions-rethink-spec §12): no
// session evidence.

import { curationContentFingerprint, curationNormalizedTitle } from "./grooming-fingerprint.js";
import { redactSecrets } from "./grooming-redaction.js";

// Memories no longer carry a project_key, so grooming collapses to a single
// global slice (the per-project `common_project` variant was retired with the
// memory project_key field). The discriminant is kept for run/hash provenance.
export type SliceKind = "common_global";

export interface EvidenceSlice {
  kind: SliceKind;
}

/**
 * A memory as a `GroomingMemorySource` returns it — backend-neutral and
 * PRE-redaction (gatherMemoryEvidence owns redaction + truncation). The source
 * hands back raw title/body; the emitted bundle is what gets redacted.
 */
export interface GroomingMemoryRecord {
  id: string;
  title: string;
  body: string;
  agentId: string | null;
  requiresApproval: boolean;
  isGlobal: boolean;
  createdAt: string;
  updatedAt: string;
  /**
   * True when the memory carries an OPEN flag from the curator actor — i.e. a
   * curator archive proposal already sits in the flag-review queue (review F2).
   * Optional so non-flag-aware sources stay valid.
   */
  hasOpenCuratorFlag?: boolean;
  /**
   * The open agent flags the curator has not reviewed yet (ADR 0013), oldest
   * first. Raw (pre-redaction) reasons; gatherMemoryEvidence redacts them.
   */
  openFlags?: { reason: string; flaggedAt: string }[];
}

/**
 * An archived memory as a `GroomingMemorySource` returns it. Carries the raw
 * title+body (for fingerprinting — never emitted) plus archive metadata.
 * `archiveReason` is null when the backend records none (the markdown vault
 * retires the event ledger, so reasons aren't persisted there).
 */
export interface GroomingTombstoneRecord {
  id: string;
  title: string;
  body: string;
  agentId: string | null;
  archivedAt: string;
  archiveReason: string | null;
}

/**
 * The memory reads the curator's evidence gathering needs, abstracted over the
 * storage backend (plan 036 Phase 4). Implementations return records
 * newest-first (by `updatedAt`) and already capped at `limit`. Since memories
 * are project-less, there is a single global slice and no slice filtering.
 */
export interface GroomingMemorySource {
  /** Slices with curatable (active|proposed) content; the scheduler due-gates them. */
  listSlices(): EvidenceSlice[];
  /** Active|proposed memories for the slice, newest-first, ≤ limit. */
  selectMemories(
    slice: EvidenceSlice,
    status: "active" | "proposed",
    limit: number,
  ): GroomingMemoryRecord[];
  /** Archived memories for the slice (with archive metadata), newest-first, ≤ limit. */
  selectTombstones(slice: EvidenceSlice, limit: number): GroomingTombstoneRecord[];
  /**
   * The targeted flag groom's memories (ADR 0013): up to `maxFlagged` active
   * memories with unreviewed agent flags, each followed by up to `neighbours`
   * related active memories, with no repeats. Optional: a source without it
   * yields an empty targeted run.
   */
  selectFlagFocus?(maxFlagged: number, neighbours: number): GroomingMemoryRecord[];
}

export interface MemoryEvidenceCaps {
  /** Max combined active + proposed + tombstone memories (active prioritised). */
  maxMemories: number;
  /** Max chars for a memory body before truncation. Default 4000. */
  maxBodyChars?: number;
  /**
   * Max chars for a FLAGGED memory's body (ADR 0013). Default 20000: the curator
   * may rewrite a flagged memory, so it must see the whole of it.
   */
  maxFlaggedBodyChars?: number;
  /**
   * "flagged" gathers the targeted flag groom's evidence instead of the
   * newest-first slice: flagged memories plus their neighbours, no proposals.
   */
  focus?: "flagged";
}

export interface MemoryEvidenceItem {
  id: string;
  title: string; // redacted
  body: string; // redacted, possibly truncated
  agentId: string | null;
  status: "active" | "proposed";
  createdAt: string;
  updatedAt: string;
  // Section 4d.3 — the protected-memory gate (set by admin/curator).
  // The curator's apply layer reads this to flag operations that touch
  // a protected memory; legacy category strings are gone.
  requiresApproval: boolean;
  isGlobal: boolean;
  // Present (and true) ONLY when a curator archive proposal is already open on
  // this memory (review F2) — the prompt tells the model to noop instead of
  // re-proposing. Omitted when false, to keep the evidence JSON lean.
  has_open_curator_flag?: true;
  // ADR 0013: the agent flags the curator should act on, redacted. Omitted when none.
  open_flags?: { reason: string; flagged_at: string }[];
  // Present (and true) when `body` is not the whole stored body: it was cut at the
  // length bound or had secret-looking text masked. The curator must not rewrite
  // a memory it can't see whole; validation rejects such an operation.
  body_incomplete?: true;
}

export interface TombstoneItem {
  id: string;
  title: string; // redacted
  agentId: string | null;
  archivedAt: string;
  archiveReason: string | null;
  /** sha256 of the normalized, redacted title+body — the resurrection key (§9.1). */
  contentFingerprint: string;
  /** Normalized, redacted title — the secondary resurrection key (§10.3). */
  normalizedTitle: string;
}

export interface MemoryEvidenceBundle {
  slice: EvidenceSlice;
  activeMemories: MemoryEvidenceItem[];
  proposedMemories: MemoryEvidenceItem[];
  tombstones: TombstoneItem[];
  /** True if the cap dropped any eligible memory or tombstone. */
  truncatedMemories: boolean;
  /** True if any body was trimmed to `maxBodyChars`. */
  truncatedFields: boolean;
  /** Count of secret occurrences scrubbed while gathering. */
  redactionCount: number;
}

const DEFAULT_MAX_BODY_CHARS = 4000;
const DEFAULT_MAX_FLAGGED_BODY_CHARS = 20_000;
/** Flagged memories per targeted run, so each group fits one model call (ADR 0013). */
export const FLAG_FOCUS_MAX_FLAGGED = 5;
/** Related memories shown alongside each flagged one (ADR 0013). */
export const FLAG_FOCUS_NEIGHBOURS = 5;
const TRUNCATION_MARKER = " …[truncated]";

/** Running totals threaded through redaction/truncation so the bundle can report them. */
interface GatherStats {
  redactionCount: number;
  truncatedFields: boolean;
}

export function gatherMemoryEvidence(
  source: GroomingMemorySource,
  slice: EvidenceSlice,
  caps: MemoryEvidenceCaps,
): MemoryEvidenceBundle {
  const bodyChars: BodyLimits = {
    plain: caps.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS,
    flagged: Math.max(
      caps.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS,
      caps.maxFlaggedBodyChars ?? DEFAULT_MAX_FLAGGED_BODY_CHARS,
    ),
  };
  const stats: GatherStats = { redactionCount: 0, truncatedFields: false };

  if (caps.focus === "flagged") {
    // The targeted flag groom: flagged memories with their neighbours, and the
    // tombstones so a correction can't resurrect archived content. Proposals are
    // left out (the apply layer still refuses to re-file one already pending).
    const focus = source.selectFlagFocus?.(FLAG_FOCUS_MAX_FLAGGED, FLAG_FOCUS_NEIGHBOURS) ?? [];
    const remaining = Math.max(0, caps.maxMemories - focus.length);
    const tombstoneRows = source.selectTombstones(slice, remaining + 1);
    const tombstonesTaken = tombstoneRows.slice(0, remaining);
    return {
      slice,
      activeMemories: focus.map((rec) => toItem(rec, "active", bodyChars, stats)),
      proposedMemories: [],
      tombstones: tombstonesTaken.map((rec) => toTombstone(rec, stats)),
      truncatedMemories: tombstoneRows.length > tombstonesTaken.length,
      truncatedFields: stats.truncatedFields,
      redactionCount: stats.redactionCount,
    };
  }

  // Fetch one past the budget per status so we can detect (not just apply) the cap.
  const limit = caps.maxMemories + 1;
  const activeRows = source.selectMemories(slice, "active", limit);
  const proposedRows = source.selectMemories(slice, "proposed", limit);
  const tombstoneRows = source.selectTombstones(slice, limit);

  // Single budget consumed in priority order: active → proposed → tombstones (§9).
  let remaining = caps.maxMemories;
  const activeTaken = activeRows.slice(0, remaining);
  remaining -= activeTaken.length;
  const proposedTaken = proposedRows.slice(0, remaining);
  remaining -= proposedTaken.length;
  const tombstonesTaken = tombstoneRows.slice(0, remaining);

  const truncatedMemories =
    activeRows.length > activeTaken.length ||
    proposedRows.length > proposedTaken.length ||
    tombstoneRows.length > tombstonesTaken.length;

  return {
    slice,
    activeMemories: activeTaken.map((rec) => toItem(rec, "active", bodyChars, stats)),
    proposedMemories: proposedTaken.map((rec) => toItem(rec, "proposed", bodyChars, stats)),
    tombstones: tombstonesTaken.map((rec) => toTombstone(rec, stats)),
    truncatedMemories,
    truncatedFields: stats.truncatedFields,
    redactionCount: stats.redactionCount,
  };
}

interface BodyLimits {
  plain: number;
  flagged: number;
}

function toItem(
  rec: GroomingMemoryRecord,
  status: "active" | "proposed",
  limits: BodyLimits,
  stats: GatherStats,
): MemoryEvidenceItem {
  const flags = rec.openFlags ?? [];
  const redactedBody = redactSecrets(rec.body);
  stats.redactionCount += redactedBody.count;
  const maxChars = flags.length > 0 ? limits.flagged : limits.plain;
  const body = truncate(redactedBody.redacted, maxChars, stats);
  const incomplete = redactedBody.count > 0 || body !== redactedBody.redacted;
  return {
    id: rec.id,
    title: redact(rec.title, stats),
    body,
    agentId: rec.agentId,
    status,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    requiresApproval: rec.requiresApproval,
    isGlobal: rec.isGlobal,
    ...(rec.hasOpenCuratorFlag === true ? { has_open_curator_flag: true as const } : {}),
    ...(flags.length > 0
      ? {
          open_flags: flags.map((flag) => ({
            reason: redact(flag.reason, stats),
            flagged_at: flag.flaggedAt,
          })),
        }
      : {}),
    ...(incomplete ? { body_incomplete: true as const } : {}),
  };
}

function toTombstone(rec: GroomingTombstoneRecord, stats: GatherStats): TombstoneItem {
  // The body is fingerprinted (via the shared redact-then-fingerprint contract)
  // but NEVER emitted, so deleted content is not re-exposed (§9.1). Only the
  // emitted title is redacted here for display + the redaction tally.
  const redactedTitle = redact(rec.title, stats);
  return {
    id: rec.id,
    title: redactedTitle,
    agentId: rec.agentId,
    archivedAt: rec.archivedAt,
    archiveReason: rec.archiveReason,
    contentFingerprint: curationContentFingerprint(rec.title, rec.body),
    normalizedTitle: curationNormalizedTitle(rec.title),
  };
}

function redact(value: string, stats: GatherStats): string {
  const { redacted, count } = redactSecrets(value);
  stats.redactionCount += count;
  return redacted;
}

function truncate(value: string, maxChars: number, stats: GatherStats): string {
  if (value.length <= maxChars) return value;
  stats.truncatedFields = true;
  return value.slice(0, maxChars) + TRUNCATION_MARKER;
}
