// Data-dir migration (rethink T26, spec §10) — ONE CLI-invoked migration pass
// plus the read-only checks the server boot runs in warn-only mode.
//
// The contract: the command mutates only what the rethink retired (renames the
// intake decision log, strips retired frontmatter fields in one sweep commit,
// removes retired settings keys) and NEVER deletes data — legacy artifacts
// (`librarian.sqlite`, `events.jsonl`, …) are reported as "archivable" with
// sizes, and anything that can't be migrated safely (e.g. a secret-stored
// legacy value with no master key) is left in place with an operator note.
// Idempotent by construction: a second run finds nothing to do and changes
// nothing (no new commits, no settings writes).
//
// `checkDataDirMigration` is the boot-side twin: the same detection, zero
// mutation, one human warning line per finding (http.ts logs them fail-soft).

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { LEGACY_PROMPT_ADDENDUM_KEY, migrateCuratorAddendum } from "./curator-addendum.js";
import { migrateLegacyCuratorLlm } from "./curator-consumers.js";
import { migrateJobEnablement, migrateGroomingSchedule } from "./grooming-config.js";
import { llmConnectionKeys } from "./llm-connection.js";
import {
  LEGACY_AWARENESS_PRIMER_KEY,
  LEGACY_WORKING_STYLE_KEY,
  PRIMER_MAX_BYTES,
  PRIMER_PATH,
  seedPrimer,
} from "./primer.js";
import { commitSubject } from "./store/commit-message.js";
import { type Vault, createVault, resolveVaultPath } from "./store/corpus/index.js";
import { type SyncGitOps, createSyncGitOps } from "./store/git/index.js";
import { resolveDataDir } from "./store/librarian-store.js";
import type { SettingsStore } from "./store/settings-store.js";
import {
  INTAKE_RUNS_FILE,
  LEGACY_INTAKE_RUNS_FILE,
  createJsonSettingsStore,
} from "./store/sidecar/index.js";

// ── What the rethink retired ─────────────────────────────────────────────────

/**
 * Top-level memory frontmatter fields no current schema reads or writes
 * (spec §10 / D7-D8-D13 long tail): `domain` (D7), the classifier/SQLite-era
 * `category`/`visibility`/`scope`/`actor_kind`/`last_recalled_at` columns, the
 * dead `recall_count`/`usefulness_score` fields, and
 * `priority` (the memory priority field was retired — recall ranks by keyword
 * relevance + flag penalty only). Confirmed retired against
 * `MemoryFrontmatterSchema` (memory-doc.ts), which tolerates them on read (Zod
 * strips unknowns) and never writes them.
 *
 * `project_key` is intentionally NOT retired: memory reads accept it as legacy
 * compatibility input and normalise it to plural `project_keys` on the next
 * intentional write. Handoffs continue to use their distinct scalar field.
 */
export const RETIRED_FRONTMATTER_FIELDS = [
  "domain",
  "category",
  "visibility",
  "scope",
  "actor_kind",
  "last_recalled_at",
  "recall_count",
  "usefulness_score",
  "priority",
] as const;

/**
 * Retired `curator_note` sub-keys (rethink T9, D4): the under-evaluation /
 * dry-run lifecycle tags. `CuratorNoteSchema` no longer reserves them.
 */
export const RETIRED_CURATOR_NOTE_FIELDS = [
  "addendum_version",
  "dry_run",
  "dry_run_candidate",
] as const;

/** The sweep commit's subject (spec §10) — pinned so tests and operators can find it. Sourced
 *  from the owned commit vocabulary (spec 064 T1) so the subject has one home. */
export const FRONTMATTER_SWEEP_COMMIT_MESSAGE = commitSubject.migrateFrontmatter();

// The legacy auto-apply confidence keys (pre-D13). Deliberately NOT
// migrated-on-read (spec §15.3 ships 0.8 as a behaviour reset); the removal
// note tells the operator what the old value was and where the new knob lives.
const LEGACY_THRESHOLD_KEYS = [
  "curator.grooming.auto_apply_confidence",
  "curator.auto_apply_confidence",
] as const;

