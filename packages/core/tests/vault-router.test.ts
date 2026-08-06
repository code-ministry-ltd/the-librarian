// Vault-set routing seam — unit coverage (spec 062 T1, SC 2).
//
// Pins: the prefix rules validateShelfSet enforces (each violation throws at the validation
// point naming the offending shelf); the inert OSS default router's shape; and the boundary
// that a NON-writable shelf is a legal set member while `writeTarget`-writability is runtime
// write-semantics (spec 062 T3) — deliberately NOT validated here.

import type { Principal, Shelf } from "@librarian/core";
import { DEFAULT_SHELF, SHELF_OPS, defaultVaultRouter, validateShelfSet } from "@librarian/core";
import { describe, expect, it } from "vitest";

// A minimal principal. The default router ignores it, and validateShelfSet never sees it.
const PRINCIPAL: Principal = { kind: "agent", actorId: "sarah", roles: ["agent"] };

// A concise shelf builder; writable defaults to true (the common case).
function shelf(id: string, prefix: string, writable = true): Shelf {
  return { id, prefix, writable };
}

describe("defaultVaultRouter — the inert OSS single-shelf router (spec 062 SC 2/T1)", () => {
  it("maps every principal and every op to the one writable root shelf", () => {
    for (const op of SHELF_OPS) {
      expect(defaultVaultRouter.shelves(PRINCIPAL, op)).toEqual([
        { id: "main", prefix: "", writable: true },
      ]);
    }
    // A different principal gets the SAME set (principal-independent — the property the
    // factory's boot self-check relies on).
    const other: Principal = { kind: "system", actorId: "system-scheduler", roles: ["system"] };
    expect(defaultVaultRouter.shelves(other, "recall")).toEqual([DEFAULT_SHELF]);
  });

  it("writeTarget returns the one writable root shelf", () => {
    expect(defaultVaultRouter.writeTarget(PRINCIPAL)).toEqual({
      id: "main",
      prefix: "",
      writable: true,
    });
  });

  it("its static shelf set passes validateShelfSet (the factory's boot self-check)", () => {
    for (const op of SHELF_OPS) {
      expect(() => validateShelfSet(defaultVaultRouter.shelves(PRINCIPAL, op))).not.toThrow();
    }
    expect(() => validateShelfSet([defaultVaultRouter.writeTarget(PRINCIPAL)])).not.toThrow();
  });
});

describe("validateShelfSet — well-formed sets pass (spec 062 SC 2)", () => {
  it("accepts the empty-prefix root shelf (the OSS default)", () => {
    expect(() => validateShelfSet([shelf("main", "")])).not.toThrow();
  });

  it("accepts two disjoint prefixed shelves (the Teams shape)", () => {
    expect(() =>
      validateShelfSet([shelf("personal", "members/sarah/"), shelf("team", "team/", false)]),
    ).not.toThrow();
  });

  it("accepts an empty set (nothing to validate)", () => {
    expect(() => validateShelfSet([])).not.toThrow();
  });

  it("accepts a NON-writable shelf member — writeTarget-writability is T3, not a set rule", () => {
    expect(() => validateShelfSet([shelf("team", "team/", false)])).not.toThrow();
    // The uniqueness rule is writable-ONLY, so two NON-writable shelves may share an id.
    expect(() =>
      validateShelfSet([shelf("dup", "a/", false), shelf("dup", "b/", false)]),
    ).not.toThrow();
  });
});

