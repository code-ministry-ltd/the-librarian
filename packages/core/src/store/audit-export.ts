// The typed, shelf-safe audit export (spec 064 T6–T8 / SC 8–12) — the read half of the
// attribution substrate. `LibrarianStore.exportAudit` turns the vault's git history into a
// stream of typed `AuditEvent`s answering "who SUCCESSFULLY changed what, when, on which shelf"
// without a consumer ever parsing git. The honest scope (what this canNOT answer — reads,
// refused writes, no-op mutations) is the published honesty list (§3 / the docs page).
//
// Three things live here:
//   1. The PERMANENT published record — `AuditEvent`, the closed `AuditAction` union, the zod
//      schema, and the `AuditSourceError`/`AuditCursorError` classes (SC 8). `AuditAction` is
//      enumerated in full because the entrypoint is permanent: adding a member later is a MAJOR
//      bump, so it is never a wildcard.
//   2. The pure subject→action / subject→id derivation (one source of truth with the T1 commit
//      vocabulary), and the read-side attribution defence SC 7c: a commit carrying ≠1
//      `Librarian-Actor` trailer exports `actor: null` — a forged/duplicated trailer is never
//      believed, even if the write-side sanitiser were bypassed.
//   3. The per-commit → events engine (`buildAuditEvents`) with the shelf filter (SC 9), the
//      non-ASCII-safe path membership (SC 9b — the read itself pins `core.quotePath=false`),
//      the admin-only `paths`/`renames`/`diff` gate, the promotion (departure/arrival) records
//      (SC 10) and the straddle downgrade to `vault.change`.

import { z } from "zod";
import { channelForActor } from "../caller-identity.js";
import type { Shelf } from "../vault-router.js";
import { commitSubject } from "./commit-message.js";
import type { AuditCommit, CommitDiff } from "./git/git-history.js";
import { classifyVaultCommit } from "./vault-restore.js";

/** The published record's schema version (SC 8) — a plugin pins it; bumping it is a MAJOR change. */
export const AUDIT_SCHEMA_VERSION = 1;

/** Commits older than the cursor per page — half the 200-commit clamp (SC 11, §4 assumption). */
export const AUDIT_PAGE_COMMITS = 100;

/**
 * Per-file diff byte cap (SC 12): a diff longer than this is truncated with `truncated: true`.
 * The audit trail is metadata-first — a diff is a legibility aid, not a file transfer — so the
 * cap is deliberately small; a reviewer who needs the full bytes opens the commit in the vault.
 */
export const AUDIT_DIFF_MAX_BYTES = 8_000;

/**
 * The CLOSED, PERMANENT audit-action union (SC 8), one member per subject in the T1 commit
 * vocabulary plus the synthetic export-only members (`vault.change` — the straddle downgrade;
 * `shelf.departure`/`shelf.arrival` — cross-shelf promotion; `other` — the legacy/unknown
 * fallback). Enumerated as a runtime array so the zod schema and the type share ONE source; it
 * is published on the stable entrypoint, so adding a member is a MAJOR bump.
 */
export const AUDIT_ACTIONS = [
  "memory.propose",
  "memory.store",
  "memory.update",
  "memory.archive",
  "memory.unarchive",
  "memory.purge",
  "memory.flag",
  "memory.resolve-flags",
  "memory.reject",
  "memory.approve",
  "memory.resolve",
  "memory.bulk-update",
  "handoff.store",
  "handoff.claim",
  "handoff.purge",
  "inbox.submit",
  "inbox.consolidate",
  "vault.edit",
  "vault.create",
  "vault.rename",
  "vault.delete",
  "vault.restore-file",
  "vault.rollback",
  "vault.pre-rollback-snapshot",
  "vault.out-of-band",
  "vault.change",
  "primer.update",
  "curator.addendum",
  "curator.addendum-rollback",
  "curator.examples",
  "curator.examples-rollback",
  "backup.snapshot",
  "shelf.departure",
  "shelf.arrival",
  "migrate.initial",
  "migrate.frontmatter",
  "migrate.primer",
  "migrate.addendum",
  "other",
] as const;

