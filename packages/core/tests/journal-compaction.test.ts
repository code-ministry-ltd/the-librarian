// Journal compaction (spec 077 §4.3, SC3): days roll into weeks after 14 days, weeks
// into months after 90; crash recovery never leaves a gap or a double summary; a failed
// roll-up keeps its sources; the daily tick self-gates.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SHELF,
  INTAKE_ENABLED_KEY,
  JOURNAL_ENABLED_KEY,
  type JournalCompactionSummary,
  type JournalFileStore,
  type LibrarianStore,
  type LlmClient,
  addProvider,
  appendEpisode,
  compactShelfJournal,
  contentHash,
  createLibrarianStore,
  isJournalCompactionDue,
  parseRollup,
  renderRollup,
  resolveSecretKey,
  runJournalCompactionTick,
  weekPeriod,
  writeConsumerConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const KEY = resolveSecretKey("0123456789abcdef".repeat(4));
const TODAY = "2026-11-02";

let store: LibrarianStore;
let dataDir = "";
let files: JournalFileStore;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-jcompact-"));
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

function blankSummary(): JournalCompactionSummary {
  return {
    ran: true,
    rolledWeeks: 0,
    rolledMonths: 0,
    recovered: 0,
    failed: 0,
    stoppedEarly: false,
  };
}

/** A fake model that answers every roll-up with a summary naming what it was given. */
function summarizer(calls: string[] = []): LlmClient {
  return {
    complete: async ({ messages }) => {
      const input = messages[1]?.content ?? "";
      calls.push(input);
      const names = [...input.matchAll(/- ([a-z0-9-]+ point)/g)].map((m) => m[1]).join(", ");
      return {
        content: JSON.stringify({ summary: `- covered: ${names}` }),
        model: "m",
        usage: null,
      };
    },
  };
}

function day(date: string, point: string): void {
  appendEpisode(files, date, {
    key: `${date}#s1`,
    time: "10:00",
    harness: "claude",
    project: "proj",
    bullets: [point],
  });
}

describe("compactShelfJournal — days into weeks", () => {
  it("rolls a closed week's day files into one week summary and deletes them", async () => {
    // 2026-W42 = 12–18 Oct, entirely ≥ 14 days before 2 Nov.
    day("2026-10-12", "mon-w42 point");
    day("2026-10-18", "sun-w42 point");
    day("2026-10-28", "recent point"); // still in the day tier
    const summary = blankSummary();
    await compactShelfJournal(files, TODAY, summarizer(), summary, () => {});

    expect(summary.rolledWeeks).toBe(1);
    expect(files.list().sort()).toEqual(["days/2026-10-28.md", "weeks/2026-W42.md"]);
    const week = parseRollup(files.read("weeks/2026-W42.md") ?? "");
    expect(week.body).toContain("mon-w42 point, sun-w42 point");
    expect(week.sources.map((s) => s.path)).toEqual(["days/2026-10-12.md", "days/2026-10-18.md"]);
  });

  it("leaves a week alone while any of its days is still in the day tier", async () => {
    // 2026-W43 = 19–25 Oct; 25 Oct is only 8 days before 2 Nov.
    day("2026-10-19", "w43 point");
    await compactShelfJournal(files, TODAY, summarizer(), blankSummary(), () => {});
    expect(files.list()).toEqual(["days/2026-10-19.md"]);
  });

  it("finishes a crashed roll-up by deleting sources already in the ledger, without a model call", async () => {
    day("2026-10-12", "a point");
    const raw = files.read("days/2026-10-12.md") ?? "";
    // Simulate a crash after the week was written but before its sources were deleted.
    files.write(
      "weeks/2026-W42.md",
      renderRollup(weekPeriod("2026-W42"), {
        sources: [{ path: "days/2026-10-12.md", hash: contentHash(raw) }],
        body: "- already summarised",
      }),
      "t",
    );
    const calls: string[] = [];
    const summary = blankSummary();
    await compactShelfJournal(files, TODAY, summarizer(calls), summary, () => {});
    expect(calls).toEqual([]);
    expect(summary.recovered).toBe(1);
    expect(files.list()).toEqual(["weeks/2026-W42.md"]);
    expect(parseRollup(files.read("weeks/2026-W42.md") ?? "").body).toBe("- already summarised");
  });

  it("folds a late-arriving day into an existing week summary instead of losing it", async () => {
    files.write(
      "weeks/2026-W42.md",
      renderRollup(weekPeriod("2026-W42"), { sources: [], body: "- earlier summary" }),
      "t",
    );
    day("2026-10-14", "late point");
    const calls: string[] = [];
    await compactShelfJournal(files, TODAY, summarizer(calls), blankSummary(), () => {});
    expect(calls[0]).toContain("EXISTING SUMMARY:\n\n- earlier summary");
    expect(calls[0]).toContain("late point");
    expect(files.list()).toEqual(["weeks/2026-W42.md"]);
  });

  it("keeps the sources when the model fails, for the next run to retry", async () => {
    day("2026-10-12", "a point");
    const broken: LlmClient = {
      complete: async () => ({ content: "nope", model: "m", usage: null }),
    };
    const summary = blankSummary();
    await compactShelfJournal(files, TODAY, broken, summary, () => {});
    expect(summary.failed).toBe(1);
    expect(files.list()).toEqual(["days/2026-10-12.md"]);
  });
});

