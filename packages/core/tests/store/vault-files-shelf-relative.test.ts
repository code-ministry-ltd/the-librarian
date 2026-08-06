// Shelf-relative vault-files discipline (spec 062 SC 2 / T2 step 3). The path-discipline
// (`assertVaultFilePath`) and file-kind detection (`vaultFileKind`) gained an optional shelf
// `prefix`. This suite pins two properties:
//
//   1. Under a non-empty prefix the depth-0-anchored rules apply SHELF-RELATIVE — `<prefix>inbox`
//      hidden exactly as depth-0 `inbox`, `<prefix>.curator` visible, `<prefix>.other-dot`
//      hidden, `<prefix>memories/…` the canonical layout, and `primer.md` pinned to the true
//      root (a singleton, never `<prefix>primer.md`).
//   2. The EMPTY prefix (the OSS default shelf) reduces every rule to EXACTLY today's behaviour
//      — a table of hardcoded depth-0 outcomes the pre-062 function produced (the old-vs-new
//      byte-equality; the golden layout test + every existing vault-files suite are the rest of
//      that proof).

import { VaultPathError, assertVaultFilePath, vaultFileKind } from "@librarian/core";
import { describe, expect, it } from "vitest";

const PREFIX = "members/x/";

/** Run an assert and report only its SHAPE — accepted (with the normalised path) or refused
 * with a VaultPathError — so root and shelf-relative outcomes are directly comparable. */
function attempt(run: () => string): { ok: string } | { refused: true } {
  try {
    return { ok: run() };
  } catch (error) {
    if (error instanceof VaultPathError) return { refused: true };
    throw error;
  }
}

describe("assertVaultFilePath — shelf-relative visibility (spec 062 SC 2)", () => {
  // Each depth-0 path and its `members/x/`-prefixed form must have the SAME accept/refuse
  // outcome; when accepted, the shelf call returns `<prefix> + <the depth-0 normalisation>`.
  const cases: { rel: string; accepts: boolean }[] = [
    { rel: "memories/note.md", accepts: true }, // canonical layout beneath the prefix
    { rel: "handoffs/h.md", accepts: true },
    { rel: "projects/prj_1.md", accepts: true },
    { rel: "project-updates/pru_1.md", accepts: true },
    { rel: "project-suggestions/prs_1.md", accepts: true },
    { rel: "references/web/r.md", accepts: true },
    { rel: ".curator/intake-addendum.md", accepts: true }, // the dot-dir exception, shelf-relative
    { rel: "inbox/item.md", accepts: false }, // inbox hidden at shelf depth 0
    { rel: ".other-dot/x.md", accepts: false }, // an arbitrary dot-dir is plumbing
    { rel: ".git/config", accepts: false },
    { rel: ".index/segments", accepts: false },
    { rel: "memories/inbox/deep.md", accepts: true }, // "inbox" is visible DEEPER than shelf depth 0
  ];

  for (const { rel, accepts } of cases) {
    it(`${accepts ? "accepts" : "refuses"} '${rel}' identically at root and under '${PREFIX}'`, () => {
      const atRoot = attempt(() => assertVaultFilePath(rel));
      const atShelf = attempt(() => assertVaultFilePath(PREFIX + rel, PREFIX));
      if (accepts) {
        expect(atRoot).toEqual({ ok: rel });
        expect(atShelf).toEqual({ ok: PREFIX + rel });
      } else {
        expect(atRoot).toEqual({ refused: true });
        expect(atShelf).toEqual({ refused: true });
      }
    });
  }

  it("refuses a path that escapes the shelf prefix", () => {
    // The vault root layout is NOT reachable from a shelf, and a sibling shelf is disjoint.
    expect(() => assertVaultFilePath("memories/a.md", PREFIX)).toThrow(VaultPathError);
    expect(() => assertVaultFilePath("members/y/memories/a.md", PREFIX)).toThrow(VaultPathError);
    // Dot-segment escapes inside the shelf are still refused.
    expect(() => assertVaultFilePath("members/x/../y/a.md", PREFIX)).toThrow(VaultPathError);
  });

  it("still enforces the prefix-independent safety rules under a shelf", () => {
    expect(() => assertVaultFilePath("members/x/a\\b.md", PREFIX)).toThrow(VaultPathError); // backslash
    expect(() => assertVaultFilePath("/members/x/a.md", PREFIX)).toThrow(VaultPathError); // absolute
    expect(() => assertVaultFilePath("members/x/a\0b.md", PREFIX)).toThrow(VaultPathError); // NUL
  });
});

