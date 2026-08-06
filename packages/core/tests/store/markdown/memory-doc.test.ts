// Memory <-> markdown-document mapping tests (plan 036 Phase 2, spec 035
// §F1). The markdown backend stores each memory as a markdown file: a
// frontmatter block + the memory body. Phase 2 is parity-first — the
// mapping is lossless for the full current Memory shape (the D16
// frontmatter minimisation happens later, at cutover) — so these pin a
// value-stable and byte-stable round-trip across all field types
// (strings, string arrays, numbers, booleans, null, nested object).

import type { Memory } from "@librarian/core";
import { parseMemoryDocument, serializeMemoryDocument } from "@librarian/core";
import { describe, expect, it } from "vitest";

const NOW = "2026-06-11T00:00:00.000Z";

const memory: Memory = {
  id: "mem_abc",
  agent_id: "codex",
  status: "active",
  tags: ["pnpm", "tooling"],
  applies_to: ["the-librarian"],
  supersedes: [],
  conflicts_with: [],
  flags: [],
  title: "Use pnpm",
  body: "Always use pnpm, never npm. See [[tooling]].",
  confidence: "working",
  created_at: "2026-06-01T09:00:00.000Z",
  updated_at: "2026-06-01T10:00:00.000Z",
  curator_note: null,
  is_global: false,
  requires_approval: false,
};

describe("memory <-> document mapping", () => {
  it("round-trips by value: parse(serialize(memory)) deep-equals memory", () => {
    expect(parseMemoryDocument(serializeMemoryDocument(memory))).toEqual(memory);
  });

  it("round-trips byte-for-byte: serialize(parse(x)) === x", () => {
    const x = serializeMemoryDocument(memory);
    expect(serializeMemoryDocument(parseMemoryDocument(x))).toBe(x);
  });

  it("preserves the body verbatim (wikilinks untouched)", () => {
    const parsed = parseMemoryDocument(serializeMemoryDocument(memory));
    expect(parsed.body).toBe("Always use pnpm, never npm. See [[tooling]].");
  });

  it("preserves field types: booleans, null, and arrays", () => {
    const p = parseMemoryDocument(serializeMemoryDocument(memory));
    expect(typeof p.is_global).toBe("boolean");
    expect(typeof p.created_at).toBe("string");
    expect(p.conflicts_with).toEqual([]);
  });

  it("round-trips a nested curator_note object", () => {
    const m: Memory = {
      ...memory,
      curator_note: { source: "curator", run_id: "run_1", confidence: 0.9 },
    };
    const p = parseMemoryDocument(serializeMemoryDocument(m));
    expect(p.curator_note).toEqual({ source: "curator", run_id: "run_1", confidence: 0.9 });
  });

  it("round-trips plural project_keys and writes them in deterministic frontmatter order", () => {
    const associated: Memory = { ...memory, project_keys: ["the-librarian", "website"] };
    const raw = serializeMemoryDocument(associated);
    expect(raw).toContain(
      "applies_to:\n  - the-librarian\nproject_keys:\n  - the-librarian\n  - website\n",
    );
    expect(parseMemoryDocument(raw)).toEqual(associated);
    expect(serializeMemoryDocument(parseMemoryDocument(raw))).toBe(raw);
  });

  it("keeps an absent project_keys field byte-compatible", () => {
    const raw = serializeMemoryDocument(memory);
    expect(raw).not.toMatch(/^project_keys:/m);
    expect(serializeMemoryDocument(parseMemoryDocument(raw))).toBe(raw);
    expect(parseMemoryDocument(raw)).not.toHaveProperty("project_keys");
  });

  it("normalises a legacy scalar project_key on read and writes only the plural form", () => {
    const legacy = serializeMemoryDocument(memory).replace(
      /^title:/m,
      "project_key: legacy-proj\ntitle:",
    );
    const parsed = parseMemoryDocument(legacy);
    expect(parsed.project_keys).toEqual(["legacy-proj"]);
    const rewritten = serializeMemoryDocument(parsed);
    expect(rewritten).toMatch(/^project_keys:\n {2}- legacy-proj$/m);
    expect(rewritten).not.toMatch(/^project_key:/m);
  });

  it("prefers plural project_keys when a legacy scalar is also present", () => {
    const plural = serializeMemoryDocument({ ...memory, project_keys: ["current-project"] });
    const mixed = plural.replace(/^title:/m, "project_key: legacy-project\ntitle:");
    expect(parseMemoryDocument(mixed).project_keys).toEqual(["current-project"]);
  });

  it("drops retired recall_count / usefulness_score / priority fields on read", () => {
    const raw = serializeMemoryDocument(memory).replace(
      /^title:/m,
      "recall_count: 7\nusefulness_score: 4\npriority: high\ntitle:",
    );
    const p = parseMemoryDocument(raw) as Record<string, unknown>;
    expect(p.recall_count).toBeUndefined();
    expect(p.usefulness_score).toBeUndefined();
    expect(p.priority).toBeUndefined();
  });

  it("round-trips an empty body", () => {
    const p = parseMemoryDocument(serializeMemoryDocument({ ...memory, body: "" }));
    expect(p.body).toBe("");
  });

  it("rejects a document whose frontmatter is missing a required field, naming it", () => {
    const raw = serializeMemoryDocument(memory).replace(/^id:.*\n/m, "");
    expect(() => parseMemoryDocument(raw)).toThrow(/id/);
  });

  it("defaults flags to [] when serialized and round-trips an empty flags list", () => {
    const p = parseMemoryDocument(serializeMemoryDocument(memory));
    expect(p.flags).toEqual([]);
  });

  it("round-trips a populated flags list losslessly", () => {
    const flagged: Memory = {
      ...memory,
      flags: [
        { agent_id: "codex", reason: "superseded by the pnpm policy", created_at: NOW },
        { agent_id: "claude", reason: "no longer accurate", created_at: NOW },
      ],
    };
    const p = parseMemoryDocument(serializeMemoryDocument(flagged));
    expect(p.flags).toEqual(flagged.flags);
  });

  it("parses a legacy document with no flags field as an empty flags list", () => {
    const raw = serializeMemoryDocument(memory).replace(/^flags:.*\n/m, "");
    expect(raw).not.toMatch(/^flags:/m);
    const parsed = parseMemoryDocument(raw);
    expect(parsed.flags).toEqual([]);
  });
});