describe("compactShelfJournal — weeks into months", () => {
  function week(label: string, body: string): void {
    files.write(
      `weeks/${label}.md`,
      renderRollup(weekPeriod(label), { sources: [], body: `- ${body}` }),
      "t",
    );
  }

  it("rolls a closed month's weeks into one month summary", async () => {
    // July 2026 weeks by Thursday: W27 (2 Jul) … W31 (30 Jul). All end ≥ 90 days before 2 Nov.
    week("2026-W27", "w27 point");
    week("2026-W31", "w31 point");
    week("2026-W32", "w32 point"); // August, and still inside the week tier
    const summary = blankSummary();
    await compactShelfJournal(files, TODAY, summarizer(), summary, () => {});
    expect(summary.rolledMonths).toBe(1);
    expect(files.list().sort()).toEqual(["months/2026-07.md", "weeks/2026-W32.md"]);
    expect(files.read("months/2026-07.md")).toMatch(/^# July 2026\n/);
  });

  it("waits on a month while one of its weeks still has unrolled day files", async () => {
    week("2026-W27", "w27 point");
    // A day of W30 (20–26 Jul) whose week roll-up keeps failing, while month roll-ups would
    // succeed: the month must still wait, or July's summary would be built without it.
    day("2026-07-21", "stuck point");
    const weekFailsMonthWorks: LlmClient = {
      complete: async ({ messages }) => ({
        content: messages[0]?.content.includes("for one week")
          ? "not json"
          : JSON.stringify({ summary: "- month" }),
        model: "m",
        usage: null,
      }),
    };
    const summary = blankSummary();
    await compactShelfJournal(files, TODAY, weekFailsMonthWorks, summary, () => {});
    expect(summary.rolledMonths).toBe(0);
    expect(files.list().sort()).toEqual(["days/2026-07-21.md", "weeks/2026-W27.md"]);
  });
});

describe("runJournalCompactionTick", () => {
  function enable(): void {
    store.setSetting(INTAKE_ENABLED_KEY, "true");
    store.setSetting(JOURNAL_ENABLED_KEY, "true");
    const provider = addProvider(store, {
      name: "default",
      endpoint: "https://e/v1",
      token: "dummy-t",
    });
    writeConsumerConfig(store, "intake", { providerId: provider.id, model: "gpt-x" });
  }
  const at = (h: number, m: number) => () => new Date(2026, 10, 2, h, m);

  it("does nothing while the journal is off, even with intake on", async () => {
    store.setSetting(INTAKE_ENABLED_KEY, "true");
    day("2026-10-12", "a point");
    const result = await runJournalCompactionTick({
      store,
      now: at(3, 0),
      buildClient: () => summarizer(),
    });
    expect(result.reason).toBe("disabled");
    expect(files.list()).toEqual(["days/2026-10-12.md"]);
  });

  it("runs once a day after 02:30 local and stamps the day", async () => {
    enable();
    day("2026-10-12", "a point");
    const early = await runJournalCompactionTick({
      store,
      now: at(2, 0),
      buildClient: () => summarizer(),
    });
    expect(early.reason).toBe("not_due");
    const due = await runJournalCompactionTick({
      store,
      now: at(2, 45),
      buildClient: () => summarizer(),
    });
    expect(due.rolledWeeks).toBe(1);
    const again = await runJournalCompactionTick({
      store,
      now: at(9, 0),
      buildClient: () => summarizer(),
    });
    expect(again.reason).toBe("not_due");
  });

  it("isJournalCompactionDue treats a new day as due again", () => {
    expect(isJournalCompactionDue(new Date(2026, 10, 3, 2, 31), "2026-11-02")).toBe(true);
    expect(isJournalCompactionDue(new Date(2026, 10, 3, 2, 29), "2026-11-02")).toBe(false);
  });
});
