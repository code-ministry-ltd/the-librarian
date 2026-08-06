// Data-dir migration (rethink T26, spec §10 / §14.9). Pins the contract on a
// legacy-shaped fixture data dir: vault git init, the runs-file rename (+ the
// store's one-time fallback read), the one-commit frontmatter sweep, the
// retired-settings removal (incl. the §15.3 legacy-threshold callout), the
// report-NEVER-delete posture for legacy artifacts, the warn-only boot checks,
// and idempotency — a second run reports nothing to do and changes nothing.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FRONTMATTER_SWEEP_COMMIT_MESSAGE,
  checkDataDirMigration,
  migrateDataDir,
  parseMemoryDocument,
  resolveIntakeRunsPath,
} from "@librarian/core";
import matter from "gray-matter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir = "";
const vaultDir = (): string => path.join(dataDir, "vault");

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-migrate-"));
  buildLegacyFixture(dataDir);
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ── The legacy-shaped fixture (every artifact spec §10 names) ────────────────

const LEGACY_MEMORY = `---
id: mem_legacy1
title: Legacy memory
agent_id: cli
status: active
project_key: legacy-project
domain: work
category: tools
visibility: common
scope: tool
actor_kind: human
last_recalled_at: '2026-01-01T00:00:00.000Z'
priority: high
confidence: strong
tags:
  - legacy
applies_to: []
supersedes: []
conflicts_with: []
flags: []
recall_count: 3
usefulness_score: 1
is_global: false
requires_approval: false
created_at: '2026-01-01T00:00:00.000Z'
updated_at: '2026-01-02T00:00:00.000Z'
curator_note: null
---
The user prefers tabs over spaces.
`;

const DRY_RUN_PROPOSAL = `---
id: mem_dryrun1
title: Dry-run proposal
agent_id: cli
status: proposed
project_key: null
priority: medium
confidence: working
tags: []
applies_to: []
supersedes: []
conflicts_with: []
flags: []
recall_count: 0
usefulness_score: 0
is_global: false
requires_approval: false
created_at: '2026-01-03T00:00:00.000Z'
updated_at: '2026-01-03T00:00:00.000Z'
curator_note:
  text: produced by a dry-run groom
  dry_run: true
  dry_run_candidate: true
  addendum_version: abc123
---
A proposal the retired dry-run lifecycle created.
`;

const CLEAN_MEMORY = `---
id: mem_clean1
title: Clean memory
agent_id: cli
status: active
project_key: null
priority: low
confidence: working
tags: []
applies_to: []
supersedes: []
conflicts_with: []
flags: []
recall_count: 0
usefulness_score: 0
is_global: false
requires_approval: false
created_at: '2026-01-04T00:00:00.000Z'
updated_at: '2026-01-04T00:00:00.000Z'
curator_note: null
---
Already in the current shape.
`;

// A handoff doc carrying its native scalar `project_key` frontmatter field.
const HANDOFF_DOC = `---
id: handoff_live1
title: Live handoff
project_key: the-librarian
created_at: '2026-01-06T00:00:00.000Z'
---
# Start & intent
x
`;

