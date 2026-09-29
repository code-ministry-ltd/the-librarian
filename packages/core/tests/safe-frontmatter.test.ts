// gray-matter ships a JavaScript front-matter engine that `eval`s whatever
// follows a `---js` fence. Every Markdown document the vault parses, and every
// file an operator imports, is untrusted text — so no parse or render path may
// ever reach that engine (review 2026-09-29 item #1).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type Memory,
  buildVaultLinkIndex,
  createVault,
  parseDocument,
  parseHandoffDocument,
  parseInboxItem,
  parseMemoryDocument,
  renderImportedReference,
  serializeMemoryDocument,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const FLAG = "__librarianFrontmatterEval";
const flagged = () => (globalThis as Record<string, unknown>)[FLAG];

// gray-matter caches parses by exact text, so every payload is unique: a cached
// hit would skip the engine and hide a regression.
let nonce = 0;
function payload(fence = "js"): string {
  nonce += 1;
  return `---${fence}\n{ title: (globalThis.${FLAG} = "${fence}", "x${nonce}") }\n---\nbody ${nonce}\n`;
}

function attempt(run: () => unknown): void {
  try {
    run();
  } catch {
    // Refusing the document is fine; executing it is not.
  }
}

let dataDir: string;

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[FLAG];
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-safe-fm-"));
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[FLAG];
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("front matter is never evaluated as code", () => {
  for (const fence of ["js", "javascript", "JS", "coffee", "cson"]) {
    it(`an imported reference with a ---${fence} fence is refused, not run`, () => {
      expect(() =>
        renderImportedReference({
          raw: payload(fence),
          via: "cli",
          capturedAt: "2026-09-29T00:00:00.000Z",
        }),
      ).toThrow(/only YAML front matter/);
      expect(flagged()).toBeUndefined();
    });
  }

  it("parsing a memory, handoff, inbox item or corpus document never runs a ---js fence", () => {
    for (const parse of [
      parseMemoryDocument,
      parseHandoffDocument,
      parseInboxItem,
      parseDocument,
    ]) {
      attempt(() => parse(payload()));
      expect(flagged()).toBeUndefined();
    }
  });

  it("serializing a memory whose body opens with a ---js fence never runs it", () => {
    const memory = {
      id: "mem_1",
      title: "t",
      body: payload(),
      agent_id: "codex",
      confidence: "working",
      tags: [],
      applies_to: [],
      supersedes: [],
      conflicts_with: [],
      flags: [],
      status: "active",
      is_global: false,
      requires_approval: false,
      created_at: "2026-09-29T00:00:00.000Z",
      updated_at: "2026-09-29T00:00:00.000Z",
      curator_note: null,
    } satisfies Memory;
    attempt(() => serializeMemoryDocument(memory));
    expect(flagged()).toBeUndefined();
  });

  it("indexing vault links over a planted ---js file never runs it", () => {
    const vault = createVault({ dataDir });
    vault.writeText("references/planted.md", payload());
    attempt(() => buildVaultLinkIndex(vault));
    expect(flagged()).toBeUndefined();
  });
});