// Retired settings keys that are plain bookkeeping — safe to remove without
// reading their values (nothing left reads them; no data worth migrating):
//  - the classifier subsystem's config surface (deleted pre-rethink + T4),
//  - the under-evaluation addendum lifecycle (rethink T9),
//  - the pre-D13 auto-apply policy level,
//  - the LIBRARIAN_CONSOLIDATOR-era seed sources (read once by
//    migrateJobEnablement / migrateGroomingSchedule, which run first below).
const RETIRED_BOOKKEEPING_KEYS = [
  "classifier.enabled",
  "classifier.provider_mode",
  "classifier.local.model_id",
  "classifier.local.quant",
  "classifier.prompt_version",
  ...Object.values(llmConnectionKeys("classifier.llm")),
  "curator.intake.addendum_status",
  "curator.intake.addendum_eval_version",
  "curator.grooming.addendum_status",
  "curator.grooming.addendum_eval_version",
  "curator.grooming.default_auto_apply",
  "curator.enabled",
  "curator.interval_minutes",
  "curator.schedule.time",
  "curator.schedule.interval_days",
  "curator.schedule.min_sessions_since_run",
] as const;

// Retired keys whose VALUE may still need migrating into its new home (the
// primer file / the grooming addendum file). The seed migrations above retire
// them when readable; an unreadable (secret, master key absent) value is left
// in place with an operator note — never destroyed unread.
const RETIRED_VALUE_CARRYING_KEYS = [
  LEGACY_AWARENESS_PRIMER_KEY,
  LEGACY_WORKING_STYLE_KEY,
  LEGACY_PROMPT_ADDENDUM_KEY,
] as const;

// The pre-named-providers curator LLM connection (`curator.llm.*`).
// migrateLegacyCuratorLlm migrates it when it can; the group handling below
// removes leftovers only when they're provably dead (superseded by a named
// provider, or endpoint-less fragments).
const LEGACY_CURATOR_LLM_KEYS = llmConnectionKeys("curator.llm");

// Legacy artifacts at the data-dir root, reported (never deleted) with sizes.
const LEGACY_ROOT_ARTIFACTS: ReadonlyArray<{ name: string; note: string }> = [
  { name: "librarian.sqlite", note: "the retired SQLite backend's database" },
  { name: "librarian.sqlite-wal", note: "the retired SQLite backend's WAL" },
  { name: "librarian.sqlite-shm", note: "the retired SQLite backend's shared memory file" },
  {
    name: "events.jsonl",
    note: "the retired event ledger (the vault's git history is the audit trail now)",
  },
  { name: "memories.md", note: "the pre-vault root memories file" },
  { name: "conv-state.json", note: "the retired conv_state sidecar" },
  { name: "session_events.jsonl", note: "a retired session-ledger file" },
  { name: "sessions.jsonl", note: "a retired session-ledger file" },
  { name: "sessions.legacy.jsonl", note: "a retired session-ledger file" },
];

// ── Report shapes ────────────────────────────────────────────────────────────

export interface RemovedSettingReport {
  key: string;
  /** Extra context (e.g. the §15.3 legacy-threshold callout). */
  note?: string;
}

export interface LegacyArtifactReport {
  /** Data-dir-relative path. */
  path: string;
  bytes: number;
  note: string;
}

export interface MigrateDataDirReport {
  dataDir: string;
  vaultRoot: string;
  /** Mutations performed by THIS run — empty on an already-migrated dir. */
  changes: string[];
  /** Settings keys removed by THIS run (also summarised in `changes`). */
  removedSettings: RemovedSettingReport[];
  /** Archivable legacy artifacts found — reported, NEVER deleted. */
  artifacts: LegacyArtifactReport[];
  /** Findings that need a human (stuck lock rows, unreadable secrets, oversized primer). */
  operatorNotes: string[];
}

export interface MigrateDataDirOptions {
  /** Explicit data dir; falls back to `LIBRARIAN_DATA_DIR` / `<cwd>/data`. */
  dataDir?: string;
  /** Master key for secret settings; absent → unreadable secrets are reported, not removed. */
  secretKey?: Buffer | null;
  /** Raw `process.env.LIBRARIAN_CONSOLIDATOR`, passed by the bin boundary (core never reads env). */
  legacyIntakeEnv?: string;
}

