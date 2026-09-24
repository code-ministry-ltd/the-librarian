// Markdown-backed MemoryStore (plan 036 Phase 2) — built behind the
// existing `MemoryStore` interface; the vault of markdown documents IS the
// storage layer.

import { createHash } from "node:crypto";
//
// The store is SYNC (the verb tests are sync): vault I/O
// is sync, and the git commit-per-op is an injected sync committer
// (`commit`) — most unit tests inject none (fast); production wires a
// synchronous git commit. Each memory is a human-readable
// `memories/<title-slug>-<shortid>.md` (resolved back to a memory by its
// frontmatter id); status lives in frontmatter (folder-based inbox/intake
// filing is Phase 4).

import { SYSTEM_ACTOR_IDS, actorTrailerValue } from "../../caller-identity.js";
import {
  DEFAULT_AGENT_ID,
  asArray,
  makeId,
  normalizeMemoryInput,
  normalizeString,
  nowIso,
} from "../../constants.js";
import { memoryContentDigest } from "../../formatters/memory-diff.js";
import { redactSecrets } from "../../grooming-redaction.js";
import { MemoryStatus } from "../../schemas/common.js";
import { commitSubject } from "../commit-message.js";
import type { Vault } from "../corpus/vault.js";
import { formatContextPackage, uniqueById } from "../memory-context.js";
import { cleanPatch } from "../memory-patch.js";
import { routeMemoryWrite } from "../memory-routing.js";
import type {
  Memory,
  CorrectionManualReviewReasonCode,
  MemoryCorrectionProposalInput,
  MemoryCorrectionProposalReview,
  MemoryCorrectionWork,
  MemoryCorrectionWorkStatus,
  MemoryStore,
} from "../memory-store.js";
import { tokenize } from "../memory-tokenize.js";
import type { MemoryCorrectionSpan } from "../../memory-correction.js";
import { parseMemoryDocument, serializeMemoryDocument } from "./memory-doc.js";

export interface MarkdownMemoryStoreDeps {
  vault: Vault;
  /**
   * Sync commit-per-op — the ATTRIBUTED, pathspec-limited primitive (spec 064 SC 1):
   * `(paths, message, actorId?)`. Every mutation names the file(s) it touched (a memory
   * write is always its one document) so the commit is scoped to them, and passes the
   * acting principal so the commit carries a sanitised `Librarian-Actor` trailer. Omit to
   * skip committing (most unit tests).
   */
  commit?: (paths: string[], message: string, actorId?: string) => void;
  /** Fired after every successful write (post-commit) — e.g. to invalidate a disposable index cache. */
  onWrite?: () => void;
  /** Clock injection (defaults to `nowIso`). */
  now?: () => string;
  /** Id generator injection (defaults to `makeId("mem")`). */
  generateId?: () => string;
}

const SLUG_MAX = 60;

/** A human-readable, filesystem-safe slug from a memory title (ASCII kebab-case). */
function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // drop accents (é → e)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // any run of non-alphanumerics → one hyphen
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, ""); // a hyphen left dangling by the slice
  return slug || "memory"; // symbol-only / empty titles still get a name
}

/** A short, stable id fragment that makes the filename unique + greppable. */
function shortId(id: string): string {
  const core = id.replace(/^mem_/, "").replace(/[^a-z0-9]/gi, "");
  return core.slice(0, 8) || id;
}

/**
 * Human-readable memory filename: `memories/<title-slug>-<shortid>.md`. The id
 * suffix guarantees uniqueness (no collision logic needed) and keeps the id
 * greppable. The name is set once at creation and never changes — the frontmatter
 * id + title are authoritative — so id→path lookups resolve by scanning ids, not
 * by recomputing the path from a (possibly changed) title.
 */
function memoryFileName(memory: { id: string; title: string }): string {
  return `memories/${slugify(memory.title)}-${shortId(memory.id)}.md`;
}

// Recall soft-demote for flagged memories (spec 047 / ADR 0006): a bounded
// ranking penalty applied to a memory with ≥1 open flag. Sized to demote a
// flagged memory below an equivalent unflagged one while staying comparable
// to — not dwarfing — the keyword-relevance band, so a strongly-relevant
// flagged memory still surfaces. Only the ranking is affected; inclusion is
// gated on pre-penalty relevance, so a flagged memory is never excluded.
const FLAG_PENALTY = 2;
const CORRECTION_MAX_ATTEMPTS = 3;
const CORRECTION_MAX_FLAGS = 10;
const CORRECTION_MAX_QUOTES = 10;
const CORRECTION_LEASE_MS = 60_000;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function correctionDigests(memory: Memory): {
  source_digest: string;
  flags_digest: string;
  snapshot_digest: string;
} {
  const {
    flags: _flags,
    correction_work: _correctionWork,
    updated_at: _updatedAt,
    updated_by: _updatedBy,
    ...source
  } = memory;
  const source_digest = digest(source);
  const flags_digest = digest(memory.flags ?? []);
  return {
    source_digest,
    flags_digest,
    snapshot_digest: digest({ source_digest, flags_digest }),
  };
}

function withCorrectionWork(memory: Memory, work: MemoryCorrectionWork[] | undefined): Memory {
  return work === undefined ? memory : { ...memory, correction_work: work };
}

function cancelCorrectionWork(
  work: MemoryCorrectionWork[] | undefined,
  reason_code: string,
): MemoryCorrectionWork[] | undefined {
  if (!work) return work;
  let changed = false;
  const cancelled = work.map((item) => {
    if (
      item.status !== "pending" &&
      item.status !== "processing" &&
      item.status !== "proposal_pending"
    ) {
      return item;
    }
    changed = true;
    const { lease_expires_at: _lease, ...withoutLease } = item;
    return { ...withoutLease, status: "cancelled" as const, reason_code };
  });
  return changed ? cancelled : work;
}

function correctionClaimMatches(input: {
  memory: Memory;
  work: MemoryCorrectionWork;
  snapshot_digest: string;
  claim_attempt: number;
  at: string;
}): boolean {
  const { memory, work, snapshot_digest, claim_attempt, at } = input;
  const atMs = Date.parse(at);
  const leaseExpiresAtMs = Date.parse(work.lease_expires_at ?? "");
  if (
    work.status !== "processing" ||
    work.snapshot_digest !== snapshot_digest ||
    work.attempt_count !== claim_attempt ||
    !Number.isFinite(atMs) ||
    !Number.isFinite(leaseExpiresAtMs) ||
    leaseExpiresAtMs <= atMs
  ) {
    return false;
  }
  const current = correctionDigests(memory);
  return (
    current.snapshot_digest === snapshot_digest &&
    current.source_digest === work.source_digest &&
    current.flags_digest === work.flags_digest
  );
}

