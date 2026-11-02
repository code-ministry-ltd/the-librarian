// Journal settings (spec 077 §4.7). Plain (non-secret) admin settings, readable
// without the master key so the dashboard can always render them.
//
// The journal rides the transcript settle-sweep, which is itself gated on curator
// intake, so `isJournalActive` is the ONE gate every journal writer and reader
// consults: the journal setting AND the intake gate.

import { z } from "zod";
import { isIntakeEnabled } from "../intake-config.js";
import type { LlmConnectionReader, LlmConnectionWriter } from "../llm-connection.js";

export const JOURNAL_ENABLED_KEY = "curator.journal.enabled";
export const JOURNAL_INJECT_BUDGET_KEY = "curator.journal.inject_budget_tokens";
/** Local date (`YYYY-MM-DD`) of the last compaction run that finished. */
export const JOURNAL_LAST_COMPACTION_KEY = "curator.journal.last_compaction_date";

export const DEFAULT_JOURNAL_INJECT_BUDGET_TOKENS = 20_000;
export const MIN_JOURNAL_INJECT_BUDGET_TOKENS = 2_000;
export const MAX_JOURNAL_INJECT_BUDGET_TOKENS = 100_000;

export interface JournalConfig {
  /** The operator's journal switch (default off — spec 077 D4). */
  enabled: boolean;
  /** Token budget for the session-start recent window (chars ÷ 4). */
  injectBudgetTokens: number;
}

export interface JournalConfigPatch {
  enabled?: boolean;
  injectBudgetTokens?: number;
}

export const JournalConfigPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  injectBudgetTokens: z.number().optional(),
});

type ConfigReader = LlmConnectionReader;
type ConfigWriter = LlmConnectionWriter;

export function readJournalConfig(store: ConfigReader): JournalConfig {
  const raw = store.getSetting(JOURNAL_INJECT_BUDGET_KEY);
  const n = Number(raw);
  const budget =
    raw !== null &&
    Number.isInteger(n) &&
    n >= MIN_JOURNAL_INJECT_BUDGET_TOKENS &&
    n <= MAX_JOURNAL_INJECT_BUDGET_TOKENS
      ? n
      : DEFAULT_JOURNAL_INJECT_BUDGET_TOKENS;
  return {
    enabled: store.getSetting(JOURNAL_ENABLED_KEY) === "true",
    injectBudgetTokens: budget,
  };
}

/** Validate + persist a journal settings patch. Throws a teaching error on a bad budget. */
export function writeJournalConfig(store: ConfigWriter, patch: JournalConfigPatch): void {
  if (patch.injectBudgetTokens !== undefined) {
    const n = patch.injectBudgetTokens;
    if (
      !Number.isInteger(n) ||
      n < MIN_JOURNAL_INJECT_BUDGET_TOKENS ||
      n > MAX_JOURNAL_INJECT_BUDGET_TOKENS
    ) {
      throw new Error(
        `Journal injection budget must be a whole number of tokens from ` +
          `${MIN_JOURNAL_INJECT_BUDGET_TOKENS} to ${MAX_JOURNAL_INJECT_BUDGET_TOKENS}, got ${n}`,
      );
    }
  }
  if (patch.enabled !== undefined) {
    store.setSetting(JOURNAL_ENABLED_KEY, patch.enabled ? "true" : "false");
  }
  if (patch.injectBudgetTokens !== undefined) {
    store.setSetting(JOURNAL_INJECT_BUDGET_KEY, String(patch.injectBudgetTokens));
  }
}

/**
 * Is the journal live? Its own switch AND the intake gate it rides on. Fail-soft:
 * a settings read error reads as "off", the safe no-write value.
 */
export function isJournalActive(store: ConfigReader): boolean {
  try {
    return readJournalConfig(store).enabled && isIntakeEnabled(store);
  } catch {
    return false;
  }
}

export function readLastJournalCompaction(store: ConfigReader): string | null {
  const raw = store.getSetting(JOURNAL_LAST_COMPACTION_KEY);
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

export function writeLastJournalCompaction(store: ConfigWriter, date: string): void {
  store.setSetting(JOURNAL_LAST_COMPACTION_KEY, date);
}
