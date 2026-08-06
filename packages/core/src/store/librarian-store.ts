import fs from "node:fs";
import path from "node:path";
import type { Principal } from "../caller-identity.js";
import type { CuratorConsumer } from "../curator-consumers.js";
import type { LlmClient } from "../grooming-llm-client.js";
import { createVaultGroomingMemorySource } from "../grooming-source-vault.js";
import type { GroomingStore } from "../grooming-worker.js";
import { type SweepSummary, runIntakeSweep } from "../intake/index.js";
import { PRIMER_PATH, type PrimerStore } from "../primer.js";
import { MemoryStatus } from "../schemas/common.js";
import {
  DEFAULT_SHELF,
  ShelfNotInWriteSetError,
  ShelfNotWritableError,
  type Shelf,
  type VaultRouter,
  defaultVaultRouter,
  validateShelfSet,
} from "../vault-router.js";
import {
  type AuditBuildContext,
  type AuditEvent,
  type AuditExportOptions,
  type AuditExportPage,
  AUDIT_PAGE_COMMITS,
  AuditCursorError,
  AuditSourceError,
  buildAuditEvents,
} from "./audit-export.js";
import { commitSubject } from "./commit-message.js";
import {
  type InboxItemRef,
  type InboxSubmissionHints,
  type Vault,
  UnsafeVaultPathError,
  createVault,
  scopeVault,
  writeInbox,
} from "./corpus/index.js";
import {
  type CorpusIndex,
  type RecalledMemory,
  type RecalledReference,
  type ReferenceHit,
  type ShelfRecall,
  type ShelfReferenceHits,
  buildCorpusIndex,
  mergeShelfRecalls,
  mergeShelfReferenceHits,
  recallMemories,
  searchReferences as searchVaultReferences,
} from "./corpus-index.js";
import type { CurationStore } from "./curation-store.js";
import {
  type CommitDiff,
  type GitPushAuth,
  type VaultCommit,
  createGitHistory,
  createSyncGitOps,
} from "./git/index.js";
import type { HandoffStore } from "./handoff-store.js";
import { createCachingEmbedder, createEmbeddingCache, resolveEmbedder } from "./index/index.js";
import type { IntakeStore } from "./intake-store.js";
import {
  createMarkdownHandoffStore,
  createMarkdownMemoryStore,
  createMarkdownProjectStore,
  createMarkdownProjectSuggestionStore,
  createMarkdownProjectUpdateStore,
  parseMemoryDocument,
} from "./markdown/index.js";
import type { Memory, MemoryStore } from "./memory-store.js";
import type { ProjectStore } from "./project-store.js";
import type { ProjectSuggestionStore } from "./project-suggestion-store.js";
import type { ProjectUpdateStore } from "./project-update-store.js";
import type { SettingsStore } from "./settings-store.js";
import {
  type ReadRefusalsOptions,
  type ReadRefusalsResult,
  type RecordRefusalInput,
  type RefusalLogErrorSink,
  REFUSAL_LOG_FILE,
  createJsonIntakeStore,
  createJsonCurationStore,
  createJsonSettingsStore,
  createRefusalLog,
  principalRefusalEvidence,
  resolveIntakeRunsPath,
} from "./sidecar/index.js";
import { type VaultFileStore, createVaultFileStore } from "./vault-files.js";
import {
  type VaultCommitSource,
  type VaultRestoreOptions,
  type VaultRestoreResult,
  classifyVaultCommit,
  restoreVaultToCommit,
} from "./vault-restore.js";

const DEFAULT_DATA_DIR = path.join(process.cwd(), "data");

/**
 * Resolve the data directory the store (and its sibling credential files) live in:
 * an explicit option wins, then `LIBRARIAN_DATA_DIR`, then `<cwd>/data`. Exported
 * so the boot path can place `secret.key` in the exact same dir the store will
 * use, before the store (which needs the key) is constructed.
 */
export function resolveDataDir(dataDir?: string): string {
  return dataDir || process.env.LIBRARIAN_DATA_DIR || DEFAULT_DATA_DIR;
}

export interface LibrarianStoreOptions {
  dataDir?: string;
  /**
   * Master key for the admin secret-store (memory-curator §7.1). Resolved by
   * the caller from `LIBRARIAN_SECRET_KEY` via `resolveSecretKey`. When absent,
   * secret settings throw on access; plain settings still work.
   */
  secretKey?: Buffer | null;
  /**
   * The vault-set router (spec 062 SC 2, ADR 0011 Decision 3): "which shelves does this
   * principal see, and where do writes land?". Defaults to {@link defaultVaultRouter} — the
   * inert OSS single-shelf-at-the-root behaviour. The 060 factory threads a plugin-supplied
   * router here (discharging spec 060 review residual 2).
   *
   * At spec 062 T1 the store STORES + exposes this ({@link LibrarianStore.vaultRouter}) but
   * reads it for NO routing decision yet — every path still hard-codes the vault root, so
   * behaviour is byte-identical to before. The shelf-scoped read/write paths (and the store's
   * runtime `validateShelfSet` application on each materialised set) land in later 062 tasks.
   */
  vaultRouter?: VaultRouter;
  /**
   * Clock injection (spec 062 SC 1 — the determinism plumbing, §4 "named API addition").
   * Threaded verbatim to the markdown memory + handoff stores' existing `deps.now`, which
   * defaults to `nowIso`. Its type MATCHES those stores' `now` (`() => string`, an ISO
   * timestamp). This is a pure PASS-THROUGH: absent, every written document stamps
   * `nowIso()` exactly as before — byte-identical. Present, the SC 1 golden layout test
   * feeds a fixed stepping clock so a representative write/groom cycle produces a
   * byte-stable vault tree (without it the comparison flakes on fresh timestamps).
   */
  now?: () => string;
  /**
   * Id generator injection (spec 062 SC 1 — the determinism plumbing). Threaded verbatim to
   * the markdown memory + handoff stores' existing `deps.generateId` (defaults to
   * `makeId("mem")` / `makeId("hdo")` — `randomUUID`-backed). Pure PASS-THROUGH: absent,
   * ids are minted exactly as before. Present, the golden test supplies a sequential
   * generator so the UUIDs-in-filenames stop flaking the byte comparison.
   */
  generateId?: () => string;
  /**
   * TEST SEAM (spec 062 SC 10) — NOT part of the public/extension API. Invoked ONCE with the
   * shelf's prefix each time that shelf's corpus index is actually (re)built via
   * {@link buildCorpusIndex} — i.e. on a cache MISS, never on a cache hit. It observes; it never
   * changes behaviour (absent ⇒ no-op, exactly the now/generateId pass-through discipline). The
   * SC 10 build-counter test injects it to assert the default router does exactly one shelf
   * iteration and at most one build per recall (cache hit on repeat), and the SC 4 test uses the
   * per-prefix argument to prove a write to shelf A rebuilds ONLY A (shelf B's cache survives).
   * Deliberately omitted from the extension-entrypoint docs — it is a measurement hook, not a seam
   * plugins consume.
   */
  onIndexBuild?: (shelfPrefix: string) => void;
  /**
   * Refusal-evidence writer selection (spec 071). Only the HTTP server sets
   * `armed: true`; stdio, CLI, and ordinary store consumers stay inert so the
   * size bound and rename rotation retain a single writer.
   */
  refusalLog?: {
    armed: boolean;
    onError?: RefusalLogErrorSink;
  };
}

/**
 * A view of the store CONFINED to one shelf (spec 062 SC 3 / T3, ADR 0011). Its reads, proposals,
 * and writes resolve BENEATH the shelf's prefix — the memory/handoff/reference/inbox layout lands
 * under `<prefix>…`, `routeMemoryWrite`'s landing-status verdict applies unchanged within the
 * shelf, and every mutation still commits (via the shelf's pathspec-limited committer) into the
 * SINGLE git repo (sidecars — sqlite/settings/embedding cache — stay vault-singular). The DEFAULT shelf's
 * handle (prefix `""`) IS the legacy top-level path: the {@link LibrarianStore}'s own
 * memory/handoff/recall/reference/inbox surface delegates to it, so there is ONE code path with no
 * drift and byte-identical default-router behaviour.
 *
 * A handle bound to a `writable: false` shelf serves reads but REFUSES every write with a
 * {@link ShelfNotWritableError} (spec 062 SC 6). This is the surface T6 (grooming) and T7
 * (Teams-shape restore) consume — the same store surface, scoped down; it exposes no more than
 * what already exists on the store.
 */
export interface ShelfScopedStore extends MemoryStore {
  /** The shelf this handle is confined to (its id/prefix/writable/label). */
  readonly shelf: Shelf;
  /** Handoff read/write confined to `<prefix>handoffs/`. */
  handoffs: HandoffStore;
  /** Project identity/lifecycle records confined to `<prefix>projects/`. */
  projects: ProjectStore;
  /** Append-only project evidence confined to `<prefix>project-updates/`. */
  projectUpdates: ProjectUpdateStore;
  /** Pinned-section suggestions confined to `<prefix>project-suggestions/`. */
  projectSuggestions: ProjectSuggestionStore;
  /** Vault-file read/write confined to the shelf (path discipline + kinds are shelf-relative). */
  vaultFiles: VaultFileStore;
  /** Index-backed recall over THIS shelf's memories only (merged multi-shelf recall is T5). */
  recall(input?: Record<string, unknown>): Promise<Memory[]>;
  /** Reference lookup over `<prefix>references/` only. */
  searchReferences(query: string, limit?: number): Promise<ReferenceHit[]>;
  /** How many reference documents this shelf holds. */
  countReferences(): number;
  /** Submit raw text to THIS shelf's `<prefix>inbox/` (fire-and-forget, committed instantly). */
  submitToInbox(text: string, hints?: InboxSubmissionHints): InboxItemRef;
}

/** Raw project stores for one explicitly supplied shelf, used only by trusted system pipelines. */
export interface ProjectSystemStores {
  readonly shelf: Shelf;
  projects: ProjectStore;
  projectUpdates: ProjectUpdateStore;
  projectSuggestions: ProjectSuggestionStore;
}

/** A scoped move could not see the target memory or named destination shelf. */
export class MemoryNotFoundForPrincipalError extends Error {
  constructor() {
    super("memory or shelf was not found");
    this.name = "MemoryNotFoundForPrincipalError";
  }
}

/** A move named the exact shelf identity that already contains the memory. */
export class MemoryAlreadyOnShelfError extends Error {
  readonly shelf: Shelf;
  constructor(shelf: Shelf) {
    super(`memory is already on shelf "${shelf.id}"`);
    this.name = "MemoryAlreadyOnShelfError";
    this.shelf = shelf;
  }
}

/** A cross-shelf move would overwrite an existing destination file. */
export class MemoryMoveDestinationExistsError extends Error {
  readonly shelf: Shelf;
  constructor(shelf: Shelf) {
    super(`the destination path on shelf "${shelf.id}" is already occupied`);
    this.name = "MemoryMoveDestinationExistsError";
    this.shelf = shelf;
  }
}

/** A cross-shelf move would traverse a symbolic link below the configured vault root. */
export class MemoryMoveUnsafePathError extends Error {
  readonly shelf: Shelf;
  constructor(shelf: Shelf) {
    super(`the path to shelf "${shelf.id}" is unsafe for a move`);
    this.name = "MemoryMoveUnsafePathError";
    this.shelf = shelf;
  }
}