/** One audit action — a closed union (SC 8). */
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** The provenance channel of an event (SC 5/SC 6). Actor-derived for a trailered commit
 *  (`channelForActor`), subject-derived (the legacy fallback) for an untrailered one. */
export type AuditChannel = "agent" | "curator" | "admin" | "system" | "other";

/**
 * A rename's two sides — EITHER may be null because SC 10 redacts the far side: a `shelf.departure`
 * seen by the source shelf shows `{ from, to: null }`, an `arrival` on the destination shows
 * `{ from: null, to }`. A plain in-shelf rename shows both.
 */
export interface AuditRename {
  from: string | null;
  to: string | null;
}

/** One file's (byte-capped) diff within an event's commit (admin-only, SC 12). */
export interface AuditDiffFile {
  path: string;
  /** Unified diff text for this file, truncated to {@link AUDIT_DIFF_MAX_BYTES}. */
  diff: string;
  /** True when the diff was longer than the cap and was cut. */
  truncated: boolean;
}

/** The per-file diffs attached to an event when `includeDiff` is set (admin-only, SC 12). */
export interface AuditDiff {
  files: readonly AuditDiffFile[];
}

/**
 * ONE typed audit record (SC 8), published as a VALUE (the schema) and a type. `actor` is the
 * `Librarian-Actor` trailer's value — `null` for an untrailered commit (pre-064 history, a system
 * sweep), for an anonymous write, AND for a commit carrying ≠1 trailer (SC 7c: a false name is
 * worse than an honest null). `paths`/`renames`/`diff` are ADMIN-ONLY (a memory filename encodes
 * its title); a non-admin caller receives only `actor`+`action`+`subjectId`+`shelves`+`at`.
 */
export interface AuditEvent {
  schemaVersion: typeof AUDIT_SCHEMA_VERSION;
  /** The commit hash. */
  commit: string;
  /** Author date, ISO-8601. */
  at: string;
  /** The attributed actor, or `null` (untrailered / anonymous / ≠1 trailer — SC 7c). */
  actor: string | null;
  channel: AuditChannel;
  action: AuditAction;
  /** The object the action names (a memory/handoff/inbox id), or `null` (no id, or redacted). */
  subjectId: string | null;
  /** The in-scope shelf ids this event touched — the intersection with the caller's shelves. */
  shelves: readonly string[];
  /** ADMIN-ONLY: the in-scope paths the commit touched (a filename encodes a memory title). */
  paths?: readonly string[];
  /** ADMIN-ONLY: the in-scope rename pairs, far side redacted when it crosses a shelf boundary. */
  renames?: readonly AuditRename[];
  /** ADMIN-ONLY, opt-in: per-file byte-capped diffs (SC 12). */
  diff?: AuditDiff;
  /** For a whole-vault rollback (`vault.rollback`): the commit the vault was rolled back TO. */
  revertedTo?: string;
}

/** A page of the audit export (SC 11): commit-addressed, so a page may hold 0..2N events. */
export interface AuditExportPage {
  events: AuditEvent[];
  /**
   * Optional display chrome keyed by actor id. Rows remain unchanged so the
   * published strict {@link AuditEventSchema} stays backward-compatible.
   * Consumers must use `Object.hasOwn` for untrusted actor ids.
   */
  actorDisplays?: Readonly<Record<string, string>>;
  /** More COMMITS remain older than this page (counted in commits, never events). */
  hasMore: boolean;
  /** The OLDEST COMMIT SCANNED in this page — pass it as the next `before` (SC 11). Never derived
   *  from `events.at(-1)`: a page can legitimately hold zero events yet still need to advance. */
  nextCursor?: string;
}

