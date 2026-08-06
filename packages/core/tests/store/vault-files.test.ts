// Vault file store tests (rethink T18/T19, spec §8 / D15) — the dashboard's
// Obsidian-lite surface: tree shape (noise excluded), raw reads with hashes,
// path discipline (traversal/symlink rejection), per-kind save validation
// (never write invalid), compare-and-swap writes (no silent last-write-wins),
// and rename with vault-wide wikilink rewrites — all committing per write.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type Vault,
  type VaultFileStore,
  VaultFileExistsError,
  VaultFileNotFoundError,
  VaultPathError,
  VaultValidationError,
  VaultWriteConflictError,
  createVault,
  createVaultFileStore,
  serializeProjectDocument,
  serializeProjectSuggestionDocument,
  serializeProjectUpdateDocument,
  validateVaultFile,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  projectRecord,
  projectSuggestionRecord,
  projectUpdateRecord,
} from "../fixtures/project-records.js";

let dataDir: string;
let vault: Vault;
let store: VaultFileStore;
let commits: string[];
let writes: string[];

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-vault-files-"));
  vault = createVault({ dataDir });
  commits = [];
  writes = [];
  store = createVaultFileStore({
    vault,
    commit: (_paths, message) => commits.push(message),
    onWrite: (relPath) => writes.push(relPath),
  });
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const VALID_MEMORY = [
  "---",
  'id: "mem_abc12345"',
  'title: "Trash Over rm"',
  'agent_id: "agent-x"',
  'status: "active"',
  'confidence: "medium"',
  "tags: []",
  "applies_to: []",
  "supersedes: []",
  "conflicts_with: []",
  "flags: []",
  "is_global: false",
  "requires_approval: false",
  'created_at: "2026-06-01T00:00:00.000Z"',
  'updated_at: "2026-06-01T00:00:00.000Z"',
  "curator_note: null",
  "---",
  "",
  "Use trash, never rm.",
  "",
].join("\n");

const VALID_HANDOFF = [
  "---",
  'handoff_id: "ho_123"',
  'title: "Carry on the refactor"',
  "project_key: null",
  "source_ref: null",
  "cwd: null",
  "created_by_agent_id: null",
  "created_in_harness: null",
  "tags: []",
  'created_at: "2026-06-01T00:00:00.000Z"',
  "claimed_at: null",
  "claimed_by: null",
  "---",
  "",
  "## Start & intent",
  "Begin.",
  "## Journey",
  "Middle.",
  "## Current state",
  "Now.",
  "## What's left",
  "Rest.",
  "## Open questions",
  "None.",
  "",
].join("\n");

const VALID_PROJECT = serializeProjectDocument(projectRecord());
const VALID_PROJECT_UPDATE = serializeProjectUpdateDocument(projectUpdateRecord());
const VALID_PROJECT_SUGGESTION = serializeProjectSuggestionDocument(projectSuggestionRecord());

