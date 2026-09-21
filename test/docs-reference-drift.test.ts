// Drift-guard logic for the generated reference (docs-site spec criterion #5 /
// T2.3). `pnpm check:docs` regenerates the reference from canonical source and
// compares it to the committed pages; any divergence fails CI, naming the stale
// page and the fix command. CI runs it AFTER the build so it can never pass
// against stale dist (K8). This suite pins the comparison logic and asserts the
// committed pages are currently in sync.

import { describe, expect, it } from "vitest";
import { findStaleReferencePages, stalePagesMessage } from "../scripts/check-docs.mjs";

describe("check:docs drift-guard", () => {
  it("reports no drift for the pages committed in this repo", () => {
    // Reads the real generated pages off disk against a fresh regeneration.
    expect(findStaleReferencePages()).toEqual([]);
  });

  it("treats a byte-for-byte match (modulo trailing newline) as in sync", () => {
    const reference = { "a.md": "hello\nworld" };
    expect(findStaleReferencePages(reference, () => "hello\nworld\n")).toEqual([]);
  });

  it("flags a page whose committed content differs", () => {
    const reference = { "a.md": "expected", "b.md": "also" };
    const onDisk = { "a.md": "expected\n", "b.md": "TAMPERED\n" };
    expect(findStaleReferencePages(reference, (p) => onDisk[p])).toEqual(["b.md"]);
  });

  it("flags a page that is missing from disk", () => {
    const reference = { "gone.md": "content" };
    expect(
      findStaleReferencePages(reference, () => {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      }),
    ).toEqual(["gone.md"]);
  });
});

// A drift verdict has two possible causes, and the guard used to name only one of
// them — then advised `pnpm docs:gen` + commit. Against stale dist that command
// regenerates OLD content and overwrites a correct committed page. These tests pin
// the guidance, because here the wrong advice is worse than none.
describe("check:docs failure guidance", () => {
  it("names every diverging page", () => {
    const message = stalePagesMessage([
      "apps/docs/src/content/docs/reference/primer.md",
      "apps/docs/src/content/docs/reference/other.md",
    ]);
    expect(message).toContain("reference/primer.md");
    expect(message).toContain("reference/other.md");
  });

  it("names both causes, so a stale build is not mistaken for a stale page", () => {
    const message = stalePagesMessage(["x.md"]);
    expect(message).toMatch(/canonical source changed/i);
    expect(message).toMatch(/built packages .*stale/i);
  });

  it("puts `pnpm build` before the docs:gen advice, and forbids committing a stale regeneration", () => {
    const message = stalePagesMessage(["x.md"]);
    // `build` is the shared first step of both causes; `docs:gen` is only ever
    // safe AFTER it, so it must not be the first command a reader meets.
    expect(message.indexOf("pnpm build")).toBeGreaterThan(-1);
    expect(message.indexOf("pnpm build")).toBeLessThan(message.indexOf("pnpm docs:gen"));
    expect(message).toMatch(/Do NOT commit/i);
  });
});