/** Options for {@link LibrarianStore.exportAudit}. */
export interface AuditExportOptions {
  /** Page size in COMMITS, clamped to [1, {@link AUDIT_PAGE_COMMITS}]. Default 100. */
  limit?: number;
  /** Cursor: only commits strictly older than this hash (SC 11). */
  before?: string;
  /** Opt in to per-file diffs — IGNORED for non-admin callers (admin-only, SC 12). */
  includeDiff?: boolean;
}

/**
 * The vault's git history could not be read for the export (SC 11) — a broken `.git`, not a bad
 * request. Published as a VALUE (a plugin `instanceof`-checks it, the 062 error-class precedent);
 * the tRPC boundary maps it to a 500-class error, NEVER a client error.
 */
export class AuditSourceError extends Error {
  constructor(detail: string) {
    super(`the vault's git history could not be read for the audit export: ${detail}`);
    this.name = "AuditSourceError";
  }
}

/**
 * The pagination cursor names no commit in the vault's history (SC 11) — a stale/unknown cursor is
 * a typed CLIENT error, never a 500. Distinct from {@link AuditSourceError} (a source failure) so
 * the boundary can map the two to different HTTP codes.
 */
export class AuditCursorError extends Error {
  constructor(cursor: string) {
    super(`audit cursor '${cursor}' names no commit in the vault's history — it may be stale`);
    this.name = "AuditCursorError";
  }
}

// ── the published zod schema (SC 8) ─────────────────────────────────────────────

const AuditRenameSchema = z.object({
  from: z.string().nullable(),
  to: z.string().nullable(),
});

const AuditDiffFileSchema = z.object({
  path: z.string(),
  diff: z.string(),
  truncated: z.boolean(),
});

const AuditDiffSchema = z.object({
  files: z.array(AuditDiffFileSchema),
});

/**
 * The published schema for one {@link AuditEvent} (SC 8). A plugin validates the wire shape with
 * this; `.strict()` keeps the permanent surface honest (an unexpected key is a bug, not silently
 * dropped). The admin-only fields are `.optional()` — a non-admin event omits them entirely.
 */
export const AuditEventSchema = z
  .object({
    schemaVersion: z.literal(AUDIT_SCHEMA_VERSION),
    commit: z.string(),
    at: z.string(),
    actor: z.string().nullable(),
    channel: z.enum(["agent", "curator", "admin", "system", "other"]),
    action: z.enum(AUDIT_ACTIONS),
    subjectId: z.string().nullable(),
    shelves: z.array(z.string()),
    paths: z.array(z.string()).optional(),
    renames: z.array(AuditRenameSchema).optional(),
    diff: AuditDiffSchema.optional(),
    revertedTo: z.string().optional(),
  })
  .strict();

// ── subject → action / subjectId (one source of truth with the T1 vocabulary) ───

/** The id-bearing actions — those whose subject names an opaque object id (SC 9's `subjectId`). */
const ID_BEARING = new Set<AuditAction>([
  "memory.propose",
  "memory.store",
  "memory.update",
  "memory.archive",
  "memory.unarchive",
  "memory.purge",
  "memory.flag",
  "memory.resolve-flags",
  "memory.reject",
  "memory.approve",
  "memory.resolve",
  "memory.bulk-update",
  "handoff.store",
  "handoff.claim",
  "handoff.purge",
  "inbox.submit",
]);

/**
 * Map a commit SUBJECT to its {@link AuditAction} (SC 8), total over the T1 vocabulary with an
 * `other` fallback. The constant (interpolation-free) subjects match `commitSubject` exactly, so
 * the mapping and the writers share one source of truth; the interpolated ones match by prefix.
 * The two `vault: restore …` shapes are disambiguated by checking the whole-vault `restore to `
 * prefix BEFORE the single-file `restore ` prefix.
 */
