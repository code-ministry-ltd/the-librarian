// Import policy (spec 079 §2, §5): which past conversations `librarian import` may
// send through which step.
//
// THE RULE. Each step imports only conversations that ENDED BEFORE that step first
// ran; after that, live capture owns the conversation and importing it again could
// only duplicate. Two cutoffs, one per step, FROZEN once set:
//
//   memories_cutoff — the earliest intake run (duplicate memories only come from intake
//                     mining a conversation twice; manual `remember` calls don't count).
//   journal_cutoff  — the start of the earliest journal period on disk.
//
// A cutoff is computed from existing data the first time it is needed, or set to "now"
// the first time an import is accepted for a step that has never run. It never moves
// again: imports write backdated journal entries and start intake runs, and a
// recomputed "earliest" would shift under a second import or a second machine.
//
// On top of the rule, two server-enforced limits keep an import from flooding the
// model: a maximum age (days) and an allowance (conversations, used one per accepted
// conversation, reset from the dashboard).

import { isIntakeEnabled } from "../intake-config.js";
import { journalShelves } from "../journal/compaction.js";
import { isJournalActive } from "../journal/config.js";
import { listJournalFiles } from "../journal/journal.js";
import type { LibrarianStore } from "../store/librarian-store.js";
import { sanitizeConvId } from "../transcript-buffer.js";
import { lookupLedger } from "./ledger.js";

export const IMPORT_MEMORIES_CUTOFF_KEY = "import.memories_cutoff";
export const IMPORT_JOURNAL_CUTOFF_KEY = "import.journal_cutoff";
export const IMPORT_MAX_AGE_DAYS_KEY = "import.max_age_days";
export const IMPORT_ALLOWANCE_KEY = "import.allowance_remaining";

export const DEFAULT_IMPORT_MAX_AGE_DAYS = 90;
export const DEFAULT_IMPORT_ALLOWANCE = 200;
export const MAX_IMPORT_MAX_AGE_DAYS = 3650;
export const MAX_IMPORT_ALLOWANCE = 100_000;
/** A conversation that ended this recently may still be live: capture owns it. */
export const IMPORT_MIN_AGE_MS = 24 * 60 * 60_000;

export type ImportStep = "memories" | "journal";

export interface ImportConfig {
  maxAgeDays: number;
  allowanceRemaining: number;
  memoriesCutoff: string | null;
  journalCutoff: string | null;
}

export interface ImportPolicy extends ImportConfig {
  intake: "enabled" | "disabled";
  journal: "enabled" | "disabled";
}

function boundedInt(raw: string | null, fallback: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : fallback;
}

function validIso(raw: string | null): string | null {
  if (!raw) return null;
  return Number.isFinite(Date.parse(raw)) ? raw : null;
}

export function readImportConfig(store: Pick<LibrarianStore, "getSetting">): ImportConfig {
  return {
    maxAgeDays: boundedInt(
      store.getSetting(IMPORT_MAX_AGE_DAYS_KEY),
      DEFAULT_IMPORT_MAX_AGE_DAYS,
      MAX_IMPORT_MAX_AGE_DAYS,
    ),
    allowanceRemaining: boundedInt(
      store.getSetting(IMPORT_ALLOWANCE_KEY),
      DEFAULT_IMPORT_ALLOWANCE,
      MAX_IMPORT_ALLOWANCE,
    ),
    memoriesCutoff: validIso(store.getSetting(IMPORT_MEMORIES_CUTOFF_KEY)),
    journalCutoff: validIso(store.getSetting(IMPORT_JOURNAL_CUTOFF_KEY)),
  };
}

export class ImportConfigError extends Error {}

/** Save the dashboard's import limits. The cutoffs are not editable. */
export function writeImportConfig(
  store: Pick<LibrarianStore, "setSetting">,
  patch: { maxAgeDays?: number | undefined; allowanceRemaining?: number | undefined },
): void {
  if (patch.maxAgeDays !== undefined) {
    if (
      !Number.isInteger(patch.maxAgeDays) ||
      patch.maxAgeDays < 1 ||
      patch.maxAgeDays > MAX_IMPORT_MAX_AGE_DAYS
    ) {
      throw new ImportConfigError(
        `Expected the maximum age as a whole number of days from 1 to ${MAX_IMPORT_MAX_AGE_DAYS}, got ${patch.maxAgeDays}`,
      );
    }
    store.setSetting(IMPORT_MAX_AGE_DAYS_KEY, String(patch.maxAgeDays));
  }
  if (patch.allowanceRemaining !== undefined) {
    if (
      !Number.isInteger(patch.allowanceRemaining) ||
      patch.allowanceRemaining < 0 ||
      patch.allowanceRemaining > MAX_IMPORT_ALLOWANCE
    ) {
      throw new ImportConfigError(
        `Expected the allowance as a whole number of conversations from 0 to ${MAX_IMPORT_ALLOWANCE}, got ${patch.allowanceRemaining}`,
      );
    }
    store.setSetting(IMPORT_ALLOWANCE_KEY, String(patch.allowanceRemaining));
  }
}

/** The created_at of the earliest intake run, or null when intake has never run. */
function earliestIntakeRun(store: LibrarianStore): string | null {
  let earliest: string | null = null;
  let before: string | undefined;
  for (let page = 0; page < 10_000; page += 1) {
    const runs = store.listIntakeRuns({ limit: 200, ...(before ? { before } : {}) });
    if (runs.length === 0) break;
    for (const run of runs) {
      if (earliest === null || run.created_at < earliest) earliest = run.created_at;
    }
    before = runs[runs.length - 1]?.id;
    if (runs.length < 200) break;
  }
  return earliest;
}

