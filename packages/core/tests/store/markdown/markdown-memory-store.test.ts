// Markdown-backed MemoryStore — createMemory + getMemory (plan 036 Phase 2).
//
// The inbox/write path: createMemory writes a markdown file (a human-readable
// `memories/<title-slug>-<shortid>.md`) via the shared normalize + routeMemoryWrite
// logic and the memory-doc mapping, optionally committing; getMemory reads it back
// by frontmatter id (path resolved by scan). Parity-first
// (full Memory shape), sync, with an injected sync committer. These pin the
// write→read round-trip and the status routing on the new backend.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMarkdownMemoryStore, createVault } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-md-store-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function makeStore() {
  const vault = createVault({ dataDir });
  const commits: string[] = [];
  let counter = 0;
  const store = createMarkdownMemoryStore({
    vault,
    commit: (_paths, message) => commits.push(message),
    now: () => "2026-06-01T00:00:00.000Z",
    generateId: () => `mem_test${++counter}`,
  });
  return { store, vault, commits };
}

describe("markdown MemoryStore — createMemory + getMemory", () => {
  it("createMemory writes a markdown file and returns an active memory", () => {
    const { store, vault } = makeStore();
    const result = store.createMemory({
      agent_id: "codex",
      title: "Use pnpm",
      body: "Always use pnpm.",
      tags: ["tooling"],
    });
    expect(result.status).toBe("active");
    expect(result.memory.id).toBe("mem_test1");
    expect(result.duplicates).toEqual([]);
    // Human-readable filename: title slug + short id fragment (id is "mem_test1").
    expect(vault.exists("memories/use-pnpm-test1.md")).toBe(true);
    expect(vault.readText("memories/use-pnpm-test1.md")).toContain("Always use pnpm.");
  });

  it("getMemory round-trips the stored memory exactly", () => {
    const { store } = makeStore();
    const { memory } = store.createMemory({
      agent_id: "codex",
      title: "Use pnpm",
      body: "Always use pnpm.",
      tags: ["tooling"],
    });
    expect(store.getMemory(memory.id)).toEqual(memory);
  });

  it("creates a memory with optional project associations and leaves them absent when omitted", () => {
    const { store } = makeStore();
    const associated = store.createMemory({
      agent_id: "codex",
      title: "Briefing evidence",
      body: "The compiler is live.",
      project_keys: ["the-librarian"],
    }).memory;
    const unassociated = store.createMemory({
      agent_id: "codex",
      title: "General",
      body: "Fact",
    }).memory;

    expect(associated.project_keys).toEqual(["the-librarian"]);
    expect(unassociated).not.toHaveProperty("project_keys");
  });

  it("getMemory returns null for an unknown id", () => {
    const { store } = makeStore();
    expect(store.getMemory("mem_ghost")).toBeNull();
  });

  it("routes a requires_approval write to proposed", () => {
    const { store } = makeStore();
    const result = store.createMemory(
      { agent_id: "codex", title: "Owner identity", body: "Guybrush is the owner." },
      { requires_approval: true },
    );
    expect(result.status).toBe("proposed");
    expect(result.memory.status).toBe("proposed");
    expect(result.memory.requires_approval).toBe(true);
  });

  it("honours an explicit is_global from the trusted options channel", () => {
    const { store } = makeStore();
    const result = store.createMemory(
      { agent_id: "codex", title: "x", body: "y" },
      { is_global: true },
    );
    expect(result.status).toBe("active");
    expect(result.memory.is_global).toBe(true);
    expect(result.memory.requires_approval).toBe(false);
  });

  it("normalizes missing input fields (defaults title/body/agent_id)", () => {
    const { store } = makeStore();
    const { memory } = store.createMemory({});
    expect(memory.title).toBe("Untitled memory");
    expect(memory.confidence).toBe("working");
  });

  it("commits per write with the memory id in the message", () => {
    const { store, commits } = makeStore();
    store.createMemory({ agent_id: "codex", title: "a", body: "b" });
    expect(commits).toHaveLength(1);
    expect(commits[0]).toContain("mem_test1");
  });

  it("works without a commit callback (commit is optional)", () => {
    const vault = createVault({ dataDir });
    const store = createMarkdownMemoryStore({ vault });
    const { memory } = store.createMemory({ agent_id: "codex", title: "a", body: "b" });
    expect(store.getMemory(memory.id)).not.toBeNull();
  });
});