describe("validateShelfSet — per-shelf prefix violations throw naming the shelf (spec 062 SC 2)", () => {
  it("rejects a missing trailing slash", () => {
    expect(() => validateShelfSet([shelf("x", "team")])).toThrow(/shelf "x".*trailing slash/);
  });

  it("rejects a leading slash (absolute-ish)", () => {
    expect(() => validateShelfSet([shelf("x", "/team/")])).toThrow(/shelf "x".*relative/);
  });

  it("rejects a drive-letter absolute path", () => {
    expect(() => validateShelfSet([shelf("x", "C:/team/")])).toThrow(/shelf "x".*relative/);
  });

  it("rejects a backslash prefix (forward slashes only)", () => {
    expect(() => validateShelfSet([shelf("x", "team\\sub\\")])).toThrow(/shelf "x".*forward slash/);
  });

  it("rejects a '..' segment", () => {
    expect(() => validateShelfSet([shelf("x", "../team/")])).toThrow(
      /shelf "x".*must not contain empty/,
    );
  });

  it("rejects a double slash (empty middle segment)", () => {
    expect(() => validateShelfSet([shelf("x", "team//sub/")])).toThrow(
      /shelf "x".*must not contain empty/,
    );
  });

  it("rejects a first segment shadowing a canonical top-level name (memories/)", () => {
    expect(() => validateShelfSet([shelf("x", "memories/")])).toThrow(
      /shelf "x".*shadows the canonical top-level name "memories"/,
    );
  });

  it("rejects canonical shadowing case-insensitively (Memories/ aliases memories/)", () => {
    expect(() => validateShelfSet([shelf("x", "Memories/")])).toThrow(
      /shadows the canonical top-level name "memories"/,
    );
  });

  it.each(["projects/", "project-updates/", "project-suggestions/"])(
    "rejects a project document directory as a shelf prefix (%s)",
    (prefix) => {
      expect(() => validateShelfSet([shelf("x", prefix)])).toThrow(
        /shadows the canonical top-level name/,
      );
    },
  );

  it("rejects a hidden canonical name too (.git/)", () => {
    expect(() => validateShelfSet([shelf("x", ".git/")])).toThrow(
      /shadows the canonical top-level name "\.git"/,
    );
  });

  it("refuses a non-NFC prefix (refused, never silently normalised)", () => {
    // "café/" spelled NFD: "cafe" + combining acute (U+0301). Its NFC form differs, so it is
    // genuinely non-NFC — the validator refuses rather than rewriting it.
    const nfd = "café/";
    expect(nfd.normalize("NFC")).not.toBe(nfd); // precondition
    expect(() => validateShelfSet([shelf("x", nfd)])).toThrow(/shelf "x".*NFC-normalised/);
  });

  it("rejects an empty id", () => {
    expect(() => validateShelfSet([shelf("", "team/")])).toThrow(/shelf id must be non-empty/);
  });

  it("rejects a whitespace-only id", () => {
    expect(() => validateShelfSet([shelf("   ", "team/")])).toThrow(/shelf id must be non-empty/);
  });

  it("rejects an empty or whitespace-only display label", () => {
    expect(() => validateShelfSet([{ ...shelf("team", "team/"), label: "" }])).toThrow(
      /shelf "team".*label must contain visible text/,
    );
    expect(() => validateShelfSet([{ ...shelf("team", "team/"), label: "   " }])).toThrow(
      /shelf "team".*label must contain visible text/,
    );
  });

  it("accepts a 2-segment prefix (members/x/ — the deepest specced shape)", () => {
    expect(() => validateShelfSet([shelf("x", "members/x/")])).not.toThrow();
  });

  it("rejects a 3-segment prefix — the depth cap (review B)", () => {
    expect(() => validateShelfSet([shelf("x", "members/x/y/")])).toThrow(
      /shelf "x".*capped at 2 segments/,
    );
  });

  it("rejects an id containing ']' — it breaks the recall provenance token (review G1)", () => {
    expect(() => validateShelfSet([shelf("a]b", "team/")])).toThrow(
      /shelf id "a\]b" must be printable/,
    );
  });

  it("rejects an id containing a newline (review G1)", () => {
    expect(() => validateShelfSet([shelf("a\nb", "team/")])).toThrow(/must be printable/);
  });

  it("accepts an id containing '/' — ids like members/x are the specced shape (review G1)", () => {
    expect(() => validateShelfSet([shelf("members/x", "members/x/")])).not.toThrow();
  });
});

describe("validateShelfSet — cross-set rules throw naming both shelves (spec 062 SC 2)", () => {
  it("rejects duplicate prefixes", () => {
    expect(() => validateShelfSet([shelf("a", "team/"), shelf("b", "team/")])).toThrow(
      /shelves "a" and "b" share the prefix "team\/"/,
    );
  });

  it("rejects nested prefixes (team/ vs team/sub/)", () => {
    expect(() => validateShelfSet([shelf("outer", "team/"), shelf("inner", "team/sub/")])).toThrow(
      /shelf "inner" .* is nested under shelf "outer"/,
    );
  });

  it("rejects the empty root prefix nesting a prefixed shelf (root + team/ overlap)", () => {
    expect(() => validateShelfSet([shelf("root", ""), shelf("team", "team/")])).toThrow(
      /nested under shelf "root"/,
    );
  });

  it("does NOT treat team/ and teams/ as nesting (the trailing slash makes the boundary exact)", () => {
    expect(() => validateShelfSet([shelf("a", "team/"), shelf("b", "teams/")])).not.toThrow();
  });

  it("rejects Team/ vs team/ — disjointness is case-insensitive (review G3)", () => {
    // On a case-insensitive filesystem these are the SAME directory, so a case-only difference is a
    // duplicate on disk, not a disjoint pair.
    expect(() => validateShelfSet([shelf("a", "Team/"), shelf("b", "team/")])).toThrow(
      /share the prefix.*case-insensitively/,
    );
  });

  it("rejects Team/ nesting team/sub/ case-insensitively (review G3)", () => {
    expect(() => validateShelfSet([shelf("a", "Team/"), shelf("b", "team/sub/")])).toThrow(
      /nested under/,
    );
  });

  it("rejects two WRITABLE shelves sharing an id", () => {
    expect(() => validateShelfSet([shelf("dup", "a/"), shelf("dup", "b/")])).toThrow(
      /two writable shelves share the id "dup"/,
    );
  });
});