/** The start (local midnight) of the earliest journal period on disk, or null. */
function earliestJournalPeriod(store: LibrarianStore): string | null {
  let earliest: string | null = null;
  for (const shelf of journalShelves(store)) {
    try {
      for (const file of listJournalFiles(store.systemJournal(shelf))) {
        if (earliest === null || file.period.first < earliest) earliest = file.period.first;
      }
    } catch {
      // an unreadable shelf contributes nothing
    }
  }
  if (earliest === null) return null;
  const [y, m, d] = earliest.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toISOString();
}

/**
 * Freeze any cutoff that is still unset but now has evidence: the earliest intake run
 * for memories, the earliest journal period for the journal. A cutoff with no
 * evidence stays unset (that step has never run, so all history is eligible). Called
 * by the settle-sweep each tick and before every import decision. Fail-soft.
 */
export function freezeImportCutoffs(store: LibrarianStore): void {
  try {
    if (validIso(store.getSetting(IMPORT_MEMORIES_CUTOFF_KEY)) === null) {
      const at = earliestIntakeRun(store);
      if (at) store.setSetting(IMPORT_MEMORIES_CUTOFF_KEY, at);
    }
  } catch {
    // retried next time
  }
  try {
    if (validIso(store.getSetting(IMPORT_JOURNAL_CUTOFF_KEY)) === null) {
      const at = earliestJournalPeriod(store);
      if (at) store.setSetting(IMPORT_JOURNAL_CUTOFF_KEY, at);
    }
  } catch {
    // retried next time
  }
}

/** What `GET /import/policy` reports: the switches, the cutoffs and the limits. */
export function importPolicy(store: LibrarianStore): ImportPolicy {
  freezeImportCutoffs(store);
  return {
    intake: isIntakeEnabled(store) ? "enabled" : "disabled",
    journal: isJournalActive(store) ? "enabled" : "disabled",
    ...readImportConfig(store),
  };
}

export interface ImportCandidate {
  conv_id: string;
  harness: string;
  /** When the conversation's last turn happened (ISO-8601). */
  ended_at: string;
  /** Restrict to these steps (the CLI's `--only`); absent = both. */
  only?: ImportStep[];
}

/** Per step: "queued", or a sentence saying why not. */
export interface ImportPlan {
  memories: string;
  journal: string;
}

export const QUEUED = "queued";

function day(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Decide, without changing anything, which steps an import of this conversation
 * would run. `allowanceRemaining` lets a batch plan account for the conversations
 * ahead of it.
 */
export function planImport(
  store: LibrarianStore,
  candidate: ImportCandidate,
  now: Date,
  allowanceRemaining?: number,
): ImportPlan {
  const config = readImportConfig(store);
  const endedMs = Date.parse(candidate.ended_at);
  const conv = sanitizeConvId(candidate.conv_id);
  const known = lookupLedger(store.dataDir, candidate.harness, conv);

  const decide = (step: ImportStep): string => {
    const enabled = step === "memories" ? isIntakeEnabled(store) : isJournalActive(store);
    if (!enabled) {
      return step === "memories"
        ? "curator intake is off on the server, so no memories are filed"
        : "the journal is off on the server";
    }
    if (candidate.only && !candidate.only.includes(step)) return "not requested (--only)";
    if (!Number.isFinite(endedMs)) {
      return `the conversation's end time '${candidate.ended_at}' isn't an ISO-8601 timestamp`;
    }
    const doneAt = step === "memories" ? known?.facts_at : known?.journal_at;
    if (doneAt) return `already done on ${day(doneAt)}`;
    if (now.getTime() - endedMs < IMPORT_MIN_AGE_MS) {
      return "ended less than a day ago; live capture covers recent conversations";
    }
    if (now.getTime() - endedMs > config.maxAgeDays * 24 * 60 * 60_000) {
      return `older than the server's ${config.maxAgeDays}-day maximum age`;
    }
    const cutoff = step === "memories" ? config.memoriesCutoff : config.journalCutoff;
    if (cutoff && endedMs >= Date.parse(cutoff)) {
      const what = step === "memories" ? "memories" : "journal";
      return `ended ${day(candidate.ended_at)}, after the ${what} cutoff ${day(cutoff)}; live capture covers it`;
    }
    return QUEUED;
  };

  const plan: ImportPlan = { memories: decide("memories"), journal: decide("journal") };
  const remaining = allowanceRemaining ?? config.allowanceRemaining;
  if ((plan.memories === QUEUED || plan.journal === QUEUED) && remaining <= 0) {
    const full = "the server's import allowance is used up; raise it on Settings → Curator";
    if (plan.memories === QUEUED) plan.memories = full;
    if (plan.journal === QUEUED) plan.journal = full;
  }
  return plan;
}

/** Does this plan send the conversation anywhere? */
export function planQueuesAnything(plan: ImportPlan): boolean {
  return plan.memories === QUEUED || plan.journal === QUEUED;
}

/**
 * Commit an accepted import: use one unit of allowance and, for each queued step whose
 * cutoff is still unset, freeze it at `now` (from here on, live capture owns that step).
 */
export function acceptImport(store: LibrarianStore, plan: ImportPlan, now: Date): void {
  const config = readImportConfig(store);
  store.setSetting(IMPORT_ALLOWANCE_KEY, String(Math.max(0, config.allowanceRemaining - 1)));
  if (plan.memories === QUEUED && !config.memoriesCutoff) {
    store.setSetting(IMPORT_MEMORIES_CUTOFF_KEY, now.toISOString());
  }
  if (plan.journal === QUEUED && !config.journalCutoff) {
    store.setSetting(IMPORT_JOURNAL_CUTOFF_KEY, now.toISOString());
  }
}