// ── Shared scans (used by both the migration and the boot checks) ────────────

interface FrontmatterScan {
  /** Vault-relative paths of memory docs carrying retired fields. */
  files: string[];
  /** Vault-relative paths of proposals tagged by the retired dry-run lifecycle. */
  dryRunProposals: string[];
}

// Read-only sweep detection over `memories/`. A doc that fails to parse as
// frontmatter is skipped (the migration must never turn a corrupt doc into a
// rewritten one).
function scanRetiredFrontmatter(vault: Vault): FrontmatterScan {
  const files: string[] = [];
  const dryRunProposals: string[] = [];
  for (const rel of vault.listMarkdown("memories")) {
    let parsed: { data: Record<string, unknown> };
    try {
      parsed = matter(vault.readText(rel));
    } catch {
      continue; // unparseable doc — not this migration's problem
    }
    const data = parsed.data;
    const note = asRecord(data.curator_note);
    const hasRetired =
      RETIRED_FRONTMATTER_FIELDS.some((field) => field in data) ||
      (note !== null && RETIRED_CURATOR_NOTE_FIELDS.some((field) => field in note));
    if (hasRetired) files.push(rel);
    if (
      data.status === "proposed" &&
      note !== null &&
      (note.dry_run === true || note.dry_run_candidate === true)
    ) {
      dryRunProposals.push(rel);
    }
  }
  return { files, dryRunProposals };
}

interface StuckCurationRun {
  id: string;
  status: string;
  created_at: string;
}

// Pre-T9 curation runs carried `visibility: "agent_private"` (+ agent_id); the
// slice kind is gone, so a non-terminal one can never complete — it holds the
// §10.1 slice lock forever. Report-only: the sidecar is the curator's decision
// log and is never rewritten by the migration.
function scanStuckCurationRuns(dataDir: string): StuckCurationRun[] {
  const filePath = path.join(dataDir, "curation-runs.json");
  if (!fs.existsSync(filePath)) return [];
  let runs: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { runs?: unknown };
    const rawRuns = asRecord(parsed.runs);
    if (rawRuns === null) return [];
    runs = rawRuns;
  } catch {
    return []; // corrupt sidecar — the stores already degrade it to empty
  }
  const stuck: StuckCurationRun[] = [];
  for (const value of Object.values(runs)) {
    const run = asRecord(value);
    if (run === null) continue;
    const status = typeof run.status === "string" ? run.status : "";
    const terminal = status === "completed" || status === "failed";
    const agentPrivate =
      run.visibility === "agent_private" ||
      (typeof run.agent_id === "string" && run.agent_id !== "");
    if (agentPrivate && !terminal) {
      stuck.push({
        id: typeof run.id === "string" ? run.id : "(no id)",
        status: status || "(no status)",
        created_at: typeof run.created_at === "string" ? run.created_at : "(unknown)",
      });
    }
  }
  return stuck;
}

function scanLegacyArtifacts(dataDir: string): LegacyArtifactReport[] {
  const artifacts: LegacyArtifactReport[] = [];
  for (const { name, note } of LEGACY_ROOT_ARTIFACTS) {
    const bytes = fileSize(path.join(dataDir, name));
    if (bytes !== null) artifacts.push({ path: name, bytes, note });
  }
  // `.predeprecation.bak` files were created at the data-dir root by a pre-1.0
  // boot rename (retired in rethink T6) — glob the root for any that linger.
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dataDir);
  } catch {
    // missing/unreadable data dir → nothing to report
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".predeprecation.bak")) continue;
    const bytes = fileSize(path.join(dataDir, entry));
    if (bytes !== null) {
      artifacts.push({ path: entry, bytes, note: "renamed by a retired pre-1.0 boot cleanup" });
    }
  }
  return artifacts;
}

/** Settings keys the rethink retired that are still present in settings.json. */
function presentRetiredKeys(settings: SettingsStore): string[] {
  const retired = new Set<string>([
    ...RETIRED_BOOKKEEPING_KEYS,
    ...LEGACY_THRESHOLD_KEYS,
    ...RETIRED_VALUE_CARRYING_KEYS,
    ...Object.values(LEGACY_CURATOR_LLM_KEYS),
  ]);
  return settings
    .listSettings()
    .map((s) => s.key)
    .filter((key) => retired.has(key));
}

