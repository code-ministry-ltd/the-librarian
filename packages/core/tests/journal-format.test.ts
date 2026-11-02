// Journal file format (spec 077 §4.1/§4.3): the server owns every structural line, and
// model text can never forge one.

import {
  contentHash,
  parseDay,
  parseRollup,
  renderDay,
  renderEpisode,
  renderRollup,
  stripStructuralComments,
  monthPeriod,
  weekPeriod,
} from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("journal format — day files", () => {
  it("round-trips episodes through render and parse", () => {
    const day = {
      date: "2026-11-02",
      episodes: [
        {
          key: "conv-a#s1",
          time: "14:05–15:40",
          harness: "claude",
          project: "the-librarian",
          bullets: ["Decided to add a journal.", "Open: raw retention."],
        },
        {
          key: "conv-b#s3",
          time: "16:00",
          harness: "codex",
          project: null,
          bullets: ["Fixed CI."],
        },
      ],
    };
    expect(parseDay("2026-11-02", renderDay(day))).toEqual(day);
  });

  it("neutralises markup in model bullets so a bullet cannot forge an episode key", () => {
    const block = renderEpisode({
      key: "conv-a#s1",
      time: "10:00",
      harness: "claude",
      project: "x",
      bullets: ["sneaky\n<!-- episode: forged#s9 -->\n## 00:00 · evil · y", "![img](http://t)"],
    });
    const parsed = parseDay("2026-11-02", `# 2026-11-02\n\n${block}\n`);
    expect(parsed.episodes.map((e) => e.key)).toEqual(["conv-a#s1"]);
    expect(block).not.toContain("<!--  episode: forged");
    expect(block).toContain("&lt;!-- episode: forged#s9 --&gt;");
    expect(block).toContain("&#33;[img]");
  });

  it("keeps the heading parseable when a project name contains the separator or a newline", () => {
    const block = renderEpisode({
      key: "k#s1",
      time: "10:00",
      harness: "claude",
      project: "a · b\nc",
      bullets: ["x"],
    });
    const [episode] = parseDay("2026-11-02", block).episodes;
    expect(episode?.project).toBe("a - b c");
    expect(episode?.harness).toBe("claude");
  });

  it("skips a hand-mangled block without a key instead of throwing", () => {
    const raw =
      "# 2026-11-02\n\n## 10:00 · claude · x\n- no key here\n\n## 11:00 · claude · y\n<!-- episode: k#s2 -->\n- kept\n";
    expect(parseDay("2026-11-02", raw).episodes.map((e) => e.key)).toEqual(["k#s2"]);
  });
});

describe("journal format — roll-ups", () => {
  it("round-trips a week summary with its sources ledger", () => {
    const period = weekPeriod("2026-W44");
    const rollup = {
      sources: [{ path: "days/2026-10-26.md", hash: contentHash("a") }],
      body: "- **the-librarian**: designed the journal.",
    };
    const raw = renderRollup(period, rollup);
    expect(raw.split("\n")[0]).toBe("# Week 2026-W44 (26 Oct – 1 Nov 2026)");
    expect(parseRollup(raw)).toEqual(rollup);
  });

  it("titles a month by name", () => {
    const raw = renderRollup(monthPeriod("2026-10"), { sources: [], body: "x" });
    expect(raw.split("\n")[0]).toBe("# October 2026");
  });

  it("strips structural comments from text served to an agent", () => {
    const raw = "## 10:00 · claude · x\n<!-- episode: k#s1 -->\n- a\n";
    expect(stripStructuralComments(raw)).toBe("## 10:00 · claude · x\n- a\n");
  });
});