export function actionForSubject(subject: string): AuditAction {
  // Constant subjects — exact match against the vocabulary.
  if (subject === commitSubject.inboxConsolidateSweep()) return "inbox.consolidate";
  if (subject === commitSubject.vaultPreRestoreSnapshot()) return "vault.pre-rollback-snapshot";
  if (subject === commitSubject.primerUpdate()) return "primer.update";
  if (subject === commitSubject.curatorIntakeExamplesUpdate()) return "curator.examples";
  if (subject === commitSubject.curatorIntakeExamplesRollback()) return "curator.examples-rollback";
  if (subject === commitSubject.backupSnapshot()) return "backup.snapshot";
  if (subject === commitSubject.migrateInitial()) return "migrate.initial";
  if (subject === commitSubject.migrateFrontmatter()) return "migrate.frontmatter";
  // Interpolated subjects — match by verb prefix.
  if (subject.startsWith("memory: propose ")) return "memory.propose";
  if (subject.startsWith("memory: store ")) return "memory.store";
  if (subject.startsWith("memory: update ")) return "memory.update";
  if (subject.startsWith("memory: unarchive ")) return "memory.unarchive";
  if (subject.startsWith("memory: archive ")) return "memory.archive";
  if (subject.startsWith("memory: purge ")) return "memory.purge";
  if (subject.startsWith("memory: flag ")) return "memory.flag";
  if (subject.startsWith("memory: resolve-flags ")) return "memory.resolve-flags";
  if (subject.startsWith("memory: resolve ")) return "memory.resolve";
  if (subject.startsWith("memory: reject ")) return "memory.reject";
  if (subject.startsWith("memory: approve ")) return "memory.approve";
  if (subject.startsWith("memory: bulk-update ")) return "memory.bulk-update";
  // Deliberately stays outside the closed-permanent AuditAction union until the next major.
  // Cross-shelf renames are represented by the typed shelf.departure / shelf.arrival events.
  if (subject.startsWith("memory: move ")) return "other";
  if (subject.startsWith("handoff: store ")) return "handoff.store";
  if (subject.startsWith("handoff: claim ")) return "handoff.claim";
  if (subject.startsWith("handoff: purge ")) return "handoff.purge";
  if (subject.startsWith("inbox: submit ")) return "inbox.submit";
  // The whole-vault rollback subject is `vault: restore to <hash>` (a BARE hash to end-of-line); the
  // single-file revert is `vault: restore <path> to <hash>`. Match the rollback by its exact
  // hash-only shape, NOT a leading `restore to ` prefix — else a file named e.g. `to review.md`
  // (subject `vault: restore to review.md to <hash>`) is misread as a whole-vault rollback (review
  // finding). Everything else under the `vault: restore ` stem is a single-file revert.
  if (/^vault: restore to [0-9a-f]{7,40}$/.test(subject)) return "vault.rollback";
  if (subject.startsWith("vault: restore ")) return "vault.restore-file";
  if (subject.startsWith("vault: edit ")) return "vault.edit";
  if (subject.startsWith("vault: create ")) return "vault.create";
  if (subject.startsWith("vault: rename ")) return "vault.rename";
  if (subject.startsWith("vault: delete ")) return "vault.delete";
  if (subject.startsWith("curator: addendum ")) return "curator.addendum";
  if (subject.startsWith("curator: rollback ")) return "curator.addendum-rollback";
  // Chronicle is additive derived system output. Keep the permanent v1 AuditAction union stable;
  // its system provenance still comes from classifyVaultCommit, while its action is `other`.
  if (subject.startsWith("chronicle: ")) return "other";
  // The journal (spec 077) is derived system output plus owner deletes; like Chronicle it
  // keeps the permanent v1 AuditAction union stable and maps to `other`.
  if (subject.startsWith("journal: ")) return "other";
  return "other";
}

/** The opaque object id an id-bearing subject names (SC 9), or null. The id is the token after
 *  the verb (`memory: store <id>`, `handoff: claim <id>`, `inbox: submit <id>`); it is opaque
 *  (never the title), so it is safe to show a non-admin caller. */