export interface LibrarianStore
  extends MemoryStore, CurationStore, IntakeStore, SettingsStore, PrimerStore {
  handoffs: HandoffStore;
  /** Default-shelf project identity/lifecycle records. */
  projects: ProjectStore;
  /** Default-shelf append-only project evidence. */
  projectUpdates: ProjectUpdateStore;
  /** Default-shelf pinned-section suggestions. */
  projectSuggestions: ProjectSuggestionStore;
  /**
   * The dashboard's Obsidian-lite vault explorer/editor surface (rethink
   * T18/T19): tree + raw read + backlinks, and validated, compare-and-swap
   * writes that commit per write and invalidate the recall index like every
   * other vault mutation.
   */
  vaultFiles: VaultFileStore;
  /**
   * The vault-set router this store was constructed with (spec 062 SC 2) — the
   * plugin-supplied {@link VaultRouter} or {@link defaultVaultRouter}. Exposed so the 060
   * factory's delivery test can prove the SAME reference threaded through the store options
   * also reaches the server handle's `internals`. At spec 062 T1 it is stored inert: NO store
   * path consults it, so behaviour is unchanged (the shelf-scoped paths are later 062 tasks).
   */
  vaultRouter: VaultRouter;
  /**
   * A store handle CONFINED to `shelf` (spec 062 SC 3 / T3). The DEFAULT shelf (prefix `""`)
   * returns the top-level handle itself — the legacy path, byte-identical. A non-default shelf
   * gets a scoped handle whose paths resolve beneath `<prefix>` and whose writes are refused when
   * `shelf.writable` is false. This is how the system pipelines (grooming/intake, T6) and the
   * Teams-shape restore (T7) get shelf scope — NOT via {@link VaultRouter.writeTarget}, which
   * governs principal-attributed writes only (spec 062 §4).
   */
  forShelf(shelf: Shelf, principal?: Principal): ShelfScopedStore;
  /**
   * Resolve where a principal's new, self-attributed material lands (spec 062 SC 6). Materialises
   * `router.shelves(principal, "write")` (validated here — the runtime validation point T1's design
   * named for supplied routers), asks the router for `writeTarget(principal)`, and enforces the
   * honest write-routing semantics: the target must be `writable` (else {@link ShelfNotWritableError})
   * AND a member of the write-op set (else {@link ShelfNotInWriteSetError}). With the default router
   * this is the single writable main shelf, byte-identical. Callers pair it with {@link forShelf}.
   */
  resolveWriteTarget(principal: Principal): Shelf;
  /** Tier-0 reference lookup over the vault's references/ (backend-independent). */
  searchReferences(query: string, limit?: number): Promise<ReferenceHit[]>;
  /**
   * How many reference documents the vault holds — the denominator the
   * dashboard's reference tester uses to tell "no references filed" apart from
   * "references exist but none matched". Counts exactly what searchReferences
   * indexes (the markdown under references/).
   */
  countReferences(): number;
  /**
   * Memory recall — index-backed (hybrid keyword+vector, backlink-aware). A
   * filter-only (no-query) call falls back to the keyword searchMemories.
   */
  recall(input?: Record<string, unknown>): Promise<Memory[]>;
  /**
   * Principal-aware MERGED recall (spec 062 SC 5, T5) — the surface the MCP `recall` tool calls.
   * Consults every shelf in `router.shelves(principal, "recall")` IN ROUTER ORDER (validated at
   * first use via {@link validateShelfSet}, as {@link resolveWriteTarget} does for writes), recalls
   * each through its memoized handle, and MERGES by the DECIDED rule: per-shelf rank interleave,
   * strict alternation, router-order priority on equal rank, dedupe by memory id (first — highest
   * precedence — occurrence wins), `limit` applied AFTER the merge. Each hit is tagged with its
   * shelf's id (+ label) — but ONLY when the materialised recall set has length > 1 (the label
   * trigger, spec 062 §6). With the DEFAULT router (one shelf) this reduces to EXACTLY {@link recall}:
   * the same main-handle path, one shelf iteration, at most one index build (spec 062 SC 10 / T4's
   * build-counter pin), and the returned {@link RecalledMemory}[] carries NO shelf fields — a
   * byte-identical wire result + MCP text. Scores are NOT compared across shelves (they are RRF rank
   * reciprocals from independent indexes), which is why the merge interleaves rather than sorts
   * (spec 062 §4 / SC 5). Read-only: no writes, only the per-shelf index work T4 already owns.
   */
  recallForPrincipal(
    principal: Principal,
    input?: Record<string, unknown>,
  ): Promise<RecalledMemory[]>;
  /**
   * Principal-aware MERGED reference search (spec 062 SC 8c, T6) — the surface the MCP
   * `search_references` tool calls. Consults every shelf in `router.shelves(principal, "search")`
   * IN ROUTER ORDER (validated at first use via {@link validateShelfSet}, exactly as
   * {@link recallForPrincipal} does), searches each through its memoized handle's per-call
   * references index, and MERGES with the SAME rule as recall (per-shelf rank interleave, strict
   * alternation, router-order priority on equal rank, dedupe by the reference path/id — first
   * occurrence wins, `limit` after the merge). Each hit is tagged with its shelf's id (+ label) —
   * but ONLY when the materialised search set has length > 1. With the DEFAULT router (one shelf)
   * this reduces to EXACTLY {@link searchReferences}: one shelf iteration, and the returned
   * {@link RecalledReference}[] carries NO shelf fields — a byte-identical wire result.
   */
  searchReferencesForPrincipal(
    principal: Principal,
    query: string,
    limit?: number,
  ): Promise<RecalledReference[]>;
  /**
   * Principal-aware MERGED memory list (spec 065 SC 7, T4) — the surface the dashboard's
   * `memories.list` calls once member-scoped. Consults every shelf in
   * `router.shelves(principal, "recall")` IN ROUTER ORDER (the memory-visibility op, matching
   * {@link recallForPrincipal}; validated at first use via {@link validateShelfSet}), enumerates
   * each shelf's filtered rows UNCAPPED (the public `listMemories` clamps at 200 and slices
   * INTERNALLY, so it cannot feed a merged pager — spec 065 §1/§4), and MERGES by the requested
   * sort key (`created_at | updated_at | title`, default `updated_at` desc — all cross-shelf
   * comparable, unlike recall's RRF rank reciprocals) with the DETERMINISTIC tie-break: router
   * shelf order, then memory id. Duplicate logical memory ids are removed BEFORE sorting and
   * paging, with the first (highest-precedence) shelf winning — the same identity rule as merged
   * recall. `offset`/`limit` apply AFTER the merge; `total` is the unique filtered row count; the
   * `{memories, total, limit, offset}` envelope is preserved. Shelf attribution
   * mirrors 062's decided rule: each merged row carries `shelfId` (+ `shelfLabel`) ONLY when the
   * materialised shelf set has length > 1 — with the DEFAULT router this DELEGATES to the main
   * handle's `listMemories`, byte-identical (the {@link recallForPrincipal} reduction precedent).
   * A principal with ZERO shelves gets the empty envelope `{memories: [], total: 0, limit,
   * offset}` — never a throw (062's empty-set rule).
   */
  listMemoriesForPrincipal(
    principal: Principal,
    filters?: Record<string, unknown>,
  ): { memories: RecalledMemory[]; total: number; limit: number; offset: number };
  /**
   * The principal's validated, materialised `"recall"` shelf set in router order (spec 066 SC 3).
   * This is the shelf-enumeration source for member-aware browse surfaces. Zero shelves returns
   * `[]`; validation happens at the same first-use boundary as every other principal surface.
   */
  shelvesForPrincipal(principal: Principal): readonly Shelf[];
  /**
   * Principal-scoped single-memory read (spec 065 SC 7, T4): resolves `id` through the SAME
   * `"recall"` shelf set as {@link listMemoriesForPrincipal} and returns `null` for an OFF-SHELF
   * id — indistinguishable from an absent one (no existence oracle). NO tRPC procedure calls it
   * yet (nothing in the dashboard reads a single memory by id); it is the scoped primitive future
   * member surfaces build on. Zero shelves → `null`.
   */
  getMemoryForPrincipal(principal: Principal, id: string): Memory | null;
  /**
   * Approve or reject one proposal visible through an ADMIN principal's validated `"recall"`
   * shelf set. This is the narrow moderation capability: it may update the proposal document
   * even when that shelf is read-only to ordinary principal-attributed writes, but it cannot
   * address an off-shelf proposal and cannot be used by a non-admin principal.
   */
  approveProposalForPrincipal(
    principal: Principal,
    id: string,
    action?: "approve" | "reject",
    patch?: Record<string, unknown>,
    agentId?: string,
  ): Memory | null;
  /**
   * Archive one ADMIN-visible proposal with a resolution marker. It has the same scoped lookup
   * and narrow read-only-shelf moderation authority as {@link approveProposalForPrincipal}.
   */
  resolveProposalForPrincipal(
    principal: Principal,
    id: string,
    resolution: string,
    agentId?: string,
  ): Memory | null;
  /**
   * Move one principal-visible memory between two writable shelves without changing its filename,
   * id, frontmatter, or bytes (spec 067 SC 2). Both target/source resolution and destination
   * visibility are confined to the principal's `"recall"` set. The destination id resolves to its
   * unique writable bearer; both shelf indexes are invalidated after the path-scoped rename commit.
   */
  moveMemoryForPrincipal(principal: Principal, id: string, destinationShelfId: string): Memory;
  /**
   * Principal-scoped distinct field values (spec 065 SC 7, T4): the UNION of `distinctValues`
   * over the `"recall"` shelf set, in the store's own ordering (case-insensitive, locale-stable).
   * Single (default-router) shelf → delegates, byte-identical; zero shelves → the empty union.
   */
  distinctValuesForPrincipal(
    principal: Principal,
    input: { field: string; include_archived?: boolean },
  ): string[];
  /**
   * Principal-scoped reference-count denominator (spec 065 T4): Σ `countReferences()` over the
   * `"search"` shelf set — the honest `searched` denominator for a member's reference search
   * (the vault-global {@link countReferences} would leak the total corpus size to a scoped
   * principal). Single (default-router) shelf → the main count, byte-identical; zero shelves → 0.
   */
  countReferencesForPrincipal(principal: Principal): number;
  /**
   * A grooming-scoped store view CONFINED to `shelf` (spec 062 SC 7, T6) — the surface a per-shelf
   * grooming pass runs against. Its memory reads (evidence), proposals, and writes resolve beneath
   * the shelf's prefix; the curation run/operation bookkeeping stays vault-singular (the ONE
   * `curation-runs.json` sidecar). The DEFAULT shelf (prefix "") returns the top-level grooming
   * surface itself, byte-identical to today's single run. This is how grooming gets shelf scope —
   * NOT via {@link VaultRouter.writeTarget}, which governs principal-attributed writes only (spec
   * 062 §4). Internal (grooming-tick consumes it); not on the extension entrypoint.
   */
  groomingStoreForShelf(shelf: Shelf): GroomingStore;
  /**
   * Trusted system-pipeline project stores confined to exactly `shelf`. Unlike the public
   * {@link forShelf} handle, this accessor is intentionally not gated by `shelf.writable` because
   * system curation authority is shelf-scoped rather than principal-attributed.
   */
  systemProjectStoresForShelf(shelf: Shelf): ProjectSystemStores;
  /**
   * SYSTEM-PIPELINE inbox submit for `shelf` (spec 062 §4 / review A1 + F) — the inbox analogue of
   * {@link groomingStoreForShelf}'s raw memory surface, and the ONLY seam through which a system
   * pipeline may land material in a shelf's `<prefix>inbox/`.
   *
   * It is SHELF-SCOPED but NOT writability-gated, exactly as spec §4 requires: `writable` gates
   * PRINCIPAL-attributed writes (the material a principal claims as their own — `remember`,
   * `/ingest`, handoffs), while the system pipelines are scoped to the shelf they are PROCESSING.
   * The transcript intake's captured facts are `system-consolidator`-bound material, not new
   * principal-attributed material, so a `writable: false` shelf must still accept them — the same
   * rule A1 applied to grooming (which composes `core.rawMemory`, not the gated view). Routing them
   * through the gated {@link forShelf} view instead made every fact throw {@link ShelfNotWritableError}
   * on a read-only shelf, which the transcript sweep's per-fact fail-soft swallowed — the buffer was
   * then consumed and deleted: PERMANENT capture loss.
   *
   * Deliberately NARROW: it takes the shelf per call and does exactly one thing. It does NOT widen the
   * principal-facing surface — {@link forShelf}'s `submitToInbox` stays gated and is what `remember`
   * and the other principal-attributed paths use.
   */
  systemSubmitToInbox(shelf: Shelf, text: string, hints?: InboxSubmissionHints): InboxItemRef;
  /**
   * Submit raw text to the intake inbox (the inbox lives in the vault).
   * Fire-and-forget: stored + committed instantly; the intake files it
   * asynchronously, carrying `hints` (the submitter's agent_id/tags/applies_to)
   * onto the resulting memory.
   */
  submitToInbox(text: string, hints?: InboxSubmissionHints): InboxItemRef;
  /**
   * Run the intake over the inbox once — reap stale claims, then FIFO
   * through navigate→judge→apply (markdown backend only). The LLM client is
   * injected by the caller (built from admin config). Returns a sweep summary.
   */
  runIntakeSweep(deps: IntakeInboxOptions): Promise<SweepSummary>;
  /**
   * Append one typed denial to the bounded refusal sidecar. Always resolves:
   * evidence failures must never change the refusal being observed.
   */
  recordRefusal(input: RecordRefusalInput): Promise<void>;
  /** Drain accepted refusal writes and persist any pending counted-drop row. */
  flushRefusals(): Promise<void>;
  /** Read the bounded refusal sidecar newest-first. Corrupt or absent files are empty. */
  readRefusals(options?: ReadRefusalsOptions): Promise<ReadRefusalsResult>;
  dataDir: string;
  close(): void;
  /** Backend-neutral maintenance verb: rebuild the disposable memory index. */
  reindex(): void;
  /**
   * Back up the git vault by pushing it to a remote (the vault IS the backed-up
   * artifact). Commits any pending changes, then pushes HEAD to the remote branch
   * via the GIT_ASKPASS path (the token never leaks). Returns the pushed commit
   * hash, or null if the vault has no commits yet.
   */
  pushVaultBackup(auth: GitPushAuth): string | null;
  /**
   * The vault-wide activity feed (rethink T21, spec §8 / D16): recent vault
   * commits newest-first, each with the files it touched and a provenance
   * `source` derived from the commit-subject conventions (see
   * classifyVaultCommit). `before` pages strictly-older commits. This surface
   * IS the audit trail — it replaces the retired event ledger.
   */
  vaultActivity(input?: { limit?: number; before?: string }): VaultActivityEntry[];
  /**
   * The per-file diffs introduced by a single vault commit (rethink T21
   * activity-feed accordion). Throws `GitHashError` on a malformed hash;
   * returns an empty `files` array for a commit unknown to the repo (the
   * caller surfaces this as a not-found teaching error at the tRPC boundary).
   */
  vaultCommitDiff(hash: string): CommitDiff;
  /**
   * The guarded whole-vault restore (rethink T21, spec §8 / D16): refuse
   * while a curation run is in flight or another restore holds the lock →
   * pause the curator (both ticks check it) → `pre-restore-<timestamp>` tag
   * on HEAD → revert the working tree to `hash`'s tree state as ONE new
   * commit → invalidate the index → resume the curator (try/finally — a
   * mid-sequence failure still resumes, and the error reports how far it
   * got). The typed-confirmation gate lives at the tRPC boundary.
   */
  restoreVaultTo(hash: string, options?: VaultRestoreOptions): Promise<VaultRestoreResult>;
  /**
   * The typed, shelf-safe, paginated AUDIT export (spec 064 T6–T8 / SC 8–12): who SUCCESSFULLY
   * changed what, when, on which shelf — derived from the vault's git history, never a separate
   * ledger. Scoped to `shelves(principal, "recall")`; a commit touching none of them is dropped.
   * ALL gating is done HERE from `principal.roles`: an admin sees the `paths`/`renames`/`diff`
   * fields (a filename encodes a memory title) and — with `includeDiff` — per-file capped diffs; a
   * non-admin member gets only `actor`+`action`+`subjectId`+`shelves`+`at`. Commit-addressed
   * pagination (`before` = a commit hash, 100-commit page): `nextCursor` is the OLDEST COMMIT
   * SCANNED, so a page filtered to zero events still advances. Throws {@link AuditCursorError} for a
   * stale cursor (a client error) and {@link AuditSourceError} for a broken `.git` (never a 500 for
   * a bad request; never a bad-request for a source failure).
   */
  exportAudit(principal: Principal, options?: AuditExportOptions): AuditExportPage;
  /**
   * Read a curator job's prompt addendum from its committed vault file
   * (`.curator/<job>-addendum.md`, spec 044 D-1). Fail-soft: a missing file
   * returns `{ content: "", version: null }` (never throws). `version` is the
   * git commit hash that last touched the file (the rollback anchor); null until
   * the file has history.
   */
  readAddendum(job: CuratorConsumer): AddendumRecord;
  /**
   * Write a curator job's prompt addendum to its committed vault file AND commit
   * it (spec 044 D-1), so it is versioned + appears in `git log`. Returns the
   * post-write record (content + the new version hash).
   */
  writeAddendum(job: CuratorConsumer, content: string, actorId?: string): AddendumRecord;
  /**
   * Roll a curator job's addendum back to its PRIOR committed version (rethink D4:
   * git is the rollback): restore the file to the commit before its current one in
   * the file's own git history, then COMMIT the restoration so the roll-back is
   * itself a revertable commit. Edge cases:
   *   - only one committed version → restore to empty (the pre-existence state),
   *     committed (`restored: true`);
   *   - no committed version at all → safe no-op (`restored: false`, version null).
   * Surgical: touches ONLY this job's addendum file, never other vault state.
   */
  rollbackAddendum(job: CuratorConsumer, actorId?: string): RollbackAddendumResult;
  /**
   * Read the intake examples document (`.curator/intake-examples.md`,
   * proposal-review rework F4 / D3) — the curator-distilled rejected-submission
   * examples that ride the intake prompt. Same fail-soft record shape as the
   * addendum: missing file → `{ content: "", version: null }`.
   */
  readIntakeExamples(): AddendumRecord;
  /**
   * Write the intake examples document AND commit it. The byte-cap policy
   * (`curator.intake.examples_max_bytes`) lives in curator-examples.ts's
   * setIntakeExamples — this is the raw committed-file primitive.
   */
  writeIntakeExamples(content: string, actorId?: string): AddendumRecord;
  /**
   * Roll the examples document back to its prior committed version, committed
   * as a new revertable commit — the same surgical semantics as
   * rollbackAddendum, over the examples file only.
   */
  rollbackIntakeExamples(actorId?: string): RollbackAddendumResult;
}

