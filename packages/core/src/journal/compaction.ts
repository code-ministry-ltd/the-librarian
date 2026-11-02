// Journal compaction (spec 077 §4.3): once a day, roll day files older than the day
// tier into ISO-week summaries, and week summaries older than the week tier into
// month summaries. Nothing is ever deleted by age (D8): month files persist.
//
// CRASH SAFETY. A roll-up writes its target FIRST, then deletes its sources, and the
// target carries a ledger of every source it already absorbed (`path@hash`). A crash
// between the two commits leaves sources that the next run recognises in the ledger
// and simply deletes — never a gap, never a double summary. A source that arrives
// late for an already-rolled period (a conversation dated into a closed week) is NOT
// in the ledger, so it is folded into the existing summary on the next run.
//
// FAIL-SOFT. A failed model call leaves that period's sources in place for tomorrow;
// a provider that is down stops the run. The tick never rejects.

import { SYSTEM_ACTOR_IDS, type Principal } from "../caller-identity.js";
import {
  type ConsumerConnection,
  consumerConnection,
  migrateLegacyCuratorLlm,
  readConsumerConfig,
  resolveConsumerToken,
} from "../curator-consumers.js";
import { isCuratorPausedForRestore } from "../curator-pause.js";
import { redactSecrets } from "../grooming-redaction.js";
import {
  type LlmClient,
  createGroomingLlmClient,
  isProviderUnavailableError,
} from "../grooming-llm-client.js";
import { commitSubject } from "../store/commit-message.js";
import type { JournalFileStore } from "../store/journal-types.js";
import type { LibrarianStore } from "../store/librarian-store.js";
import { type Shelf, validateShelfSet } from "../vault-router.js";
import {
  isJournalActive,
  readLastJournalCompaction,
  writeLastJournalCompaction,
} from "./config.js";
import { contentHash, parseRollup, renderRollup, type RollupSource } from "./format.js";
import { type JournalFile, listJournalFiles, renderForAgent } from "./journal.js";
import {
  type JournalPeriod,
  isMonthClosedForRollup,
  isPastDayTier,
  isWeekClosedForRollup,
  isWeekPastWeekTier,
  isoWeekOf,
  localDate,
  monthOfWeek,
  monthPeriod,
  weekPeriod,
} from "./periods.js";
import { summarizeRollup } from "./summarize.js";

/** Local time the daily compaction becomes due (spec 077 §4.3). */
export const JOURNAL_COMPACTION_TIME = { hour: 2, minute: 30 } as const;

type Warn = (info: Record<string, unknown>, msg: string) => void;

export interface JournalCompactionOptions {
  store: LibrarianStore;
  now?: () => Date;
  /** Injectable client builder (tests); defaults to the intake consumer's client. */
  buildClient?: (conn: ConsumerConnection, token: string) => LlmClient;
  warn?: Warn;
  /** Run even when not due today (tests, a future "compact now"). */
  force?: boolean;
}

export interface JournalCompactionSummary {
  ran: boolean;
  reason?: "disabled" | "paused" | "not_due" | "no_client";
  rolledWeeks: number;
  rolledMonths: number;
  /** Source sets deleted because the target ledger already held them (crash recovery). */
  recovered: number;
  failed: number;
  stoppedEarly: boolean;
}

/** Is compaction due at `now`, given the date it last ran? */
export function isJournalCompactionDue(now: Date, lastRunDate: string | null): boolean {
  const today = localDate(now);
  if (lastRunDate === today) return false;
  const due = new Date(now);
  due.setHours(JOURNAL_COMPACTION_TIME.hour, JOURNAL_COMPACTION_TIME.minute, 0, 0);
  return now.getTime() >= due.getTime();
}

/** Build the LLM client from the intake consumer config, or null when it isn't usable. */
export function buildJournalLlmClient(
  store: LibrarianStore,
  inject: JournalCompactionOptions["buildClient"],
  warn: Warn,
): LlmClient | null {
  try {
    migrateLegacyCuratorLlm(store);
    const llm = readConsumerConfig(store, "intake");
    if (!llm.isOperational) return null;
    let token: string | null;
    try {
      token = resolveConsumerToken(store, "intake");
    } catch {
      return null;
    }
    if (!token) return null;
    const build = inject ?? ((conn, secret) => createGroomingLlmClient({ ...conn, token: secret }));
    return build(consumerConnection(llm), token);
  } catch (err) {
    warn({ err: (err as Error).message }, "journal LLM client build failed (fail-soft)");
    return null;
  }
}

/** The shelves the system pipelines tend (the groom set), deduplicated and validated. */
export function journalShelves(store: LibrarianStore): Shelf[] {
  const principal: Principal = {
    kind: "system",
    actorId: SYSTEM_ACTOR_IDS.scheduler,
    roles: ["system"],
  };
  const seen = new Set<string>();
  const out: Shelf[] = [];
  for (const shelf of store.vaultRouter.shelves(principal, "groom")) {
    if (seen.has(shelf.prefix)) continue;
    try {
      validateShelfSet([shelf]);
    } catch {
      continue;
    }
    seen.add(shelf.prefix);
    out.push(shelf);
  }
  return out;
}

type RollupResult = "rolled" | "recovered" | "failed" | "unavailable";

