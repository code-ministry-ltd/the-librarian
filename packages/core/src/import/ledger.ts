// The conversation ledger (spec 079 §3): a durable record of which capture steps have
// run for which conversation, written by the settle-sweep when a step completes — for
// live capture and imports alike. Its one job is stopping a conversation being
// imported twice (a re-run, a second machine, a synced folder). Eligibility comes from
// the frozen cutoffs (./policy.ts), not from this file.
//
// One JSON file beside the other sidecars (outside the git vault). Rows are tiny and
// never pruned; writes are whole-file, via a temp file + rename, so a crash leaves
// either the old ledger or the new one, never half of one.

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SHELF } from "../vault-router.js";
import type { LibrarianStore } from "../store/librarian-store.js";
import { parseDay } from "../journal/format.js";
import { journalShelves } from "../journal/compaction.js";
import { listJournalFiles } from "../journal/journal.js";

export const CONVERSATION_LEDGER_FILE = "conversation-ledger.json";

/** A row backfilled from journal files carries no harness: it matches any. */
export const ANY_HARNESS = "*";

export interface LedgerRow {
  harness: string;
  conv: string;
  /** When the memories (facts) step finished, ISO-8601. */
  facts_at?: string;
  /** When the journal step finished, ISO-8601. */
  journal_at?: string;
  source: "live" | "import" | "backfill";
}

interface LedgerFile {
  version: 1;
  rows: Record<string, LedgerRow>;
}

function ledgerPath(dataDir: string): string {
  return path.join(dataDir, CONVERSATION_LEDGER_FILE);
}

function rowKey(harness: string, conv: string): string {
  return `${harness}\u0000${conv}`;
}

function readFile(dataDir: string): LedgerFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(dataDir), "utf8")) as LedgerFile;
    if (parsed && parsed.version === 1 && typeof parsed.rows === "object" && parsed.rows) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function writeFile(dataDir: string, ledger: LedgerFile): void {
  const target = ledgerPath(dataDir);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(ledger), "utf8");
  fs.renameSync(tmp, target);
}

/** Does the ledger exist yet? (It is created on first use, with the journal backfill.) */
export function ledgerExists(dataDir: string): boolean {
  return fs.existsSync(ledgerPath(dataDir));
}

/**
 * What the ledger knows about one conversation: its own row merged with any
 * harness-less backfill row for the same id. Null when it has never been seen.
 */
export function lookupLedger(
  dataDir: string,
  harness: string,
  conv: string,
): { facts_at?: string; journal_at?: string } | null {
  const ledger = readFile(dataDir);
  if (!ledger) return null;
  const own = ledger.rows[rowKey(harness, conv)];
  const any = ledger.rows[rowKey(ANY_HARNESS, conv)];
  if (!own && !any) return null;
  const facts_at = own?.facts_at ?? any?.facts_at;
  const journal_at = own?.journal_at ?? any?.journal_at;
  return { ...(facts_at ? { facts_at } : {}), ...(journal_at ? { journal_at } : {}) };
}

/** Record that steps finished for a conversation. Earlier timestamps are kept. */
export function recordLedger(
  dataDir: string,
  entry: {
    harness: string;
    conv: string;
    facts: boolean;
    journal: boolean;
    source: LedgerRow["source"];
  },
  at: Date,
): void {
  if (!entry.facts && !entry.journal) return;
  const ledger = readFile(dataDir) ?? { version: 1 as const, rows: {} };
  const key = rowKey(entry.harness, entry.conv);
  const existing = ledger.rows[key];
  const iso = at.toISOString();
  ledger.rows[key] = {
    harness: entry.harness,
    conv: entry.conv,
    source: existing?.source ?? entry.source,
    ...(existing?.facts_at || entry.facts ? { facts_at: existing?.facts_at ?? iso } : {}),
    ...(existing?.journal_at || entry.journal ? { journal_at: existing?.journal_at ?? iso } : {}),
  };
  writeFile(dataDir, ledger);
}

/** How many conversations the ledger holds (for the dashboard). */
export function ledgerSize(dataDir: string): number {
  return Object.keys(readFile(dataDir)?.rows ?? {}).length;
}

/**
 * Create the ledger on first use, seeded from the journal day files still on disk:
 * every episode key (`<conv>#s<seq>[-n]`) proves the journal step ran for `<conv>`.
 * Day files carry no harness, so these rows match any harness. Older journal history
 * has been rolled into week and month summaries, which keep no conversation ids; the
 * frozen journal cutoff covers that period instead. Idempotent and fail-soft.
 */
export function ensureLedger(store: LibrarianStore): void {
  if (ledgerExists(store.dataDir)) return;
  const ledger: LedgerFile = { version: 1, rows: {} };
  let shelves = [DEFAULT_SHELF];
  try {
    shelves = journalShelves(store);
  } catch {
    // keep the default shelf
  }
  for (const shelf of shelves) {
    try {
      for (const file of listJournalFiles(store.systemJournal(shelf))) {
        if (file.period.tier !== "day") continue;
        for (const episode of parseDay(file.period.label, file.raw).episodes) {
          const conv = episode.key.replace(/#s\d+(?:-\d+)?$/, "");
          if (!conv) continue;
          ledger.rows[rowKey(ANY_HARNESS, conv)] = {
            harness: ANY_HARNESS,
            conv,
            source: "backfill",
            journal_at: `${file.period.label}T00:00:00.000Z`,
          };
        }
      }
    } catch {
      // A shelf whose journal can't be read contributes nothing.
    }
  }
  writeFile(store.dataDir, ledger);
}