function applyCorrectionSpans(
  source: string,
  spans: readonly MemoryCorrectionSpan[],
): string | null {
  if (spans.length === 0 || spans.length > CORRECTION_MAX_QUOTES) return null;
  const ordered = [...spans].sort((left, right) => left.start - right.start);
  let previousEnd = -1;
  for (const span of ordered) {
    if (
      !Number.isSafeInteger(span.start) ||
      !Number.isSafeInteger(span.end) ||
      span.start < 0 ||
      span.end <= span.start ||
      span.end > source.length ||
      span.start < previousEnd ||
      source.slice(span.start, span.end) !== span.quote
    ) {
      return null;
    }
    previousEnd = span.end;
  }
  let body = source;
  for (let index = ordered.length - 1; index >= 0; index--) {
    const span = ordered[index];
    if (span) body = body.slice(0, span.start) + body.slice(span.end);
  }
  return body.trim().length > 0 ? body : null;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function createMarkdownMemoryStore(deps: MarkdownMemoryStoreDeps): MemoryStore {
  const { vault } = deps;
  const now = deps.now ?? nowIso;
  const generateId = deps.generateId ?? (() => makeId("mem"));
  const rawCommit = deps.commit ?? (() => {});
  // Wrap commit so every write fires onWrite — one hook covering all mutations
  // (createMemory + persist, used by update/archive/verify), e.g. to invalidate
  // the disposable recall index.
  const commit = (paths: string[], message: string, actorId?: string): void => {
    rawCommit(paths, message, actorId);
    deps.onWrite?.();
  };

  // id → relative path. Filenames are human-readable slugs (memoryFileName), so
  // reads + write-backs resolve a memory's file by its frontmatter id rather than
  // computing the path. Built lazily by scanning memories/, kept current as we
  // create, and rescanned once on a miss (the vault is git-backed + hand-editable,
  // and pre-slug `<id>.md` files must still resolve).
  let idToPath: Map<string, string> | null = null;
  function scanIdToPath(): Map<string, string> {
    const map = new Map<string, string>();
    for (const rel of vault.listMarkdown("memories")) {
      try {
        map.set(parseMemoryDocument(vault.readText(rel)).id, rel);
      } catch {
        // a hand-edited / foreign .md that doesn't parse is just not
        // id-addressable (fail-soft, mirrors buildCorpusIndex).
      }
    }
    return map;
  }
  function pathForId(id: string): string | null {
    idToPath ??= scanIdToPath();
    const hit = idToPath.get(id);
    if (hit) return hit;
    idToPath = scanIdToPath(); // miss → maybe written outside the store; rescan once
    return idToPath.get(id) ?? null;
  }

  function createMemory(input: Record<string, unknown>, options: Record<string, unknown> = {}) {
    const normalized = normalizeMemoryInput(input);
    const { status, isGlobal, requiresApproval, curatorNote } = routeMemoryWrite(
      normalized.status,
      options,
    );
    const ts = now();
    // Only the fields the markdown model persists (D16 retired
    // category/visibility/scope) — keeps createMemory's returned memory
    // identical to a getMemory read-back.
    const memory: Memory = {
      id: generateId(),
      title: normalized.title,
      body: normalized.body,
      agent_id: normalized.agent_id,
      confidence: normalized.confidence,
      tags: normalized.tags,
      applies_to: normalized.applies_to,
      supersedes: [],
      conflicts_with: [],
      flags: [],
      status,
      is_global: isGlobal,
      requires_approval: requiresApproval,
      created_at: ts,
      updated_at: ts,
      curator_note: curatorNote,
    };
    const related = detectRelated(memory);
    // Human-readable filename; the id suffix keeps it unique, but guard against
    // the astronomically rare same-slug + same-fragment clash so we never
    // silently overwrite a different memory.
    let rel = memoryFileName(memory);
    if (vault.exists(rel))
      rel = `memories/${slugify(memory.title)}-${memory.id.replace(/^mem_/, "")}.md`;
    vault.writeText(rel, serializeMemoryDocument(memory));
    idToPath?.set(memory.id, rel); // keep the resolver cache current
    // OWNER vs AUDIT ACTOR (spec 064 F3). The OWNER (frontmatter `agent_id`) may legitimately
    // differ from the acting principal — an admin merge/split creates a memory OWNED by someone
    // else. The commit TRAILER (the audit actor) must still be the ACTING PRINCIPAL, never a
    // body-supplied owner. It rides `options.audit_actor_id` so the merge/split primitives thread
    // it without a signature change; when absent (the ordinary agent create, where owner === actor)
    // it FALLS BACK to the owner — byte-identical to before, so the golden fixture is unmoved.
    // There is no `updated_by` on a create (that is for later mutations), just the trailer.
    const auditActor =
      typeof options.audit_actor_id === "string" ? options.audit_actor_id : normalized.agent_id;
    commit(
      [rel],
      status === MemoryStatus.Proposed
        ? commitSubject.memoryPropose(memory.id)
        : commitSubject.memoryStore(memory.id),
      auditActor,
    );
    // Narrow to the interface's active|proposed return shape. (A caller
    // force-passing options.status: "archived" is the lone edge; real callers
    // pass nothing or "proposed".)
    return {
      status: status as MemoryStatus.Active | MemoryStatus.Proposed,
      memory,
      duplicates: related.duplicates,
    };
  }

  function getMemory(id: string): Memory | null {
    const rel = pathForId(id);
    if (rel === null) return null;
    const raw = vault.tryReadText(rel);
    return raw ? parseMemoryDocument(raw) : null;
  }

  // Write a mutated memory back + commit. The state-transition logic below
  // applies each mutation directly to the document. `actorId` is the acting
  // principal (spec 064 SC 4): it stamps `updated_by` (last-writer, Q2) and rides
  // the commit's `Librarian-Actor` trailer. Only a trailer-eligible actor is
  // stamped — an anonymous (`unknown-agent`) write leaves the prior `updated_by`
  // untouched (the last KNOWN writer) and commits untrailered.
  function persist(memory: Memory, message: string, actorId?: string): Memory {
    const writer = actorTrailerValue(actorId);
    const stamped: Memory = writer !== undefined ? { ...memory, updated_by: writer } : memory;
    // Write back to the existing file (resolved by id) so the filename stays
    // stable across updates/retitles; fall back to a fresh name if somehow absent.
    const rel = pathForId(stamped.id) ?? memoryFileName(stamped);
    vault.writeText(rel, serializeMemoryDocument(stamped));
    commit([rel], message, actorId);
    return stamped;
  }

  function updateMemory(
    id: string,
    patch: Record<string, unknown> = {},
    agent_id: string = DEFAULT_AGENT_ID,
    options: { allowProtected?: boolean } = {},
  ): Memory | null {
    const existing = getMemory(id);
    if (!existing) throw new Error(`No memory found for id ${id}`);
    const correctionNote = existing.curator_note;
    if (
      existing.status === MemoryStatus.Proposed &&
      (correctionNote?.source === "flagged_correction" ||
        Object.hasOwn(correctionNote ?? {}, "correction"))
    ) {
      throw new Error("Flagged-correction proposals can only change through correction review.");
    }
    if (
      existing.requires_approval === true &&
      existing.status === MemoryStatus.Active &&
      !options.allowProtected
    ) {
      throw new Error("Protected memories must be changed through a proposal workflow.");
    }
    const normalizedPatch = cleanPatch(patch);
    if (normalizedPatch.status !== undefined && normalizedPatch.status !== existing.status) {
      throw new Error("Memory status changes must use the dedicated approval or archive workflow.");
    }
    return persist(
      { ...existing, ...normalizedPatch, id, updated_at: now() },
      commitSubject.memoryUpdate(id),
      agent_id,
    );
  }

  function archiveMemory(id: string, agent_id: string = DEFAULT_AGENT_ID): Memory | null {
    const existing = getMemory(id);
    if (!existing) throw new Error(`No memory found for id ${id}`);
    const correction_work = cancelCorrectionWork(existing.correction_work, "cancelled_by_archive");
    if (existing.status === MemoryStatus.Archived && correction_work === existing.correction_work) {
      return existing; // idempotent
    }
    return persist(
      withCorrectionWork(
        { ...existing, status: MemoryStatus.Archived, updated_at: now() },
        correction_work,
      ),
      commitSubject.memoryArchive(id),
      agent_id,
    );
  }

  function archiveFlaggedMemory(id: string, agent_id: string = DEFAULT_AGENT_ID): Memory | null {
    const existing = getMemory(id);
    if (!existing) throw new Error(`No memory found for id ${id}`);
    const correction_work = cancelCorrectionWork(existing.correction_work, "cancelled_by_archive");
    if (
      existing.status === MemoryStatus.Archived &&
      (existing.flags ?? []).length === 0 &&
      correction_work === existing.correction_work
    ) {
      return existing;
    }
    return persist(
      withCorrectionWork(
        { ...existing, status: MemoryStatus.Archived, flags: [], updated_at: now() },
        correction_work,
      ),
      commitSubject.memoryArchive(id),
      agent_id,
    );
  }

  // The narrow inverse of archiveMemory (spec 044 D-5b): restore an archived
  // memory to Active. Used by the admin `unmerge` mutation to un-archive the
  // sources a bad merge collapsed. Mirrors archiveMemory's shape exactly —
  // status transition + updated_at + commit — and is idempotent (an
  // already-active memory is returned unchanged, no commit).
  function unarchiveMemory(id: string, agent_id: string = DEFAULT_AGENT_ID): Memory | null {
    const existing = getMemory(id);
    if (!existing) throw new Error(`No memory found for id ${id}`);
    if (existing.status === MemoryStatus.Active) return existing; // idempotent
    return persist(
      { ...existing, status: MemoryStatus.Active, updated_at: now() },
      commitSubject.memoryUnarchive(id),
      agent_id,
    );
  }

  // Permanently delete an ARCHIVED memory: hard-delete its vault document (the
  // narrow archive=move exception) and commit. The disposable index rebuilds
  // from the vault on the next read, so the row drops automatically — no
  // separate index delete. Guarded to archived-only so a one-click destroy can
  // never hit a live (active/proposed) memory: archive it first. Idempotent —
  // purging an already-absent memory is a no-op returning null. The deletion is
  // a git commit, so an admin can still recover it from history.
  function purgeMemory(id: string, agent_id: string = DEFAULT_AGENT_ID): Memory | null {
    const existing = getMemory(id);
    if (!existing) return null; // already gone — idempotent no-op
    if (existing.status !== MemoryStatus.Archived) {
      throw new Error(
        `Memory ${id} is ${existing.status}, not archived — only archived memories can be permanently deleted. Archive it first.`,
      );
    }
    const rel = pathForId(id);
    idToPath?.delete(id); // keep the resolver cache current
    // `existing` was resolved via pathForId, so `rel` is non-null here; the guard keeps
    // the pathspec-limited commit honest (an empty pathspec would throw — SC 1).
    if (rel) {
      vault.removeFile(rel);
      commit([rel], commitSubject.memoryPurge(id), agent_id);
    }
    return existing;
  }

  // Flag a memory as incorrect/misleading/outdated (spec 047 / ADR 0006).
  // Appends an open flag to the doc's `flags` list — the same storage method
  // `proposed` uses, no separate ledger. A flag NEVER changes the memory's
  // status (route-to-review, never archive); the calling agent is resolved
  // server-side and passed in as `agent_id` (never trust a client id for the
  // flagger). Multiple agents may flag the same memory. Fail-soft: an unknown
  // id is a no-op returning null (mirrors purgeMemory's idempotent style).
  function flagMemory(
    id: string,
    reason: string,
    agent_id: string = DEFAULT_AGENT_ID,
  ): Memory | null {
    const existing = getMemory(id);
    if (!existing) return null; // unknown id — fail-soft no-op
    const flags = [...(existing.flags ?? []), { agent_id, reason, created_at: now() }];
    return persist(
      { ...existing, flags, updated_at: now() },
      commitSubject.memoryFlag(id),
      agent_id,
    );
  }

  // The public flag path writes the flag and its digest-only correction marker
  // in one existing memory-store persist. Bodies and reasons remain on the
  // memory itself, never in operational work metadata.
  function flagMemoryForCorrection(input: {
    id: string;
    reason: string;
    agent_id: string;
    principal_id: string;
    shelf_id: string;
    manual_review_reason_code?: CorrectionManualReviewReasonCode;
  }): Memory | null {
    const { id, reason, agent_id, principal_id, shelf_id, manual_review_reason_code } = input;
    const existing = getMemory(id);
    if (!existing) return null;
    if (!principal_id || !shelf_id)
      throw new Error("Correction work requires resolved principal and shelf ids.");

    const queuedAt = now();
    const flagged: Memory = {
      ...existing,
      flags: [...(existing.flags ?? []), { agent_id, reason, created_at: queuedAt }],
      updated_at: queuedAt,
    };
    const digests = correctionDigests(flagged);
    const history = cancelCorrectionWork(existing.correction_work, "superseded_by_new_flag") ?? [];
    const workStatus: MemoryCorrectionWorkStatus =
      flagged.status === MemoryStatus.Active && manual_review_reason_code === undefined
        ? "pending"
        : "manual_review";
    const work: MemoryCorrectionWork = {
      ...digests,
      principal_id,
      shelf_id,
      status: workStatus,
      attempt_count: 0,
      queued_at: queuedAt,
    };
    if (workStatus === "manual_review") {
      work.reason_code =
        flagged.status === MemoryStatus.Active
          ? (manual_review_reason_code ?? "no_admin_scope")
          : "ineligible_status";
    }
    return persist(
      { ...flagged, correction_work: [...history, work] },
      commitSubject.memoryFlag(id),
      agent_id,
    );
  }

  function listDueMemoryCorrections(at: string = now()): {
    memory_id: string;
    work: MemoryCorrectionWork;
  }[] {
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) throw new Error(`Expected ISO-8601 timestamp, got '${at}'.`);
    const isDue = (value?: string) => value === undefined || Date.parse(value) <= atMs;
    const memories = readAllMemories();
    const byId = new Map(memories.map((memory) => [memory.id, memory]));
    return memories
      .flatMap((memory) =>
        (memory.correction_work ?? []).flatMap((work) => {
          const due =
            (work.status === "pending" && isDue(work.next_attempt_at)) ||
            (work.status === "processing" &&
              (work.lease_expires_at === undefined || isDue(work.lease_expires_at))) ||
            (work.status === "proposal_pending" &&
              (!work.proposal_id || byId.get(work.proposal_id)?.status !== MemoryStatus.Proposed));
          return due ? [{ memory_id: memory.id, work }] : [];
        }),
      )
      .sort((a, b) => cmpStr(a.work.queued_at, b.work.queued_at));
  }

  function claimMemoryCorrection(input: {
    id: string;
    snapshot_digest: string;
    lease_ms?: number;
    agent_id?: string;
  }): MemoryCorrectionWork | null {
    const {
      id,
      snapshot_digest,
      lease_ms = CORRECTION_LEASE_MS,
      agent_id = "system-memory-correction",
    } = input;
    if (!Number.isFinite(lease_ms) || lease_ms <= 0) {
      throw new Error(`Expected a positive correction lease duration, got '${lease_ms}'.`);
    }
    const existing = getMemory(id);
    if (!existing) return null;
    const index = (existing.correction_work ?? []).findIndex(
      (work) => work.snapshot_digest === snapshot_digest,
    );
    if (index < 0) return null;
    const work = existing.correction_work?.[index];
    if (!work) return null;
    const claimedAt = now();
    const claimedAtMs = Date.parse(claimedAt);
    if (!Number.isFinite(claimedAtMs)) {
      throw new Error(`Expected ISO-8601 timestamp, got '${claimedAt}'.`);
    }
    const isExpired =
      work.status === "processing" &&
      (work.lease_expires_at === undefined || Date.parse(work.lease_expires_at) <= claimedAtMs);
    const isPending =
      work.status === "pending" &&
      (work.next_attempt_at === undefined || Date.parse(work.next_attempt_at) <= claimedAtMs);
    if (!isPending && !isExpired) return null;

    const persistWork = (nextWork: MemoryCorrectionWork): MemoryCorrectionWork => {
      const correction_work = [...(existing.correction_work ?? [])];
      correction_work[index] = nextWork;
      const saved = persist(
        { ...existing, correction_work, updated_at: claimedAt },
        commitSubject.memoryUpdate(id),
        agent_id,
      );
      const savedWork = saved.correction_work?.[index];
      if (!savedWork) throw new Error(`Correction marker disappeared while persisting ${id}.`);
      return savedWork;
    };
    if (correctionDigests(existing).snapshot_digest !== snapshot_digest) {
      const { lease_expires_at: _lease, ...withoutLease } = work;
      persistWork({ ...withoutLease, status: "manual_review", reason_code: "snapshot_drift" });
      return null;
    }
    if (work.attempt_count >= CORRECTION_MAX_ATTEMPTS) {
      const { lease_expires_at: _lease, ...withoutLease } = work;
      persistWork({ ...withoutLease, status: "manual_review", reason_code: "max_attempts" });
      return null;
    }
    const { next_attempt_at: _nextAttempt, ...ready } = work;
    return persistWork({
      ...ready,
      status: "processing",
      attempt_count: work.attempt_count + 1,
      lease_expires_at: new Date(claimedAtMs + lease_ms).toISOString(),
    });
  }

  function updateMemoryCorrectionWork(input: {
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
  }): MemoryCorrectionWork | null {
    const {
      id,
      snapshot_digest,
      claim_attempt,
      patch,
      agent_id = "system-memory-correction",
    } = input;
    const existing = getMemory(id);
    if (!existing) return null;
    const works = existing.correction_work ?? [];
    const index = works.findIndex((work) => work.snapshot_digest === snapshot_digest);
    const work = works[index];
    const updatedAt = now();
    if (
      !work ||
      patch.status === "applied" ||
      patch.status === "cancelled" ||
      !correctionClaimMatches({
        memory: existing,
        work,
        snapshot_digest,
        claim_attempt,
        at: updatedAt,
      })
    ) {
      return null;
    }
    const {
      lease_expires_at: _oldLease,
      next_attempt_at: _oldNextAttempt,
      ...withoutSchedule
    } = work;
    const status: MemoryCorrectionWorkStatus = patch.status;
    const nextWork: MemoryCorrectionWork = { ...withoutSchedule, ...patch, status };
    const correction_work = [...works];
    correction_work[index] = nextWork;
    const saved = persist(
      { ...existing, correction_work, updated_at: updatedAt },
      commitSubject.memoryUpdate(id),
      agent_id,
    );
    return saved.correction_work?.[index] ?? null;
  }

  function applyMemoryCorrection(input: {
    id: string;
    snapshot_digest: string;
    claim_attempt: number;
    spans: readonly MemoryCorrectionSpan[];
    agent_id?: string;
  }): Memory | null {
    const { id, snapshot_digest, claim_attempt, spans } = input;
    const agent_id = input.agent_id ?? "system-memory-correction";
    const existing = getMemory(id);
    if (
      !existing ||
      existing.status !== MemoryStatus.Active ||
      existing.requires_approval ||
      existing.flags.length === 0 ||
      existing.flags.length > CORRECTION_MAX_FLAGS
    ) {
      return null;
    }
    const works = existing.correction_work ?? [];
    const index = works.findIndex((work) => work.snapshot_digest === snapshot_digest);
    const work = works[index];
    const appliedAt = now();
    if (
      !work ||
      !correctionClaimMatches({
        memory: existing,
        work,
        snapshot_digest,
        claim_attempt,
        at: appliedAt,
      })
    ) {
      return null;
    }
    const body = applyCorrectionSpans(existing.body, spans);
    if (body === null) return null;

    const {
      lease_expires_at: _lease,
      next_attempt_at: _nextAttempt,
      reason_code: _reason,
      ...completedWork
    } = work;
    const correction_work = [...works];
    correction_work[index] = { ...completedWork, status: "applied", applied_at: appliedAt };
    return persist(
      { ...existing, body, flags: [], correction_work, updated_at: appliedAt },
      commitSubject.memoryUpdate(id),
      agent_id,
    );
  }

  // Clear every open flag on a memory (spec 047 / ADR 0006) — the adjudication
  // primitive the dashboard drives once a flag has been reviewed. Leaves the
  // status untouched (a flag never moved it). Fail-soft: an unknown id is a
  // no-op returning null.
  function getMemoryCorrectionProposal(input: {
    source_memory_id: string;
    snapshot_digest: string;
  }): Memory | null {
    return (
      listAll().find((proposal) => {
        const note = proposal.curator_note;
        const correction = note && isPlainRecord(note.correction) ? note.correction : null;
        return (
          note?.source === "flagged_correction" &&
          correction?.source_memory_id === input.source_memory_id &&
          correction?.snapshot_digest === input.snapshot_digest
        );
      }) ?? null
    );
  }

  function createMemoryCorrectionProposal(input: MemoryCorrectionProposalInput): Memory | null {
    const existingProposal = getMemoryCorrectionProposal({
      source_memory_id: input.source_memory_id,
      snapshot_digest: input.snapshot_digest,
    });
    if (existingProposal) return existingProposal;

    const source = getMemory(input.source_memory_id);
    if (
      !source ||
      source.status !== MemoryStatus.Active ||
      source.flags.length === 0 ||
      source.flags.length > CORRECTION_MAX_FLAGS ||
      input.shelf_id.length === 0
    ) {
      return null;
    }
    const work = source.correction_work?.find(
      (item) => item.snapshot_digest === input.snapshot_digest,
    );
    const createdAt = now();
    if (
      !work ||
      work.source_digest !== input.source_digest ||
      work.flags_digest !== input.flags_digest ||
      !correctionClaimMatches({
        memory: source,
        work,
        snapshot_digest: input.snapshot_digest,
        claim_attempt: input.claim_attempt,
        at: createdAt,
      })
    ) {
      return null;
    }
    const proposedBody = applyCorrectionSpans(source.body, input.spans);
    if (proposedBody === null || proposedBody !== input.proposed_body) return null;

    const normalizedProposedBody = normalizeString(proposedBody);
    const proposedContentDigest = memoryContentDigest({
      title: source.title,
      body: normalizedProposedBody,
    });
    const curator_note = {
      source: "flagged_correction",
      proposed_action: "update",
      rationale: redactSecrets(input.rationale).redacted,
      supersedes: [source.id],
      source_digests: { [source.id]: memoryContentDigest(source) },
      correction: {
        version: 1,
        source_memory_id: source.id,
        source_shelf_id: input.shelf_id,
        snapshot_digest: input.snapshot_digest,
        source_digest: input.source_digest,
        flags_digest: input.flags_digest,
        proposed_content_digest: proposedContentDigest,
      },
    };
    return createMemory(
      {
        title: source.title,
        body: normalizedProposedBody,
        agent_id: input.agent_id,
        confidence: source.confidence,
        tags: source.tags,
        applies_to: source.applies_to,
        is_global: source.is_global,
      },
      {
        is_global: source.is_global,
        requires_approval: true,
        curator_note,
        audit_actor_id: SYSTEM_ACTOR_IDS.memoryCurator,
      },
    ).memory;
  }

  function inspectMemoryCorrectionProposal(input: {
    proposal_id: string;
    shelf_id: string;
  }): MemoryCorrectionProposalReview | null {
    const proposal = getMemory(input.proposal_id);
    const note = proposal?.curator_note;
    const isCorrection =
      note?.source === "flagged_correction" || Object.hasOwn(note ?? {}, "correction");
    if (!proposal || !isCorrection) return null;

    const raw = note?.correction;
    if (!isPlainRecord(raw)) {
      return {
        source_memory_id: null,
        shelf_id: input.shelf_id,
        status: "blocked",
        reason_code: "invalid_correction_baseline",
      };
    }
    const sourceId = raw.source_memory_id;
    const sourceShelfId = raw.source_shelf_id;
    const snapshotDigest = raw.snapshot_digest;
    const sourceDigest = raw.source_digest;
    const flagsDigest = raw.flags_digest;
    const proposedContentDigest = raw.proposed_content_digest;
    if (
      typeof sourceId !== "string" ||
      typeof sourceShelfId !== "string" ||
      typeof snapshotDigest !== "string" ||
      typeof sourceDigest !== "string" ||
      typeof flagsDigest !== "string" ||
      typeof proposedContentDigest !== "string" ||
      raw.version !== 1 ||
      sourceShelfId !== input.shelf_id ||
      !/^[a-f0-9]{64}$/.test(snapshotDigest) ||
      !/^[a-f0-9]{64}$/.test(sourceDigest) ||
      !/^[a-f0-9]{64}$/.test(flagsDigest) ||
      !/^[a-f0-9]{64}$/.test(proposedContentDigest)
    ) {
      return {
        source_memory_id: typeof sourceId === "string" ? sourceId : null,
        shelf_id: input.shelf_id,
        status: "blocked",
        reason_code: "invalid_correction_baseline",
      };
    }

    const source = getMemory(sourceId);
    if (!source) {
      return {
        source_memory_id: sourceId,
        shelf_id: input.shelf_id,
        status: "blocked",
        reason_code: "correction_source_missing",
      };
    }
    const work = source.correction_work?.find((item) => item.snapshot_digest === snapshotDigest);
    const sourceDigests = note?.source_digests;
    const sourceContentDigest = isPlainRecord(sourceDigests) ? sourceDigests[sourceId] : undefined;
    const supersedes = note?.supersedes;
    const current = correctionDigests(source);
    let reasonCode: string | undefined;
    if (proposal.status !== MemoryStatus.Proposed || proposal.requires_approval !== true) {
      reasonCode = "correction_proposal_not_open";
    } else if (
      note?.proposed_action !== "update" ||
      !Array.isArray(supersedes) ||
      supersedes.length !== 1 ||
      supersedes[0] !== sourceId
    ) {
      reasonCode = "invalid_correction_baseline";
    } else if (source.status !== MemoryStatus.Active || source.flags.length === 0) {
      reasonCode = "correction_source_not_reviewable";
    } else if (
      !work ||
      work.status !== "proposal_pending" ||
      work.proposal_id !== proposal.id ||
      work.shelf_id !== input.shelf_id ||
      work.source_digest !== sourceDigest ||
      work.flags_digest !== flagsDigest ||
      work.snapshot_digest !== snapshotDigest
    ) {
      reasonCode = "correction_work_drifted";
    } else if (
      current.source_digest !== sourceDigest ||
      current.flags_digest !== flagsDigest ||
      current.snapshot_digest !== snapshotDigest ||
      sourceContentDigest !== memoryContentDigest(source) ||
      proposedContentDigest !== memoryContentDigest(proposal)
    ) {
      reasonCode = "correction_content_drifted";
    }

    return reasonCode
      ? {
          source_memory_id: sourceId,
          shelf_id: input.shelf_id,
          status: "blocked",
          reason_code: reasonCode,
        }
      : { source_memory_id: sourceId, shelf_id: input.shelf_id, status: "ready" };
  }

  function reconcileMemoryCorrectionProposalResolution(input: {
    source_memory_id: string;
    proposal_id?: string;
    snapshot_digest: string;
    shelf_id: string;
    agent_id?: string;
  }): MemoryCorrectionWork | null {
    const source = getMemory(input.source_memory_id);
    if (!source) return null;
    const works = source.correction_work ?? [];
    const workIndex = works.findIndex((item) => item.snapshot_digest === input.snapshot_digest);
    const work = works[workIndex];
    if (
      !work ||
      work.status !== "proposal_pending" ||
      work.shelf_id !== input.shelf_id ||
      (input.proposal_id !== undefined && input.proposal_id !== work.proposal_id)
    ) {
      return work ?? null;
    }

    const markManualReview = (reason_code: string): MemoryCorrectionWork | null => {
      const { lease_expires_at: _lease, next_attempt_at: _nextAttempt, ...withoutSchedule } = work;
      const correction_work = [...works];
      correction_work[workIndex] = {
        ...withoutSchedule,
        status: "manual_review",
        reason_code,
      };
      const saved = persist(
        { ...source, correction_work, updated_at: now() },
        commitSubject.memoryUpdate(source.id),
        input.agent_id ?? DEFAULT_AGENT_ID,
      );
      return saved.correction_work?.[workIndex] ?? null;
    };

    const proposalId = input.proposal_id ?? work.proposal_id;
    if (!proposalId || proposalId !== work.proposal_id) {
      return markManualReview("correction_proposal_missing");
    }
    const proposal = getMemory(proposalId);
    if (!proposal) return markManualReview("correction_proposal_missing");

    const note = proposal.curator_note;
    const rawCorrection = note?.correction;
    const correction = isPlainRecord(rawCorrection) ? rawCorrection : null;
    const sourceDigests = note?.source_digests;
    const sourceContentDigest = isPlainRecord(sourceDigests) ? sourceDigests[source.id] : undefined;
    const reviewedAt = correction?.reviewed_at;
    const reviewedBy = correction?.reviewed_by;
    const current = correctionDigests(source);
    const validBaseline =
      note?.source === "flagged_correction" &&
      note.proposed_action === "update" &&
      Array.isArray(note.supersedes) &&
      note.supersedes.length === 1 &&
      note.supersedes[0] === source.id &&
      correction?.version === 1 &&
      correction.source_memory_id === source.id &&
      correction.source_shelf_id === input.shelf_id &&
      correction.snapshot_digest === work.snapshot_digest &&
      correction.source_digest === work.source_digest &&
      correction.flags_digest === work.flags_digest &&
      correction.proposed_content_digest === memoryContentDigest(proposal) &&
      current.snapshot_digest === work.snapshot_digest &&
      current.source_digest === work.source_digest &&
      current.flags_digest === work.flags_digest &&
      typeof sourceContentDigest === "string" &&
      sourceContentDigest === memoryContentDigest(source) &&
      source.status === MemoryStatus.Active &&
      source.flags.length > 0 &&
      typeof reviewedAt === "string" &&
      Number.isFinite(Date.parse(reviewedAt)) &&
      new Date(Date.parse(reviewedAt)).toISOString() === reviewedAt &&
      typeof reviewedBy === "string" &&
      reviewedBy.length > 0;
    if (!validBaseline || !correction) {
      return markManualReview("correction_proposal_resolution_drifted");
    }

    const outcome = correction.review_outcome;
    if (outcome === "approved" && proposal.status === MemoryStatus.Active) {
      const {
        lease_expires_at: _lease,
        next_attempt_at: _nextAttempt,
        reason_code: _reason,
        ...completedWork
      } = work;
      const correction_work = [...works];
      correction_work[workIndex] = {
        ...completedWork,
        status: "applied",
        applied_at: reviewedAt,
      };
      const archived = persist(
        {
          ...source,
          status: MemoryStatus.Archived,
          flags: [],
          correction_work,
          updated_at: reviewedAt,
        },
        commitSubject.memoryArchive(source.id),
        reviewedBy,
      );
      withdrawInvalidatedProposals(proposal.id, [source.id], reviewedBy);
      return archived.correction_work?.[workIndex] ?? null;
    }
    if (outcome === "rejected" && proposal.status === MemoryStatus.Archived) {
      return markManualReview("correction_proposal_rejected");
    }
    return markManualReview("correction_proposal_resolution_mismatch");
  }

  function approveMemoryCorrectionProposal(input: {
    proposal_id: string;
    shelf_id: string;
    agent_id?: string;
  }): Memory | null {
    const proposal = getMemory(input.proposal_id);
    if (!proposal) throw new Error(`No memory found for id ${input.proposal_id}`);
    const review = inspectMemoryCorrectionProposal(input);
    if (review?.status !== "ready" || review.source_memory_id === null) {
      throw new Error(
        `Correction proposal cannot be approved: ${review?.reason_code ?? "not_a_correction_proposal"}.`,
      );
    }
    const note = proposal.curator_note;
    const correction = note?.correction;
    if (!note || !isPlainRecord(correction)) {
      throw new Error("Correction proposal has no recoverable review baseline.");
    }

    const agent_id = input.agent_id ?? DEFAULT_AGENT_ID;
    const approvedAt = now();
    const approved = persist(
      {
        ...proposal,
        status: MemoryStatus.Active,
        curator_note: {
          ...note,
          correction: {
            ...correction,
            review_outcome: "approved",
            reviewed_at: approvedAt,
            reviewed_by: agent_id,
          },
        },
        updated_at: approvedAt,
      },
      commitSubject.memoryApprove(proposal.id),
      agent_id,
    );

    const completed = reconcileMemoryCorrectionProposalResolution({
      source_memory_id: review.source_memory_id,
      proposal_id: proposal.id,
      snapshot_digest: correction.snapshot_digest as string,
      shelf_id: input.shelf_id,
      agent_id,
    });
    if (completed?.status !== "applied") {
      throw new Error("Correction source changed during approval; manual review is required.");
    }
    return approved;
  }

  function rejectMemoryCorrectionProposal(input: {
    proposal_id: string;
    shelf_id: string;
    agent_id?: string;
  }): Memory | null {
    const existing = getMemory(input.proposal_id);
    if (!existing) throw new Error(`No memory found for id ${input.proposal_id}`);
    if (existing.status !== MemoryStatus.Proposed) {
      throw new Error(`Memory ${input.proposal_id} is not proposed`);
    }
    const note = existing.curator_note;
    const correction = note?.correction;
    if (
      note?.source !== "flagged_correction" ||
      !isPlainRecord(correction) ||
      correction.source_shelf_id !== input.shelf_id
    ) {
      throw new Error("Correction proposal does not belong to the requested shelf.");
    }

    const agent_id = input.agent_id ?? DEFAULT_AGENT_ID;
    const rejectedAt = now();
    const rejected = persist(
      {
        ...existing,
        status: MemoryStatus.Archived,
        curator_note: {
          ...note,
          correction: {
            ...correction,
            review_outcome: "rejected",
            reviewed_at: rejectedAt,
            reviewed_by: agent_id,
          },
        },
        updated_at: rejectedAt,
      },
      commitSubject.memoryReject(existing.id),
      agent_id,
    );
    reconcileMemoryCorrectionProposalResolution({
      source_memory_id:
        typeof correction.source_memory_id === "string" ? correction.source_memory_id : "",
      proposal_id: existing.id,
      snapshot_digest:
        typeof correction.snapshot_digest === "string" ? correction.snapshot_digest : "",
      shelf_id: input.shelf_id,
      agent_id,
    });
    return rejected;
  }

  function resolveFlags(id: string, agent_id: string = DEFAULT_AGENT_ID): Memory | null {
    const existing = getMemory(id);
    if (!existing) return null; // unknown id — fail-soft no-op
    const correction_work = cancelCorrectionWork(existing.correction_work, "cancelled_by_dismiss");
    return persist(
      withCorrectionWork({ ...existing, flags: [], updated_at: now() }, correction_work),
      commitSubject.memoryResolveFlags(id),
      agent_id,
    );
  }

  function approveProposal(
    id: string,
    action: string = "approve",
    patch: Record<string, unknown> = {},
    agent_id: string = DEFAULT_AGENT_ID,
  ): Memory | null {
    const existing = getMemory(id);
    if (!existing) throw new Error(`No memory found for id ${id}`);
    if (existing.status !== MemoryStatus.Proposed) throw new Error(`Memory ${id} is not proposed`);
    if (
      existing.curator_note?.source === "flagged_correction" ||
      Object.hasOwn(existing.curator_note ?? {}, "correction")
    ) {
      throw new Error("Flagged-correction proposals require exact-shelf correction review.");
    }
    if (action === "reject") {
      return persist(
        { ...existing, status: MemoryStatus.Archived, updated_at: now() },
        commitSubject.memoryReject(id),
        agent_id,
      );
    }
    // Activate the proposal FIRST, then archive what it supersedes — so the
    // replacement is live before any source is dropped (never a window with no
    // active memory for the fact).
    const approved = persist(
      { ...existing, ...cleanPatch(patch), status: MemoryStatus.Active, updated_at: now() },
      commitSubject.memoryApprove(id),
      agent_id,
    );
    // Replace-on-approve (spec 2026-06-20 proposal-review-ux, D4): a proposed
    // update/supersede/merge replaces its sources, so archive them on approval.
    // `split` is EXCLUDED — an admin may accept some split replacements and reject
    // others, so archiving the shared source on one approval would be premature
    // (it's archived later via an explicit affordance). Read curator_note
    // defensively: it may be absent/null, and proposed_action/supersedes may be
    // missing or the wrong shape on a free-form record. Each archive is its own
    // git commit via the existing store primitive, and is fail-soft — an
    // already-archived id no-ops (archiveMemory is idempotent) and an unknown id
    // is skipped rather than thrown.
    const note = existing.curator_note;
    const proposedAction = note?.proposed_action;
    const supersedes = note?.supersedes;
    const replacesSources =
      proposedAction === "update" || proposedAction === "supersede" || proposedAction === "merge";
    const archivedSourceIds: string[] = [];
    if (replacesSources && Array.isArray(supersedes)) {
      for (const sourceId of supersedes) {
        if (typeof sourceId !== "string" || sourceId.length === 0) continue;
        if (!getMemory(sourceId)) continue; // unknown id — fail-soft skip
        archiveMemory(sourceId, agent_id); // idempotent on an already-archived source
        archivedSourceIds.push(sourceId);
      }
    }
    // Cascade (spec 072, D4/D5): archiving those sources invalidated every OTHER
    // open proposal about them. Keyed on what was ARCHIVED rather than on what
    // was approved — which is exactly what keeps a split's sibling replacements
    // (they all supersede the same source by construction) alive when one of
    // them is approved: split archives nothing, so nothing cascades.
    if (archivedSourceIds.length > 0) withdrawInvalidatedProposals(id, archivedSourceIds, agent_id);
    return approved;
  }

  // Spec 072 (SC 1-3). Before this, two open proposals could supersede the same
  // memory M, and approving BOTH left two active memories each claiming to
  // replace M — silently, because the second archive of M no-ops
  // (`archiveMemory` is idempotent). Generic peer withdrawal reuses
  // `resolveProposal`; stale flagged-correction peers use their dedicated
  // invalidation path. Both remain archived in git, and grooming re-proposes
  // generic judgments on the next sweep if they still stand. Fail-soft: a peer with a
  // malformed `supersedes` is skipped, never thrown on.
  function withdrawInvalidatedProposals(
    approvedId: string,
    archivedSourceIds: string[],
    agent_id: string,
  ): void {
    const archived = new Set(archivedSourceIds);
    for (const peer of listAll({ status: MemoryStatus.Proposed })) {
      if (peer.id === approvedId) continue;
      const supersedes = peer.curator_note?.supersedes;
      if (!Array.isArray(supersedes)) continue;
      if (!supersedes.some((s) => typeof s === "string" && archived.has(s))) continue;
      const resolution = `superseded_by_approval:${approvedId}`;
      const isCorrectionProposal =
        peer.curator_note?.source === "flagged_correction" ||
        Object.hasOwn(peer.curator_note ?? {}, "correction");
      if (isCorrectionProposal) {
        // This correction proposal is stale because its exact source was archived by another
        // approved proposal. Withdraw it as invalidated, not rejected; resolveProposal correctly
        // refuses to route correction proposals through the generic review path.
        persist(
          {
            ...peer,
            status: MemoryStatus.Archived,
            curator_note: { ...(peer.curator_note ?? {}), resolution },
            updated_at: now(),
          },
          commitSubject.memoryResolve(peer.id, resolution),
          agent_id,
        );
      } else {
        resolveProposal(peer.id, resolution, agent_id);
      }
    }
  }

  // Resolve a proposal OUT of the queue with provenance (proposal-review
  // rework 2026-07-01, D8/D9): archive it and stamp curator_note.resolution —
  // "applied_plan" when the persisted plan was executed against its target,
  // "resolved_via_chat" when a proposal-grounded chat action was confirmed.
  // Unlike approveProposal's approve arm this NEVER archives supersedes
  // sources — the resolving mutation already happened elsewhere; this is pure
  // queue bookkeeping. curator_note is not patchable over the wire (cleanPatch
  // strips it), so this trusted seam is the only writer of `resolution`.
  function resolveProposal(
    id: string,
    resolution: string,
    agent_id: string = DEFAULT_AGENT_ID,
  ): Memory | null {
    const existing = getMemory(id);
    if (!existing) throw new Error(`No memory found for id ${id}`);
    if (existing.status !== MemoryStatus.Proposed) throw new Error(`Memory ${id} is not proposed`);
    if (
      existing.curator_note?.source === "flagged_correction" ||
      Object.hasOwn(existing.curator_note ?? {}, "correction")
    ) {
      throw new Error("Flagged-correction proposals must be approved or rejected directly.");
    }
    return persist(
      {
        ...existing,
        status: MemoryStatus.Archived,
        curator_note: { ...(existing.curator_note ?? {}), resolution },
        updated_at: now(),
      },
      commitSubject.memoryResolve(id, resolution),
      agent_id,
    );
  }

  function readAllMemories(): Memory[] {
    return vault.listMarkdown("memories").map((rel) => parseMemoryDocument(vault.readText(rel)));
  }

  function listAll(filters: Record<string, unknown> = {}): Memory[] {
    let out = readAllMemories();
    if (filters.status) out = out.filter((m) => m.status === filters.status);
    if (filters.agent_id) out = out.filter((m) => m.agent_id === filters.agent_id);
    return out.sort((a, b) => cmpStr(b.updated_at, a.updated_at));
  }

  // The FULL filtered + sorted row set `listMemories` pages over — extracted (spec 065 SC 7) so
  // the principal-scoped merged list can enumerate per-shelf rows UNCAPPED: the public
  // `listMemories` clamps `limit` at 200 and slices INTERNALLY, so a cross-shelf merge built on it
  // would silently truncate any page past rank 200 per shelf. Filter + sort semantics are the one
  // shared implementation (byte-identical to the pre-065 inline code).
  function filterAndSortMemories(filters: Record<string, unknown> = {}): Memory[] {
    let out = readAllMemories();
    if (filters.status) out = out.filter((m) => m.status === filters.status);
    if (filters.agent_id) out = out.filter((m) => m.agent_id === filters.agent_id);
    if (filters.is_global !== undefined) {
      out = out.filter((m) => m.is_global === Boolean(filters.is_global));
    }
    if (filters.requires_approval !== undefined) {
      out = out.filter((m) => m.requires_approval === Boolean(filters.requires_approval));
    }
    if (filters.has_open_flags !== undefined) {
      const wantFlagged = Boolean(filters.has_open_flags);
      out = out.filter((m) => (m.flags ?? []).length > 0 === wantFlagged);
    }
    if (Array.isArray(filters.tags) && filters.tags.length > 0) {
      const wanted = filters.tags as string[];
      out = out.filter((m) => wanted.some((tag) => m.tags.includes(tag)));
    }
    if (filters.from) out = out.filter((m) => String(m.created_at) >= String(filters.from));
    if (filters.to) {
      // `to` is a date; compare against end-of-day.
      const ceiling = `${String(filters.to)}T23:59:59.999Z`;
      out = out.filter((m) => String(m.created_at) <= ceiling);
    }

    const sortField: "created_at" | "updated_at" | "title" = (
      ["created_at", "updated_at", "title"] as const
    ).includes(filters.sort as "created_at" | "updated_at" | "title")
      ? (filters.sort as "created_at" | "updated_at" | "title")
      : "updated_at";
    const asc = filters.order === "asc";
    out.sort((a, b) => {
      const cmp = cmpStr(String(a[sortField]), String(b[sortField]));
      return asc ? cmp : -cmp;
    });
    return out;
  }

  function listMemories(filters: Record<string, unknown> = {}) {
    const out = filterAndSortMemories(filters);
    const total = out.length;
    const limit = Math.min(Math.max(Number(filters.limit ?? 100), 1), 200);
    const offset = Math.max(Number(filters.offset ?? 0), 0);
    return { memories: out.slice(offset, offset + limit), total, limit, offset };
  }

  // UNCAPPED enumeration (spec 065 SC 7): every filtered row, sorted, NO limit clamp and NO
  // internal slice — the per-shelf feed for `listMemoriesForPrincipal`'s merge. Pagination is the
  // MERGE's job (offset/limit apply AFTER cross-shelf ordering); a per-shelf cap here would
  // reintroduce the truncation this method exists to avoid.
  function listMemoriesUncapped(filters: Record<string, unknown> = {}): {
    memories: Memory[];
    total: number;
  } {
    const memories = filterAndSortMemories(filters);
    return { memories, total: memories.length };
  }

  function searchMemories(input: Record<string, unknown> = {}): Memory[] {
    const query = typeof input.query === "string" ? input.query : "";
    const limit = typeof input.limit === "number" ? input.limit : 8;
    const status = (input.status as string | undefined) ?? MemoryStatus.Active;
    const cleaned = normalizeString(query);
    const tagSet = new Set(asArray(input.tags));

    const allowed = listAll({ status }).filter((memory) => {
      if (!tagSet.size) return true;
      return (memory.tags || []).some((tag) => tagSet.has(tag));
    });
    if (!cleaned) return allowed.slice(0, limit);

    const terms = tokenize(cleaned);
    const scored = allowed
      .map((memory) => {
        const haystack = `${memory.title} ${memory.body} ${memory.tags.join(" ")}`.toLowerCase();
        let relevance = 0;
        for (const term of terms) if (haystack.includes(term)) relevance += term.length > 4 ? 3 : 1;
        // Soft-demote a flagged memory (spec 047 / ADR 0006): a bounded penalty
        // ranks a memory with ≥1 open flag below an equivalent unflagged one in
        // the result order — but only the pre-penalty `relevance` gates
        // inclusion, so a genuinely-matching flagged memory is still returned
        // (route-to-review, never drop from recall).
        const score = relevance - ((memory.flags ?? []).length > 0 ? FLAG_PENALTY : 0);
        return { memory, relevance, score };
      })
      .filter((item) => item.relevance > 0);

    scored.sort(
      (a, b) => b.score - a.score || b.memory.updated_at.localeCompare(a.memory.updated_at),
    );
    return scored.slice(0, limit).map((item) => item.memory);
  }

  function detectRelated(candidate: Memory, options: { threshold?: number } = {}) {
    const terms = new Set(
      tokenize(`${candidate.title} ${candidate.body} ${candidate.tags.join(" ")}`),
    );
    if (!terms.size) return { duplicates: [] as Memory[] };
    const pool = listAll({
      status: MemoryStatus.Active,
      agent_id: candidate.agent_id,
    }).filter((memory) => memory.id !== candidate.id);
    const duplicates = pool
      .map((memory) => {
        const other = new Set(tokenize(`${memory.title} ${memory.body} ${memory.tags.join(" ")}`));
        const overlap = [...terms].filter((term) => other.has(term)).length;
        return { memory, ratio: overlap / Math.max(terms.size, other.size, 1) };
      })
      .filter((item) => item.ratio >= (options.threshold ?? 0.55))
      .map((item) => item.memory);
    return { duplicates };
  }

  function getRelated(id: string) {
    const memory = getMemory(id);
    if (!memory) return null;
    const terms = new Set(tokenize(`${memory.title} ${memory.body} ${memory.tags.join(" ")}`));
    if (!terms.size) return { memory, related: [] };
    const pool = listAll({
      status: MemoryStatus.Active,
      agent_id: memory.agent_id,
    }).filter((other) => other.id !== id);
    const related = pool
      .map((other) => {
        const otherTerms = new Set(
          tokenize(`${other.title} ${other.body} ${other.tags.join(" ")}`),
        );
        const overlap = [...terms].filter((term) => otherTerms.has(term)).length;
        const ratio = overlap / Math.max(terms.size, otherTerms.size, 1);
        return { memory: other, ratio, isDuplicate: ratio >= 0.55 };
      })
      .filter((item) => item.ratio >= 0.32)
      .sort((a, b) => b.ratio - a.ratio);
    return { memory, related };
  }

  function getAggregates() {
    const active = listAll({}).filter((m) => m.status !== MemoryStatus.Archived);
    const tally = (field: "agent_id" | "status") => {
      const counts = new Map<unknown, number>();
      for (const memory of active) {
        const value = memory[field];
        if (!value) continue;
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([value, count]) => ({ value, count }));
    };
    return {
      agents: tally("agent_id"),
      statuses: tally("status"),
      total: active.length,
    };
  }

  function bulkUpdateMemory(input: {
    ids: string[];
    patch: { agent_id?: string };
    agent_id?: string;
  }): { transaction_id: string; updated: number } {
    const patch: Record<string, unknown> = {};
    if (input.patch.agent_id !== undefined) patch.agent_id = input.patch.agent_id;
    if (Object.keys(patch).length === 0) {
      throw new Error("bulkUpdateMemory requires agent_id in patch");
    }
    const transaction_id = makeId("txn");
    let updated = 0;
    for (const id of input.ids) {
      const existing = getMemory(id);
      if (!existing) continue;
      persist(
        { ...existing, ...patch, updated_at: now() },
        commitSubject.memoryBulkUpdate(id),
        input.agent_id,
      );
      updated++;
    }
    return { transaction_id, updated };
  }

  function distinctValues(input: { field: string; include_archived?: boolean }): string[] {
    if (input.field !== "agent_id") {
      throw new Error(`distinctValues field not allowed: ${input.field}`);
    }
    const includeArchived = input.include_archived === true;
    const values = new Set<string>();
    for (const memory of readAllMemories()) {
      if (!includeArchived && memory.status === MemoryStatus.Archived) continue;
      // The field is whitelisted to `agent_id` by the guard above.
      const value = memory.agent_id;
      if (typeof value === "string" && value.length > 0) values.add(value);
    }
    // Case-insensitive, locale-stable ordering.
    return [...values].sort((a, b) => cmpStr(a.toLowerCase(), b.toLowerCase()));
  }

  function countMemoriesByAgentId(): { agent_id: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const memory of readAllMemories()) {
      if (!memory.agent_id) continue;
      counts.set(memory.agent_id, (counts.get(memory.agent_id) ?? 0) + 1);
    }
    return [...counts.entries()].map(([agent_id, count]) => ({ agent_id, count }));
  }

  function listMemoryIdsByAgentId(agentId: string): string[] {
    return readAllMemories()
      .filter((memory) => memory.agent_id === agentId)
      .map((memory) => memory.id);
  }

  function startContext(input: { agent_id?: string; task_summary?: string } = {}) {
    const { agent_id = DEFAULT_AGENT_ID, task_summary = "" } = input;
    const globals = listAll({ status: MemoryStatus.Active, is_global: true });
    const privateMemories = searchMemories({
      agent_id,
      query: task_summary || agent_id,
      include_private: true,
      limit: 6,
    }).filter((memory) => memory.agent_id === agent_id);
    const relevant = task_summary
      ? searchMemories({
          agent_id,
          query: task_summary,
          include_private: true,
          limit: 8,
        })
      : [];
    const memories = uniqueById([...globals, ...privateMemories, ...relevant]);
    return {
      memories,
      text: formatContextPackage({
        identity: globals,
        relationship: [],
        privateMemories,
        relevant,
      }),
    };
  }

  return {
    createMemory,
    getMemory,
    listAll,
    listMemories,
    listMemoriesUncapped,
    getAggregates,
    searchMemories,
    detectRelated,
    getRelated,
    updateMemory,
    archiveMemory,
    archiveFlaggedMemory,
    unarchiveMemory,
    purgeMemory,
    flagMemory,
    flagMemoryForCorrection,
    listDueMemoryCorrections,
    claimMemoryCorrection,
    updateMemoryCorrectionWork,
    applyMemoryCorrection,
    getMemoryCorrectionProposal,
    createMemoryCorrectionProposal,
    inspectMemoryCorrectionProposal,
    approveMemoryCorrectionProposal,
    rejectMemoryCorrectionProposal,
    reconcileMemoryCorrectionProposalResolution,
    resolveFlags,
    approveProposal,
    resolveProposal,
    bulkUpdateMemory,
    distinctValues,
    countMemoriesByAgentId,
    listMemoryIdsByAgentId,
    startContext,
  };
}
