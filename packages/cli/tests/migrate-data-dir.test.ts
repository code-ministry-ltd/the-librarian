// `the-librarian migrate-data-dir` (rethink T26, spec §10 / §14.9). The deep
// migration mechanics live in core's migrate-data-dir tests; here we pin the
// CLI surface: dispatch + exit codes, the --data-dir flag, the human report's
// sections (changes / archivable / operator), the §15.3 threshold callout, and
// the end-to-end idempotency + report-not-delete contract through the command.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withStore } from "../../../test/helpers.js";
import { runCli } from "../src/runtime.js";

let legacyDir = "";

beforeEach(() => {
  legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-cli-migrate-"));
  buildLegacyFixture(legacyDir);
});
afterEach(() => {
  fs.rmSync(legacyDir, { recursive: true, force: true });
});

// A compact legacy-shaped fixture: one memory with retired frontmatter, the
// legacy runs file, retired settings keys (incl. the pre-D13 threshold), and
// never-delete artifacts.
function buildLegacyFixture(dir: string): void {
  fs.mkdirSync(path.join(dir, "vault", "memories"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "vault", "memories", "old-pref-aaa111.md"),
    [
      "---",
      "id: mem_aaa111",
      "title: Old pref",
      "agent_id: cli",
      "status: active",
      "project_key: null",
      "domain: work",
      "category: tools",
      "priority: normal",
      "confidence: working",
      "tags: []",
      "applies_to: []",
      "supersedes: []",
      "conflicts_with: []",
      "flags: []",
      "recall_count: 0",
      "usefulness_score: 0",
      "is_global: false",
      "requires_approval: false",
      "created_at: '2026-01-01T00:00:00.000Z'",
      "updated_at: '2026-01-01T00:00:00.000Z'",
      "curator_note: null",
      "---",
      "Tabs over spaces.",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "consolidation-runs.json"),
    `${JSON.stringify({ runs: {}, operations: {} }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    `${JSON.stringify(
      {
        "curator.auto_apply_confidence": {
          value: "0.5",
          is_secret: false,
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(dir, "librarian.sqlite"), Buffer.alloc(1024, 1));
  fs.writeFileSync(path.join(dir, "events.jsonl"), '{"type":"legacy"}\n');
}

describe("the-librarian migrate-data-dir", () => {
  it("migrates the --data-dir target and prints the three report sections", async () => {
    await withStore(async (store: LibrarianStore) => {
      const r = await runCli(["migrate-data-dir", "--data-dir", legacyDir], store);
      expect(r.exitCode).toBe(0);

      // Section headers.
      expect(r.stdout).toContain(`Data-dir migration — ${legacyDir}`);
      expect(r.stdout).toContain("Changes made:");
      expect(r.stdout).toContain("Archivable legacy artifacts (left in place — never deleted):");

      // The changes it made.
      expect(r.stdout).toContain("renamed consolidation-runs.json → intake-runs.json");
      expect(r.stdout).toContain("stripped retired frontmatter fields from 1 memory document(s)");
      // §15.3 callout: old value, new default, new knob.
      expect(r.stdout).toContain("legacy threshold 0.5");
      expect(r.stdout).toContain("the new default is 0.8 under curator.apply.confidence_threshold");

      // The archivable list carries sizes and the files survive.
      expect(r.stdout).toMatch(/librarian\.sqlite \(1\.0 KB\)/);
      expect(fs.existsSync(path.join(legacyDir, "librarian.sqlite"))).toBe(true);
      expect(fs.existsSync(path.join(legacyDir, "events.jsonl"))).toBe(true);

      // It really migrated: vault repo + renamed runs file + clean frontmatter.
      expect(fs.existsSync(path.join(legacyDir, "vault", ".git"))).toBe(true);
      expect(fs.existsSync(path.join(legacyDir, "intake-runs.json"))).toBe(true);
      const doc = fs.readFileSync(
        path.join(legacyDir, "vault", "memories", "old-pref-aaa111.md"),
        "utf8",
      );
      expect(doc).not.toContain("domain:");
      expect(doc).not.toContain("category:");
      // The legacy scalar remains untouched until an intentional memory write;
      // readers normalise a string value to plural project_keys in memory.
      expect(doc).toContain("project_key: null");
      expect(doc).not.toContain("recall_count:");
      expect(doc).not.toContain("usefulness_score:");
      expect(doc).not.toContain("priority:");
    });
  });

  it("is idempotent through the CLI: the second run reports nothing to do (§14.9)", async () => {
    await withStore(async (store: LibrarianStore) => {
      expect((await runCli(["migrate-data-dir", "--data-dir", legacyDir], store)).exitCode).toBe(0);
      const second = await runCli(["migrate-data-dir", "--data-dir", legacyDir], store);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("nothing to do — the data dir is already migrated");
      // Report-not-delete holds across runs.
      expect(second.stdout).toContain("librarian.sqlite");
      expect(fs.existsSync(path.join(legacyDir, "librarian.sqlite"))).toBe(true);
    });
  });

  it("defaults to the store's own data dir when --data-dir is omitted", async () => {
    await withStore(async (store: LibrarianStore, dataDir: string) => {
      const r = await runCli(["migrate-data-dir"], store);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`Data-dir migration — ${dataDir}`);
      // A fresh store dir has no legacy state — the only action left is the
      // boot-equivalent primer seed, and there is nothing to archive.
      expect(r.stdout).toContain("(none found)");
      expect(r.stdout).not.toContain("Needs the operator:");
      // The second run is a true no-op.
      const second = await runCli(["migrate-data-dir"], store);
      expect(second.stdout).toContain("nothing to do — the data dir is already migrated");
    });
  });
});
