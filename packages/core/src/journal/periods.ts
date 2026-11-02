// Journal periods (spec 077 §4.1/§4.3): the day / ISO-week / month files the journal
// is made of, their vault-relative paths, and the age arithmetic compaction and the
// recent window run on. Pure + clock-injected, so every boundary is unit-testable.
//
// Every date here is a SERVER-LOCAL calendar date (`YYYY-MM-DD`), matching how
// Chronicle labels its weeks: the journal is read by a person in one timezone, and a
// conversation that ends at 00:30 local belongs to that local day.

/** The three tiers a journal file can belong to. */
export type JournalTier = "day" | "week" | "month";

/** One journal file's period, derived from its path. */
export interface JournalPeriod {
  tier: JournalTier;
  /** `2026-11-02`, `2026-W44`, or `2026-10`. */
  label: string;
  /** Inclusive first local date, `YYYY-MM-DD`. */
  first: string;
  /** Inclusive last local date, `YYYY-MM-DD`. */
  last: string;
  /** Journal-relative path: `days/<label>.md`, `weeks/<label>.md`, `months/<label>.md`. */
  path: string;
}

const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const WEEK_RE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Days of detail kept as individual episodes (spec 077 §4.3). */
export const DAY_TIER_DAYS = 14;
/** Age after which week summaries roll into months (spec 077 §4.3). */
export const WEEK_TIER_DAYS = 90;
/** How many week summaries the recent window carries (spec 077 §4.4, D6). */
export const RECENT_WINDOW_WEEKS = 4;

/** Format a Date as its server-local calendar date. */
export function localDate(value: Date): string {
  return [
    String(value.getFullYear()).padStart(4, "0"),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ].join("-");
}

/** Parse `YYYY-MM-DD` into local midnight. Throws a teaching error on a malformed date. */
export function parseLocalDate(label: string): Date {
  if (!DAY_RE.test(label)) {
    throw new Error(`Expected a date as YYYY-MM-DD, got '${label}'`);
  }
  const [y, m, d] = label.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  // Reject roll-overs such as 2026-02-31 → 2026-03-03.
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
    throw new Error(`Expected a real calendar date as YYYY-MM-DD, got '${label}'`);
  }
  return date;
}

/** True when `label` is a real `YYYY-MM-DD` calendar date. */
export function isLocalDate(label: string): boolean {
  try {
    parseLocalDate(label);
    return true;
  } catch {
    return false;
  }
}

/** Shift a local date label by whole days. */
export function addDays(label: string, days: number): string {
  const date = parseLocalDate(label);
  return localDate(new Date(date.getFullYear(), date.getMonth(), date.getDate() + days));
}

/** Monday of the ISO week containing `label`. */
function weekMonday(label: string): string {
  const date = parseLocalDate(label);
  const daysSinceMonday = (date.getDay() + 6) % 7;
  return addDays(label, -daysSinceMonday);
}

/** ISO week label (`2026-W44`) of the week containing `label`. */
export function isoWeekOf(label: string): string {
  const date = parseLocalDate(label);
  const probe = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = probe.getUTCDay() || 7;
  probe.setUTCDate(probe.getUTCDate() + 4 - day);
  const weekYear = probe.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil(((probe.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}

/** First (Monday) and last (Sunday) local dates of an ISO week label. */
function weekBounds(label: string): { first: string; last: string } {
  const [yRaw, wRaw] = label.split("-W") as [string, string];
  const year = Number(yRaw);
  const week = Number(wRaw);
  // ISO week 1 is the week containing 4 January.
  const jan4 = localDate(new Date(year, 0, 4));
  const first = addDays(weekMonday(jan4), (week - 1) * 7);
  return { first, last: addDays(first, 6) };
}

/** First and last local dates of a `YYYY-MM` month. */
function monthBounds(label: string): { first: string; last: string } {
  const [y, m] = label.split("-").map(Number) as [number, number];
  return {
    first: localDate(new Date(y, m - 1, 1)),
    last: localDate(new Date(y, m, 0)),
  };
}

/**
 * The month a week belongs to: the month of its Thursday (the ISO convention), so
 * every week lands in exactly one month even when it straddles a month boundary.
 */
export function monthOfWeek(weekLabel: string): string {
  const { first } = weekBounds(weekLabel);
  return addDays(first, 3).slice(0, 7);
}

export function dayPeriod(label: string): JournalPeriod {
  parseLocalDate(label);
  return { tier: "day", label, first: label, last: label, path: `days/${label}.md` };
}

export function weekPeriod(label: string): JournalPeriod {
  if (!WEEK_RE.test(label)) throw new Error(`Expected an ISO week as YYYY-Www, got '${label}'`);
  return { tier: "week", label, ...weekBounds(label), path: `weeks/${label}.md` };
}

export function monthPeriod(label: string): JournalPeriod {
  if (!MONTH_RE.test(label)) throw new Error(`Expected a month as YYYY-MM, got '${label}'`);
  return { tier: "month", label, ...monthBounds(label), path: `months/${label}.md` };
}

/**
 * Parse a journal-relative path back into its period. Returns null for anything
 * that is not exactly one of the three canonical shapes — a stray file in the
 * journal folder is ignored, never misread.
 */
export function periodFromPath(relPath: string): JournalPeriod | null {
  const match = /^(days|weeks|months)\/([^/]+)\.md$/.exec(relPath);
  if (!match) return null;
  const [, dir, label] = match as unknown as [string, string, string];
  try {
    if (dir === "days") return dayPeriod(label);
    if (dir === "weeks") return weekPeriod(label);
    return monthPeriod(label);
  } catch {
    return null;
  }
}

/** Order periods oldest-first (by first date, then finer tier first on a tie). */
export function comparePeriods(a: JournalPeriod, b: JournalPeriod): number {
  if (a.first !== b.first) return a.first < b.first ? -1 : 1;
  const rank: Record<JournalTier, number> = { month: 0, week: 1, day: 2 };
  return rank[a.tier] - rank[b.tier];
}

/** Does `[first, last]` overlap the inclusive range `[from, to]`? */
export function overlaps(period: JournalPeriod, from: string, to: string): boolean {
  return period.first <= to && period.last >= from;
}

/**
 * Is this day past the day tier on `today`? A day rolls once it is 14 or more days
 * old: with DAY_TIER_DAYS = 14 the day tier is `today − 13 … today`.
 */
export function isPastDayTier(dayLabel: string, today: string): boolean {
  return dayLabel <= addDays(today, -DAY_TIER_DAYS);
}

/** A week rolls up only once ALL its days are past the day tier (spec 077 §4.3). */
export function isWeekClosedForRollup(weekLabel: string, today: string): boolean {
  return isPastDayTier(weekBounds(weekLabel).last, today);
}

/**
 * A month rolls up once every week assigned to it (by Thursday) is past the week
 * tier. The last such week ends at most 3 days after the month's last day.
 */
export function isMonthClosedForRollup(monthLabel: string, today: string): boolean {
  const { last } = monthBounds(monthLabel);
  return addDays(last, 3) <= addDays(today, -WEEK_TIER_DAYS);
}

/** Is this week past the week tier (all its days older than 90 days)? */
export function isWeekPastWeekTier(weekLabel: string, today: string): boolean {
  return weekBounds(weekLabel).last <= addDays(today, -WEEK_TIER_DAYS);
}