describe("assertVaultFilePath — empty prefix is byte-for-byte today's behaviour", () => {
  // Hardcoded depth-0 outcomes (what the pre-062 single-arg function returned / threw). The
  // no-arg call and the explicit empty-prefix call must both produce these.
  const rootCases: { rel: string; expected: "refused" | string }[] = [
    { rel: "primer.md", expected: "primer.md" },
    { rel: "memories/a.md", expected: "memories/a.md" },
    { rel: "handoffs/h.md", expected: "handoffs/h.md" },
    { rel: "projects/prj_1.md", expected: "projects/prj_1.md" },
    { rel: "project-updates/pru_1.md", expected: "project-updates/pru_1.md" },
    { rel: "project-suggestions/prs_1.md", expected: "project-suggestions/prs_1.md" },
    { rel: "references/web/r.md", expected: "references/web/r.md" },
    { rel: ".curator/grooming-addendum.md", expected: ".curator/grooming-addendum.md" },
    { rel: "inbox/i.md", expected: "refused" }, // depth-0 inbox hidden
    { rel: ".git/config", expected: "refused" },
    { rel: ".index/x", expected: "refused" },
    { rel: ".secret/x.md", expected: "refused" }, // arbitrary dot-dir hidden
    { rel: "../escape.md", expected: "refused" },
    { rel: "a\\b.md", expected: "refused" },
  ];

  for (const { rel, expected } of rootCases) {
    it(`'${rel}' → ${expected} (no-arg === empty-prefix)`, () => {
      const noArg = attempt(() => assertVaultFilePath(rel));
      const emptyPrefix = attempt(() => assertVaultFilePath(rel, ""));
      const want = expected === "refused" ? { refused: true } : { ok: expected };
      expect(noArg).toEqual(want);
      expect(emptyPrefix).toEqual(want);
    });
  }
});

describe("vaultFileKind — shelf-relative classification (spec 062 SC 2)", () => {
  it("classifies the per-shelf kinds beneath the prefix", () => {
    expect(vaultFileKind("members/x/memories/a.md", PREFIX)).toBe("memory");
    expect(vaultFileKind("members/x/handoffs/h.md", PREFIX)).toBe("handoff");
    expect(vaultFileKind("members/x/projects/prj_1.md", PREFIX)).toBe("project");
    expect(vaultFileKind("members/x/project-updates/pru_1.md", PREFIX)).toBe("project-update");
    expect(vaultFileKind("members/x/project-suggestions/prs_1.md", PREFIX)).toBe(
      "project-suggestion",
    );
    expect(vaultFileKind("members/x/references/web/r.md", PREFIX)).toBe("reference");
    expect(vaultFileKind("members/x/.curator/a.md", PREFIX)).toBe("curator");
    expect(vaultFileKind("members/x/notes/free.md", PREFIX)).toBe("other");
  });

  it("pins primer.md to the true vault root (singleton, never per-shelf)", () => {
    expect(vaultFileKind("primer.md")).toBe("primer");
    expect(vaultFileKind("primer.md", PREFIX)).toBe("primer"); // the exact root path is always the primer
    expect(vaultFileKind("members/x/primer.md", PREFIX)).toBe("other"); // no per-shelf primer
  });

  it("does NOT classify a shelf path when queried at the root (empty prefix)", () => {
    expect(vaultFileKind("members/x/memories/a.md")).toBe("other");
  });

  it("empty prefix is byte-for-byte today's classification", () => {
    for (const rel of [
      "primer.md",
      "memories/a.md",
      "handoffs/h.md",
      "projects/prj_1.md",
      "project-updates/pru_1.md",
      "project-suggestions/prs_1.md",
      "references/r.md",
      ".curator/a.md",
      "random.md",
      "inbox/i.md",
    ]) {
      expect(vaultFileKind(rel, "")).toBe(vaultFileKind(rel));
    }
    expect(vaultFileKind("memories/a.md")).toBe("memory");
    expect(vaultFileKind("handoffs/h.md")).toBe("handoff");
    expect(vaultFileKind("projects/prj_1.md")).toBe("project");
    expect(vaultFileKind("project-updates/pru_1.md")).toBe("project-update");
    expect(vaultFileKind("project-suggestions/prs_1.md")).toBe("project-suggestion");
    expect(vaultFileKind("references/r.md")).toBe("reference");
    expect(vaultFileKind(".curator/a.md")).toBe("curator");
    expect(vaultFileKind("primer.md")).toBe("primer");
    expect(vaultFileKind("inbox/i.md")).toBe("other"); // inbox is not a validated kind
    expect(vaultFileKind("random.md")).toBe("other");
  });
});