async function rollupPeriod(
  files: JournalFileStore,
  target: JournalPeriod,
  sources: JournalFile[],
  llm: LlmClient,
  warn: Warn,
): Promise<RollupResult> {
  const existingRaw = files.read(target.path);
  const existing = existingRaw === null ? null : parseRollup(existingRaw);
  const ledger = new Set((existing?.sources ?? []).map((s) => `${s.path}@${s.hash}`));
  const withHash = sources.map((file) => ({
    file,
    source: { path: file.period.path, hash: contentHash(file.raw) } satisfies RollupSource,
  }));
  const fresh = withHash.filter(({ source }) => !ledger.has(`${source.path}@${source.hash}`));
  const subject = commitSubject.journalRollup(target.label);

  if (fresh.length === 0) {
    // Every source is already in the target: a crash between write and delete. Finish it.
    files.remove(
      sources.map((s) => s.period.path),
      subject,
    );
    return "recovered";
  }

  const outcome = await summarizeRollup(
    target,
    {
      existing: existing?.body ?? null,
      entries: fresh.map(({ file }) => renderForAgent(file)),
    },
    llm,
  );
  if (!outcome.ok) {
    warn(
      { period: target.label, err: (outcome.error as Error | undefined)?.message ?? "unknown" },
      "journal roll-up failed; sources kept for the next run",
    );
    return isProviderUnavailableError(outcome.error) ? "unavailable" : "failed";
  }
  const content = renderRollup(target, {
    sources: [...(existing?.sources ?? []), ...fresh.map(({ source }) => source)],
    // Defense in depth before the summary is committed to the git vault.
    body: redactSecrets(outcome.value).redacted,
  });
  files.write(target.path, content, subject); // target FIRST …
  files.remove(
    sources.map((s) => s.period.path),
    subject,
  ); // … then the sources
  return "rolled";
}

/** Group values by a key, preserving first-seen key order. */
function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    out.set(k, [...(out.get(k) ?? []), item]);
  }
  return out;
}

/**
 * Compact one shelf's journal. Exported for tests; the tick calls it per shelf.
 * Returns false when a provider outage should stop the whole run.
 */
export async function compactShelfJournal(
  files: JournalFileStore,
  today: string,
  llm: LlmClient,
  summary: JournalCompactionSummary,
  warn: Warn,
): Promise<boolean> {
  const tally = (result: RollupResult, tier: "week" | "month"): boolean => {
    if (result === "rolled") {
      if (tier === "week") summary.rolledWeeks += 1;
      else summary.rolledMonths += 1;
    } else if (result === "recovered") summary.recovered += 1;
    else summary.failed += 1;
    return result !== "unavailable";
  };

  // Days → weeks.
  const oldDays = listJournalFiles(files).filter(
    (f) => f.period.tier === "day" && isPastDayTier(f.period.label, today),
  );
  for (const [week, days] of groupBy(oldDays, (f) => isoWeekOf(f.period.label))) {
    if (!isWeekClosedForRollup(week, today)) continue;
    if (!tally(await rollupPeriod(files, weekPeriod(week), days, llm, warn), "week")) return false;
  }

  // Weeks → months. Re-list: the pass above changed the files.
  const after = listJournalFiles(files);
  // Months that still own unrolled day files (their week roll-up failed or is pending).
  const monthsWithLeftoverDays = new Set(
    after.filter((f) => f.period.tier === "day").map((f) => monthOfWeek(isoWeekOf(f.period.label))),
  );
  const oldWeeks = after.filter(
    (f) => f.period.tier === "week" && isWeekPastWeekTier(f.period.label, today),
  );
  for (const [month, weeks] of groupBy(oldWeeks, (f) => monthOfWeek(f.period.label))) {
    if (!isMonthClosedForRollup(month, today)) continue;
    // A week of this month still has day files (its roll-up failed): wait, so the month
    // summary is never built without them.
    if (monthsWithLeftoverDays.has(month)) continue;
    if (!tally(await rollupPeriod(files, monthPeriod(month), weeks, llm, warn), "month")) {
      return false;
    }
  }
  return true;
}

/**
 * One scheduler poll. Self-gates on restore-pause, the journal gate and the daily due
 * time; stamps the day as done once it has tried every shelf (a failed period retries
 * tomorrow). Never rejects.
 */
export async function runJournalCompactionTick(
  options: JournalCompactionOptions,
): Promise<JournalCompactionSummary> {
  const { store } = options;
  const warn: Warn = options.warn ?? (() => {});
  const now = (options.now ?? (() => new Date()))();
  const summary: JournalCompactionSummary = {
    ran: false,
    rolledWeeks: 0,
    rolledMonths: 0,
    recovered: 0,
    failed: 0,
    stoppedEarly: false,
  };
  try {
    if (isCuratorPausedForRestore(store, now)) return { ...summary, reason: "paused" };
    if (!isJournalActive(store)) return { ...summary, reason: "disabled" };
    if (!options.force && !isJournalCompactionDue(now, readLastJournalCompaction(store))) {
      return { ...summary, reason: "not_due" };
    }
    const llm = buildJournalLlmClient(store, options.buildClient, warn);
    if (!llm) return { ...summary, reason: "no_client" };

    summary.ran = true;
    const today = localDate(now);
    for (const shelf of journalShelves(store)) {
      try {
        const keepGoing = await compactShelfJournal(
          store.systemJournal(shelf),
          today,
          llm,
          summary,
          warn,
        );
        if (!keepGoing) {
          summary.stoppedEarly = true;
          break;
        }
      } catch (err) {
        summary.failed += 1;
        warn(
          { shelf: shelf.id, err: (err as Error).message },
          "journal compaction failed for a shelf",
        );
      }
    }
    if (!summary.stoppedEarly) writeLastJournalCompaction(store, today);
  } catch (err) {
    warn({ err: (err as Error).message }, "journal compaction tick failed (fail-soft)");
  }
  return summary;
}
