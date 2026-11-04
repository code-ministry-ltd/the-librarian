// Repo-structure contract tests.
//
// What this guards:
//
//   1. The post-sessions-rethink slash surface (`/handoff`, `/takeover`,
//      `/toggle-private`; `/learn` was retired in 1.50.0) ships ONLY via the Claude plugin
//      (`integrations/claude/commands/`, installed from the marketplace) —
//      NOT a repo-local `.claude/commands/` copy. A duplicate set makes it
//      ambiguous which surface is firing, so the repo-local copy must stay
//      absent (along with the retired `lib-session-*` / `lib-toggle-private`).
//   2. The `integrations/` directory carries exactly the five in-tree
//      harness surfaces (rethink T14–T16, D14): claude, codex, hermes,
//      opencode, pi. The standalone plugin repos are being archived —
//      this is the inverse of the pre-rethink rule, which pinned
//      `integrations/` absent.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const SLASH_COMMANDS = ["handoff", "takeover", "toggle-private"] as const;
const RETIRED_SESSION_VERBS = [
  "lib-session-start",
  "lib-session-list",
  "lib-session-resume",
  "lib-session-checkpoint",
  "lib-session-pause",
  "lib-session-end",
  "lib-session-search",
  "lib-toggle-private",
] as const;

function assertNonEmptyFile(p: string): void {
  expect(fs.existsSync(p), `expected file: ${path.relative(REPO_ROOT, p)}`).toBe(true);
  const stat = fs.statSync(p);
  expect(stat.isFile(), `expected ${path.relative(REPO_ROOT, p)} to be a file`).toBe(true);
  expect(stat.size, `expected ${path.relative(REPO_ROOT, p)} to be non-empty`).toBeGreaterThan(0);
}

describe("repo structure", () => {
  it("ships the slash surface via the Claude plugin, not a repo-local .claude/commands copy", () => {
    // Canonical home is the Claude Code plugin (installed from the marketplace);
    // the per-verb commands must exist there...
    for (const command of SLASH_COMMANDS) {
      assertNonEmptyFile(
        path.join(REPO_ROOT, "integrations", "claude", "commands", `${command}.md`),
      );
    }
    // ...and must NOT be duplicated in a repo-local `.claude/commands/` copy. A
    // second set obscures whether the plugin is the surface in use (retired
    // session/private verbs stay gone too).
    for (const stem of [...SLASH_COMMANDS, ...RETIRED_SESSION_VERBS]) {
      expect(
        fs.existsSync(path.join(REPO_ROOT, ".claude", "commands", `${stem}.md`)),
        `repo-local .claude/commands/${stem}.md must not exist — the slash commands ship via the Claude plugin (integrations/claude/commands)`,
      ).toBe(false);
    }
  });

  it("integrations/ carries exactly the five in-tree harness surfaces (rethink D14)", () => {
    const integrationsDir = path.join(REPO_ROOT, "integrations");
    expect(
      fs.existsSync(integrationsDir),
      "integrations/ must exist — the five harness surfaces live in-tree (rethink D14)",
    ).toBe(true);
    const harnesses = fs
      .readdirSync(integrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(harnesses).toEqual(["claude", "codex", "hermes", "opencode", "pi"]);
    // Every harness ships its README — the per-harness install contract
    // (spec §13: README is the contract).
    for (const harness of harnesses) {
      assertNonEmptyFile(path.join(integrationsDir, harness, "README.md"));
    }
  });
});