// Primer over the hard cap (spec §5.2): the byte-for-byte legacy migration is
// exempt from the cap, so a migrated `awareness.primer` can ride the MCP
// initialize `instructions` over budget until the operator trims it.
function oversizedPrimerBytes(vault: Vault): number | null {
  const content = vault.tryReadText(PRIMER_PATH);
  if (content === null) return null;
  const bytes = Buffer.byteLength(content, "utf8");
  return bytes > PRIMER_MAX_BYTES ? bytes : null;
}

// ── The boot checks (warn-only; zero mutation) ───────────────────────────────

/**
 * The read-only twin of `migrateDataDir` (spec §10): detect every migration
 * finding without touching anything, returning one human warning line per
 * finding. The server boot logs these (fail-soft) so an operator learns a
 * legacy-shaped data dir needs `migrate-data-dir` — boot itself never mutates.
 */
export function checkDataDirMigration(options: { dataDir?: string } = {}): string[] {
  const dataDir = resolveDataDir(options.dataDir);
  const vaultRoot = resolveVaultPath({ dataDir });
  // create:false — a read-only check must not materialize the vault dir.
  const vault = createVault({ dataDir, create: false });
  const findings: string[] = [];
  const cmd = "`migrate-data-dir`";

  if (fs.existsSync(vaultRoot) && !fs.existsSync(path.join(vaultRoot, ".git"))) {
    findings.push(`the vault at ${vaultRoot} is not a git repository — ${cmd} will initialize it`);
  }

  if (
    fs.existsSync(path.join(dataDir, LEGACY_INTAKE_RUNS_FILE)) &&
    !fs.existsSync(path.join(dataDir, INTAKE_RUNS_FILE))
  ) {
    findings.push(
      `legacy ${LEGACY_INTAKE_RUNS_FILE} is still in use — ${cmd} renames it to ${INTAKE_RUNS_FILE}`,
    );
  }

  const sweep = scanRetiredFrontmatter(vault);
  if (sweep.files.length > 0) {
    findings.push(
      `${sweep.files.length} memory document(s) carry retired frontmatter fields ` +
        `(${RETIRED_FRONTMATTER_FIELDS.join("/")} or retired curator_note tags) — ` +
        `${cmd} strips them in one sweep commit`,
    );
  }
  if (sweep.dryRunProposals.length > 0) {
    findings.push(
      `${sweep.dryRunProposals.length} proposal(s) were tagged by the retired dry-run lifecycle — ` +
        `${cmd} lists them; review/reject them via the dashboard`,
    );
  }

  const settings = createJsonSettingsStore({
    filePath: path.join(dataDir, "settings.json"),
    secretKey: null, // listSettings never decrypts; the check reads no secret values
  });
  const retiredKeys = presentRetiredKeys(settings);
  if (retiredKeys.length > 0) {
    findings.push(`retired settings keys present: ${retiredKeys.join(", ")} — ${cmd} removes them`);
  }

  for (const artifact of scanLegacyArtifacts(dataDir)) {
    findings.push(
      `legacy artifact ${artifact.path} (${formatByteSize(artifact.bytes)}) — ${artifact.note}; ` +
        `archivable (${cmd} reports it and never deletes)`,
    );
  }

  const stuck = scanStuckCurationRuns(dataDir);
  if (stuck.length > 0) {
    findings.push(
      `${stuck.length} stuck agent_private curation run(s) in curation-runs.json ` +
        `(${stuck.map((r) => r.id).join(", ")}) — the retired slice kind can never complete them; ` +
        `${cmd} reports the rows`,
    );
  }

  const primerBytes = oversizedPrimerBytes(vault);
  if (primerBytes !== null) {
    findings.push(
      `vault/${PRIMER_PATH} is ${primerBytes} bytes — over the ${PRIMER_MAX_BYTES}-byte cap; ` +
        `it rides every MCP initialize over budget until trimmed (dashboard vault editor)`,
    );
  }

  return findings;
}