export function subjectIdForSubject(subject: string, action: AuditAction): string | null {
  if (!ID_BEARING.has(action)) return null;
  return subject.split(" ")[2] ?? null;
}

/** The commit a whole-vault rollback returned the tree TO (`vault: restore to <hash>`). */
function revertedToOf(subject: string): string | undefined {
  const prefix = "vault: restore to ";
  return subject.startsWith(prefix) ? subject.slice(prefix.length).trim() : undefined;
}

// ── the per-commit → events engine (SC 7c / SC 9 / SC 10) ────────────────────────

/** Everything a page-build needs about the caller + the diff source. */
export interface AuditBuildContext {
  /** The caller's recall shelves (the scope), ordered. */
  shelves: readonly Shelf[];
  /** Whether the caller may see the admin-only `paths`/`renames`/`diff` fields. */
  isAdmin: boolean;
  /** Whether to attach diffs (admin-only; already ANDed with isAdmin by the store). */
  includeDiff: boolean;
  /** Per-file diffs for a commit (only called for admin + includeDiff). */
  commitDiff: (hash: string) => CommitDiff;
}

/** The most specific caller shelf a path sits under, or undefined when the path is out of scope.
 *  The empty-prefix (OSS default) shelf covers every path; a longer prefix wins over it. */
function shelfCovering(path: string, shelves: readonly Shelf[]): Shelf | undefined {
  let best: Shelf | undefined;
  for (const shelf of shelves) {
    if (shelf.prefix === "" || path.startsWith(shelf.prefix)) {
      if (best === undefined || shelf.prefix.length > best.prefix.length) best = shelf;
    }
  }
  return best;
}

/** Byte-cap one file's diff text (SC 12). */
function capDiff(text: string): { diff: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= AUDIT_DIFF_MAX_BYTES) return { diff: text, truncated: false };
  return { diff: buf.subarray(0, AUDIT_DIFF_MAX_BYTES).toString("utf8"), truncated: true };
}

/**
 * Turn ONE raw {@link AuditCommit} into 0..2 {@link AuditEvent}s for the caller (SC 7c/9/9b/10).
 * Pure. Zero events when the commit touches none of the caller's shelves; two when a rename
 * crosses a shelf boundary the caller sees both sides of.
 */
