// resolveEmbedder selection tests (plan 036 Phase 3/7 / spec 035 §F2).
// Selection only — these never load/download a model: the llama embedder is
// lazy, so we assert the SHAPE (asymmetric embedQuery present ⇒ llama; absent ⇒
// hash) without triggering a model load.

import { defaultEmbedThreads, resolveEmbedThreads, resolveEmbedder } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let prev: string | undefined;

beforeEach(() => {
  prev = process.env.LIBRARIAN_EMBEDDER;
});

afterEach(() => {
  if (prev === undefined) delete process.env.LIBRARIAN_EMBEDDER;
  else process.env.LIBRARIAN_EMBEDDER = prev;
});

describe("resolveEmbedder", () => {
  it("defaults to the hash embedder under a test run (VITEST set, no override)", () => {
    delete process.env.LIBRARIAN_EMBEDDER;
    const e = resolveEmbedder({ dataDir: "/tmp/does-not-matter" });
    expect(e.embedQuery).toBeUndefined(); // hash is symmetric — no model, no download
  });

  it("LIBRARIAN_EMBEDDER=hash forces the hash embedder", () => {
    process.env.LIBRARIAN_EMBEDDER = "hash";
    expect(resolveEmbedder({ dataDir: "/tmp/x" }).embedQuery).toBeUndefined();
  });

  it("LIBRARIAN_EMBEDDER=llama selects the asymmetric model embedder (lazily, not loaded)", () => {
    process.env.LIBRARIAN_EMBEDDER = "llama";
    const e = resolveEmbedder({ dataDir: "/tmp/x" });
    // llama exposes embedQuery (asymmetric prompts); the model is NOT loaded here
    expect(typeof e.embedQuery).toBe("function");
  });

  it("throws on an unrecognized LIBRARIAN_EMBEDDER value (catches typos before a surprise download)", () => {
    process.env.LIBRARIAN_EMBEDDER = "Hash"; // wrong case → not a valid value
    expect(() => resolveEmbedder({ dataDir: "/tmp/x" })).toThrow(/LIBRARIAN_EMBEDDER/);
  });
});

describe("embedding thread count", () => {
  it("defaults to half the host's cores, never fewer than 1 or more than node-llama-cpp's 6", () => {
    expect(defaultEmbedThreads(1)).toBe(1);
    expect(defaultEmbedThreads(2)).toBe(1);
    expect(defaultEmbedThreads(6)).toBe(3);
    expect(defaultEmbedThreads(7)).toBe(3);
    expect(defaultEmbedThreads(12)).toBe(6);
    expect(defaultEmbedThreads(64)).toBe(6);
  });

  it("uses the default when LIBRARIAN_EMBED_THREADS is unset or blank", () => {
    expect(resolveEmbedThreads(undefined, 8)).toBe(4);
    expect(resolveEmbedThreads("  ", 8)).toBe(4);
  });

  it("honours an explicit positive whole number, including one above the default ceiling", () => {
    expect(resolveEmbedThreads("2", 8)).toBe(2);
    expect(resolveEmbedThreads(" 16 ", 8)).toBe(16);
  });

  it.each(["0", "-2", "1.5", "four", "4 threads"])(
    "refuses %j with a message that names the variable and the default",
    (raw) => {
      expect(() => resolveEmbedThreads(raw, 8)).toThrow(
        /LIBRARIAN_EMBED_THREADS must be a whole number.*1 or more.*\(here: 4\)/,
      );
    },
  );
});
