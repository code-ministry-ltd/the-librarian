// Whole-vault restore + activity feed tests (rethink T21, spec §8 / D16).
//
// The guarded restore sequence on a real fixture vault: pre-restore tag on
// the old HEAD, the tree reverted to the target commit as ONE new commit
// (files added since are gone, never a history rewrite), the curator paused
// for the duration (asserted by a REAL intake tick polling mid-restore via
// the test seam) and resumed afterwards — including after a mid-sequence
// failure. Plus the concurrency guards and the activity feed's
// subject-derived provenance.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CurationRunInFlightError,
  type GitHistory,
  type LibrarianStore,
  type SettingsStore,
  VaultRestoreError,
  VaultRestoreInProgressError,
  VaultRestoreUnknownCommitError,
  classifyVaultCommit,
  createLibrarianStore,
  isCuratorPausedForRestore,
  restoreVaultToCommit,
  resumeCuratorAfterRestore,
  runIntakeTick,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir: string;
let store: LibrarianStore;

const vaultDir = (): string => path.join(dataDir, "vault");
const gitOut = (...args: string[]): string =>
  execFileSync("git", args, { cwd: vaultDir(), encoding: "utf8" }).trim();

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-vault-restore-"));
  store = createLibrarianStore({ dataDir });
});

afterEach(() => {
  resumeCuratorAfterRestore(store); // belt-and-braces: never leak a pause across tests
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("restoreVaultTo", () => {
  it("runs the full guard sequence: tag → ONE revert commit → resume", async () => {
    store.vaultFiles.createFile("references/keep.md", "kept content v1\n");
    const target = store.vaultActivity()[0]!; // the commit to restore to
    store.vaultFiles.writeFile("references/keep.md", "kept content v2\n");
    store.vaultFiles.createFile("references/added-later.md", "should disappear\n");
    const headBefore = gitOut("rev-parse", "HEAD");
    const logBefore = gitOut("log", "--format=%H").split("\n");

    const result = await store.restoreVaultTo(target.hash);

    // The tree matches the target: edits reverted, later files gone.
    expect(fs.readFileSync(path.join(vaultDir(), "references/keep.md"), "utf8")).toBe(
      "kept content v1\n",
    );
    expect(fs.existsSync(path.join(vaultDir(), "references/added-later.md"))).toBe(false);

    // ONE new commit on top — every prior commit still in the log (no rewrite).
    const logAfter = gitOut("log", "--format=%H").split("\n");
    expect(logAfter).toHaveLength(logBefore.length + 1);
    expect(logAfter.slice(1)).toEqual(logBefore);
    expect(gitOut("log", "-1", "--format=%s")).toBe(`vault: restore to ${target.hash}`);
    expect(result.commit).toBe(logAfter[0]);
    expect(result.restoredTo).toBe(target.hash);

    // The safety tag marks the pre-restore HEAD.
    expect(result.preRestoreTag).toMatch(/^pre-restore-\d{8}-\d{6}$/);
    expect(gitOut("rev-parse", `${result.preRestoreTag}^{commit}`)).toBe(headBefore);

    // The curator is resumed.
    expect(isCuratorPausedForRestore(store)).toBe(false);

    // The restored state is what reads now serve (index invalidated).
    expect(store.vaultFiles.readFile("references/keep.md").raw).toBe("kept content v1\n");
  });

  it("pauses the curator for the duration: a REAL intake tick mid-restore observes it", async () => {
    store.vaultFiles.createFile("references/doc.md", "v1\n");
    const target = store.vaultActivity()[0]!;
    store.vaultFiles.writeFile("references/doc.md", "v2\n");

    let midRestoreTick: unknown;
    await store.restoreVaultTo(target.hash, {
      onPausedForTest: async () => {
        midRestoreTick = await runIntakeTick({ store, allowDisabled: true });
      },
    });
    expect(midRestoreTick).toEqual({ ran: false, reason: "paused" });
    // …and a tick after the restore is no longer paused.
    const after = await runIntakeTick({ store, allowDisabled: true });
    expect((after as { reason: string }).reason).not.toBe("paused");
  });

  it("a mid-sequence failure still resumes the curator and reports the partial state", async () => {
    store.vaultFiles.createFile("references/doc.md", "v1\n");
    const target = store.vaultActivity()[0]!;
    // Force a failure AFTER the pause via the seam (the earliest mid-sequence point).
    await expect(
      store.restoreVaultTo(target.hash, {
        onPausedForTest: () => {
          throw new Error("simulated mid-sequence crash");
        },
      }),
    ).rejects.toThrow(VaultRestoreError);
    await expect(
      store.restoreVaultTo(target.hash, {
        onPausedForTest: () => {
          throw new Error("simulated mid-sequence crash");
        },
      }),
    ).rejects.toThrow(/failed before any change was made .*curator was resumed/);
    expect(isCuratorPausedForRestore(store)).toBe(false);
    // The vault is untouched and a clean retry succeeds.
    const retry = await store.restoreVaultTo(target.hash);
    expect(retry.restoredTo).toBe(target.hash);
  });

  it("rejects an unknown commit before touching anything", async () => {
    store.vaultFiles.createFile("references/doc.md", "v1\n");
    await expect(store.restoreVaultTo("deadbeef".repeat(5))).rejects.toThrow(
      VaultRestoreUnknownCommitError,
    );
    expect(isCuratorPausedForRestore(store)).toBe(false);
  });

  it("rejects while a curation/intake run is in flight", async () => {
    store.vaultFiles.createFile("references/doc.md", "v1\n");
    const target = store.vaultActivity()[0]!;
    const run = store.createIntakeRun({ trigger: "manual" });
    store.startIntakeRun(run.id); // status: running
    await expect(store.restoreVaultTo(target.hash)).rejects.toThrow(CurationRunInFlightError);
    store.completeIntakeRun(run.id);
    await expect(store.restoreVaultTo(target.hash)).resolves.toMatchObject({
      restoredTo: target.hash,
    });
  });

  it("rejects a concurrent restore (simple lock)", async () => {
    store.vaultFiles.createFile("references/doc.md", "v1\n");
    const target = store.vaultActivity()[0]!;
    let second: Promise<unknown> | null = null;
    await store.restoreVaultTo(target.hash, {
      onPausedForTest: () => {
        second = store.restoreVaultTo(target.hash);
      },
    });
    await expect(second!).rejects.toThrow(VaultRestoreInProgressError);
  });
});

// Failure-hygiene units against fake deps: the disposable index and the
// process-wide locks must come out clean from ANY mid-sequence failure.
describe("restoreVaultToCommit failure hygiene (unit)", () => {
  const TARGET = "a".repeat(40);

  function fakeSettings(): SettingsStore {
    const map = new Map<string, string>();
    return {
      setSetting: (key, value) => void map.set(key, value),
      getSetting: (key) => map.get(key) ?? null,
      deleteSetting: (key) => void map.delete(key),
      listSettings: () => [],
    };
  }

  function fakeHistory(overrides: Partial<GitHistory> = {}): GitHistory {
    return {
      fileHistory: () => [],
      fileAtCommit: () => null,
      fileDiff: () => "",
      recentCommits: () => [],
      commitExists: () => true,
      tag: () => {},
      restoreTreeTo: () => {},
      ...overrides,
    };
  }

  it("a failure after the tree may have changed still invalidates the index", async () => {
    let invalidated = 0;
    const settings = fakeSettings();
    const deps = {
      settings,
      git: { head: () => TARGET, commitAll: () => null },
      history: fakeHistory({
        restoreTreeTo: () => {
          throw new Error("git died mid-restore");
        },
      }),
      hasRunningCurationRun: () => false,
      invalidate: () => {
        invalidated += 1;
      },
    };
    await expect(restoreVaultToCommit(deps, TARGET)).rejects.toThrow(VaultRestoreError);
    // The tree may be partially restored — recall must never serve the
    // pre-restore corpus from a stale cached index.
    expect(invalidated).toBeGreaterThan(0);
    expect(isCuratorPausedForRestore(settings)).toBe(false); // resumed
  });

  it("a pause-write failure neither wedges the restore lock nor strands the pause", async () => {
    const map = new Map<string, string>();
    let settingsBroken = true;
    const settings: SettingsStore = {
      setSetting: (key, value) => {
        if (settingsBroken) throw new Error("settings sidecar: disk full");
        map.set(key, value);
      },
      getSetting: (key) => map.get(key) ?? null,
      deleteSetting: (key) => void map.delete(key),
      listSettings: () => [],
    };
    const deps = {
      settings,
      git: { head: () => TARGET, commitAll: () => TARGET },
      history: fakeHistory(),
      hasRunningCurationRun: () => false,
      invalidate: () => {},
    };
    await expect(restoreVaultToCommit(deps, TARGET)).rejects.toThrow(
      /failed before any change was made/,
    );
    expect(isCuratorPausedForRestore(settings)).toBe(false);
    // The process-wide lock was released: a retry once settings heal succeeds.
    settingsBroken = false;
    await expect(restoreVaultToCommit(deps, TARGET)).resolves.toMatchObject({
      restoredTo: TARGET,
    });
  });
});

describe("vaultActivity", () => {
  it("lists recent commits newest-first with files touched and provenance source", () => {
    store.vaultFiles.createFile("references/doc.md", "# Doc\n");
    store.submitToInbox("an agent remembered something");
    store.writePrimer("Recall before answering.");

    const feed = store.vaultActivity();
    expect(feed.length).toBeGreaterThanOrEqual(3);
    expect(feed[0]).toMatchObject({ subject: "primer: update", source: "admin" });
    expect(feed[1]?.subject).toMatch(/^inbox: submit /);
    expect(feed[1]?.source).toBe("agent");
    const create = feed.find((c) => c.subject === "vault: create references/doc.md")!;
    expect(create.source).toBe("admin");
    expect(create.files).toEqual(["references/doc.md"]);
    expect(create.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(create.date).toMatch(/^\d{4}-/);
  });

  it("pages with `before` (strictly older, no overlap)", () => {
    for (let i = 0; i < 5; i++) {
      store.vaultFiles.createFile(`references/doc-${i}.md`, `# Doc ${i}\n`);
    }
    const page1 = store.vaultActivity({ limit: 2 });
    expect(page1).toHaveLength(2);
    const page2 = store.vaultActivity({ limit: 2, before: page1[1]!.hash });
    expect(page2).toHaveLength(2);
    const seen = [...page1, ...page2].map((c) => c.hash);
    expect(new Set(seen).size).toBe(4); // no duplicates across pages
  });
});

describe("classifyVaultCommit (the provenance conventions)", () => {
  it("maps each commit-subject convention to its source", () => {
    const cases: [string, string][] = [
      ["inbox: submit ib_123", "agent"],
      ["memory: flag mem_1", "agent"],
      ["handoff: store ho_1", "agent"],
      ["handoff: claim ho_1", "agent"],
      ["inbox: consolidate sweep", "curator"],
      ["curator: addendum grooming", "curator"],
      ["curator: rollback intake", "curator"],
      ["memory: store mem_1", "curator"],
      ["memory: propose mem_1", "curator"],
      ["memory: update mem_1", "curator"],
      ["memory: archive mem_1", "curator"],
      ["memory: approve mem_1", "admin"],
      ["memory: reject mem_1", "admin"],
      ["memory: purge mem_1", "admin"],
      ["handoff: purge ho_1", "admin"],
      ["vault: edit references/doc.md", "admin"],
      ["vault: restore to abc123", "admin"],
      ["primer: update", "admin"],
      ["backup: snapshot", "system"],
      ["vault: pre-restore snapshot", "system"],
      ["chronicle: 2026-W31", "system"],
      ["journal: episode 2026-11-02", "system"],
      ["journal: rollup 2026-W44", "system"],
      ["journal: delete days/2026-11-02.md", "admin"],
      ["some hand-made commit", "other"],
    ];
    for (const [subject, source] of cases) {
      expect(classifyVaultCommit(subject), subject).toBe(source);
    }
  });
});
