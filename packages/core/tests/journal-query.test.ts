// The `journal` verb's engine (spec 077 §4.5, SC10/SC11): retrieve by range, search by
// BM25, filter by project/harness, page back when trimmed, and teach on bad input.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SHELF,
  type JournalFileStore,
  JournalQueryError,
  type LibrarianStore,
  appendEpisode,
  createLibrarianStore,
  parseJournalQueryArgs,
  queryJournal,
  renderRollup,
  resolveSecretKey,
  weekPeriod,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const KEY = resolveSecretKey("0123456789abcdef".repeat(4));
const TODAY = "2026-11-02";

let store: LibrarianStore;
let dataDir = "";
let files: JournalFileStore;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-jquery-"));
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

function entry(
  date: string,
  key: string,
  bullets: string[],
  project = "alpha",
  harness = "claude",
) {
  appendEpisode(files, date, { key, time: "10:00", harness, project, bullets });
}

function week(label: string, body: string): void {
  files.write(`weeks/${label}.md`, renderRollup(weekPeriod(label), { sources: [], body }), "t");
}

describe("parseJournalQueryArgs", () => {
  it("accepts an empty call (retrieve the last 30 days)", () => {
    expect(parseJournalQueryArgs({})).toEqual({});
  });

  it("teaches on malformed dates, inverted ranges and out-of-range numbers", () => {
    expect(() => parseJournalQueryArgs({ from: "2026-13-01" })).toThrow(
      "Expected `from` as YYYY-MM-DD, got '2026-13-01'",
    );
    expect(() => parseJournalQueryArgs({ from: "2026-10-01", to: "2026-09-01" })).toThrow(
      "`from` (2026-10-01) is after `to` (2026-09-01)",
    );
    expect(() => parseJournalQueryArgs({ limit: 0 })).toThrow(
      "Expected `limit` as a whole number from 1 to 50, got 0",
    );
    expect(() => parseJournalQueryArgs({ max_tokens: 50 })).toThrow(JournalQueryError);
    expect(() => parseJournalQueryArgs({ query: 42 })).toThrow(
      "Expected `query` to be a string, got number",
    );
  });

  it("treats blank strings as absent", () => {
    expect(parseJournalQueryArgs({ query: "  ", project: "" })).toEqual({});
  });
});

describe("queryJournal — retrieve mode (SC10)", () => {
  it("returns every entry in range oldest first, defaulting to the last 30 days", () => {
    entry("2026-09-01", "old#s1", ["Too old for the default range."]);
    entry("2026-10-20", "a#s1", ["First in range."]);
    entry("2026-11-01", "b#s1", ["Second in range."]);
    const text = queryJournal(files, {}, TODAY);
    expect(text).toContain("# Journal, 2026-10-03 to 2026-11-02 (oldest first)");
    expect(text).not.toContain("Too old");
    expect(text.indexOf("First in range")).toBeLessThan(text.indexOf("Second in range"));
    expect(text).not.toContain("<!--");
  });

  it("reads older history when asked, including week summaries", () => {
    week("2026-W30", "- **alpha**: shipped the importer.");
    const text = queryJournal(files, { from: "2026-07-01", to: "2026-07-31" }, TODAY);
    expect(text).toContain("shipped the importer");
  });

  it("drops the oldest entries to fit max_tokens and says how to page back", () => {
    entry("2026-10-20", "a#s1", ["early ".repeat(900)]);
    entry("2026-11-01", "b#s1", ["late ".repeat(900)]);
    const text = queryJournal(files, { maxTokens: 1_500 }, TODAY);
    expect(text).not.toContain("early early");
    expect(text).toContain("late late");
    expect(text).toContain("call again with `to: 2026-10-31`");
  });

  it("filters episodes by project and harness exactly, ignoring case", () => {
    entry("2026-11-01", "a#s1", ["Alpha work."], "alpha", "claude");
    entry("2026-11-01", "b#s1", ["Beta work."], "beta", "codex");
    const byProject = queryJournal(files, { project: "ALPHA" }, TODAY);
    expect(byProject).toContain("Alpha work.");
    expect(byProject).not.toContain("Beta work.");
    const byHarness = queryJournal(files, { harness: "codex" }, TODAY);
    expect(byHarness).toContain("Beta work.");
    expect(byHarness).not.toContain("Alpha work.");
  });

  it("matches summaries by text when filtering by project, and labels them as looser", () => {
    week("2026-W30", "- **alpha**: shipped the importer.");
    week("2026-W31", "- **beta**: fixed CI.");
    const text = queryJournal(
      files,
      { from: "2026-07-01", to: "2026-08-10", project: "alpha" },
      TODAY,
    );
    expect(text).toContain("shipped the importer");
    expect(text).toContain("matched by text");
    expect(text).not.toContain("fixed CI");
  });

  it("explains an empty result", () => {
    expect(queryJournal(files, {}, TODAY)).toContain(
      "No journal entries for 2026-10-03 to 2026-11-02",
    );
  });
});

describe("queryJournal — search mode (SC11)", () => {
  it("ranks matches by relevance across a year, with date and tier on each", () => {
    entry("2026-10-01", "a#s1", ["Talked about lunch."]);
    entry("2026-10-15", "b#s1", ["Decided to keep raw transcripts out for privacy."]);
    week("2026-W20", "- **alpha**: raw transcripts debate started.");
    const text = queryJournal(files, { query: "raw transcripts privacy" }, TODAY);
    expect(text).toMatch(/^# Journal search: "raw transcripts privacy", 2025-11-02 to 2026-11-02/);
    const first = text.indexOf("[entry, 2026-10-15]");
    expect(first).toBeGreaterThan(-1);
    expect(text).toContain("[week summary, 2026-05-11 to 2026-05-17]");
    expect(first).toBeLessThan(text.indexOf("[week summary"));
    expect(text).not.toContain("lunch");
  });

  it("breaks score ties newest first and honours limit", () => {
    entry("2026-10-01", "a#s1", ["zebra"]);
    entry("2026-10-20", "b#s1", ["zebra"]);
    const text = queryJournal(files, { query: "zebra", limit: 1 }, TODAY);
    expect(text).toContain("[entry, 2026-10-20]");
    expect(text).not.toContain("[entry, 2026-10-01]");
    expect(text).toContain("1 best match");
  });

  it("searches only inside an explicit range and filter", () => {
    entry("2026-10-01", "a#s1", ["zebra in alpha"], "alpha");
    entry("2026-10-20", "b#s1", ["zebra in beta"], "beta");
    const text = queryJournal(files, { query: "zebra", project: "beta" }, TODAY);
    expect(text).toContain("zebra in beta");
    expect(text).not.toContain("zebra in alpha");
  });

  it("finds a word that ends a sentence, while keeping dotted names like file.ts searchable", () => {
    entry("2026-10-01", "a#s1", ["Shipped the importer.", "Renamed config.ts to settings.ts."]);
    expect(queryJournal(files, { query: "importer" }, TODAY)).toContain("[entry, 2026-10-01]");
    expect(queryJournal(files, { query: "settings.ts" }, TODAY)).toContain("[entry, 2026-10-01]");
  });

  it("suggests what to try when nothing matches", () => {
    entry("2026-10-01", "a#s1", ["something else"]);
    expect(queryJournal(files, { query: "zebra" }, TODAY)).toContain(
      'No journal entries match "zebra"',
    );
  });
});