// ── The migration ────────────────────────────────────────────────────────────

/**
 * The one data-dir migration pass (rethink T26, spec §10). Mutates only retired
 * state (see module comment), reports everything else, never deletes data, and
 * is idempotent — a second run returns an empty `changes` list and creates no
 * commits. The CLI (`migrate-data-dir`) is the only intended caller.
 */
export function migrateDataDir(options: MigrateDataDirOptions = {}): MigrateDataDirReport {
  const dataDir = resolveDataDir(options.dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  const vault = createVault({ dataDir });
  const git = createSyncGitOps({ cwd: vault.root });

  const changes: string[] = [];
  const removedSettings: RemovedSettingReport[] = [];
  const operatorNotes: string[] = [];

  // 1. Vault git check (spec §10 / §8 D16): the boot path inits too — here we
  // verify + report, and init through the exact same GitOps path when missing.
  const wasRepo = fs.existsSync(path.join(vault.root, ".git"));
  git.init();
  if (!wasRepo) changes.push(`initialized a git repository in the vault (${vault.root})`);
  if (git.head() === null && vault.listFiles().length > 0) {
    // D16 pairs init with an initial commit — a vault full of pre-git docs gets
    // its history baseline now instead of riding along with the next write.
    if (git.commitAll(commitSubject.migrateInitial()) !== null) {
      changes.push('committed pre-existing vault content ("migrate: initial vault commit")');
    }
  }

  // 2. Rename the intake decision log (spec §10). The store reads the legacy
  // name as a one-time fallback (resolveIntakeRunsPath), so this rename is the
  // moment the new name takes over. Never clobbers: if both files exist the
  // new one wins and the legacy file is reported as archivable.
  const legacyRuns = path.join(dataDir, LEGACY_INTAKE_RUNS_FILE);
  const currentRuns = path.join(dataDir, INTAKE_RUNS_FILE);
  if (fs.existsSync(legacyRuns) && !fs.existsSync(currentRuns)) {
    fs.renameSync(legacyRuns, currentRuns);
    changes.push(`renamed ${LEGACY_INTAKE_RUNS_FILE} → ${INTAKE_RUNS_FILE}`);
  }

  // 3. Run the boot-side seed migrations first, so removing their legacy
  // source keys below can never lose a value that still needed migrating.
  const settings = createJsonSettingsStore({
    filePath: path.join(dataDir, "settings.json"),
    secretKey: options.secretKey ?? null,
  });
  // Snapshot the value-carrying legacy keys before the seed migrations run:
  // seedPrimer/migrateCuratorAddendum retire them themselves on success, and
  // the report must still list every removal (spec §10).
  const valueCarryingBefore = RETIRED_VALUE_CARRYING_KEYS.filter((key) =>
    settings.listSettings().some((s) => s.key === key),
  );
  migrateJobEnablement(settings, {
    ...(options.legacyIntakeEnv !== undefined ? { legacyIntakeEnv: options.legacyIntakeEnv } : {}),
  });
  migrateGroomingSchedule(settings);
  try {
    if (migrateLegacyCuratorLlm(settings)) {
      changes.push("migrated the legacy curator.llm.* connection into a named LLM provider");
    }
  } catch {
    // fail-soft — the group handling below reports what's left
  }
  const addendumStore = makeFileBackedStore(vault, git, settings);
  const primerExisted = vault.exists(PRIMER_PATH);
  try {
    seedPrimer(addendumStore);
    if (!primerExisted && vault.exists(PRIMER_PATH)) {
      changes.push(`seeded vault/${PRIMER_PATH} (from the legacy settings primer when present)`);
    }
  } catch {
    // fail-soft — an unreadable legacy primer is handled by the key sweep below
  }
  try {
    migrateCuratorAddendum(addendumStore);
  } catch {
    // fail-soft — same: the value-carrying key handling below reports leftovers
  }

  // 4. Remove retired settings keys (spec §10), reporting each removal.
  const secretByKey = new Map(settings.listSettings().map((s) => [s.key, s.is_secret]));
  for (const key of valueCarryingBefore) {
    if (!secretByKey.has(key)) {
      removedSettings.push({ key, note: "migrated into the vault (primer/addendum) and retired" });
      changes.push(`removed retired setting ${key} (migrated into the vault and retired)`);
    }
  }
  const removeKey = (key: string, note?: string): void => {
    settings.deleteSetting(key);
    removedSettings.push(note === undefined ? { key } : { key, note });
    changes.push(`removed retired setting ${key}${note === undefined ? "" : ` (${note})`}`);
  };
  for (const key of RETIRED_BOOKKEEPING_KEYS) {
    if (secretByKey.has(key)) removeKey(key);
  }
  for (const key of LEGACY_THRESHOLD_KEYS) {
    if (!secretByKey.has(key)) continue;
    // Spec §15.3 callout: 0.8 ships as a deliberate behaviour reset — tell the
    // operator what the old value was and where the new knob lives.
    const value = readSettingSafely(settings, key) ?? "(unreadable)";
    removeKey(
      key,
      `legacy threshold ${value} found — the new default is 0.8 under ` +
        `curator.apply.confidence_threshold; re-set it via the dashboard if you want the old behaviour`,
    );
  }
  for (const key of RETIRED_VALUE_CARRYING_KEYS) {
    if (!secretByKey.has(key)) continue;
    // The seed migrations above retire these when readable; a key that's still
    // here either had nothing left to migrate (its file already exists — safe
    // to remove) or is an unreadable secret (left in place, operator note).
    if (secretByKey.get(key) === true && readSettingSafely(settings, key) === null) {
      operatorNotes.push(
        `setting ${key} is secret and could not be read (master key unavailable) — ` +
          `left in place; re-run with LIBRARIAN_SECRET_KEY set to migrate it, or delete it via the dashboard`,
      );
      continue;
    }
    removeKey(key, "retired legacy source for the primer/addendum vault files");
  }
  // The curator.llm.* group: remove only when provably dead.
  const curatorLlmPresent = Object.values(LEGACY_CURATOR_LLM_KEYS).filter((key) =>
    secretByKey.has(key),
  );
  if (curatorLlmPresent.length > 0) {
    const hasProviders = readSettingSafely(settings, "llm.providers") !== null;
    const hasEndpoint =
      (readSettingSafely(settings, LEGACY_CURATOR_LLM_KEYS.endpoint) ?? "") !== "";
    if (hasProviders) {
      for (const key of curatorLlmPresent) removeKey(key, "superseded by named LLM providers");
    } else if (!hasEndpoint) {
      for (const key of curatorLlmPresent) {
        removeKey(key, "endpoint-less legacy fragment; nothing to migrate");
      }
    } else {
      operatorNotes.push(
        `legacy curator.llm.* keys could not be migrated (the token needs the master key) — ` +
          `left in place; re-run with LIBRARIAN_SECRET_KEY set`,
      );
    }
  }

  // 5. Frontmatter sweep (spec §10): strip retired fields from every memory doc
  // in ONE commit. Dry-run-tagged proposals are reported BEFORE the strip — the
  // report is the durable record of which proposals the retired lifecycle made.
  const sweep = scanRetiredFrontmatter(vault);
  for (const rel of sweep.dryRunProposals) {
    operatorNotes.push(
      `proposal ${rel} was created by the retired dry-run lifecycle — review/reject it via the dashboard`,
    );
  }
  if (sweep.files.length > 0) {
    for (const rel of sweep.files) stripRetiredFields(vault, rel);
    if (git.commitAll(FRONTMATTER_SWEEP_COMMIT_MESSAGE) !== null) {
      changes.push(
        `stripped retired frontmatter fields from ${sweep.files.length} memory document(s) ` +
          `("${FRONTMATTER_SWEEP_COMMIT_MESSAGE}")`,
      );
    }
  }

  // 6. Report-only findings: archivable artifacts, stuck lock rows, oversized primer.
  const artifacts = scanLegacyArtifacts(dataDir);
  if (fs.existsSync(legacyRuns) && fs.existsSync(currentRuns)) {
    artifacts.push({
      path: LEGACY_INTAKE_RUNS_FILE,
      bytes: fileSize(legacyRuns) ?? 0,
      note: `superseded — the store reads ${INTAKE_RUNS_FILE}`,
    });
  }
  for (const run of scanStuckCurationRuns(dataDir)) {
    operatorNotes.push(
      `curation-runs.json holds a stuck agent_private run ${run.id} ` +
        `(status ${run.status}, created ${run.created_at}) — the retired slice kind can never ` +
        `complete it; safe to delete the row by hand if it bothers you`,
    );
  }
  const primerBytes = oversizedPrimerBytes(vault);
  if (primerBytes !== null) {
    operatorNotes.push(
      `vault/${PRIMER_PATH} is ${primerBytes} bytes — over the ${PRIMER_MAX_BYTES}-byte cap ` +
        `(a migrated legacy primer is exempt at write time); trim it via the dashboard so MCP ` +
        `initialize instructions fit the budget`,
    );
  }

  return { dataDir, vaultRoot: vault.root, changes, removedSettings, artifacts, operatorNotes };
}

// ── Internals ────────────────────────────────────────────────────────────────

// Strip the retired fields from one memory doc and rewrite it through the same
// deterministic YAML writer the canonical serializer uses (gray-matter →
// js-yaml). Only the retired keys are touched — every other key keeps its
// position and value, so the rewrite is the minimal diff. The caller commits.
function stripRetiredFields(vault: Vault, rel: string): void {
  const parsed = matter(vault.readText(rel));
  // Clone before mutating: gray-matter caches parses by input string, so
  // editing `parsed.data` in place would poison the cache for any later
  // parse of the same bytes.
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    // js-yaml turns unquoted timestamps into Dates; write them back as ISO
    // strings, matching the canonical writer (memory-doc.ts coerceDates).
    data[key] = value instanceof Date ? value.toISOString() : value;
  }
  for (const field of RETIRED_FRONTMATTER_FIELDS) delete data[field];
  const note = asRecord(data.curator_note);
  if (note !== null) {
    const cleaned = { ...note };
    for (const field of RETIRED_CURATOR_NOTE_FIELDS) delete cleaned[field];
    data.curator_note = cleaned;
  }
  vault.writeText(rel, matter.stringify(parsed.content, data));
}

