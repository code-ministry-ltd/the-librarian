// Keyword index tests (plan 036 Phase 3 / spec 035 §F2; BM25 upgrade
// 2026-06-19). A deterministic, dependency-free inverted index over the corpus
// (reusing the shared tokenizer). Scoring is BM25 (IDF + TF saturation + length
// normalisation), so a doc matching ALL the query terms beats one that spams a
// single common term — the "gentle coding" failure. Assertions are ranking-based
// (BM25 magnitudes aren't magic numbers worth pinning); the invariants that
// matter are order, exclusion, tie-break, and the empty case.

import { buildKeywordIndex } from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("buildKeywordIndex", () => {
  it("returns only the docs that match the query, with a positive score", () => {
    const index = buildKeywordIndex([
      { id: "pnpm", text: "use pnpm for the monorepo; pnpm pnpm pnpm" },
      { id: "npm", text: "npm is fine too" },
      { id: "cal", text: "calendar tuesdays" },
    ]);
    const hits = index.search("pnpm");
    expect(hits.map((h) => h.id)).toEqual(["pnpm"]);
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it("ranks a doc matching more query terms above one matching fewer", () => {
    const index = buildKeywordIndex([
      { id: "a", text: "deploy deploy command notes" },
      { id: "b", text: "deploy once" },
    ]);
    expect(index.search("deploy command").map((h) => h.id)).toEqual(["a", "b"]);
  });

  it("ranks a doc matching all query terms above one that spams a single common term", () => {
    // 'coding' is common across the corpus (low IDF); 'gentle' is rare (high
    // IDF). The target matches both; the spam doc repeats only the common term.
    // Raw summed-tf would rank the spam doc first (7 > 2+2); BM25 must not.
    const index = buildKeywordIndex([
      { id: "spam", text: "coding coding coding coding coding coding coding" },
      { id: "target", text: "gentle coding is gentle careful coding work" },
      { id: "c1", text: "coding standards matter" },
      { id: "c2", text: "more coding examples here" },
      { id: "c3", text: "coding again today" },
    ]);
    const hits = index.search("gentle coding");
    expect(hits[0]!.id).toBe("target");
  });

  it("rewards a rarer term: a single rare match outranks many common matches", () => {
    const index = buildKeywordIndex([
      { id: "rare", text: "telescope observations" },
      { id: "common1", text: "notes notes notes notes" },
      { id: "common2", text: "more notes" },
      { id: "common3", text: "notes again" },
    ]);
    // 'telescope' appears in one doc (high IDF); 'notes' is everywhere (low IDF).
    const hits = index.search("telescope notes");
    expect(hits[0]!.id).toBe("rare");
  });

  it("normalises by length: with equal term frequency the shorter doc wins", () => {
    const index = buildKeywordIndex([
      { id: "short", text: "alpha alpha" },
      { id: "long", text: "alpha alpha bravo charlie delta echo foxtrot golf hotel" },
    ]);
    expect(index.search("alpha").map((h) => h.id)).toEqual(["short", "long"]);
  });

  it("excludes non-matching docs and respects the limit", () => {
    const index = buildKeywordIndex([
      { id: "a", text: "alpha beta" },
      { id: "b", text: "alpha gamma" },
      { id: "c", text: "delta" },
    ]);
    expect(
      index
        .search("alpha")
        .map((h) => h.id)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(index.search("alpha", 1)).toHaveLength(1);
  });

  it("breaks score ties by id for stable ordering", () => {
    const index = buildKeywordIndex([
      { id: "zeta", text: "shared" },
      { id: "alpha", text: "shared" },
    ]);
    expect(index.search("shared").map((h) => h.id)).toEqual(["alpha", "zeta"]);
  });

  it("returns [] for a query with no indexable terms", () => {
    const index = buildKeywordIndex([{ id: "a", text: "alpha" }]);
    expect(index.search("")).toEqual([]);
    expect(index.search("a the and")).toEqual([]); // too-short + stopwords
  });
});

describe("buildKeywordIndex — sentence-final words", () => {
  it("matches a word that ends a sentence or clause, as recall's keyword half needs", () => {
    const index = buildKeywordIndex([
      { id: "a", text: "We decided to keep the importer." },
      { id: "b", text: "Nothing relevant here at all" },
    ]);
    expect(index.search("importer").map((h) => h.id)).toEqual(["a"]);
  });

  it("still keeps dotted, slashed and hyphenated names whole", () => {
    const index = buildKeywordIndex([
      { id: "a", text: "Renamed config.ts; see docs/release.md and pre-commit." },
      { id: "b", text: "Config files and release notes" },
    ]);
    expect(index.search("config.ts").map((h) => h.id)).toEqual(["a"]);
    expect(index.search("docs/release.md").map((h) => h.id)).toEqual(["a"]);
    expect(index.search("pre-commit").map((h) => h.id)).toEqual(["a"]);
  });
});
