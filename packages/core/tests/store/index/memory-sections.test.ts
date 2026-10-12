// Memory sections (spec 075 §3.1.1): a memory is indexed as ~180-word
// sections so a fact deep inside a long memory is matched on its own words,
// not diluted by everything else the memory says.

import { MAX_SECTION_WORDS, splitMemorySections } from "@librarian/core";
import { describe, expect, it } from "vitest";

const words = (n: number, word = "alpha"): string =>
  Array.from({ length: n }, () => word).join(" ");

describe("splitMemorySections", () => {
  it("keeps a short memory as one section", () => {
    expect(splitMemorySections("One short fact.\n\nAnd another.")).toEqual([
      "One short fact.\n\nAnd another.",
    ]);
  });

  it("packs paragraphs greedily up to the section word limit", () => {
    const para = words(100);
    const sections = splitMemorySections([para, para, para].join("\n\n"));
    // 100 + 100 > 180, so each paragraph starts a new section
    expect(sections).toHaveLength(3);
    const small = words(60);
    expect(splitMemorySections([small, small, small, small].join("\n\n"))).toHaveLength(2);
  });

  it("starts a new paragraph at a markdown heading even without a blank line", () => {
    const sections = splitMemorySections(`${words(178)}\n## Ports\nthe router listens on 9431`);
    expect(sections).toHaveLength(2);
    expect(sections[1]).toBe("## Ports\nthe router listens on 9431");
  });

  it("does not treat a # comment inside fenced code as a heading", () => {
    const body = `${words(178)}\n\`\`\`sh\n# install\npnpm install\n\`\`\``;
    expect(splitMemorySections(body)).toEqual([body]);
  });

  it("keeps an oversize paragraph whole as its own section", () => {
    const big = words(MAX_SECTION_WORDS + 50, "beta");
    const sections = splitMemorySections(`intro\n\n${big}\n\noutro`);
    expect(sections).toEqual(["intro", big, "outro"]);
  });

  it("returns one empty section for an empty body, so every memory is indexable", () => {
    expect(splitMemorySections("   \n\n ")).toEqual([""]);
  });
});
