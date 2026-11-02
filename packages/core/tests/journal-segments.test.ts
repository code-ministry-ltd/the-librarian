// Long journal episodes are split at turn boundaries (journal capture quality fix).

import { EPISODE_SEGMENT_MAX_CHARS, hasExchange, splitEpisodeSegments } from "@librarian/core";
import { describe, expect, it } from "vitest";

const turn = (role: "user" | "assistant", seq: number, body: string): string =>
  `### ${role} (seq=${seq} ts=2026-11-02T10:0${seq}:00.000Z)\n\n${body}\n`;

describe("hasExchange", () => {
  it("needs both a user turn and an assistant turn", () => {
    expect(hasExchange(turn("user", 1, "hi") + "\n" + turn("assistant", 1, "hello"))).toBe(true);
    expect(hasExchange(turn("user", 1, "hi"))).toBe(false);
    expect(hasExchange(turn("assistant", 1, "hello"))).toBe(false);
    expect(hasExchange("")).toBe(false);
  });
});

describe("splitEpisodeSegments", () => {
  it("returns a buffer that fits as one unchanged segment", () => {
    const text = turn("user", 1, "short") + "\n" + turn("assistant", 1, "reply");
    expect(splitEpisodeSegments(text)).toEqual([text]);
  });

  it("cuts only between turns, keeps every turn, and respects the limit", () => {
    const turns = [0, 1, 2, 3, 4, 5].map((i) =>
      turn(i % 2 === 0 ? "user" : "assistant", i, `t${i} ${"y".repeat(400)}`),
    );
    const text = turns.join("\n");
    const segments = splitEpisodeSegments(text, 1_000);
    expect(segments.length).toBeGreaterThan(1);
    for (const s of segments) {
      expect(s.length).toBeLessThanOrEqual(1_000);
      expect(s.startsWith("### ")).toBe(true);
    }
    expect(segments.join("\n")).toBe(text);
  });

  it("keeps a single oversized turn whole, as its own segment", () => {
    const big = turn("user", 1, "z".repeat(2_000));
    const text = big + "\n" + turn("assistant", 1, "ok");
    const segments = splitEpisodeSegments(text, 1_000);
    expect(segments[0]).toBe(big);
    expect(segments).toHaveLength(2);
  });

  it("defaults to roughly 30k characters per segment", () => {
    expect(EPISODE_SEGMENT_MAX_CHARS).toBe(30_000);
  });
});
