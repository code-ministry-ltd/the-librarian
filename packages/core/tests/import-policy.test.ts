// Import past conversations (spec 079): the frozen per-step cutoffs, the server limits,
// the conversation ledger, and how the settle-sweep runs an imported conversation.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SHELF,
  IMPORT_ALLOWANCE_KEY,
  IMPORT_JOURNAL_CUTOFF_KEY,
  IMPORT_MEMORIES_CUTOFF_KEY,
  INTAKE_ENABLED_KEY,
  JOURNAL_ENABLED_KEY,
  type LibrarianStore,
  type LlmClient,
  QUEUED,
  acceptImport,
  addProvider,
  appendEpisode,
  createLibrarianStore,
  ensureLedger,
  freezeImportCutoffs,
  lookupLedger,
  planImport,
  readImportConfig,
  recordLedger,
  resolveSecretKey,
  runTranscriptSweepTick,
  transcriptBufferPath,
  transcriptHarnessMarkerPath,
  endedMarkerPath,
  writeConsumerConfig,
  writeImportConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isReviewerCall, keepEverything } from "./helpers/keeping-reviewer.js";

const KEY = resolveSecretKey("0123456789abcdef".repeat(4));
const NOW = new Date("2026-11-02T12:00:00.000Z");
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString();

let store: LibrarianStore;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-import-"));
  store = createLibrarianStore({ dataDir, backend: "markdown", secretKey: KEY });
  store.setSetting(INTAKE_ENABLED_KEY, "true");
  store.setSetting(JOURNAL_ENABLED_KEY, "true");
});
afterEach(() => {
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const candidate = (ended_at: string, over: Record<string, unknown> = {}) => ({
  conv_id: "conv-1",
  harness: "claude",
  ended_at,
  ...over,
});

describe("planImport — the per-step cutoff rule", () => {
  it("queues both steps when neither step has ever run (no cutoffs)", () => {
    expect(planImport(store, candidate(daysAgo(10)), NOW)).toEqual({
      memories: QUEUED,
      journal: QUEUED,
    });
  });

  it("imports a step only for conversations that ended before that step's cutoff", () => {
    store.setSetting(IMPORT_MEMORIES_CUTOFF_KEY, daysAgo(5));
    store.setSetting(IMPORT_JOURNAL_CUTOFF_KEY, daysAgo(20));
    const plan = planImport(store, candidate(daysAgo(10)), NOW);
    expect(plan.memories).toBe(QUEUED);
    expect(plan.journal).toMatch(/after the journal cutoff .*; live capture covers it/);
  });

  it("never re-runs a step the ledger already records, whichever harness backfilled it", () => {
    recordLedger(
      dataDir,
      { harness: "*", conv: "conv-1", facts: false, journal: true, source: "backfill" },
      NOW,
    );
    const plan = planImport(store, candidate(daysAgo(10)), NOW);
    expect(plan.memories).toBe(QUEUED);
    expect(plan.journal).toMatch(/^already done on 2026-11-02$/);
  });

  it("leaves conversations from the last day to live capture", () => {
    const plan = planImport(
      store,
      candidate(new Date(NOW.getTime() - 3_600_000).toISOString()),
      NOW,
    );
    expect(plan.memories).toMatch(/less than a day ago/);
  });

  it("refuses conversations older than the server's maximum age", () => {
    writeImportConfig(store, { maxAgeDays: 30 });
    expect(planImport(store, candidate(daysAgo(31)), NOW).journal).toMatch(
      /older than the server's 30-day maximum age/,
    );
  });

  it("says the allowance is used up rather than queueing", () => {
    writeImportConfig(store, { allowanceRemaining: 0 });
    expect(planImport(store, candidate(daysAgo(10)), NOW).memories).toMatch(/allowance is used up/);
  });

  it("explains a switched-off step and honours --only", () => {
    store.setSetting(INTAKE_ENABLED_KEY, "false");
    const off = planImport(store, candidate(daysAgo(10)), NOW);
    expect(off.memories).toMatch(/curator intake is off/);
    store.setSetting(INTAKE_ENABLED_KEY, "true");
    const only = planImport(store, candidate(daysAgo(10), { only: ["journal"] }), NOW);
    expect(only).toEqual({ memories: "not requested (--only)", journal: QUEUED });
  });
});

describe("freezeImportCutoffs — set once from evidence, never moved", () => {
  it("takes the memories cutoff from the earliest intake run", () => {
    const run = store.createIntakeRun({ trigger: "tick" });
    freezeImportCutoffs(store);
    expect(readImportConfig(store).memoriesCutoff).toBe(run.created_at);
  });

  it("takes the journal cutoff from the earliest journal period, and a later backdated day doesn't move it", () => {
    const files = store.systemJournal(DEFAULT_SHELF);
    appendEpisode(files, "2026-10-20", {
      key: "a#s1",
      time: "09:00",
      harness: "claude",
      project: null,
      bullets: ["x"],
    });
    freezeImportCutoffs(store);
    const first = readImportConfig(store).journalCutoff;
    expect(first?.length).toBeGreaterThan(0);
    expect(new Date(first!).getDate()).toBe(20);

    // An import writes an older day; the cutoff stays where it was.
    appendEpisode(files, "2026-06-01", {
      key: "b#s1",
      time: "09:00",
      harness: "claude",
      project: null,
      bullets: ["y"],
    });
    freezeImportCutoffs(store);
    expect(readImportConfig(store).journalCutoff).toBe(first);
  });

  it("leaves a cutoff unset while its step has never run", () => {
    freezeImportCutoffs(store);
    expect(readImportConfig(store)).toMatchObject({ memoriesCutoff: null, journalCutoff: null });
  });
});

describe("acceptImport", () => {
  it("uses one unit of allowance and freezes an unset cutoff for each queued step", () => {
    store.setSetting(IMPORT_MEMORIES_CUTOFF_KEY, daysAgo(5));
    acceptImport(store, { memories: QUEUED, journal: QUEUED }, NOW);
    const config = readImportConfig(store);
    expect(config.allowanceRemaining).toBe(199);
    expect(config.memoriesCutoff).toBe(daysAgo(5)); // already set: unchanged
    expect(config.journalCutoff).toBe(NOW.toISOString()); // unset: frozen now
    expect(store.getSetting(IMPORT_ALLOWANCE_KEY)).toBe("199");
  });
});

describe("ensureLedger — first-use backfill from journal day files", () => {
  it("records every journalled conversation still in a day file, for any harness", () => {
    const files = store.systemJournal(DEFAULT_SHELF);
    appendEpisode(files, "2026-10-30", {
      key: "abc#s4",
      time: "09:00",
      harness: "codex",
      project: null,
      bullets: ["x"],
    });
    appendEpisode(files, "2026-10-30", {
      key: "abc#s4-1",
      time: "10:00",
      harness: "codex",
      project: null,
      bullets: ["y"],
    });
    ensureLedger(store);
    expect(lookupLedger(dataDir, "pi", "abc")).toEqual({ journal_at: "2026-10-30T00:00:00.000Z" });
    expect(lookupLedger(dataDir, "pi", "other")).toBeNull();
  });
});

describe("the settle-sweep and imported conversations", () => {
  const BUFFER =
    "### user (seq=0 ts=2026-09-01T10:00:00.000Z)\n\nShould we keep raw transcripts?\n\n" +
    "### assistant (seq=0 ts=2026-09-01T10:05:00.000Z)\n\nNo — privacy first.\n";

  function enableModel(): void {
    const provider = addProvider(store, { name: "p", endpoint: "https://e/v1", token: "dummy-t" });
    writeConsumerConfig(store, "intake", { providerId: provider.id, model: "m" });
  }

  function queue(conv: string, plan: { facts: boolean; journal: boolean } | null): void {
    const p = transcriptBufferPath(dataDir, conv);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, BUFFER, "utf8");
    fs.writeFileSync(
      transcriptHarnessMarkerPath(dataDir, conv),
      JSON.stringify({ harness: "claude", ...(plan ? { import: plan } : {}) }),
    );
    fs.writeFileSync(endedMarkerPath(dataDir, conv), "");
  }

  function client(calls: { facts: number; journal: number; reviews?: number }): LlmClient {
    return {
      complete: async ({ messages }) => {
        const system = messages[0]?.content ?? "";
        const user = messages[1]?.content ?? "";
        if (isReviewerCall(messages)) {
          calls.reviews = (calls.reviews ?? 0) + 1;
          return keepEverything(messages);
        }
        if (system.includes("Memory Extractor")) {
          calls.facts += 1;
          return {
            content: JSON.stringify({ facts: ["Raw transcripts are not kept."] }),
            model: "m",
            usage: null,
          };
        }
        if (!user.startsWith("DRAFT ENTRY:")) calls.journal += 1;
        return {
          content: JSON.stringify({ bullets: ["Chose privacy first."] }),
          model: "m",
          usage: null,
        };
      },
    };
  }

  it("runs only the steps in an import's plan, and records the conversation in the ledger", async () => {
    enableModel();
    queue("imp-1", { facts: false, journal: true });
    const calls = { facts: 0, journal: 0 };
    await runTranscriptSweepTick({ store, buildClient: () => client(calls) });
    expect(calls).toEqual({ facts: 0, journal: 1 });
    expect(lookupLedger(dataDir, "claude", "imp-1")).toMatchObject({
      journal_at: expect.any(String),
    });
    expect(lookupLedger(dataDir, "claude", "imp-1")?.facts_at).toBeUndefined();
  });

  it("reviews the facts of an imported conversation", async () => {
    enableModel();
    queue("imp-1", { facts: true, journal: false });
    const calls = { facts: 0, journal: 0, reviews: 0 };
    const summary = await runTranscriptSweepTick({ store, buildClient: () => client(calls) });
    expect(calls.reviews).toBe(1);
    expect(summary.review.reviewed).toBe(1);
  });

  it("records live conversations in the ledger too", async () => {
    enableModel();
    queue("live-1", null);
    await runTranscriptSweepTick({ store, buildClient: () => client({ facts: 0, journal: 0 }) });
    expect(lookupLedger(dataDir, "claude", "live-1")).toMatchObject({
      facts_at: expect.any(String),
      journal_at: expect.any(String),
    });
  });

  it("processes live buffers first and only a few imports per tick", async () => {
    enableModel();
    queue("imp-a", { facts: true, journal: true });
    queue("imp-b", { facts: true, journal: true });
    queue("live-z", null);
    const summary = await runTranscriptSweepTick({
      store,
      importsPerTick: 1,
      buildClient: () => client({ facts: 0, journal: 0 }),
    });
    expect(summary.extracted).toBe(2);
    expect(lookupLedger(dataDir, "claude", "live-z")).not.toBeNull();
    expect(lookupLedger(dataDir, "claude", "imp-a")).not.toBeNull();
    expect(lookupLedger(dataDir, "claude", "imp-b")).toBeNull();
    expect(fs.existsSync(transcriptBufferPath(dataDir, "imp-b"))).toBe(true);
  });
});
