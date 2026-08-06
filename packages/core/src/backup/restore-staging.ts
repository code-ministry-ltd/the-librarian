// Restart-staged restore (git-native). The dashboard can't swap the vault under a
// live store (the open git repo + in-memory index), so a restore is two phases:
//
//   stageRestore()        — runs in the live server (tRPC): clone the backup remote
//                           into a staging dir beside the vault, validate it, and
//                           drop a `restore.pending.json` marker. Live data is
//                           untouched.
//   applyPendingRestore() — runs at BOOT, before the store opens: back up the live
//                           vault to `<vault>.pre-restore.bak` (reversible), swap
//                           the clone in, clear the marker. On failure the live
//                           vault is put back and the marker is quarantined.

import fs from "node:fs";
import path from "node:path";
import { resolveVaultPath } from "../store/corpus/index.js";
import { cloneVaultBackup } from "../store/git/index.js";
import type { LibrarianStore } from "../store/librarian-store.js";
import { parseProjectDocument } from "../store/markdown/project-doc.js";
import { MAX_SHELF_PREFIX_SEGMENTS, isLegalShelfSegment } from "../vault-router.js";
import { resolveBackupRemote } from "./config.js";

export const RESTORE_MARKER = "restore.pending.json";
export const RESTORE_FAILED_MARKER = "restore.failed.json";
const PRE_RESTORE_SUFFIX = ".pre-restore.bak";
const STAGING_NAME = ".restore-staging";
/** Default-layout pre-restore backup name (display + the default-path tests). */
export const PRE_RESTORE_BAK = `vault${PRE_RESTORE_SUFFIX}`;

export interface StageRestoreResult {
  /** The "owner/repo" the restore was staged from. */
  staged: string;
  restartRequired: true;
}

export interface ApplyRestoreResult {
  applied: boolean;
  repo?: string;
  error?: string;
}

interface RestoreMarker {
  repo: string;
  staged_at: string;
}

interface RestorePaths {
  liveVault: string;
  stagedVault: string;
  bak: string;
  markerPath: string;
  failedMarkerPath: string;
}

// Resolve the live vault the SAME way the store does (honors LIBRARIAN_VAULT_PATH),
// and keep the staging clone + the pre-restore backup as siblings of it — so the
// swap is always a same-filesystem rename and never silently targets the wrong dir.
// The marker lives in the data dir, where the boot path looks for it.
function restorePaths(dataDir: string): RestorePaths {
  const liveVault = resolveVaultPath({ dataDir });
  const parent = path.dirname(liveVault);
  return {
    liveVault,
    stagedVault: path.join(parent, STAGING_NAME),
    bak: `${liveVault}${PRE_RESTORE_SUFFIX}`,
    markerPath: path.join(dataDir, RESTORE_MARKER),
    failedMarkerPath: path.join(dataDir, RESTORE_FAILED_MARKER),
  };
}

// A restored vault must look like a Librarian vault — a git repo carrying the canonical layout — so a
// wrong/arbitrary repo configured as the backup remote can't silently replace it. (A never-committed
// repo fails the clone before we ever get here.)
//
// Two accepted shapes (review B — tightened from the over-permissive 062 scan, which accepted ANY git
// repo with ONE canonical-named dir up to two levels deep, so a foreign repo that merely contained a
// nested `references/` folder passed):
//
//   ROOT (OSS single-shelf): one legacy canonical entry
//     (`memories`/`inbox`/`references`/`handoffs`) directly at the vault root, preserving the
//     PRE-062 `existsSync` semantics exactly; or a `projects/` directory containing at least one
//     valid, filename-matched Project document.
//
//   NESTED (Teams shelf-prefixed, spec 062 / ADR 0011 Decision 5): the canonical CLUSTER beneath a
//     shelf prefix of up to MAX_SHELF_PREFIX_SEGMENTS segments (`team/`, `members/x/`). A "cluster"
//     is a `memories/` dir, a valid `projects/<id>.md`, at least TWO recognised data dirs, or one
//     recognised data dir plus a `.curator/` or `primer.md` sibling — enough co-located Librarian
//     structure that a foreign repo (e.g. a `src/references/` or `src/projects/` folder) won't trip
//     it. Every
//     intermediate prefix segment must be shelf-legal (reusing {@link isLegalShelfSegment}, so the
//     scan matches the router's prefix rules), and the descent is bounded to the SAME depth the
//     validator caps prefixes at — so a backed-up shelf tree is always restorable, by construction.
//
//     DEVIATION (review B): the review's decided cluster was "≥2 canonical dirs OR 1 + sidecar",
//     WITHOUT the `memories/`-alone arm. But the SC 9 Teams-shape tree the restore MUST accept is a
//     freshly-used shelf that carries only `memories/` — the review's rule rejected exactly the tree
//     it needed to accept. The `memories/`-alone arm is the minimal correction that keeps real shelves
//     restorable while still refusing a lone nested `references/`/`inbox/`/`handoffs/`.
//
// This is a "does this look like a vault AT ALL?" guard, not a full structural validation, so it
// short-circuits on the first hit and never walks the whole tree. `.git` is never a shelf prefix, so
// it is skipped on descent.
const LEGACY_VAULT_DIRS = ["memories", "inbox", "references", "handoffs"];
const PROJECT_AUXILIARY_DIRS = ["project-updates", "project-suggestions"];

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function hasValidProjectDocument(dir: string): boolean {
  const projectsDir = path.join(dir, "projects");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".md")) return false;
    try {
      const project = parseProjectDocument(
        fs.readFileSync(path.join(projectsDir, entry.name), "utf8"),
      );
      return entry.name === `${project.id}.md`;
    } catch {
      return false;
    }
  });
}

