// The owned commit-subject vocabulary (spec 064 T1 / SC 7).
//
// ONE typed home for every commit subject the store writes. Two reasons it exists:
//
//   1. The audit export (T6) maps a commit's subject to a closed `AuditAction`
//      union. Deriving that mapping from string literals scattered across six files
//      is how a subject silently drifts out of the union; a single vocabulary makes
//      the mapping total and reviewable.
//   2. SECURITY — message sanitisation (SC 7a). Every caller-influenced value
//      interpolated into a subject (a memory id, a vault path, a rename pair) has
//      CR/LF stripped here. The vault path validator (`assertVaultFilePath`,
//      vault-files.ts) rejects NUL, `..`, backslashes and non-`.md` — but NOT
//      newlines — and the ingest pipeline mints filenames from FETCHED content, so a
//      path like `x\nLibrarian-Actor: root` would otherwise put a forged trailer on
//      its own line in the message body. Stripping CR/LF keeps every subject exactly
//      one line, so the message body can never carry an attribution trailer.
//
// The actor trailer is NEVER concatenated into the message: it is written out of band
// via `git commit --trailer` with its own charset defence (see `actorTrailerValue`,
// caller-identity.ts, and `commitPaths`/`commitAll`, sync-git-ops.ts). This module
// governs the SUBJECT only — belt to that trailer's braces.
//
// For every SUBJECT that carries no interpolation the constructor returns a constant
// string, so the vocabulary is the single source of truth even for the fixed subjects.

/**
 * Strip ALL C0 control bytes (and DEL) from an interpolated value. CR/LF keep every subject to one
 * line, so a forged `Librarian-Actor:` trailer can never be smuggled into the message body. The
 * REST of the C0 range matters for a second reason: the audit reader frames its `git log` output
 * with `\x1e`/`\x1f` and reads the actor trailer off the SAME header line as the subject
 * (`git-history.ts`) — so a caller-influenced path carrying a literal `\x1f` would otherwise shift a
 * path fragment into the trailer field and forge an actor on an untrailered commit (review finding).
 * Built from char codes (not a control-char regex) to stay lint-clean.
 */
function oneLine(value: string): string {
  return Array.from(value, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? "" : ch;
  }).join("");
}

/**
 * Every commit subject the store writes, as a typed constructor (spec 064 SC 7). The
 * output is byte-identical to the literals these replaced — the existing suites (the
 * golden layout test, the activity-feed classifier tests, the sync-git-ops tests) pin
 * that. Interpolated values are CR/LF-stripped; the fixed subjects are constants.
 */
export const commitSubject = {
  // ── memory (markdown-memory-store.ts) ────────────────────────────────────────
  memoryPropose: (id: string): string => `memory: propose ${oneLine(id)}`,
  memoryStore: (id: string): string => `memory: store ${oneLine(id)}`,
  memoryUpdate: (id: string): string => `memory: update ${oneLine(id)}`,
  memoryArchive: (id: string): string => `memory: archive ${oneLine(id)}`,
  memoryUnarchive: (id: string): string => `memory: unarchive ${oneLine(id)}`,
  memoryPurge: (id: string): string => `memory: purge ${oneLine(id)}`,
  memoryFlag: (id: string): string => `memory: flag ${oneLine(id)}`,
  memoryResolveFlags: (id: string): string => `memory: resolve-flags ${oneLine(id)}`,
  memoryReject: (id: string): string => `memory: reject ${oneLine(id)}`,
  memoryApprove: (id: string): string => `memory: approve ${oneLine(id)}`,
  memoryResolve: (id: string, resolution: string): string =>
    `memory: resolve ${oneLine(id)} (${oneLine(resolution)})`,
  memoryBulkUpdate: (id: string): string => `memory: bulk-update ${oneLine(id)}`,
  memoryMove: (id: string, sourceShelfId: string, destinationShelfId: string): string =>
    `memory: move ${oneLine(id)} (${oneLine(sourceShelfId)} -> ${oneLine(destinationShelfId)})`,

  // ── handoff (markdown-handoff-store.ts) ──────────────────────────────────────
  handoffStore: (id: string): string => `handoff: store ${oneLine(id)}`,
  handoffClaim: (id: string): string => `handoff: claim ${oneLine(id)}`,
  handoffPurge: (id: string): string => `handoff: purge ${oneLine(id)}`,

  // ── project briefings (project Markdown stores) ──────────────────────────────
  projectCreate: (id: string): string => `project: create ${oneLine(id)}`,
  projectUpdate: (id: string): string => `project: update ${oneLine(id)}`,
  projectUpdateAppend: (id: string): string => `project-update: append ${oneLine(id)}`,
  projectSuggestionCreate: (id: string): string => `project-suggestion: create ${oneLine(id)}`,
  projectSuggestionUpdate: (id: string): string => `project-suggestion: update ${oneLine(id)}`,

  // ── inbox (librarian-store.ts) ───────────────────────────────────────────────
  inboxSubmit: (id: string): string => `inbox: submit ${oneLine(id)}`,
  inboxConsolidateSweep: (): string => "inbox: consolidate sweep",

  // ── vault-file verbs (vault-files.ts) ────────────────────────────────────────
  vaultEdit: (rel: string): string => `vault: edit ${oneLine(rel)}`,
  vaultCreate: (rel: string): string => `vault: create ${oneLine(rel)}`,
  vaultRename: (from: string, to: string): string =>
    `vault: rename ${oneLine(from)} -> ${oneLine(to)}`,
  vaultDelete: (rel: string): string => `vault: delete ${oneLine(rel)}`,
  /** A single file reverted to a prior version — NOT the whole-vault rollback below. */
  vaultRestoreFile: (rel: string, hash: string): string =>
    `vault: restore ${oneLine(rel)} to ${oneLine(hash).slice(0, 12)}`,

  // ── whole-vault restore (vault-restore.ts) ───────────────────────────────────
  vaultPreRestoreSnapshot: (): string => "vault: pre-restore snapshot",
  /** The whole vault rolled back to a commit — the most destructive op in the product. */
  vaultRestoreTo: (hash: string): string => `vault: restore to ${oneLine(hash)}`,

  // ── primer (librarian-store.ts + migrate-data-dir.ts) ────────────────────────
  primerUpdate: (): string => "primer: update",

  // ── curator files (librarian-store.ts + migrate-data-dir.ts) ─────────────────
  curatorAddendum: (job: string): string => `curator: addendum ${oneLine(job)}`,
  curatorRollback: (job: string): string => `curator: rollback ${oneLine(job)}`,
  curatorIntakeExamplesUpdate: (): string => "curator: intake-examples update",
  curatorIntakeExamplesRollback: (): string => "curator: intake-examples rollback",

  // ── backup (librarian-store.ts) ──────────────────────────────────────────────
  backupSnapshot: (): string => "backup: snapshot",

  // ── migration sweeps (migrate-data-dir.ts) ───────────────────────────────────
  migrateInitial: (): string => "migrate: initial vault commit",
  migrateFrontmatter: (): string => "migrate: strip retired frontmatter fields",
} as const;