/** One activity-feed entry: a vault commit + its subject-derived provenance. */
export interface VaultActivityEntry extends VaultCommit {
  source: VaultCommitSource;
}

/** A curator job's addendum content + its git version (spec 044 D-1). */
export interface AddendumRecord {
  /** The addendum text (empty string when the file is absent — fail-soft). */
  content: string;
  /** The commit hash that last touched the file, or null when it has no history. */
  version: string | null;
}

/** The outcome of a `rollbackAddendum`. */
export interface RollbackAddendumResult {
  /** True when a restoration commit was made (prior version OR empty); false on a no-op. */
  restored: boolean;
  /** The new HEAD commit hash for the file after the roll-back, or null on a no-op. */
  version: string | null;
}

/**
 * Vault-relative path of a job's committed addendum file (spec 044 D-1):
 * `.curator/intake-addendum.md` / `.curator/grooming-addendum.md`.
 */
export function addendumPath(job: CuratorConsumer): string {
  return `.curator/${job}-addendum.md`;
}

/**
 * Vault-relative path of the intake examples document (proposal-review rework
 * F4 / D3) — the addendum's sibling: `.curator/intake-examples.md`.
 */
export const INTAKE_EXAMPLES_PATH = ".curator/intake-examples.md";

/** Options for `LibrarianStore.runIntakeSweep`. */
export interface IntakeInboxOptions {
  llmClient: LlmClient;
  /** The single curator.apply.confidence_threshold knob (D13); default 0.8. */
  confidenceThreshold?: number;
  /** Stale-claim TTL for the reaper (defaults to the sweep's 60 min). */
  lockTtlMs?: number;
  /** Per-item error sink — called for each item whose processing threw (LLM/transport). */
  onError?: (error: unknown) => void;
  /** What opened this sweep (boot | tick | watcher | manual); recorded on the decision-log run. */
  trigger?: string;
  /**
   * Operator steering for the judge prompt (spec 044 D-2), read ONCE per sweep by
   * the caller (`readJobAddendum(store,"intake").content`) and threaded into every
   * item's judge call. Empty/absent → today's behaviour (no OPERATOR GUIDANCE).
   */
  promptAddendum?: string;
  /**
   * The intake examples document (proposal-review rework F4 / D3), read ONCE
   * per sweep by the caller (`readIntakeExamples(store).content`) and threaded
   * into every item's judge call. Empty/absent → no examples block.
   */
  intakeExamples?: string;
}

/** Actor id that owns intake writes (common-slice, system-owned). */
const INTAKE_ACTOR_ID = "system-consolidator";

/**
 * Default result bound for a merged multi-shelf recall (spec 062 T5) when the caller supplies no
 * `limit` — matches the per-shelf `recallMemories` default so the merged limit is the same size an
 * agent already expects from single-shelf recall.
 */
const DEFAULT_MERGED_RECALL_LIMIT = 8;

/**
 * Default result bound for a merged multi-shelf REFERENCE search (spec 062 T6) when the caller
 * supplies no `limit` — mirrors `searchReferences`' own `DEFAULT_REFERENCE_LIMIT` (corpus-index.ts)
 * so the merged limit matches the size an agent already expects from single-shelf reference search.
 */
const DEFAULT_MERGED_REFERENCE_LIMIT = 12;

