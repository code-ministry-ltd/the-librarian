// Whole-vault restore + activity-feed provenance (rethink T21, spec §8 / D16).
//
// The guarded restore sequence, exactly as D16 orders it (the tRPC layer owns
// the typed-confirmation gate before any of this runs):
//
//   1. refuse while a curation/intake run is in flight, and while another
//      restore holds the (process-wide) restore lock;
//   2. pause the curator — both ticks check `isCuratorPausedForRestore`
//      before anything else, run-now included;
//   3. snapshot any uncommitted out-of-band edits, then `git tag
//      pre-restore-<timestamp>` on the current HEAD (the safety anchor);
//   4. make the working tree match the target commit's tree and commit it as
//      ONE new commit ("vault: restore to <hash>") — never a history rewrite;
//   5. invalidate the disposable index/caches; resume the curator.
//
// Resume is in a `finally`: a failure anywhere mid-sequence still resumes the
// curator, and the thrown error says honestly how far the sequence got (the
// safety tag, once created, is named so the operator can find it).

import {
  isCuratorPausedForRestore,
  pauseCuratorForRestore,
  resumeCuratorAfterRestore,
} from "../curator-pause.js";
import { commitSubject } from "./commit-message.js";
import type { GitHistory } from "./git/git-history.js";
import type { SettingsStore } from "./settings-store.js";

/** A second restore (or one from another admin tab) while one is running. */
export class VaultRestoreInProgressError extends Error {}

/** A curator run is mid-flight — restoring under it would corrupt its writes. */
export class CurationRunInFlightError extends Error {}

/** The target hash names no commit in the vault's history. */
export class VaultRestoreUnknownCommitError extends Error {}

/** A mid-sequence failure, reported with how far the sequence got. */
export class VaultRestoreError extends Error {}

export interface VaultRestoreResult {
  /** The commit the vault tree now matches. */
  restoredTo: string;
  /** The safety tag left on the pre-restore HEAD. */
  preRestoreTag: string;
  /**
   * The ONE new restore commit, or null when the target tree already matched
   * HEAD (nothing to commit — the vault was already in that state).
   */
  commit: string | null;
}

export interface VaultRestoreDeps {
  settings: SettingsStore;
  git: { head(): string | null; commitAll(message: string, actorId?: string): string | null };
  history: GitHistory;
  /** Is any curation/intake run currently `running`? (checked before pausing) */
  hasRunningCurationRun(): boolean;
  /** Drop the disposable recall index + primer cache after the tree changed. */
  invalidate(): void;
}

export interface VaultRestoreOptions {
  now?: Date;
  /**
   * Test seam (rethink T21 e2e): awaited right after the curator is paused,
   * so a test can run a real tick mid-restore and assert it observes the
   * pause. Production never sets it.
   */
  onPausedForTest?: () => void | Promise<void>;
  /**
   * The admin who triggered the restore (spec 064 SC 3). A restore is the most
   * destructive operation in the product, reached from an `adminProcedure` holding the
   * principal — its bytes ARE the admin's own, so the `vault: restore to <hash>` commit is
   * TRAILERED with this actor. The pre-restore snapshot stays untrailered (it captures the
   * PRIOR state — other people's bytes). Omitted → the restore commit is untrailered.
   */
  actorId?: string;
}

// One restore at a time, process-wide — the same process owns the schedulers
// and the tRPC surface, so this is the authoritative lock.
let restoreInFlight = false;

