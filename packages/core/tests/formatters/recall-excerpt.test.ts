// Recall excerpts (spec 075 §3.1.6): a long memory comes back to the agent as
// its best-matching section plus a footer saying how to fetch the rest; short
// memories are unchanged byte for byte.

import { EXCERPT_MIN_BODY_CHARS, formatRecall } from "@librarian/core";
import { describe, expect, it } from "vitest";

const id = "mem_00000000-0000-4000-8000-000000000001";
const words = (n: number, word: string): string => Array.from({ length: n }, () => word).join(" ");

describe("formatRecall excerpts", () => {
  it("leaves a short memory byte-identical, excerpts on or off", () => {
    const memory = { id, title: "Ports", body: "the proxy listens on 9431", matchedSection: "x" };
    expect(formatRecall([memory], "Relevant Memories", { excerpts: true })).toBe(
      formatRecall([memory], "Relevant Memories"),
    );
  });

  it("returns a long memory's matched section with a footer naming the id and the words left", () => {
    const first = words(170, "alpha");
    const second = words(170, "beta");
    const body = `${first}\n\n${second}`;
    expect(body.length).toBeGreaterThan(EXCERPT_MIN_BODY_CHARS);
    const out = formatRecall(
      [{ id, title: "Notes", body, matchedSection: second }],
      "Relevant Memories",
      { excerpts: true },
    );
    expect(out).toBe(
      `Relevant Memories\n\n- Notes: ${second}\n` +
        `(excerpt — 170 more words in this memory; recall with ids ["${id}"] for all of it)`,
    );
  });

  it("keeps the id prefix when include_ids is on", () => {
    const body = `${words(170, "alpha")}\n\n${words(170, "beta")}`;
    const out = formatRecall(
      [{ id, title: "Notes", body, matchedSection: words(170, "beta") }],
      "Relevant Memories",
      { excerpts: true, includeIds: true },
    );
    expect(out.startsWith(`Relevant Memories\n\n- [${id}] Notes: beta`)).toBe(true);
  });

  it("returns a long single-section memory whole — there is nothing to point at", () => {
    const body = words(400, "gamma"); // one paragraph → one section
    const out = formatRecall([{ id, title: "Blob", body, matchedSection: body }], "R", {
      excerpts: true,
    });
    expect(out).toBe(`R\n\n- Blob: ${body}`);
  });

  it("returns a long memory whole when no section matched (a backlink neighbour)", () => {
    const body = `${words(170, "alpha")}\n\n${words(170, "beta")}`;
    const out = formatRecall([{ id, title: "Linked", body }], "R", { excerpts: true });
    expect(out).toBe(`R\n\n- Linked: ${body}`);
  });
});