export function createLibrarianStore(options: LibrarianStoreOptions = {}): LibrarianStore {
  const dataDir = resolveDataDir(options.dataDir);
  // The vault-set router (spec 062 T1). Stored + exposed below, but read for NO decision
  // yet — every path still hard-codes the vault root, so behaviour is byte-identical. The
  // default is the inert single-shelf OSS router.
  const vaultRouter = options.vaultRouter ?? defaultVaultRouter;

  fs.mkdirSync(dataDir, { recursive: true });

  // Memory + handoff live in the git vault; settings/secrets in sidecar JSON
  // files outside it.
  const vault = createVault({ dataDir });
  // scratchDir = the data dir: the GIT_ASKPASS helper push() writes must be on an
  // exec-capable filesystem, and a read_only container's /tmp is noexec (would
  // break backup). The data dir is a writable, exec-capable volume outside the
  // vault working tree (`<dataDir>/vault`). See runGitWithToken.
  const git = createSyncGitOps({ cwd: vault.root, scratchDir: dataDir });
  git.init();
  // The two commit primitives (spec 064 SC 1/SC 3). Attributed writes use the
  // pathspec-limited, trailered `commitPaths` (below, per shelf + at the top level); the
  // whole-tree system sweeps that have no path set use `commitAll` — untrailered by default
  // so they export `actor: null` HONESTLY (they capture OTHER people's out-of-band bytes),
  // and passed an actor only where the sweep genuinely owns the bytes (restore, consolidate).
  const commitAll = (message: string, actorId?: string): string | null =>
    git.commitAll(message, actorId);
  // Index embedder for recall + references — hash under tests, the real model
  // (EmbeddingGemma) in production (see resolveEmbedder). Wrapped in a content
  // cache that OUTLIVES index rebuilds: the index is invalidated on every
  // memory write and rebuilt from scratch, re-embedding all active docs, so
  // without this a bulk groom (e.g. seeding N memories) re-embeds the growing
  // corpus O(N^2) times. The cache makes each distinct doc embed once.
  const embedder = createCachingEmbedder(resolveEmbedder({ dataDir }));
  // Persistent embedding cache (rethink T23): chunk/doc vectors keyed by
  // (file path, content hash, model id), in a sidecar OUTSIDE the vault — it
  // is derived state and must never be git-committed/pushed with the vault.
  // This is what makes a process restart cheap: the in-memory caching embedder
  // above dies with the process; this survives it, so a second boot re-embeds
  // nothing that hasn't changed (references AND memories). Skipped (null) only
  // if an embedder has no model identity — caching without it could serve
  // another model's vectors.
  const embeddingCache = embedder.modelId
    ? createEmbeddingCache({
        dir: path.join(dataDir, "embeddings-cache"),
        modelId: embedder.modelId,
      })
    : null;
  // Determinism plumbing (spec 062 SC 1): the optional clock/id injections thread through to
  // the two markdown stores that stamp timestamps + mint ids INTO vault files (memories/ and
  // handoffs/). Passed only when supplied so the defaults (`nowIso` / `makeId`) stand under
  // exactOptionalPropertyTypes — with the options absent this is byte-for-byte the old
  // construction. (References carry no store-minted clock/id — they are inert content files —
  // so there is no reference store to thread; the inbox mints its own numeric clock/id via
  // InboxDeps, a different type, and is out of this API's scope, spec 062 §4.)
  const deterministicDeps = {
    ...(options.now ? { now: options.now } : {}),
    ...(options.generateId ? { generateId: options.generateId } : {}),
  };
  const jsonSettings = createJsonSettingsStore({
    filePath: path.join(dataDir, "settings.json"),
    secretKey: options.secretKey ?? null,
  });
  // Intake decision log (spec 043 C1) — the intake's full-outcome sidecar,
  // paralleling curation-runs.json. Purely observational + fail-soft, so it never
  // affects filing; the sweep wires it below. Lives at intake-runs.json; the
  // resolver falls back to a pre-rethink consolidation-runs.json until
  // `migrate-data-dir` renames it (rethink T26, spec §10).
  const markdownIntake = createJsonIntakeStore({
    filePath: resolveIntakeRunsPath(dataDir),
  });
  const refusalLog = createRefusalLog({
    filePath: path.join(dataDir, REFUSAL_LOG_FILE),
    armed: options.refusalLog?.armed === true,
    ...(options.refusalLog?.onError ? { onError: options.refusalLog.onError } : {}),
  });
  // The primer read cache (rethink T11): undefined = not yet read this
  // process; null = read and absent (pre-seed); string = the file's content.
  // Updated on writePrimer — every primer write flows through it.
  let cachedPrimer: string | null | undefined;
  // The vault's git history reader (rethink T20/T21) — ONE per repo, shared across every
  // shelf-scoped vault-file store (git is keyed on FULL vault-relative paths, never shelf-relative).
  const gitHistory = createGitHistory({ cwd: vault.root });

  // ── shelf-scoped store handles (spec 062 SC 3 / T3) ─────────────────────────────────────────
  // The load-bearing mechanism: a factory that builds the SAME memory/handoff/reference/inbox
  // surface CONFINED to one shelf, over a shelf-scoped vault view (`scopeVault`). The memory /
  // handoff / inbox / corpus-index / reference sub-stores are subdir-hardcoded (`memories/`,
  // `handoffs/`, `inbox/`, `references/`) and take a `Vault`, so a scoped vault lands their layout
  // beneath `<prefix>` with NO change to them; the vault-file store instead takes the TRUE vault +
  // a `prefix` (it speaks FULL paths to git). Every mutation still flows through the ONE `commit`
  // closure into the SINGLE repo; sidecars stay vault-singular. The DEFAULT shelf (prefix "") makes
  // `scopeVault` an identity, so the main handle IS the legacy path — one code path, no drift.
  interface ShelfCoreOptions {
    /** Extra per-file-write side effect (the main core drops the primer cache on a primer edit). */
    onFileWrite?: (relPath: string) => void;
  }
  /**
   * The EXPENSIVE, prefix-determined core of a shelf handle (spec 062 T4 + review A2): the scoped
   * vault, the raw (UN-gated) memory/handoff/file sub-stores, and the lazily-built + separately
   * invalidated recall index. EVERYTHING here is a function of the PREFIX alone — which files the
   * shelf covers, what its index caches — so it is memoized ONE-per-prefix. The write GATE is
   * deliberately NOT baked in (that was the A2 defect: whichever caller materialised a prefix first
   * fixed its gate process-wide); the per-call {@link gateShelfCore} view derives writability from
   * the SHELF passed to `forShelf`, so the same prefix serves a writable and a read-only view
   * honestly — a member's read-only recall of `team/` no longer neuters a later legitimately-writable
   * groom of it (or vice versa).
   */
  interface ShelfCore {
    readonly prefix: string;
    /** This shelf's scoped vault view (the intake sweep drains its inbox). */
    readonly scopedVault: Vault;
    /** The un-gated memory store (curation source + intake sweep + the gate view all wrap it). */
    readonly rawMemory: MemoryStore;
    /** The un-gated handoff store. */
    readonly rawHandoffs: HandoffStore;
    /** The un-gated Project store. */
    readonly rawProjects: ProjectStore;
    /** The un-gated append-only ProjectUpdate store. */
    readonly rawProjectUpdates: ProjectUpdateStore;
    /** The un-gated ProjectSuggestion store. */
    readonly rawProjectSuggestions: ProjectSuggestionStore;
    /** The un-gated vault-file store (speaks FULL vault-relative paths to git). */
    readonly rawFiles: VaultFileStore;
    /** The un-gated inbox submitter. */
    rawSubmitToInbox(text: string, hints?: InboxSubmissionHints): InboxItemRef;
    /** Index-backed recall over THIS shelf only (read-only — gate-independent). */
    recall(input?: Record<string, unknown>): Promise<Memory[]>;
    /** Reference lookup over `<prefix>references/` only (read-only). */
    searchReferences(query: string, limit?: number): Promise<ReferenceHit[]>;
    /** How many reference documents this shelf holds (read-only). */
    countReferences(): number;
    /** This shelf's lazily-built, cached recall index. */
    corpusIndex(): Promise<CorpusIndex>;
    /** Drop this shelf's cached recall index (fired on every memory/file write). */
    invalidateIndex(): void;
  }
  /** A per-call write-gate view over a {@link ShelfCore} (spec 062 review A2) — the public
   * shelf-scoped surface plus the raw handles the system pipelines consume. */
  interface ShelfHandle extends ShelfScopedStore {
    /** The (write-gated) memory store, as a single object — the top-level store re-spreads it. */
    readonly memory: MemoryStore;
    /** The un-gated memory store (curation source + intake sweep write through it directly). */
    readonly rawMemory: MemoryStore;
    /** This shelf's scoped vault view (the intake sweep drains its inbox). */
    readonly scopedVault: Vault;
    /** This shelf's lazily-built, cached recall index. */
    corpusIndex(): Promise<CorpusIndex>;
    /** Drop this shelf's cached recall index (fired on every memory/file write). */
    invalidateIndex(): void;
  }
  function buildShelfCore(prefix: string, opts: ShelfCoreOptions): ShelfCore {
    const scopedVault = scopeVault(vault, prefix);
    let cachedIndex: Promise<CorpusIndex> | null = null;
    const invalidateIndex = (): void => {
      cachedIndex = null;
    };
    // Attributed, pathspec-limited committers (spec 064 SC 1). The memory/handoff/inbox
    // stores speak SHELF-RELATIVE paths (they run over `scopedVault`), but git keys on FULL
    // vault-relative paths — so prepend the prefix (an identity for the default shelf, where
    // it is byte-for-byte the legacy path). The vault-file store already speaks FULL paths, so
    // it commits through `git.commitPaths` directly.
    const commitScoped = (paths: string[], message: string, actorId?: string): string | null =>
      git.commitPaths(
        paths.map((p) => prefix + p),
        message,
        actorId,
      );
    // Disposable recall index over THIS shelf's memories, built lazily + cached, invalidated on
    // every memory/file write (onWrite) — exactly today's single-index semantics, PER SHELF (each
    // core owns its own `cachedIndex`, so a write to one shelf leaves the others' caches intact,
    // spec 062 SC 4). The persistent embedding cache is SHARED across shelves (memory-cheap; its
    // records are content-hash-validated and keyed by the FULL vault-relative path via
    // `cacheKeyPrefix`, so shelves stay disjoint). Under the default shelf (prefix "") this is
    // byte-identical to before: one index, one cache, `cacheKeyPrefix` empty.
    const buildIndex = (): Promise<CorpusIndex> => {
      options.onIndexBuild?.(prefix); // spec 062 SC 10 test seam (non-API): counts real builds
      return buildCorpusIndex(scopedVault, {
        embedder,
        cache: embeddingCache,
        cacheKeyPrefix: prefix,
      }).catch((error: unknown) => {
        cachedIndex = null; // a failed/transient build must not poison recall
        throw error;
      });
    };
    const corpusIndex = (): Promise<CorpusIndex> => (cachedIndex ??= buildIndex());
    const rawMemory = createMarkdownMemoryStore({
      vault: scopedVault,
      commit: commitScoped,
      onWrite: invalidateIndex,
      ...deterministicDeps,
    });
    const rawHandoffs = createMarkdownHandoffStore({
      vault: scopedVault,
      commit: commitScoped,
      ...deterministicDeps,
    });
    const rawProjects = createMarkdownProjectStore({ vault: scopedVault, commit: commitScoped });
    const rawProjectUpdates = createMarkdownProjectUpdateStore({
      vault: scopedVault,
      commit: commitScoped,
    });
    const rawProjectSuggestions = createMarkdownProjectSuggestionStore({
      vault: scopedVault,
      commit: commitScoped,
    });
    // The vault-file store takes the TRUE vault (full paths to git) + the shelf prefix (T2's
    // shelf-relative path discipline / kinds). Its onWrite invalidates this shelf's index and
    // runs the core's extra side effect (the main core's primer-cache drop).
    const rawFiles = createVaultFileStore({
      vault,
      commit: git.commitPaths,
      history: gitHistory,
      prefix,
      onWrite: (relPath) => {
        invalidateIndex();
        opts.onFileWrite?.(relPath);
      },
    });
    // Index-backed recall over this shelf only — the same code the `recall` verb + the intake's
    // navigate step use. Read-only, so it lives on the core (gate-independent). Merged multi-shelf
    // recall is T5; this is one shelf.
    const recall = async (input: Record<string, unknown> = {}): Promise<Memory[]> => {
      const query = typeof input.query === "string" ? input.query : "";
      if (!query.trim()) return rawMemory.searchMemories(input); // filter-only stays on keyword
      return recallMemories(
        { index: await corpusIndex(), getMemory: (id) => rawMemory.getMemory(id) },
        query,
        {
          tags: Array.isArray(input.tags) ? (input.tags as string[]) : undefined,
          limit: typeof input.limit === "number" ? input.limit : undefined,
        },
      );
    };
    const searchReferences = (query: string, limit?: number): Promise<ReferenceHit[]> =>
      searchVaultReferences(scopedVault, embedder, query, {
        cache: embeddingCache,
        cacheKeyPrefix: prefix,
        ...(limit !== undefined ? { limit } : {}),
      });
    // "references" mirrors corpus-index's REFERENCES_DIR — a faithful "searched" denominator.
    const countReferences = (): number => scopedVault.listMarkdown("references").length;
    const rawSubmitToInbox = (text: string, hints?: InboxSubmissionHints): InboxItemRef => {
      const ref = writeInbox(scopedVault, text, hints ? { hints } : {});
      // Attributed + pathspec-limited to the one inbox file just written (spec 064 SC 1/SC 4);
      // `ref.relPath` is shelf-relative, so commitScoped prepends the prefix. The submitter
      // (`hints.agentId` — the resolved principal `remember` threads) rides the trailer. A
      // system pipeline that submits without an agentId commits untrailered (honest null).
      commitScoped([ref.relPath], commitSubject.inboxSubmit(ref.id), hints?.agentId); // durable + committed instantly
      return ref;
    };
    return {
      prefix,
      scopedVault,
      rawMemory,
      rawHandoffs,
      rawProjects,
      rawProjectUpdates,
      rawProjectSuggestions,
      rawFiles,
      rawSubmitToInbox,
      recall,
      searchReferences,
      countReferences,
      corpusIndex,
      invalidateIndex,
    };
  }

  /**
   * Derive the PER-CALL write-gated view of a memoized {@link ShelfCore} (spec 062 review A2). The
   * gate + the shelf identity/label come from the `shelf` argument of THIS call — never baked into
   * the core — so a writable and a read-only use of the SAME prefix each get an honest view. A
   * writable shelf gets the raw sub-stores directly (zero wrapper overhead ⇒ the DEFAULT shelf is
   * byte-identical); a read-only shelf serves reads but REFUSES every write with a
   * {@link ShelfNotWritableError} (spec 062 SC 6). Read paths (recall/search/count) are
   * gate-independent and delegate straight to the core.
   */
  function gateShelfCore(core: ShelfCore, shelf: Shelf, principal?: Principal): ShelfHandle {
    const refuseWrite = (): never => {
      void refusalLog.record({
        kind: "shelf-not-writable",
        surface: "store",
        outcome: "refused",
        shelfId: shelf.id,
        ...(shelf.label === undefined ? {} : { shelfLabel: shelf.label }),
        ...principalRefusalEvidence(principal),
      });
      throw new ShelfNotWritableError(shelf);
    };
    const memory: MemoryStore = shelf.writable
      ? core.rawMemory
      : {
          ...core.rawMemory,
          createMemory: () => refuseWrite(),
          updateMemory: () => refuseWrite(),
          archiveMemory: () => refuseWrite(),
          unarchiveMemory: () => refuseWrite(),
          purgeMemory: () => refuseWrite(),
          flagMemory: () => refuseWrite(),
          resolveFlags: () => refuseWrite(),
          approveProposal: () => refuseWrite(),
          resolveProposal: () => refuseWrite(),
          bulkUpdateMemory: () => refuseWrite(),
        };
    const handoffs: HandoffStore = shelf.writable
      ? core.rawHandoffs
      : {
          ...core.rawHandoffs,
          store: () => refuseWrite(),
          claim: () => refuseWrite(),
          purge: () => refuseWrite(),
        };
    const projects: ProjectStore = shelf.writable
      ? core.rawProjects
      : {
          ...core.rawProjects,
          create: () => refuseWrite(),
          update: () => refuseWrite(),
        };
    const projectUpdates: ProjectUpdateStore = shelf.writable
      ? core.rawProjectUpdates
      : {
          ...core.rawProjectUpdates,
          append: () => refuseWrite(),
        };
    const projectSuggestions: ProjectSuggestionStore = shelf.writable
      ? core.rawProjectSuggestions
      : {
          ...core.rawProjectSuggestions,
          create: () => refuseWrite(),
          update: () => refuseWrite(),
        };
    const vaultFiles: VaultFileStore = shelf.writable
      ? core.rawFiles
      : {
          ...core.rawFiles,
          writeFile: () => refuseWrite(),
          createFile: () => refuseWrite(),
          renameFile: () => refuseWrite(),
          deleteFile: () => refuseWrite(),
          restoreFileVersion: () => refuseWrite(),
        };
    const submitToInbox = shelf.writable ? core.rawSubmitToInbox : (): never => refuseWrite();
    return {
      ...memory,
      shelf,
      handoffs,
      projects,
      projectUpdates,
      projectSuggestions,
      vaultFiles,
      recall: core.recall,
      searchReferences: core.searchReferences,
      countReferences: core.countReferences,
      submitToInbox,
      memory,
      rawMemory: core.rawMemory,
      scopedVault: core.scopedVault,
      corpusIndex: core.corpusIndex,
      invalidateIndex: core.invalidateIndex,
    };
  }

  // The DEFAULT-shelf CORE = the legacy top-level path (prefix "" → identity vault). A primer edit
  // drops the primer read cache; the shared persistent embedding cache is wired inside buildShelfCore
  // (all shelves share it, keyed by full vault-relative path — spec 062 T4).
  const mainCore = buildShelfCore("", {
    onFileWrite: (relPath) => {
      if (relPath === PRIMER_PATH) cachedPrimer = undefined;
    },
  });
  // The writable default view over the main core — what the top-level store delegates to (writable ⇒
  // zero wrapper overhead ⇒ byte-identical to the legacy top-level surface).
  const mainHandle = gateShelfCore(mainCore, DEFAULT_SHELF);

  // Per-shelf CORES, MEMOIZED by prefix (spec 062 T4). Prefix is the stable, content-determining key:
  // it fixes WHICH files the shelf's index covers, validateShelfSet keeps prefixes disjoint, and it is
  // what the persistent cache keys on — so a prefix owns exactly ONE core (one lazily-built,
  // separately invalidated index). The WRITE GATE is derived per call from the shelf (review A2),
  // never memoized: two Shelf objects sharing a prefix but differing in `writable`/`label`/`id` get
  // honest, distinct views over the SAME core. Seeded with the default-shelf core so
  // forShelf({ prefix: "" }) reuses the one main core (byte-identical top-level path).
  //
  // Review note (accepted): this map grows one entry per DISTINCT prefix ever materialised and is
  // never evicted — bounded in every real shape (default router = 1; a Teams overlay = a handful of
  // member/team prefixes), so the unbounded-in-principle map is left as-is (offboarding-time eviction
  // is a Teams-layer concern, out of scope here).
  const cores = new Map<string, ShelfCore>([["", mainCore]]);

  /** The memoized (prefix-keyed) core for a shelf (spec 062 SC 3 / T4). Built once per prefix; its
   * prefix is validated before scopeVault trusts it. Its cached index + scoped invalidation persist
   * across calls. The system pipelines (grooming/intake sweep, T6) consume this directly to reach
   * `rawMemory`/`scopedVault`, which the narrowed public {@link ShelfScopedStore} does not expose. */
  const coreForShelf = (shelf: Shelf): ShelfCore => {
    const existing = cores.get(shelf.prefix);
    if (existing) return existing;
    validateShelfSet([shelf]); // catch a malformed prefix before scopeVault trusts it
    const core = buildShelfCore(shelf.prefix, {});
    cores.set(shelf.prefix, core);
    return core;
  };

  /** The internal (full) per-call shelf handle: the memoized core wrapped in THIS call's write gate
   * (spec 062 SC 3 / T4 / review A2). Cheap — a few object spreads over the memoized core. */
  const handleForShelf = (shelf: Shelf, principal?: Principal): ShelfHandle =>
    gateShelfCore(coreForShelf(shelf), shelf, principal);

  /** The public, narrowed store handle confined to `shelf` (spec 062 SC 3 / T4). */
  const forShelf = (shelf: Shelf, principal?: Principal): ShelfScopedStore =>
    handleForShelf(shelf, principal);

  /** Resolve + validate where a principal's new material lands (spec 062 SC 6). */
  const resolveWriteTarget = (principal: Principal): Shelf => {
    // The runtime validation point T1's design named: validate whatever a SUPPLIED router
    // materialises, at first use. The default router's static set already passed at boot.
    const writeShelves = vaultRouter.shelves(principal, "write");
    validateShelfSet(writeShelves);
    const target = vaultRouter.writeTarget(principal);
    if (!target.writable) {
      void refusalLog.record({
        kind: "shelf-not-writable",
        surface: "store",
        outcome: "refused",
        ...principalRefusalEvidence(principal),
        shelfId: target.id,
        ...(target.label === undefined ? {} : { shelfLabel: target.label }),
      });
      throw new ShelfNotWritableError(target);
    }
    // Honest write-routing semantics (reported decision): writeTarget MUST be one of the
    // principal's write-op shelves — else the "where writes land" and "what may be written" axes
    // disagree. Matched by id AND prefix (a writable shelf's id is unique per the T1 rules).
    // Matched by id AND prefix AND writable (review A3): a set member that shares the target's
    // id/prefix but disagrees on `writable` is a mis-specified router — "where writes land" and
    // "what may be written" then disagree, and the per-call gate would silently honour the target's
    // own `writable` rather than the set's. Since `target.writable` is already asserted true above,
    // this requires a WRITABLE set member with the same id/prefix.
    if (
      !writeShelves.some(
        (s) => s.id === target.id && s.prefix === target.prefix && s.writable === target.writable,
      )
    ) {
      void refusalLog.record({
        kind: "shelf-outside-write-set",
        surface: "store",
        outcome: "refused",
        ...principalRefusalEvidence(principal),
        shelfId: target.id,
        ...(target.label === undefined ? {} : { shelfLabel: target.label }),
      });
      throw new ShelfNotInWriteSetError(target, writeShelves);
    }
    return target;
  };

  /**
   * Principal-aware MERGED recall (spec 062 SC 5 / T5). Resolves the principal's recall shelves in
   * router order, validates the materialised set (the same first-use validation point writes use),
   * recalls each through its memoized handle, and merges by the decided rank-interleave + dedupe
   * rule. Read-only: it drives ONLY the per-shelf recall handles (whose index build/caching T4
   * owns) — no writes, no new I/O on the single-shelf path.
   */
  const recallForPrincipal = async (
    principal: Principal,
    input: Record<string, unknown> = {},
  ): Promise<RecalledMemory[]> => {
    const shelves = vaultRouter.shelves(principal, "recall");
    validateShelfSet(shelves); // validate whatever a SUPPLIED router materialises, at first use
    const firstShelf = shelves[0];
    if (firstShelf === undefined) return []; // a router mapping the principal to no recall shelves
    // SINGLE shelf — the DEFAULT router, and any principal a supplied router maps to one shelf.
    // EXACTLY today's path: recall through that ONE shelf's memoized core, no provenance tagging,
    // no merge. The default router's shelf is DEFAULT_SHELF, whose core IS mainCore — so this
    // is byte-identical to the legacy `recall`, ONE shelf iteration, at most ONE index build (spec
    // 062 SC 10 / T4). The returned Memory[] carries NO shelf fields, so the MCP text is unchanged
    // (the label trigger is set-length > 1, spec 062 §6). Memory[] IS a RecalledMemory[] (the shelf
    // fields are optional-absent).
    if (shelves.length === 1) return coreForShelf(firstShelf).recall(input);
    // MULTI-shelf: consult EACH shelf's index via its memoized core, IN ROUTER ORDER, then merge.
    // The caller's `input` (incl. its own `limit`) passes to each shelf unchanged; the merged
    // `limit` is applied AFTER the merge by mergeShelfRecalls.
    const perShelf: ShelfRecall[] = [];
    for (const shelf of shelves) {
      perShelf.push({ shelf, hits: await coreForShelf(shelf).recall(input) });
    }
    const limit = typeof input.limit === "number" ? input.limit : DEFAULT_MERGED_RECALL_LIMIT;
    return mergeShelfRecalls(perShelf, limit);
  };

  /**
   * Principal-aware MERGED reference search (spec 062 SC 8c / T6) — the reference-search analogue of
   * {@link recallForPrincipal}. Resolves the principal's `search` shelves in router order, validates
   * the materialised set (the same first-use validation point), searches each through its memoized
   * core, and merges by the decided rank-interleave + dedupe-by-path rule. Read-only.
   */
  const searchReferencesForPrincipal = async (
    principal: Principal,
    query: string,
    limit?: number,
  ): Promise<RecalledReference[]> => {
    const shelves = vaultRouter.shelves(principal, "search");
    validateShelfSet(shelves); // validate whatever a SUPPLIED router materialises, at first use
    const firstShelf = shelves[0];
    if (firstShelf === undefined) return []; // a router mapping the principal to no search shelves
    // SINGLE shelf — the DEFAULT router, and any principal a supplied router maps to one shelf.
    // EXACTLY today's path: search that ONE shelf's references, no provenance tagging, no merge. The
    // default router's shelf is DEFAULT_SHELF (mainCore), so this is byte-identical to the legacy
    // `searchReferences` — a plain ReferenceHit[] with NO shelf fields (a RecalledReference[] whose
    // shelf fields are optional-absent), so the search_references JSON is unchanged.
    if (shelves.length === 1) return coreForShelf(firstShelf).searchReferences(query, limit);
    // MULTI-shelf: search EACH shelf via its memoized handle, IN ROUTER ORDER, then merge. Each
    // shelf's search already clamps to its own limit; the merged `limit` is applied AFTER the merge.
    const perShelf: ShelfReferenceHits[] = [];
    for (const shelf of shelves) {
      perShelf.push({ shelf, hits: await coreForShelf(shelf).searchReferences(query, limit) });
    }
    const merged = typeof limit === "number" ? limit : DEFAULT_MERGED_REFERENCE_LIMIT;
    return mergeShelfReferenceHits(perShelf, merged);
  };

  // Plain string compare — the SAME semantics as the markdown store's own sort comparator, so the
  // merged list's ordering matches what each shelf's `listMemories` would produce.
  const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

  /** The list sort key, resolved exactly as the markdown store resolves it (default updated_at). */
  const resolveListSortField = (
    filters: Record<string, unknown>,
  ): "created_at" | "updated_at" | "title" =>
    (["created_at", "updated_at", "title"] as const).includes(
      filters.sort as "created_at" | "updated_at" | "title",
    )
      ? (filters.sort as "created_at" | "updated_at" | "title")
      : "updated_at";

  /**
   * Principal-aware MERGED memory list (spec 065 SC 7 / T4). Resolves the principal's `"recall"`
   * shelves in router order, validates the materialised set (the same first-use validation point
   * every principal surface uses), enumerates each shelf UNCAPPED, merges by the requested sort
   * key with the deterministic tie-break (router shelf order, then memory id), and pages AFTER
   * the merge. See the interface doc for the full decided semantics.
   */
  const listMemoriesForPrincipal = (
    principal: Principal,
    filters: Record<string, unknown> = {},
  ): { memories: RecalledMemory[]; total: number; limit: number; offset: number } => {
    const materialisedShelves = vaultRouter.shelves(principal, "recall");
    validateShelfSet(materialisedShelves); // validate whatever a SUPPLIED router materialises
    const { shelf: shelfId, ...memoryFilters } = filters;
    // A shelf id restricts the SET before enumeration. Shared ids intentionally retain every
    // matching shelf. The key never reaches the underlying memory filters in either arm.
    const shelves =
      shelfId === undefined
        ? materialisedShelves
        : materialisedShelves.filter((shelf) => shelf.id === shelfId);
    // The envelope's limit/offset mirror listMemories' own clamps, so the wire shape is uniform
    // across the zero-, single- and multi-shelf arms.
    const limit = Math.min(Math.max(Number(filters.limit ?? 100), 1), 200);
    const offset = Math.max(Number(filters.offset ?? 0), 0);
    const firstShelf = shelves[0];
    // 062's empty-set rule: a router mapping the principal to no recall shelves → the empty
    // envelope, never a throw.
    if (firstShelf === undefined) return { memories: [], total: 0, limit, offset };
    // SINGLE shelf — the DEFAULT router, and any principal a supplied router maps to one shelf:
    // DELEGATE to that shelf's own listMemories. The default router's shelf is DEFAULT_SHELF,
    // whose core IS mainCore — byte-identical envelope, NO shelf fields (the label trigger is
    // set-length > 1; the recallForPrincipal reduction precedent).
    if (shelves.length === 1) return coreForShelf(firstShelf).rawMemory.listMemories(memoryFilters);
    // MULTI-shelf: enumerate each shelf's filtered rows UNCAPPED (the public listMemories clamps
    // at 200 and slices internally — it cannot feed a merged pager), dedupe logical memory ids by
    // router precedence (the same identity rule as merged recall), then merge by the requested
    // sort key.
    const sortField = resolveListSortField(memoryFilters);
    const asc = memoryFilters.order === "asc";
    interface MergeRow {
      memory: Memory;
      shelfIndex: number;
      shelf: Shelf;
    }
    const rows: MergeRow[] = [];
    const seenIds = new Set<string>();
    shelves.forEach((shelf, shelfIndex) => {
      const perShelf = coreForShelf(shelf).rawMemory.listMemoriesUncapped(memoryFilters);
      for (const memory of perShelf.memories) {
        if (seenIds.has(memory.id)) continue;
        seenIds.add(memory.id);
        rows.push({ memory, shelfIndex, shelf });
      }
    });
    rows.sort((a, b) => {
      const cmp = cmpStr(String(a.memory[sortField]), String(b.memory[sortField]));
      if (cmp !== 0) return asc ? cmp : -cmp;
      // Deterministic tie-break (spec 065 SC 7): router shelf order first, then memory id.
      if (a.shelfIndex !== b.shelfIndex) return a.shelfIndex - b.shelfIndex;
      return cmpStr(a.memory.id, b.memory.id);
    });
    // offset/limit AFTER the merge; every merged row carries its shelf id (+ label when the shelf
    // has one) — 062's attribution rule, active because the set length is > 1 here.
    const memories = rows.slice(offset, offset + limit).map(({ memory, shelf }) => ({
      ...memory,
      shelfId: shelf.id,
      ...(shelf.label !== undefined ? { shelfLabel: shelf.label } : {}),
    }));
    return { memories, total: rows.length, limit, offset };
  };

  const shelvesForPrincipal = (principal: Principal): readonly Shelf[] => {
    const shelves = vaultRouter.shelves(principal, "recall");
    validateShelfSet(shelves);
    return shelves;
  };

  /**
   * Principal-scoped single-memory read (spec 065 SC 7 / T4): the id resolves through the SAME
   * `"recall"` shelf set, in router order; an off-shelf id is `null` — indistinguishable from
   * absent (no existence oracle). Zero shelves → `null` (062's empty-set rule).
   */
  const getMemoryForPrincipal = (principal: Principal, id: string): Memory | null => {
    const shelves = vaultRouter.shelves(principal, "recall");
    validateShelfSet(shelves);
    for (const shelf of shelves) {
      const memory = coreForShelf(shelf).rawMemory.getMemory(id);
      if (memory) return memory;
    }
    return null;
  };

  /**
   * Locate the highest-precedence visible proposal core for an admin moderation mutation.
   *
   * Read-only shelves deliberately use the raw store here: accepting, rejecting, or consuming
   * a submitted proposal is an admin moderation capability, not a general grant to write arbitrary
   * content on that shelf. The public `forShelf` surface remains write-gated for every other path.
   */
  const proposalCoreForPrincipal = (principal: Principal, id: string): ShelfCore => {
    if (!principal.roles.includes("admin")) {
      throw new Error("proposal moderation requires an admin principal");
    }
    const shelves = vaultRouter.shelves(principal, "recall");
    validateShelfSet(shelves);
    for (const shelf of shelves) {
      const core = coreForShelf(shelf);
      if (core.rawMemory.getMemory(id)) return core;
    }
    // Deliberately indistinguishable from an absent id: callers must not gain an off-shelf
    // existence oracle from a moderation attempt.
    throw new MemoryNotFoundForPrincipalError();
  };

  const approveProposalForPrincipal = (
    principal: Principal,
    id: string,
    action: "approve" | "reject" = "approve",
    patch: Record<string, unknown> = {},
    agentId?: string,
  ): Memory | null =>
    proposalCoreForPrincipal(principal, id).rawMemory.approveProposal(id, action, patch, agentId);

  const resolveProposalForPrincipal = (
    principal: Principal,
    id: string,
    resolution: string,
    agentId?: string,
  ): Memory | null =>
    proposalCoreForPrincipal(principal, id).rawMemory.resolveProposal(id, resolution, agentId);

  const sameShelfIdentity = (left: Shelf, right: Shelf): boolean =>
    left.id === right.id && left.prefix === right.prefix;

  /**
   * Cross-shelf memory move (spec 067 SC 2): resolve entirely within the principal's recall set,
   * rename the existing file without touching its bytes, commit exactly the old/new paths, and
   * invalidate both independently-cached shelf indexes.
   */
  const moveMemoryForPrincipal = (
    principal: Principal,
    id: string,
    destinationShelfId: string,
  ): Memory => {
    const shelves = vaultRouter.shelves(principal, "recall");
    validateShelfSet(shelves);

    let sourceShelf: Shelf | undefined;
    let memory: Memory | undefined;
    for (const shelf of shelves) {
      const candidate = coreForShelf(shelf).rawMemory.getMemory(id);
      if (!candidate) continue;
      sourceShelf = shelf;
      memory = candidate;
      break;
    }
    if (!sourceShelf || !memory) throw new MemoryNotFoundForPrincipalError();

    const destinationBearers = shelves.filter((shelf) => shelf.id === destinationShelfId);
    if (destinationBearers.length === 0) throw new MemoryNotFoundForPrincipalError();
    const destinationShelf = destinationBearers.find((shelf) => shelf.writable);
    if (!destinationShelf) {
      void refusalLog.record({
        kind: "shelf-not-writable",
        surface: "store",
        outcome: "refused",
        ...principalRefusalEvidence(principal),
        shelfId: destinationBearers[0]!.id,
        ...(destinationBearers[0]!.label === undefined
          ? {}
          : { shelfLabel: destinationBearers[0]!.label }),
      });
      throw new ShelfNotWritableError(destinationBearers[0]!);
    }
    if (sameShelfIdentity(sourceShelf, destinationShelf)) {
      throw new MemoryAlreadyOnShelfError(destinationShelf);
    }
    if (!sourceShelf.writable) {
      void refusalLog.record({
        kind: "shelf-not-writable",
        surface: "store",
        outcome: "refused",
        ...principalRefusalEvidence(principal),
        shelfId: sourceShelf.id,
        ...(sourceShelf.label === undefined ? {} : { shelfLabel: sourceShelf.label }),
      });
      throw new ShelfNotWritableError(sourceShelf);
    }

    const sourceCore = coreForShelf(sourceShelf);
    const destinationCore = coreForShelf(destinationShelf);
    const sourceRelativePath = sourceCore.scopedVault
      .listMarkdown("memories")
      .find((relativePath) => {
        try {
          return parseMemoryDocument(sourceCore.scopedVault.readText(relativePath)).id === id;
        } catch {
          return false;
        }
      });
    if (!sourceRelativePath) throw new MemoryNotFoundForPrincipalError();

    const sourcePath = sourceShelf.prefix + sourceRelativePath;
    const destinationPath = destinationShelf.prefix + sourceRelativePath;
    if (vault.exists(destinationPath)) {
      throw new MemoryMoveDestinationExistsError(destinationShelf);
    }
    // The path check alone misses a drifted copy: the same logical id can live
    // on the destination under a different filename (the state list dedupe
    // resolves by precedence). Moving would leave two files with one id.
    if (destinationCore.rawMemory.getMemory(id) !== null) {
      throw new MemoryMoveDestinationExistsError(destinationShelf);
    }

    let moved = false;
    try {
      vault.moveFile(sourcePath, destinationPath);
      moved = true;
      const committed = git.commitPaths(
        [sourcePath, destinationPath],
        commitSubject.memoryMove(id, sourceShelf.id, destinationShelf.id),
        principal.actorId,
      );
      if (committed === null) {
        throw new Error("memory move produced no Git commit");
      }
    } catch (error) {
      if (!moved) {
        if (error instanceof UnsafeVaultPathError) {
          throw new MemoryMoveUnsafePathError(destinationShelf);
        }
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new MemoryMoveDestinationExistsError(destinationShelf);
        }
        throw error;
      }

      const rollbackErrors: unknown[] = [];
      try {
        vault.moveFile(destinationPath, sourcePath);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      try {
        git.resetPaths([sourcePath, destinationPath]);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      sourceCore.invalidateIndex();
      destinationCore.invalidateIndex();
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "memory move failed and automatic rollback was incomplete; inspect the vault before retrying",
        );
      }
      throw new Error("memory move commit failed; the filesystem move was rolled back", {
        cause: error,
      });
    }
    sourceCore.invalidateIndex();
    destinationCore.invalidateIndex();
    return memory;
  };

  /**
   * Principal-scoped distinct values (spec 065 SC 7 / T4): the union over the `"recall"` shelf
   * set. Single shelf delegates (byte-identical, the default-router reduction); the multi-shelf
   * union re-sorts with the store's own ordering (case-insensitive, locale-stable) so the result
   * is deterministic regardless of shelf order. Zero shelves → the empty union.
   */
  const distinctValuesForPrincipal = (
    principal: Principal,
    input: { field: string; include_archived?: boolean },
  ): string[] => {
    const shelves = vaultRouter.shelves(principal, "recall");
    validateShelfSet(shelves);
    const firstShelf = shelves[0];
    if (firstShelf === undefined) return [];
    if (shelves.length === 1) return coreForShelf(firstShelf).rawMemory.distinctValues(input);
    const union = new Set<string>();
    for (const shelf of shelves) {
      for (const value of coreForShelf(shelf).rawMemory.distinctValues(input)) union.add(value);
    }
    return [...union].sort((a, b) => cmpStr(a.toLowerCase(), b.toLowerCase()));
  };

  /**
   * Principal-scoped reference-count denominator (spec 065 T4): Σ per-shelf `countReferences`
   * over the `"search"` set — the honest `searched` figure for a member's References tab (the
   * vault-global count would leak corpus size across shelf boundaries). Single shelf → that
   * shelf's count (default router: the main count, byte-identical); zero shelves → 0.
   */
  const countReferencesForPrincipal = (principal: Principal): number => {
    const shelves = vaultRouter.shelves(principal, "search");
    validateShelfSet(shelves);
    let total = 0;
    for (const shelf of shelves) total += coreForShelf(shelf).countReferences();
    return total;
  };

  // Curator read-side over the vault (Phase 4): memory evidence + slice enumeration come from the
  // (default-shelf) markdown memory store; run/operation bookkeeping lives in a sidecar JSON file.
  const markdownCuration = createJsonCurationStore({
    filePath: path.join(dataDir, "curation-runs.json"),
    memorySource: createVaultGroomingMemorySource(mainCore.rawMemory),
  });

  /**
   * A grooming-scoped store view for `shelf` (spec 062 SC 7, T6). The memory-evidence SOURCE and the
   * live-memory mutation surface resolve beneath the shelf's prefix; the run/operation bookkeeping is
   * vault-singular (the ONE `curation-runs.json` sidecar). The DEFAULT shelf reuses the top-level
   * `markdownCuration` (whose source reads mainCore.rawMemory) + the main memory surface, so it is
   * byte-identical to today's single run; a non-default shelf gets a fresh curation view over THE
   * SAME sidecar file with a source reading that shelf's memory. Grooming NEVER consults writeTarget
   * (spec 062 §4) — this handle IS its shelf scope.
   *
   * The mutation surface is the shelf's RAW (un-gated) memory store, NOT the write-gated view (review
   * A1). Grooming is a SYSTEM pipeline: spec §4 scopes it to the shelf being processed, and `writable`
   * gates PRINCIPAL-attributed writes only (vault-router.ts). Composing the gated `memory` here made a
   * `writable: false` team shelf throw `ShelfNotWritableError` on every proposal apply — swallowed into
   * the run's `errored`/`failed` counts, so a Teams grooming pass silently did nothing. The raw store
   * lets a read-only team shelf groom fine, its writes landing UNDER the shelf (intake already does
   * exactly this via `rawMemory`).
   */
  const groomingStoreForShelf = (shelf: Shelf): GroomingStore => {
    const core = coreForShelf(shelf);
    const curation =
      shelf.prefix === ""
        ? markdownCuration
        : createJsonCurationStore({
            filePath: path.join(dataDir, "curation-runs.json"),
            memorySource: createVaultGroomingMemorySource(core.rawMemory),
          });
    return { ...curation, ...core.rawMemory };
  };

  /**
   * The SYSTEM-PIPELINE inbox seam (spec 062 §4 / review A1 + F). Submits into `shelf`'s
   * `<prefix>inbox/` through the memoized core's UN-gated `rawSubmitToInbox` — the same way grooming
   * and the intake sweep reach `core.rawMemory` / `core.scopedVault`. System pipelines are
   * SHELF-SCOPED, not writability-gated: `writable` governs principal-attributed writes only, so a
   * read-only shelf's inbox still accepts `system-consolidator`-bound transcript facts (routing them
   * through the gated `forShelf` view lost them permanently — the sweep's per-fact fail-soft swallowed
   * the ShelfNotWritableError and then deleted the buffer). Under the DEFAULT shelf this is
   * `mainCore.rawSubmitToInbox` — byte-identical to `submitToInbox`.
   */
  const systemSubmitToInbox = (
    shelf: Shelf,
    text: string,
    hints?: InboxSubmissionHints,
  ): InboxItemRef => coreForShelf(shelf).rawSubmitToInbox(text, hints);

  const systemProjectStoresForShelf = (shelf: Shelf): ProjectSystemStores => {
    const core = coreForShelf(shelf);
    return {
      shelf,
      projects: core.rawProjects,
      projectUpdates: core.rawProjectUpdates,
      projectSuggestions: core.rawProjectSuggestions,
    };
  };

  return {
    ...mainHandle.memory,
    ...markdownCuration,
    ...markdownIntake,
    ...jsonSettings,
    handoffs: mainHandle.handoffs,
    projects: mainHandle.projects,
    projectUpdates: mainHandle.projectUpdates,
    projectSuggestions: mainHandle.projectSuggestions,
    vaultFiles: mainHandle.vaultFiles,
    vaultRouter,
    forShelf,
    resolveWriteTarget,
    searchReferences: mainHandle.searchReferences,
    // "references" mirrors corpus-index's REFERENCES_DIR — the exact set
    // searchReferences indexes, so this is a faithful "searched" denominator.
    countReferences: mainHandle.countReferences,
    recall: mainHandle.recall,
    recallForPrincipal,
    searchReferencesForPrincipal,
    listMemoriesForPrincipal,
    shelvesForPrincipal,
    getMemoryForPrincipal,
    approveProposalForPrincipal,
    resolveProposalForPrincipal,
    moveMemoryForPrincipal,
    distinctValuesForPrincipal,
    countReferencesForPrincipal,
    groomingStoreForShelf,
    systemProjectStoresForShelf,
    systemSubmitToInbox,
    submitToInbox: mainHandle.submitToInbox,
    recordRefusal: refusalLog.record,
    flushRefusals: refusalLog.flush,
    readRefusals: refusalLog.read,
    runIntakeSweep: async (deps): Promise<SweepSummary> => {
      // The intake sweep drains EVERY shelf's inbox (spec 062 SC 8a). The inbox-holding shelves are
      // the system pipeline's processing set — the shelves the SYSTEM principal grooms
      // (`shelves(system, "groom")`). This is the honest choice: it is the only shelf set the router
      // can answer (a VaultRouter is a function of a principal, so "every materialisable shelf" is
      // not enumerable), and it matches where captures land (a Teams router that routes captures to a
      // member shelf must also groom it). The intake system principal is the honest `system-consolidator` —
      // kind "system", the INTAKE_ACTOR_ID (`system-consolidator`) intake already attributes its
      // writes to. Each shelf is processed within its own SCOPED handle, still as
      // `system-consolidator`. Under the DEFAULT router this materialises the single main shelf → one
      // sweep over the one inbox, byte-identical to today.
      const systemPrincipal: Principal = {
        kind: "system",
        actorId: INTAKE_ACTOR_ID,
        roles: ["system"],
      };
      const shelves = vaultRouter.shelves(systemPrincipal, "groom");
      validateShelfSet(shelves); // validate whatever a SUPPLIED router materialises, at first use
      const summary: SweepSummary = {
        reclaimed: 0,
        consolidated: 0,
        judgeErrors: 0,
        claimedByOther: 0,
        errored: 0,
      };
      for (const shelf of shelves) {
        const core = coreForShelf(shelf);
        // PERF: each applied item invalidates the recall index (onWrite) and the
        // next item's navigate rebuilds + re-embeds the corpus; listActive also
        // re-reads the vault per item. Correct (later items see earlier filings,
        // S1/G6) but ~O(items) rebuilds — batch/defer index invalidation across a
        // sweep when the real embedder makes this a hot spot. Fine while sweeps
        // are serial + off the hot path.
        const shelfSummary = await runIntakeSweep({
          vault: core.scopedVault,
          recall: (q, n) => core.recall({ query: q, limit: n }),
          listActive: () => core.rawMemory.listAll({ status: MemoryStatus.Active }),
          store: core.rawMemory,
          actorId: INTAKE_ACTOR_ID,
          llmClient: deps.llmClient,
          // Observational decision log — fail-soft inside the sweep, never affects filing. Shared
          // (vault-singular) across shelves; each shelf opens its own run lazily only if it works.
          intakeLog: markdownIntake,
          intakeTrigger: deps.trigger ?? "manual",
          ...(deps.confidenceThreshold !== undefined
            ? { confidenceThreshold: deps.confidenceThreshold }
            : {}),
          ...(deps.lockTtlMs !== undefined ? { lockTtlMs: deps.lockTtlMs } : {}),
          ...(deps.onError ? { onError: deps.onError } : {}),
          ...(deps.promptAddendum ? { promptAddendum: deps.promptAddendum } : {}),
          ...(deps.intakeExamples ? { intakeExamples: deps.intakeExamples } : {}),
        });
        summary.reclaimed += shelfSummary.reclaimed;
        summary.consolidated += shelfSummary.consolidated;
        summary.judgeErrors += shelfSummary.judgeErrors;
        summary.claimedByOther += shelfSummary.claimedByOther;
        summary.errored += shelfSummary.errored;
      }
      // The apply path commits per memory write (each pathspec-limited + attributed to
      // INTAKE_ACTOR_ID); commit once more to capture the inbox claim/complete moves a no-op
      // or judge-error sweep leaves behind (commitAll is a no-op when the tree is already clean).
      // This mop-up is WHOLE-TREE (the leftover moves have no path set) and therefore
      // UNTRAILERED — an honest null. With no repo lock (the CLI + a human's Obsidian editor are
      // separate processes on this repo), `git add -A` can sweep an UNRELATED concurrent edit into
      // this commit; trailering it `system-consolidator` would stamp a human's bytes with a false
      // name — worse than a null (spec 064 §4). The per-memory writes above already carry the
      // `system-consolidator`'s attribution; the export still derives the "system" channel from the
      // `inbox:` subject prefix, so nothing the audit needs is lost by dropping the trailer here.
      commitAll(commitSubject.inboxConsolidateSweep());
      return summary;
    },
    dataDir,
    close: () => {},
    // drop EVERY shelf's cached recall index → the next recall on each rebuilds from the vault
    // (also picks up out-of-band vault edits, e.g. a hand-added reference). Vault-wide maintenance
    // verb: under the default router there is one core, so this is byte-identical to before
    // (spec 062 T4 — the per-shelf generalisation of "invalidate the index", no new semantics).
    reindex: () => {
      for (const core of cores.values()) core.invalidateIndex();
    },
    vaultActivity: (input = {}) =>
      gitHistory.recentCommits(input).map((entry) => ({
        ...entry,
        source: classifyVaultCommit(entry.subject),
      })),
    vaultCommitDiff: (hash) => gitHistory.commitDiff(hash),
    restoreVaultTo: (hash, options) =>
      restoreVaultToCommit(
        {
          settings: jsonSettings,
          git,
          history: gitHistory,
          // A live curator pass (grooming slice) or intake sweep run record in
          // `running` — restoring under either would corrupt its writes.
          hasRunningCurationRun: () =>
            markdownCuration.listCurationRuns({ status: "running" }).length > 0 ||
            markdownIntake.listIntakeRuns({ status: "running" }).length > 0,
          invalidate: () => {
            // A restore replaces the WHOLE working tree, so every shelf's index is stale — drop
            // them all (default router = one core, byte-identical; spec 062 T4).
            for (const core of cores.values()) core.invalidateIndex();
            cachedPrimer = undefined; // primer.md may have changed with the tree
          },
        },
        hash,
        options,
      ),
    exportAudit: (principal, options = {}) => {
      // Scope = the caller's recall shelves (NOT a new op — adding `"audit"` would be a MAJOR bump
      // on 062's stabilised entrypoint, to buy a WIDER grant than recall). Same first-use
      // validation the read/write paths apply to whatever a supplied router materialises.
      const shelves = vaultRouter.shelves(principal, "recall");
      validateShelfSet(shelves);
      // Admin unlocks the confidential FIELDS (paths/renames/diff), never the shelf scope — even an
      // admin scoped to shelf A sees zero bytes of shelf B (spec 064 SC 9). Gating lives HERE, so
      // the tRPC procedure stays a thin principal pass-through.
      const isAdmin = principal.roles.includes("admin");
      const includeDiff = isAdmin && options.includeDiff === true;
      const pageSize = Math.max(
        1,
        Math.min(options.limit ?? AUDIT_PAGE_COMMITS, AUDIT_PAGE_COMMITS),
      );
      // Read ONE extra commit to learn whether more remain — hasMore counts COMMITS, not events
      // (SC 9 can drop a commit to 0 events, SC 10 can expand one to 2).
      const read = gitHistory.auditCommits({
        limit: pageSize + 1,
        ...(options.before !== undefined ? { before: options.before } : {}),
      });
      if (read.kind === "unreadable") throw new AuditSourceError(read.detail);
      if (read.kind === "unknown-cursor") {
        throw new AuditCursorError(options.before ?? "");
      }
      if (read.kind === "empty") return { events: [], hasMore: false };
      const scanned = read.commits;
      const hasMore = scanned.length > pageSize;
      const pageCommits = scanned.slice(0, pageSize);
      // nextCursor = the OLDEST COMMIT SCANNED in the page, never `events.at(-1)` (a zero-event page
      // must still advance — a shelf-scoped client would otherwise dead-end; spec 064 SC 11).
      const nextCursor = pageCommits.at(-1)?.hash;
      const ctx: AuditBuildContext = {
        shelves,
        isAdmin,
        includeDiff,
        commitDiff: (hash) => gitHistory.commitDiff(hash),
      };
      const events: AuditEvent[] = pageCommits.flatMap((commit) => buildAuditEvents(commit, ctx));
      return { events, hasMore, ...(nextCursor !== undefined ? { nextCursor } : {}) };
    },
    pushVaultBackup: (auth) => {
      // Every memory write already commits, but capture any out-of-band edits
      // (e.g. a hand-added reference) before the push so nothing is left behind.
      commitAll(commitSubject.backupSnapshot());
      const head = git.head();
      // A commitless vault (fresh install, no memories yet) has nothing to push —
      // pushing HEAD would fail ("src refspec HEAD does not match any").
      if (!head) return null;
      git.push(auth);
      return head;
    },
    // The primer lives at vault/primer.md (rethink T11, spec §5.2): same
    // write+commit primitive as the addendums below. Reads are cached
    // in-memory — the text is read per MCP initialize / GET /primer.md — and
    // the cache is refreshed on every write, so an admin edit is served fresh
    // to the next connection without a re-read per request.
    readPrimer: () => {
      if (cachedPrimer === undefined) cachedPrimer = vault.tryReadText(PRIMER_PATH);
      return cachedPrimer;
    },
    writePrimer: (content, actorId) => {
      vault.writeText(PRIMER_PATH, content);
      // Attributed + pathspec-limited to primer.md (spec 064 SC 1/SC 4). PRIMER_PATH is a
      // vault SINGLETON at the true root, so it is already a full vault-relative path.
      git.commitPaths([PRIMER_PATH], commitSubject.primerUpdate(), actorId);
      cachedPrimer = content;
    },
    // Curator addenda live as committed vault files (spec 044 D-1): same
    // write+commit primitive as memory/handoff, read back as raw text (no
    // frontmatter), versioned by the file's last-touching commit hash. The
    // intake examples document (proposal-review rework F4 / D3) is a sibling
    // over the SAME primitives — one committed-file helper serves both.
    readAddendum: (job) => readCuratorFile(addendumPath(job)),
    writeAddendum: (job, content, actorId) =>
      writeCuratorFile(addendumPath(job), content, commitSubject.curatorAddendum(job), actorId),
    rollbackAddendum: (job, actorId) =>
      rollbackCuratorFile(addendumPath(job), commitSubject.curatorRollback(job), actorId),
    readIntakeExamples: () => readCuratorFile(INTAKE_EXAMPLES_PATH),
    writeIntakeExamples: (content, actorId) =>
      writeCuratorFile(
        INTAKE_EXAMPLES_PATH,
        content,
        commitSubject.curatorIntakeExamplesUpdate(),
        actorId,
      ),
    rollbackIntakeExamples: (actorId) =>
      rollbackCuratorFile(
        INTAKE_EXAMPLES_PATH,
        commitSubject.curatorIntakeExamplesRollback(),
        actorId,
      ),
  };

  function readCuratorFile(rel: string): AddendumRecord {
    const content = vault.tryReadText(rel) ?? "";
    // The version is meaningful only when the file actually exists on disk;
    // lastCommitFor would otherwise return null anyway, but skip the git call.
    const version = vault.exists(rel) ? git.lastCommitFor(rel) : null;
    return { content, version };
  }

  function writeCuratorFile(
    rel: string,
    content: string,
    message: string,
    actorId?: string,
  ): AddendumRecord {
    vault.writeText(rel, content);
    // Attributed + pathspec-limited to this one curator file (spec 064 SC 1/SC 4); `rel` is
    // a full vault-relative path (`.curator/<job>-addendum.md`, `.curator/intake-examples.md`).
    git.commitPaths([rel], message, actorId);
    return { content, version: git.lastCommitFor(rel) };
  }

  function rollbackCuratorFile(
    rel: string,
    message: string,
    actorId?: string,
  ): RollbackAddendumResult {
    // The file's own commit history, newest-first. [0] = current version,
    // [1] = the prior version we roll back to.
    const history = git.commitsFor(rel);
    if (history.length === 0) {
      // Never committed — nothing to roll back. Safe no-op.
      return { restored: false, version: null };
    }
    const prior = history[1];
    if (prior) {
      // Restore ONLY this file to its prior committed content (surgical — the
      // vault is the live shared tree), then commit the restoration so it is a
      // revertable commit at the head of the file's history.
      git.checkoutFile(rel, prior);
    } else {
      // Single committed version → no prior content to restore to. Roll back to
      // the pre-existence state by clearing the file, still committed.
      vault.writeText(rel, "");
    }
    git.commitPaths([rel], message, actorId);
    return { restored: true, version: git.lastCommitFor(rel) };
  }
}