/** The safety tag name: filesystem/ref-safe UTC stamp, e.g. pre-restore-20260612-153000. */
export function preRestoreTagName(now: Date): string {
  return `pre-restore-${now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
}

export async function restoreVaultToCommit(
  deps: VaultRestoreDeps,
  hash: string,
  options: VaultRestoreOptions = {},
): Promise<VaultRestoreResult> {
  const now = options.now ?? new Date();
  if (restoreInFlight || isCuratorPausedForRestore(deps.settings, now)) {
    throw new VaultRestoreInProgressError(
      "a vault restore is already in progress — wait for it to finish before starting another",
    );
  }
  if (deps.hasRunningCurationRun()) {
    throw new CurationRunInFlightError(
      "a curator run is in flight — wait for it to finish (or check the Curator page), then retry the restore",
    );
  }
  if (!deps.history.commitExists(hash)) {
    throw new VaultRestoreUnknownCommitError(
      `no commit '${hash}' exists in the vault's history — pick one from the activity feed`,
    );
  }

  restoreInFlight = true;
  let tagName: string | null = null;
  try {
    // Pause INSIDE the try: should the settings write itself fail, the
    // finally below still releases the lock and clears the in-process flag.
    pauseCuratorForRestore(deps.settings, now);
    await options.onPausedForTest?.();
    // Capture any uncommitted out-of-band edits first, so the safety tag (and
    // a later return to it) covers EVERYTHING that existed before the restore.
    // UNTRAILERED — the pre-restore state is other people's bytes (spec 064 SC 3).
    deps.git.commitAll(commitSubject.vaultPreRestoreSnapshot());
    tagName = preRestoreTagName(now);
    deps.history.tag(tagName);
    // The whole tree back to the target's state, as ONE new commit — TRAILERED with the
    // admin who caused it (spec 064 SC 3), so the most destructive op is never anonymous.
    deps.history.restoreTreeTo(hash);
    const commit = deps.git.commitAll(commitSubject.vaultRestoreTo(hash), options.actorId);
    return { restoredTo: hash, preRestoreTag: tagName, commit };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new VaultRestoreError(
      tagName === null
        ? `vault restore to ${hash} failed before any change was made (the curator was resumed): ${detail}`
        : `vault restore to ${hash} failed mid-sequence after creating safety tag '${tagName}' — ` +
            `the working tree may be partially restored; inspect the vault (the tag marks the ` +
            `pre-restore state) before retrying. The curator was resumed. Cause: ${detail}`,
    );
  } finally {
    // Invalidation rides the finally, not the success path: a mid-sequence
    // failure may have left the tree partially restored, and the disposable
    // index/caches must never keep serving the pre-restore corpus. (On
    // success it rebuilds from markdown by construction.)
    deps.invalidate();
    try {
      resumeCuratorAfterRestore(deps.settings);
    } finally {
      restoreInFlight = false; // the lock outlives nothing, even a failed resume
    }
  }
}

// ── activity-feed provenance (rethink T21) ────────────────────────────────────

/**
 * Who a vault commit came from, derived from the commit-subject conventions
 * (the vault has a single committer identity, so the subject prefix IS the
 * provenance channel):
 *
 *   agent    `inbox: submit …` (remember), `memory: flag …`,
 *            `handoff: store/claim …`
 *   curator  `inbox: consolidate sweep`, `curator: …` (addendum/rollback),
 *            and the memory lifecycle writes `memory: store/propose/update/
 *            archive/unarchive …` — the curator's apply path. CAVEAT: admin
 *            edits from the dashboard MEMORY BROWSER share this write path,
 *            so those land as `curator` too; subjects don't distinguish them.
 *   admin    `vault: …` (explorer/editor + restores), `primer: update`,
 *            `memory: approve/reject/purge/resolve-flags/bulk-update …`,
 *            `handoff: purge …` — admin-only surfaces.
 *   system   `backup: snapshot`, `vault: pre-restore snapshot`, `chronicle: …` (historical:
 *            Chronicle was retired in 1.40.0, its commits remain in existing vaults),
 *            `journal: episode/rollup …` (spec 077). `journal: delete …` is admin.
 *   other    anything else (e.g. hand-made commits from a checkout).
 */
export type VaultCommitSource = "agent" | "curator" | "admin" | "system" | "other";

export function classifyVaultCommit(subject: string): VaultCommitSource {
  // Re-expressed over the owned commit vocabulary (spec 064 SC 7d): the exact-match
  // subjects come from `commitSubject`, so the classifier and the writers share ONE
  // source of truth. Its VaultCommitSource behaviour is DELIBERATELY unchanged — this
  // stays the activity feed's subject-based classifier (only `AuditEvent.channel` is
  // actor-derived, T5/T6), so the existing activity-feed tests remain green. The family
  // matches (prefixes + the two `memory:` verb-set regexes) compactly express the
  // vocabulary's verb families and are left as-is.
  if (
    subject === commitSubject.backupSnapshot() ||
    subject === commitSubject.vaultPreRestoreSnapshot() ||
    subject.startsWith("chronicle: ") ||
    subject.startsWith("journal: episode ") ||
    subject.startsWith("journal: rollup ")
  ) {
    return "system";
  }
  if (subject.startsWith("journal: delete ")) return "admin";
  if (subject === commitSubject.inboxConsolidateSweep()) return "curator";
  if (subject.startsWith("curator: ")) return "curator";
  if (subject.startsWith("inbox: submit ")) return "agent";
  if (subject.startsWith("memory: flag ")) return "agent";
  if (subject.startsWith("handoff: store ") || subject.startsWith("handoff: claim ")) {
    return "agent";
  }
  if (subject.startsWith("handoff: purge ")) return "admin";
  if (/^memory: (approve|reject|purge|resolve-flags|bulk-update) /.test(subject)) return "admin";
  if (/^memory: (store|propose|update|archive|unarchive) /.test(subject)) return "curator";
  if (subject.startsWith("vault: ") || subject === commitSubject.primerUpdate()) return "admin";
  return "other";
}