describe("markdown MemoryStore — human-readable filenames", () => {
  const names = (): string[] => fs.readdirSync(path.join(dataDir, "vault", "memories"));

  it("names the file from a title slug + short id, not the raw id", () => {
    const { store, vault } = makeStore();
    const { memory } = store.createMemory({
      agent_id: "a",
      title: "Role & Responsibilities!",
      body: "x",
    }); // id mem_test1 → shortid "test1"
    expect(vault.exists("memories/role-responsibilities-test1.md")).toBe(true);
    expect(store.getMemory(memory.id)?.title).toBe("Role & Responsibilities!"); // resolvable by id
  });

  it("keeps the filename stable when an update changes the title", () => {
    const { store, vault } = makeStore();
    const { memory } = store.createMemory({ agent_id: "a", title: "Family", body: "x" });
    expect(vault.exists("memories/family-test1.md")).toBe(true);

    store.updateMemory(memory.id, { title: "Family and Home" });
    expect(vault.exists("memories/family-test1.md")).toBe(true); // unchanged — no rename
    expect(vault.exists("memories/family-and-home-test1.md")).toBe(false);
    expect(store.getMemory(memory.id)?.title).toBe("Family and Home"); // title is authoritative
  });

  it("gives two same-titled memories distinct filenames via the id suffix", () => {
    const { store } = makeStore();
    store.createMemory({ agent_id: "a", title: "Notes", body: "one" }); // notes-test1
    store.createMemory({ agent_id: "a", title: "Notes", body: "two" }); // notes-test2
    expect(names()).toEqual(expect.arrayContaining(["notes-test1.md", "notes-test2.md"]));
  });

  it("slugifies edge cases: accents, symbol-only fallback, length cap", () => {
    const { store } = makeStore();
    store.createMemory({ agent_id: "a", title: "Café Ñoño", body: "x" }); // test1
    store.createMemory({ agent_id: "a", title: "!!!", body: "x" }); // test2
    store.createMemory({ agent_id: "a", title: "x".repeat(100), body: "x" }); // test3
    const filed = names();
    expect(filed).toContain("cafe-nono-test1.md"); // accents stripped
    expect(filed).toContain("memory-test2.md"); // symbol-only → "memory" fallback
    const long = filed.find((n) => n.endsWith("-test3.md"));
    expect(long?.replace("-test3.md", "").length).toBeLessThanOrEqual(60); // slug capped
  });

  it("backward-compat: resolves + updates a legacy `<id>.md` file in place (no duplicate)", () => {
    const { store, vault } = makeStore();
    const { memory } = store.createMemory({ agent_id: "a", title: "Legacy Note", body: "old" });
    const memDir = path.join(dataDir, "vault", "memories");

    // Relocate the slug file to the OLD `<id>.md` convention — what an upgraded
    // pre-slug vault has on disk.
    const slugFile = names().find((f) => f.endsWith("-test1.md"))!;
    const content = fs.readFileSync(path.join(memDir, slugFile), "utf8");
    fs.unlinkSync(path.join(memDir, slugFile));
    fs.writeFileSync(path.join(memDir, `${memory.id}.md`), content);

    // A FRESH store (cold id-cache) must resolve the legacy file by id and write
    // updates back to that same legacy name — no migration, no duplicate.
    const store2 = createMarkdownMemoryStore({ vault });
    expect(store2.getMemory(memory.id)?.title).toBe("Legacy Note");
    store2.updateMemory(memory.id, { body: "new" });
    expect(fs.existsSync(path.join(memDir, `${memory.id}.md`))).toBe(true);
    expect(names()).toHaveLength(1); // updated in place, no second file
    expect(store2.getMemory(memory.id)?.body).toBe("new");
  });
});
