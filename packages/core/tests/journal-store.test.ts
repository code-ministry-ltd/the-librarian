// The journal over a real markdown store (spec 077 §4.1/§4.4): idempotent appends,
// owner deletes, the recent window with its budget, the path guard, and the rule that
// journal files are never memories.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SHELF,
  type JournalFileStore,
  type LibrarianStore,
  RECENT_WINDOW_HEADER,
  RECENT_WINDOW_TRIMMED_NOTE,
  appendEpisode,
  createLibrarianStore,
  deleteEpisode,
  deletePeriod,
  episodeTiming,
  renderRecentWindow,
  resolveSecretKey,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const KEY = resolveSecretKey("0123456789abcdef".repeat(4));

let store: LibrarianStore;
let dataDir = "";
let files: JournalFileStore;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-journal-"));
  store = createLibrarianStore({ dataDir, backend: "markdown", secretKey: KEY });
  files = store.systemJournal(DEFAULT_SHELF);
});
afterEach(() => {
  try {
    store.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function episode(key: string, bullets = ["Did a thing."], project: string | null = "proj") {
  return { key, time: "10:00–11:00", harness: "claude", project, bullets };
}

function lastCommitSubject(): string {
  const vaultDir = path.join(dataDir, "vault");
  return execFileSync("git", ["-C", vaultDir, "log", "-1", "--format=%s"], {
    encoding: "utf8",
  }).trim();
}

describe("appendEpisode", () => {
  it("writes the episode under journal/days and commits it as system output", () => {
    expect(appendEpisode(files, "2026-11-02", episode("c#s1"))).toBe("written");
    expect(files.list()).toEqual(["days/2026-11-02.md"]);
    expect(files.read("days/2026-11-02.md")).toContain("<!-- episode: c#s1 -->");
    expect(lastCommitSubject()).toBe("journal: episode 2026-11-02");
  });

  it("writes nothing when the same episode key is appended again (a retried conversation)", () => {
    appendEpisode(files, "2026-11-02", episode("c#s1"));
    const before = files.read("days/2026-11-02.md");
    expect(appendEpisode(files, "2026-11-02", episode("c#s1", ["Different words."]))).toBe(
      "exists",
    );
    expect(files.read("days/2026-11-02.md")).toBe(before);
  });

  it("appends after an owner's hand edit without rewriting it", () => {
    appendEpisode(files, "2026-11-02", episode("c#s1"));
    const edited = `${files.read("days/2026-11-02.md")}\nA note the owner typed by hand.\n`;
    files.write("days/2026-11-02.md", edited, "vault: edit test");
    appendEpisode(files, "2026-11-02", episode("c#s2"));
    expect(files.read("days/2026-11-02.md")).toContain("A note the owner typed by hand.");
  });

  it("writes nothing for an episode with no bullets", () => {
    expect(appendEpisode(files, "2026-11-02", episode("c#s1", []))).toBe("empty");
    expect(files.list()).toEqual([]);
  });
});

describe("owner deletes", () => {
  it("removes one episode and keeps the rest of the day", () => {
    appendEpisode(files, "2026-11-02", episode("a#s1", ["first"]));
    appendEpisode(files, "2026-11-02", episode("b#s1", ["second"]));
    expect(deleteEpisode(files, "2026-11-02", "a#s1")).toBe(true);
    const raw = files.read("days/2026-11-02.md") ?? "";
    expect(raw).not.toContain("first");
    expect(raw).toContain("second");
    expect(lastCommitSubject()).toBe("journal: delete days/2026-11-02.md#a#s1");
  });

  it("removes the day file when its last episode is deleted", () => {
    appendEpisode(files, "2026-11-02", episode("a#s1"));
    deleteEpisode(files, "2026-11-02", "a#s1");
    expect(files.list()).toEqual([]);
  });

  it("deletes a whole period and reports a missing one", () => {
    appendEpisode(files, "2026-11-02", episode("a#s1"));
    expect(deletePeriod(files, "days/2026-11-02.md")).toBe(true);
    expect(deletePeriod(files, "days/2026-11-02.md")).toBe(false);
    expect(deleteEpisode(files, "2026-11-02", "nope")).toBe(false);
  });
});

describe("the store seam", () => {
  it("refuses any path that is not a canonical journal file", () => {
    for (const bad of ["../memories/x.md", "days/../../x.md", "notes.md", "days/2026-11-02.txt"]) {
      expect(() => files.write(bad, "x", "s"), bad).toThrow(/must be days\/YYYY-MM-DD\.md/);
    }
  });

  it("never lets journal files reach recall", async () => {
    appendEpisode(files, "2026-11-02", episode("a#s1", ["The zebrafish deployment was approved."]));
    const hits = await store.recall({ query: "zebrafish deployment", limit: 8 });
    expect(hits).toEqual([]);
  });
});

describe("renderRecentWindow", () => {
  it("serves nothing when the journal is empty", () => {
    expect(renderRecentWindow(files, 20_000)).toBeNull();
  });

  it("serves the 4 newest week summaries and every day file, oldest first, without structural comments", () => {
    for (const week of ["2026-W38", "2026-W39", "2026-W40", "2026-W41", "2026-W42"]) {
      files.write(
        `weeks/${week}.md`,
        `# Week ${week}\n<!-- sources: x@1 -->\n\n- summary ${week}\n`,
        "t",
      );
    }
    appendEpisode(files, "2026-10-30", episode("a#s1", ["day one"]));
    appendEpisode(files, "2026-11-02", episode("b#s1", ["day two"]));
    const text = renderRecentWindow(files, 20_000) ?? "";
    expect(text.startsWith(RECENT_WINDOW_HEADER)).toBe(true);
    expect(text).not.toContain("summary 2026-W38");
    expect(text).not.toContain("<!--");
    const order = ["summary 2026-W39", "summary 2026-W42", "day one", "day two"].map((s) =>
      text.indexOf(s),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text).toContain("## 2026-11-02 10:00–11:00 · claude · proj");
  });

  it("drops the oldest entries first when over budget, keeping the newest", () => {
    appendEpisode(files, "2026-10-30", episode("a#s1", ["old ".repeat(400)]));
    appendEpisode(files, "2026-11-02", episode("b#s1", ["new ".repeat(400)]));
    const text = renderRecentWindow(files, 700) ?? "";
    expect(text).not.toContain("old old");
    expect(text).toContain("new new");
    // A cap too small for the newest entry keeps a cut-down copy of it, never an older one.
    const tiny = renderRecentWindow(files, 20_000, { maxChars: 1_000 }) ?? "";
    expect(tiny).toContain("new new");
    expect(tiny).not.toContain("old old");
  });
});

describe("renderRecentWindow — maxChars for capped injection channels (spec 077 §4.9)", () => {
  it("trims one entry at a time, oldest first, and says how to read further back", () => {
    for (let i = 1; i <= 9; i += 1) {
      appendEpisode(files, `2026-10-2${i}`, episode(`e${i}#s1`, [`entry ${i} `.repeat(120)]));
    }
    const text = renderRecentWindow(files, 20_000, { maxChars: 4_000 }) ?? "";
    expect(text.length).toBeLessThanOrEqual(4_000);
    expect(text).toContain("entry 9 entry 9");
    expect(text).not.toContain("entry 1 entry 1");
    expect(text.trimEnd().endsWith(RECENT_WINDOW_TRIMMED_NOTE)).toBe(true);
  });

  it("drops individual entries within a busy day rather than the whole day", () => {
    for (let i = 1; i <= 6; i += 1) {
      appendEpisode(files, "2026-11-02", episode(`d${i}#s1`, [`busy ${i} `.repeat(120)]));
    }
    const text = renderRecentWindow(files, 20_000, { maxChars: 4_000 }) ?? "";
    expect(text).toContain("busy 6 busy 6");
    expect(text).not.toContain("busy 1 busy 1");
  });

  it("never exceeds the cap, even when the newest entry alone is too long", () => {
    appendEpisode(files, "2026-11-02", episode("big#s1", ["x".repeat(1_200)]));
    const text = renderRecentWindow(files, 20_000, { maxChars: 1_000 }) ?? "";
    expect(text.length).toBeLessThanOrEqual(1_000);
    expect(text).toContain("…");
  });

  it("adds no note when everything fits", () => {
    appendEpisode(files, "2026-11-02", episode("a#s1"));
    expect(renderRecentWindow(files, 20_000, { maxChars: 9_500 })).not.toContain(
      RECENT_WINDOW_TRIMMED_NOTE,
    );
  });
});

describe("episodeTiming", () => {
  it("dates an episode by its last turn and shows the local time range", () => {
    const first = new Date(2026, 10, 2, 14, 5);
    const last = new Date(2026, 10, 2, 15, 40);
    const buffer = `### user (seq=1 ts=${first.toISOString()})\n\nhi\n\n### assistant (seq=1 ts=${last.toISOString()})\n\nhello\n`;
    expect(episodeTiming(buffer, new Date(2026, 0, 1))).toEqual({
      date: "2026-11-02",
      time: "14:05–15:40",
    });
  });

  it("falls back to the settle time when turns carry no timestamps", () => {
    expect(episodeTiming("### user (seq=1)\n\nhi\n", new Date(2026, 10, 3, 9, 7))).toEqual({
      date: "2026-11-03",
      time: "09:07",
    });
  });
});