// A shelf-prefix directory carries the canonical CLUSTER: a `memories/` dir, a valid Project
// document, ≥2 recognised data dirs, or one recognised data dir plus a `.curator/` or `primer.md`
// sibling. The file-named degenerate case remains a root-only, pre-062 concession.
function hasCanonicalCluster(dir: string): boolean {
  if (isDir(path.join(dir, "memories"))) return true;
  if (hasValidProjectDocument(dir)) return true;
  const canonical = [...LEGACY_VAULT_DIRS, ...PROJECT_AUXILIARY_DIRS].filter((name) =>
    isDir(path.join(dir, name)),
  ).length;
  if (canonical >= 2) return true;
  return (
    canonical >= 1 &&
    (isDir(path.join(dir, ".curator")) || fs.existsSync(path.join(dir, "primer.md")))
  );
}

// True if a shelf-legal subdirectory of `baseDir` (within the remaining depth budget) carries the
// canonical cluster. `depthFromRoot` gates the first-segment canonical-shadow rule.
function hasNestedShelfCluster(baseDir: string, depthFromRoot: number): boolean {
  if (depthFromRoot >= MAX_SHELF_PREFIX_SEGMENTS) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".git") continue; // .git is never a shelf prefix
    if (!isLegalShelfSegment(entry.name, depthFromRoot === 0)) continue; // must be a legal prefix segment
    const childDir = path.join(baseDir, entry.name);
    if (hasCanonicalCluster(childDir)) return true; // <…>/entry/ is a shelf prefix carrying the cluster
    if (hasNestedShelfCluster(childDir, depthFromRoot + 1)) return true; // descend one more segment
  }
  return false;
}

function isLibrarianVault(dir: string): boolean {
  if (!fs.existsSync(path.join(dir, ".git"))) return false;
  // Root arm: PRE-062 semantics exactly — existsSync (file OR dir), any of the four.
  if (LEGACY_VAULT_DIRS.some((name) => fs.existsSync(path.join(dir, name)))) return true;
  if (hasValidProjectDocument(dir)) return true;
  // Nested arm: a shelf-prefixed layout — the canonical cluster beneath a legal shelf prefix.
  return hasNestedShelfCluster(dir, 0);
}

export function stageRestore(store: LibrarianStore): StageRestoreResult {
  const remote = resolveBackupRemote(store);
  if (!remote) {
    throw new Error(
      "restore: no backup remote configured — set the GitHub repo + token in the backup settings",
    );
  }

  const { stagedVault, markerPath } = restorePaths(store.dataDir);
  fs.rmSync(stagedVault, { recursive: true, force: true }); // clear any prior staging

  cloneVaultBackup({
    remoteUrl: remote.auth.remoteUrl,
    branch: remote.auth.branch,
    token: remote.auth.token,
    dest: stagedVault,
  });

  // Refuse to stage a clone that doesn't look like a vault — better to fail here
  // (live data untouched) than swap junk in at boot.
  if (!isLibrarianVault(stagedVault)) {
    fs.rmSync(stagedVault, { recursive: true, force: true });
    throw new Error(
      "restore: the cloned repo does not look like a Librarian vault " +
        "(no memories/inbox/references/handoffs/projects) — check the configured backup repo",
    );
  }

  const marker: RestoreMarker = { repo: remote.repo, staged_at: new Date().toISOString() };
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  return { staged: remote.repo, restartRequired: true };
}

export function applyPendingRestore(dataDir: string): ApplyRestoreResult {
  const { liveVault, stagedVault, bak, markerPath, failedMarkerPath } = restorePaths(dataDir);
  if (!fs.existsSync(markerPath)) return { applied: false };

  // Quarantine the marker so a bad restore neither retries on every boot nor is
  // silently lost. If quarantining itself fails, leave the pending marker.
  const quarantine = (marker: RestoreMarker | null, error: string): ApplyRestoreResult => {
    try {
      fs.writeFileSync(
        failedMarkerPath,
        `${JSON.stringify({ ...(marker ?? {}), error, failed_at: new Date().toISOString() }, null, 2)}\n`,
      );
      fs.rmSync(markerPath, { force: true });
    } catch {
      /* couldn't quarantine — keep the pending marker rather than lose it */
    }
    return { applied: false, ...(marker?.repo ? { repo: marker.repo } : {}), error };
  };

  let marker: RestoreMarker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as RestoreMarker;
  } catch (err) {
    return quarantine(null, `unreadable ${RESTORE_MARKER}: ${(err as Error).message}`);
  }

  try {
    if (!isLibrarianVault(stagedVault)) {
      throw new Error("the staged restore is missing or does not look like a Librarian vault");
    }

    // Back up the live vault (reversible), then swap the clone in. Same-dir renames
    // are atomic; if the swap fails after the backup, put the live vault back so a
    // failed restore never loses data.
    fs.rmSync(bak, { recursive: true, force: true }); // drop any prior pre-restore backup
    const hadLive = fs.existsSync(liveVault);
    if (hadLive) fs.renameSync(liveVault, bak);
    try {
      fs.renameSync(stagedVault, liveVault);
    } catch (swapErr) {
      if (hadLive) fs.renameSync(bak, liveVault); // recover the live vault
      throw swapErr;
    }

    fs.rmSync(stagedVault, { recursive: true, force: true });
    fs.rmSync(markerPath, { force: true });
    return { applied: true, repo: marker.repo };
  } catch (err) {
    // Live vault is untouched (or recovered); its prior content is in `bak`.
    return quarantine(marker, (err as Error).message);
  }
}