// The committed-file slice migrateCuratorAddendum/seedPrimer need, built from
// the migration's own vault + git primitives (the full LibrarianStore would
// spin up embedders this command never uses). Commit subjects mirror the
// store's own (`primer: update`, `curator: addendum <job>`).
function makeFileBackedStore(
  vault: Vault,
  git: SyncGitOps,
  settings: SettingsStore,
): SettingsStore & {
  readPrimer: () => string | null;
  writePrimer: (content: string) => void;
  readAddendum: (job: "intake" | "grooming") => { content: string; version: string | null };
  writeAddendum: (
    job: "intake" | "grooming",
    content: string,
  ) => { content: string; version: string | null };
} {
  const addendumRel = (job: "intake" | "grooming"): string => `.curator/${job}-addendum.md`;
  return {
    ...settings,
    readPrimer: () => vault.tryReadText(PRIMER_PATH),
    writePrimer: (content) => {
      vault.writeText(PRIMER_PATH, content);
      git.commitAll(commitSubject.primerUpdate());
    },
    readAddendum: (job) => {
      const rel = addendumRel(job);
      const content = vault.tryReadText(rel) ?? "";
      const version = vault.exists(rel) ? git.lastCommitFor(rel) : null;
      return { content, version };
    },
    writeAddendum: (job, content) => {
      // No 2KB cap here on purpose: the byte-for-byte legacy migration is
      // deliberately exempt (curator-addendum.ts), so an over-cap legacy
      // addendum still gets an operator-visible, git-versioned home.
      const rel = addendumRel(job);
      vault.writeText(rel, content);
      git.commitAll(commitSubject.curatorAddendum(job));
      return { content, version: git.lastCommitFor(rel) };
    },
  };
}

function readSettingSafely(settings: SettingsStore, key: string): string | null {
  try {
    return settings.getSetting(key);
  } catch {
    return null; // secret value without the master key
  }
}

function fileSize(absPath: string): number | null {
  try {
    const stat = fs.statSync(absPath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Human-readable size for report/warning lines (1.2 KB / 3.4 MB). */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