function buildLegacyFixture(dir: string): void {
  const vault = path.join(dir, "vault");
  fs.mkdirSync(path.join(vault, "memories"), { recursive: true });
  fs.mkdirSync(path.join(vault, "handoffs"), { recursive: true });
  fs.writeFileSync(path.join(vault, "memories", "legacy-memory-legacy1.md"), LEGACY_MEMORY);
  fs.writeFileSync(path.join(vault, "memories", "dry-run-proposal-dryrun1.md"), DRY_RUN_PROPOSAL);
  fs.writeFileSync(path.join(vault, "memories", "clean-memory-clean1.md"), CLEAN_MEMORY);
  fs.writeFileSync(path.join(vault, "handoffs", "live-handoff-live1.md"), HANDOFF_DOC);
  // A primer over the 2KB cap (a migrated legacy primer is cap-exempt at write
  // time) — reported, never rewritten.
  fs.writeFileSync(path.join(vault, "primer.md"), `recall first. ${"x".repeat(2100)}\n`);

  // The pre-rethink intake decision log under its legacy name.
  fs.writeFileSync(
    path.join(dir, "consolidation-runs.json"),
    `${JSON.stringify(
      {
        runs: {
          crun_legacy: {
            id: "crun_legacy",
            status: "completed",
            trigger: "tick",
            consolidated: 1,
            judge_errors: 0,
            errored: 0,
            reclaimed: 0,
            summary: null,
            error: null,
            created_at: "2026-01-05T00:00:00.000Z",
            started_at: "2026-01-05T00:00:00.000Z",
            completed_at: "2026-01-05T00:01:00.000Z",
          },
        },
        operations: {},
      },
      null,
      2,
    )}\n`,
  );

  // Curation sidecar with a stuck agent_private lock row (pre-T9 slice kind)
  // and a healthy common row that must not be flagged.
  fs.writeFileSync(
    path.join(dir, "curation-runs.json"),
    `${JSON.stringify(
      {
        runs: {
          run_stuck: {
            id: "run_stuck",
            status: "running",
            trigger: "schedule",
            mode: "apply",
            visibility: "agent_private",
            agent_id: "guybrush",
            project_key: null,
            input_hash: "h1",
            created_at: "2026-01-06T00:00:00.000Z",
          },
          run_done: {
            id: "run_done",
            status: "completed",
            trigger: "schedule",
            mode: "apply",
            visibility: "common",
            agent_id: null,
            project_key: null,
            input_hash: "h2",
            created_at: "2026-01-07T00:00:00.000Z",
          },
        },
        operations: {},
      },
      null,
      2,
    )}\n`,
  );

  // Settings: retired keys (classifier era, pre-D13 apply knobs, addendum
  // lifecycle, LIBRARIAN_CONSOLIDATOR-era seeds, the legacy primer) + one LIVE
  // key that must survive, + a secret-stored legacy value with no master key.
  const entry = (value: string): { value: string; is_secret: boolean; updated_at: string } => ({
    value,
    is_secret: false,
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    `${JSON.stringify(
      {
        "curator.intake.enabled": entry("true"),
        "classifier.enabled": entry("true"),
        "classifier.llm.endpoint": entry("https://example.test/v1"),
        "curator.grooming.default_auto_apply": entry("safe_only"),
        "curator.grooming.auto_apply_confidence": entry("0.5"),
        "curator.auto_apply_confidence": entry("0.6"),
        "curator.intake.addendum_status": entry("under_evaluation"),
        "curator.grooming.addendum_eval_version": entry("deadbeef"),
        "curator.enabled": entry("true"),
        "curator.interval_minutes": entry("90"),
        "curator.schedule.time": entry("04:30"),
        working_style: entry("Be terse."),
        "awareness.primer": {
          // Secret ciphertext with no master key available — must be left in
          // place with an operator note, never destroyed unread.
          value: "aaaaaaaaaaaaaaaaaaaaaaaa",
          is_secret: true,
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      },
      null,
      2,
    )}\n`,
  );

  // Archivable legacy artifacts — reported with sizes, NEVER deleted.
  fs.writeFileSync(path.join(dir, "librarian.sqlite"), Buffer.alloc(2048, 1));
  fs.writeFileSync(path.join(dir, "events.jsonl"), '{"type":"legacy"}\n');
  fs.writeFileSync(path.join(dir, "memories.md"), "# Old root memories\n");
  fs.writeFileSync(path.join(dir, "conv-state.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "sessions.jsonl.predeprecation.bak"), "{}\n");
}

function readSettings(): Record<string, { value: string; is_secret: boolean }> {
  return JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8")) as Record<
    string,
    { value: string; is_secret: boolean }
  >;
}

function vaultCommitCount(): number {
  return Number(
    execFileSync("git", ["rev-list", "--count", "HEAD"], {
      cwd: vaultDir(),
      encoding: "utf8",
    }).trim(),
  );
}

function vaultLog(): string[] {
  return execFileSync("git", ["log", "--format=%s"], { cwd: vaultDir(), encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

describe("migrateDataDir (rethink T26, spec §10)", () => {
  it("initializes the vault as a git repo with an initial commit and reports it", () => {
    expect(fs.existsSync(path.join(vaultDir(), ".git"))).toBe(false);
    const report = migrateDataDir({ dataDir });
    expect(fs.existsSync(path.join(vaultDir(), ".git"))).toBe(true);
    expect(vaultLog()).toContain("migrate: initial vault commit");
    expect(report.changes.some((c) => c.includes("initialized a git repository"))).toBe(true);
  });

  it("renames consolidation-runs.json → intake-runs.json, preserving its content", () => {
    const report = migrateDataDir({ dataDir });
    expect(fs.existsSync(path.join(dataDir, "consolidation-runs.json"))).toBe(false);
    const renamed = path.join(dataDir, "intake-runs.json");
    expect(fs.existsSync(renamed)).toBe(true);
    const data = JSON.parse(fs.readFileSync(renamed, "utf8")) as { runs: Record<string, unknown> };
    expect(Object.keys(data.runs)).toEqual(["crun_legacy"]);
    expect(report.changes).toContain("renamed consolidation-runs.json → intake-runs.json");
  });

  it("resolveIntakeRunsPath reads the legacy file until the rename, the new name after", () => {
    // Pre-migration: only the legacy file exists → one-time fallback read.
    expect(resolveIntakeRunsPath(dataDir)).toBe(path.join(dataDir, "consolidation-runs.json"));
    migrateDataDir({ dataDir });
    expect(resolveIntakeRunsPath(dataDir)).toBe(path.join(dataDir, "intake-runs.json"));
    // Fresh dir: the new name from the start.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-fresh-"));
    try {
      expect(resolveIntakeRunsPath(fresh)).toBe(path.join(fresh, "intake-runs.json"));
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("strips retired frontmatter fields in ONE sweep commit, leaving everything else intact", () => {
    migrateDataDir({ dataDir });

    const swept = fs.readFileSync(
      path.join(vaultDir(), "memories", "legacy-memory-legacy1.md"),
      "utf8",
    );
    for (const field of [
      "domain",
      "category",
      "visibility",
      "scope",
      "actor_kind",
      "last_recalled_at",
      "recall_count",
      "usefulness_score",
      "priority",
    ]) {
      expect(swept).not.toContain(`${field}:`);
    }
    // Still a valid memory document with its non-retired fields + body intact.
    const memory = parseMemoryDocument(swept);
    expect(memory).toMatchObject({
      id: "mem_legacy1",
      status: "active",
      body: "The user prefers tabs over spaces.",
      project_keys: ["legacy-project"],
    });
    expect(matter(swept).data.project_key).toBe("legacy-project");

    // The proposal's retired curator_note tags are stripped; the proposal survives.
    const proposal = matter(
      fs.readFileSync(path.join(vaultDir(), "memories", "dry-run-proposal-dryrun1.md"), "utf8"),
    );
    const note = proposal.data.curator_note as Record<string, unknown>;
    expect(note.dry_run).toBeUndefined();
    expect(note.dry_run_candidate).toBeUndefined();
    expect(note.addendum_version).toBeUndefined();
    expect(note.text).toBe("produced by a dry-run groom");
    expect(proposal.data.status).toBe("proposed");

    // ONE sweep commit, by its pinned subject.
    expect(vaultLog().filter((s) => s === FRONTMATTER_SWEEP_COMMIT_MESSAGE)).toHaveLength(1);
  });

  it("leaves a handoff doc's live project_key untouched (the sweep is memories/ only)", () => {
    migrateDataDir({ dataDir });
    const handoff = matter(
      fs.readFileSync(path.join(vaultDir(), "handoffs", "live-handoff-live1.md"), "utf8"),
    );
    // The scalar remains live compatibility input for memories and handoffs.
    expect(handoff.data.project_key).toBe("the-librarian");
  });

  it("reports dry-run-tagged proposals for operator review", () => {
    const report = migrateDataDir({ dataDir });
    expect(
      report.operatorNotes.some(
        (n) => n.includes("dry-run-proposal-dryrun1.md") && n.includes("dry-run"),
      ),
    ).toBe(true);
  });

  it("removes retired settings keys, keeps live ones, and calls out the legacy threshold (§15.3)", () => {
    const report = migrateDataDir({ dataDir });
    const settings = readSettings();

    for (const gone of [
      "classifier.enabled",
      "classifier.llm.endpoint",
      "curator.grooming.default_auto_apply",
      "curator.grooming.auto_apply_confidence",
      "curator.auto_apply_confidence",
      "curator.intake.addendum_status",
      "curator.grooming.addendum_eval_version",
      "curator.enabled",
      "curator.interval_minutes",
      "curator.schedule.time",
      "working_style",
    ]) {
      expect(settings[gone], gone).toBeUndefined();
      expect(report.removedSettings.some((r) => r.key === gone)).toBe(true);
    }
    // Live keys survive untouched.
    expect(settings["curator.intake.enabled"]?.value).toBe("true");
    // The legacy seeds were migrated before removal (seed-once, no-clobber).
    expect(settings["curator.grooming.enabled"]?.value).toBe("true");
    expect(settings["curator.grooming.schedule_time"]?.value).toBe("04:30");
    expect(settings["curator.grooming.debounce_minutes"]?.value).toBe("90");

    // §15.3 callout: the old value and the new knob, verbatim enough to teach.
    const thresholdNote = report.removedSettings.find(
      (r) => r.key === "curator.grooming.auto_apply_confidence",
    );
    expect(thresholdNote?.note).toContain("legacy threshold 0.5");
    expect(thresholdNote?.note).toContain("0.8");
    expect(thresholdNote?.note).toContain("curator.apply.confidence_threshold");
  });

  it("leaves an unreadable secret legacy value in place with an operator note", () => {
    const report = migrateDataDir({ dataDir }); // no secretKey → ciphertext unreadable
    expect(readSettings()["awareness.primer"]?.is_secret).toBe(true);
    expect(
      report.operatorNotes.some((n) => n.includes("awareness.primer") && n.includes("master key")),
    ).toBe(true);
  });

  it("reports legacy artifacts with sizes and NEVER deletes them", () => {
    const report = migrateDataDir({ dataDir });
    const byPath = new Map(report.artifacts.map((a) => [a.path, a]));
    expect(byPath.get("librarian.sqlite")?.bytes).toBe(2048);
    for (const name of [
      "librarian.sqlite",
      "events.jsonl",
      "memories.md",
      "conv-state.json",
      "sessions.jsonl.predeprecation.bak",
    ]) {
      expect(byPath.has(name), name).toBe(true);
      expect(fs.existsSync(path.join(dataDir, name)), name).toBe(true);
    }
  });

  it("reports the stuck agent_private curation lock row and the oversized primer, touching neither", () => {
    const curationBefore = fs.readFileSync(path.join(dataDir, "curation-runs.json"), "utf8");
    const primerBefore = fs.readFileSync(path.join(vaultDir(), "primer.md"), "utf8");
    const report = migrateDataDir({ dataDir });
    expect(report.operatorNotes.some((n) => n.includes("run_stuck"))).toBe(true);
    expect(report.operatorNotes.some((n) => n.includes("run_done"))).toBe(false);
    expect(report.operatorNotes.some((n) => n.includes("primer.md"))).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, "curation-runs.json"), "utf8")).toBe(curationBefore);
    expect(fs.readFileSync(path.join(vaultDir(), "primer.md"), "utf8")).toBe(primerBefore);
  });

  it("is idempotent: the second run reports nothing to do and changes nothing (§14.9)", () => {
    const first = migrateDataDir({ dataDir });
    expect(first.changes.length).toBeGreaterThan(0);

    const commitsAfterFirst = vaultCommitCount();
    const settingsAfterFirst = fs.readFileSync(path.join(dataDir, "settings.json"), "utf8");
    const memoriesDir = path.join(vaultDir(), "memories");
    const docsAfterFirst = new Map(
      fs
        .readdirSync(memoriesDir)
        .map((f) => [f, fs.readFileSync(path.join(memoriesDir, f), "utf8")]),
    );

    const second = migrateDataDir({ dataDir });
    expect(second.changes).toEqual([]);
    expect(vaultCommitCount()).toBe(commitsAfterFirst); // git log count stable
    expect(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8")).toBe(settingsAfterFirst);
    for (const [file, content] of docsAfterFirst) {
      expect(fs.readFileSync(path.join(memoriesDir, file), "utf8"), file).toBe(content);
    }
    // Report-not-delete: the legacy artifacts are still present AND still reported.
    expect(fs.existsSync(path.join(dataDir, "librarian.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "events.jsonl"))).toBe(true);
    expect(second.artifacts.some((a) => a.path === "librarian.sqlite")).toBe(true);
  });
});

describe("checkDataDirMigration (boot warn-only checks)", () => {
  it("detects every finding on a legacy-shaped dir without mutating anything", () => {
    const findings = checkDataDirMigration({ dataDir });

    expect(findings.some((f) => f.includes("not a git repository"))).toBe(true);
    expect(findings.some((f) => f.includes("consolidation-runs.json"))).toBe(true);
    expect(findings.some((f) => f.includes("retired frontmatter fields"))).toBe(true);
    expect(findings.some((f) => f.includes("retired settings keys"))).toBe(true);
    expect(findings.some((f) => f.includes("librarian.sqlite"))).toBe(true);
    expect(findings.some((f) => f.includes("dry-run"))).toBe(true);
    expect(findings.some((f) => f.includes("agent_private"))).toBe(true);
    expect(findings.some((f) => f.includes("primer.md"))).toBe(true);

    // Checks are read-only: no repo created, nothing renamed, settings untouched.
    expect(fs.existsSync(path.join(vaultDir(), ".git"))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "consolidation-runs.json"))).toBe(true);
    expect(readSettings()["classifier.enabled"]?.value).toBe("true");
  });

  it("goes quiet on actionable findings after migrateDataDir ran", () => {
    migrateDataDir({ dataDir });
    const findings = checkDataDirMigration({ dataDir });
    expect(findings.some((f) => f.includes("not a git repository"))).toBe(false);
    expect(findings.some((f) => f.includes("consolidation-runs.json"))).toBe(false);
    expect(findings.some((f) => f.includes("retired frontmatter fields"))).toBe(false);
    // The unreadable secret legacy primer is deliberately left in place (no
    // master key), so the retired-keys warning narrows to exactly that key.
    const retiredKeysLine = findings.find((f) => f.includes("retired settings keys"));
    expect(retiredKeysLine).toContain("awareness.primer");
    expect(retiredKeysLine).not.toContain("classifier.enabled");
    // Report-only findings remain — the artifacts still exist by design.
    expect(findings.some((f) => f.includes("librarian.sqlite"))).toBe(true);
  });

  it("returns no findings for a fresh, never-legacy data dir", () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-freshcheck-"));
    try {
      expect(checkDataDirMigration({ dataDir: fresh })).toEqual([]);
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});