export function buildAuditEvents(commit: AuditCommit, ctx: AuditBuildContext): AuditEvent[] {
  // SC 7c: ≠1 trailer → actor null. A duplicated/forged trailer is never believed on read.
  const actor = commit.actors.length === 1 ? (commit.actors[0] ?? null) : null;
  // SC 5/SC 6: a trailered commit's channel is ACTOR-derived; an untrailered one falls back to
  // the subject-based legacy classifier (which alone yields "curator"/"other").
  const channel: AuditChannel =
    actor !== null ? channelForActor(actor) : classifyVaultCommit(commit.subject);
  const at = commit.date;
  const baseAction = actionForSubject(commit.subject);

  const touchedPaths = [...commit.files];
  for (const rename of commit.renames) touchedPaths.push(rename.from, rename.to);

  const inScopeIds = new Set<string>();
  for (const path of touchedPaths) {
    const shelf = shelfCovering(path, ctx.shelves);
    if (shelf) inScopeIds.add(shelf.id);
  }
  if (inScopeIds.size === 0) return []; // SC 9: touches no in-scope shelf — dropped entirely

  const covers = (path: string): boolean => shelfCovering(path, ctx.shelves) !== undefined;

  const attachDiff = (event: AuditEvent, paths: readonly string[]): void => {
    if (!ctx.isAdmin || !ctx.includeDiff || paths.length === 0) return;
    const set = new Set(paths);
    const files: AuditDiffFile[] = [];
    for (const file of ctx.commitDiff(event.commit).files) {
      if (!set.has(file.path)) continue; // never a byte of an out-of-scope file
      const { diff, truncated } = capDiff(file.diff);
      files.push({ path: file.path, diff, truncated });
    }
    if (files.length > 0) event.diff = { files };
  };

  const makeEvent = (spec: {
    action: AuditAction;
    subjectId: string | null;
    shelves: string[];
    paths: string[];
    renames: AuditRename[];
    revertedTo?: string;
  }): AuditEvent => {
    const event: AuditEvent = {
      schemaVersion: AUDIT_SCHEMA_VERSION,
      commit: commit.hash,
      at,
      actor,
      channel,
      action: spec.action,
      subjectId: spec.subjectId,
      shelves: spec.shelves,
    };
    if (spec.revertedTo !== undefined) event.revertedTo = spec.revertedTo;
    if (ctx.isAdmin) {
      if (spec.paths.length > 0) event.paths = spec.paths;
      if (spec.renames.length > 0) event.renames = spec.renames;
      // Diffs are NOT attached here — only to the base (all-in-shelf) event below. A cross-shelf
      // departure/arrival's far path is redacted, but a rename's `git show` diff header names BOTH
      // sides, so attaching it to an arrival would leak the source shelf's filename (SC 9/SC 10).
    }
    return event;
  };

  // SC 10: a rename crossing a shelf boundary the caller sees → a departure/arrival PAIR, each
  // with the OTHER side redacted. This REPLACES the plain rename event for the caller.
  const crossEvents: AuditEvent[] = [];
  for (const rename of commit.renames) {
    const fromShelf = shelfCovering(rename.from, ctx.shelves);
    const toShelf = shelfCovering(rename.to, ctx.shelves);
    if ((fromShelf?.id ?? null) === (toShelf?.id ?? null)) continue; // same shelf — not a crossing
    if (fromShelf) {
      crossEvents.push(
        makeEvent({
          action: "shelf.departure",
          subjectId: null,
          shelves: [fromShelf.id],
          paths: [rename.from],
          renames: [{ from: rename.from, to: null }],
        }),
      );
    }
    if (toShelf) {
      crossEvents.push(
        makeEvent({
          action: "shelf.arrival",
          subjectId: null,
          shelves: [toShelf.id],
          paths: [rename.to],
          renames: [{ from: null, to: rename.to }],
        }),
      );
    }
  }
  if (crossEvents.length > 0) return crossEvents;

  // The base event. SC 9 straddle downgrade: an id-bearing commit that ALSO touches an
  // out-of-scope path hides its object (null subjectId, action → vault.change) so the caller
  // learns "something touching my shelf changed" without learning WHAT, in another shelf.
  let subjectId = subjectIdForSubject(commit.subject, baseAction);
  let action = baseAction;
  const straddles = touchedPaths.some((path) => !covers(path));
  if (subjectId !== null && straddles) {
    subjectId = null;
    action = "vault.change";
  }

  const inScopePaths = commit.files.filter(covers);
  const inScopeRenames: AuditRename[] = commit.renames
    .filter((rename) => covers(rename.from) || covers(rename.to))
    .map((rename) => ({ from: rename.from, to: rename.to }));
  const revertedTo = action === "vault.rollback" ? revertedToOf(commit.subject) : undefined;

  const baseEvent = makeEvent({
    action,
    subjectId,
    shelves: [...inScopeIds],
    paths: inScopePaths,
    renames: inScopeRenames,
    ...(revertedTo !== undefined ? { revertedTo } : {}),
  });
  // Diffs attach ONLY to the base event (review finding). A rename crossing a shelf boundary the
  // caller sees returns above as a departure/arrival pair — so the base event's paths are ALL
  // in-scope, and its diff can never carry a foreign shelf's filename. (An arrival's `git show`
  // diff would, because the rename header names the source path too.)
  attachDiff(baseEvent, inScopePaths);
  return [baseEvent];
}