describe("vault file tree (T18)", () => {
  it("lists the vault recursively — dirs first, with name/path/type/mtime", () => {
    vault.writeText("primer.md", "Primer text.\n");
    vault.writeText("memories/elaine-1.md", VALID_MEMORY);
    vault.writeText(".curator/intake-addendum.md", "Be terse.\n");
    vault.writeText("references/guide.md", "# Guide\n");

    const tree = store.tree();
    expect(tree.map((node) => `${node.type}:${node.path}`)).toEqual([
      "dir:.curator",
      "dir:memories",
      "dir:references",
      "file:primer.md",
    ]);
    const memories = tree.find((node) => node.path === "memories");
    expect(memories?.children?.map((c) => c.path)).toEqual(["memories/elaine-1.md"]);
    const file = memories?.children?.[0];
    expect(file?.name).toBe("elaine-1.md");
    expect(file?.type).toBe("file");
    expect(file?.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("shows the three canonical project document directories", () => {
    vault.writeText("projects/prj_123.md", VALID_PROJECT);
    vault.writeText("project-updates/pru_123.md", VALID_PROJECT_UPDATE);
    vault.writeText("project-suggestions/prs_123.md", VALID_PROJECT_SUGGESTION);

    expect(store.tree().map((node) => node.path)).toEqual([
      "project-suggestions",
      "project-updates",
      "projects",
    ]);
    expect(store.readFile("projects/prj_123.md").kind).toBe("project");
    expect(store.readFile("project-updates/pru_123.md").kind).toBe("project-update");
    expect(store.readFile("project-suggestions/prs_123.md").kind).toBe("project-suggestion");
  });

  it("excludes vault plumbing: .git, the inbox queue, .index, and stray dotfiles", () => {
    vault.writeText("primer.md", "Primer.\n");
    vault.writeText("inbox/raw-item.md", "queued submission\n");
    fs.mkdirSync(path.join(vault.root, ".git"), { recursive: true });
    fs.writeFileSync(path.join(vault.root, ".git", "config"), "[core]\n");
    fs.mkdirSync(path.join(vault.root, ".index"), { recursive: true });
    fs.writeFileSync(path.join(vault.root, ".gitignore"), ".index\n");

    const paths = store.tree().map((node) => node.path);
    expect(paths).toEqual(["primer.md"]);
  });
});

describe("vault file read (T18)", () => {
  it("returns raw text, lenient frontmatter, body, content hash, and mtime", () => {
    vault.writeText("memories/elaine-1.md", VALID_MEMORY);
    const read = store.readFile("memories/elaine-1.md");
    expect(read.kind).toBe("memory");
    expect(read.raw).toBe(VALID_MEMORY);
    expect(read.body.trim()).toBe("Use trash, never rm.");
    expect(read.frontmatter).toMatchObject({ id: "mem_abc12345", title: "Trash Over rm" });
    expect(read.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(read.mtime).toMatch(/^\d{4}-/);
  });

  it("reads a file the schemas would reject (the explorer must show broken files)", () => {
    vault.writeText("memories/broken.md", "no frontmatter at all\n");
    const read = store.readFile("memories/broken.md");
    expect(read.frontmatter).toBeNull();
    expect(read.body).toContain("no frontmatter at all");
  });

  it("throws a teaching not-found error for an absent path", () => {
    expect(() => store.readFile("memories/missing.md")).toThrow(VaultFileNotFoundError);
  });
});

describe("path discipline (T18.3)", () => {
  it.each([
    "../outside.md",
    "/etc/passwd",
    "memories/../../escape.md",
    "memories/./elaine.md",
    ".git/config",
    "inbox/raw-item.md",
    ".index/cache.md",
    "memories\\elaine.md",
    ".hidden/notes.md",
    "memories/.sneaky.md",
    // Case variants of canonical top-level names: on a case-insensitive
    // filesystem (macOS/Windows) these would alias the canonical entry while
    // skipping its rules (hidden surface, per-kind validation, byte caps).
    "Inbox/raw-item.md",
    "Memories/elaine.md",
    "Projects/prj_123.md",
    "Project-Updates/pru_123.md",
    "Project-Suggestions/prs_123.md",
    "PRIMER.MD",
    "",
  ])("rejects '%s' without touching disk", (badPath) => {
    expect(() => store.readFile(badPath)).toThrow(VaultPathError);
    expect(() => store.writeFile(badPath, "x")).toThrow(VaultPathError);
    expect(commits).toEqual([]);
  });

  it("refuses to read or write through a symlink planted inside the vault", () => {
    const outside = path.join(dataDir, "outside.md");
    fs.writeFileSync(outside, "secret outside the vault\n");
    fs.mkdirSync(path.join(vault.root, "references"), { recursive: true });
    fs.symlinkSync(outside, path.join(vault.root, "references", "sneaky.md"));

    expect(() => store.readFile("references/sneaky.md")).toThrow(VaultPathError);
    expect(() => store.writeFile("references/sneaky.md", "overwrite")).toThrow(VaultPathError);
    expect(fs.readFileSync(outside, "utf8")).toBe("secret outside the vault\n");
  });

  it("refuses a path under a symlinked directory pointing outside the vault", () => {
    const outsideDir = path.join(dataDir, "outside-dir");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(vault.root, "linked"));

    expect(() => store.createFile("linked/file.md", "x")).toThrow(VaultPathError);
    expect(fs.existsSync(path.join(outsideDir, "file.md"))).toBe(false);
  });

  it("mutations only accept .md documents", () => {
    expect(() => store.createFile("references/script.sh", "#!/bin/sh\n")).toThrow(VaultPathError);
  });
});

describe("per-kind validation (T19.1)", () => {
  it("memories must satisfy the memory frontmatter schema", () => {
    expect(validateVaultFile("memories/elaine-1.md", VALID_MEMORY)).toEqual([]);
    const errors = validateVaultFile("memories/elaine-1.md", "---\nid: 'x'\n---\nbody\n");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/frontmatter/i);
  });

  it("handoffs must parse AND carry all five required headings", () => {
    expect(validateVaultFile("handoffs/ho_123.md", VALID_HANDOFF)).toEqual([]);
    const missing = VALID_HANDOFF.replace("## Open questions", "## Closing thoughts");
    const errors = validateVaultFile("handoffs/ho_123.md", missing);
    expect(errors).toEqual([expect.stringContaining("'## Open questions'")]);
  });

  it("project records, updates and suggestions must satisfy their strict codecs", () => {
    expect(validateVaultFile("projects/prj_123.md", VALID_PROJECT)).toEqual([]);
    expect(validateVaultFile("project-updates/pru_123.md", VALID_PROJECT_UPDATE)).toEqual([]);
    expect(validateVaultFile("project-suggestions/prs_123.md", VALID_PROJECT_SUGGESTION)).toEqual(
      [],
    );

    expect(validateVaultFile("projects/prj_123.md", "broken")[0]).toMatch(/project/i);
    expect(validateVaultFile("project-updates/pru_123.md", "broken")[0]).toMatch(/project update/i);
    expect(validateVaultFile("project-suggestions/prs_123.md", "broken")[0]).toMatch(
      /project suggestion/i,
    );
    expect(validateVaultFile("projects/wrong.md", VALID_PROJECT)[0]).toMatch(/filename.*id/i);
    expect(validateVaultFile("projects/nested/prj_123.md", VALID_PROJECT)[0]).toMatch(
      /directly under projects/i,
    );
  });

  it("primer.md and .curator addendums are capped at 2 KB", () => {
    const big = "x".repeat(2049);
    expect(validateVaultFile("primer.md", big)).toEqual([expect.stringMatching(/2048 bytes/)]);
    expect(validateVaultFile(".curator/intake-addendum.md", big)).toEqual([
      expect.stringMatching(/2048 bytes/),
    ]);
    expect(validateVaultFile("primer.md", "x".repeat(2048))).toEqual([]);
  });

  it("references and other plain files are lenient — any text is valid", () => {
    expect(validateVaultFile("references/guide.md", "anything\ngoes\n")).toEqual([]);
    expect(validateVaultFile("notes.md", "---\nodd: [unbalanced\n---\ntext")).toEqual([]);
  });

  it("an invalid save is rejected and never reaches the vault", () => {
    vault.writeText("memories/elaine-1.md", VALID_MEMORY);
    expect(() => store.writeFile("memories/elaine-1.md", "broken doc")).toThrow(
      VaultValidationError,
    );
    expect(vault.readText("memories/elaine-1.md")).toBe(VALID_MEMORY);
    expect(commits).toEqual([]);
  });
});

describe("write / create / delete (T19)", () => {
  it("writeFile validates, writes, commits, and fires onWrite", () => {
    vault.writeText("references/guide.md", "v1\n");
    const result = store.writeFile("references/guide.md", "v2\n");
    expect(vault.readText("references/guide.md")).toBe("v2\n");
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(commits).toEqual(["vault: edit references/guide.md"]);
    expect(writes).toEqual(["references/guide.md"]);
  });

  it("writeFile refuses an absent path (create is the explicit verb)", () => {
    expect(() => store.writeFile("references/new.md", "x")).toThrow(VaultFileNotFoundError);
  });

  it("createFile refuses an existing path", () => {
    vault.writeText("references/guide.md", "v1\n");
    expect(() => store.createFile("references/guide.md", "v2\n")).toThrow(VaultFileExistsError);
    expect(vault.readText("references/guide.md")).toBe("v1\n");
  });

  it("deleteFile removes the document and commits", () => {
    vault.writeText("references/guide.md", "v1\n");
    store.deleteFile("references/guide.md");
    expect(vault.exists("references/guide.md")).toBe(false);
    expect(commits).toEqual(["vault: delete references/guide.md"]);
  });
});

describe("compare-and-swap (T19.3)", () => {
  it("a save against a file that changed since read is refused — no last-write-wins", () => {
    vault.writeText("references/guide.md", "v1\n");
    const stale = store.readFile("references/guide.md").hash;
    store.writeFile("references/guide.md", "v2 — someone else\n");

    expect(() =>
      store.writeFile("references/guide.md", "v2 — me\n", { expectedHash: stale }),
    ).toThrow(VaultWriteConflictError);
    expect(vault.readText("references/guide.md")).toBe("v2 — someone else\n");
  });

  it("a save with the current hash succeeds and returns the new hash", () => {
    vault.writeText("references/guide.md", "v1\n");
    const current = store.readFile("references/guide.md").hash;
    const result = store.writeFile("references/guide.md", "v2\n", { expectedHash: current });
    expect(result.hash).toBe(store.readFile("references/guide.md").hash);
    expect(vault.readText("references/guide.md")).toBe("v2\n");
  });
});

describe("rename with wikilink integrity (T19.1)", () => {
  it("rewrites links targeting the old filename stem across the vault, in one commit", () => {
    vault.writeText("references/old-name.md", "# Doc\n");
    vault.writeText("references/citing.md", "See [[old-name]] and [[old-name|the doc]].\n");
    vault.writeText("references/unrelated.md", "No links.\n");

    const result = store.renameFile("references/old-name.md", "references/new-name.md");
    expect(result).toEqual({
      path: "references/new-name.md",
      changedLinks: ["references/citing.md"],
    });
    expect(vault.exists("references/old-name.md")).toBe(false);
    expect(vault.readText("references/citing.md")).toContain("[[new-name]]");
    expect(vault.readText("references/citing.md")).toContain("[[new-name|the doc]]");
    expect(commits).toEqual(["vault: rename references/old-name.md -> references/new-name.md"]);
  });

  it("refuses to rename onto an existing file", () => {
    vault.writeText("references/a.md", "A\n");
    vault.writeText("references/b.md", "B\n");
    expect(() => store.renameFile("references/a.md", "references/b.md")).toThrow(
      VaultFileExistsError,
    );
  });
});

describe("librarian-store integration", () => {
  it("vaultFiles writes land as git commits and update recall reads", async () => {
    // The real store: vault-file edits must ride the same commit + index
    // invalidation path as every other write.
    const { createLibrarianStore } = await import("@librarian/core");
    const realStore = createLibrarianStore({ dataDir });
    try {
      const created = realStore.createMemory({
        title: "Trash Over rm",
        body: "Use trash, never rm.",
        agent_id: "agent-x",
      });
      const memoriesDir = realStore.vaultFiles.tree().find((node) => node.path === "memories");
      const rel = memoriesDir?.children?.[0]?.path ?? "";
      expect(rel).toMatch(/^memories\/trash-over-rm-/);
      const before = realStore.vaultFiles.readFile(rel);
      const edited = before.raw.replace("Use trash, never rm.", "Use trash-cli, never rm -rf.");
      realStore.vaultFiles.writeFile(rel, edited, { expectedHash: before.hash });

      // The edit is committed…
      const log = execFileSync("git", ["log", "--format=%s"], {
        cwd: path.join(dataDir, "vault"),
        encoding: "utf8",
      });
      expect(log).toContain(`vault: edit ${rel}`);
      // …and visible through the memory store (same id, new body).
      expect(realStore.getMemory(created.memory.id)?.body).toContain("trash-cli");
    } finally {
      realStore.close();
    }
  });
});
