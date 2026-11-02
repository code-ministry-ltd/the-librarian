// Journal timeline geometry (spec 077 PR D) — pure, so the rail's behaviour is
// unit-testable without a browser.
//
// THE SCALE. The rail maps "days ago" onto [0, 1] (0 = today, at the top) with a
// logarithmic curve, the same shape as the journal itself: the last fortnight is
// kept entry by entry, older weeks are summarised, older months more so. A linear
// rail would give the detailed fortnight 4% of a year-long bar, and the marker would
// barely move while you read most of the page; the log curve gives recent days room
// and still shows a year at a glance.

/** Whole days between two local `YYYY-MM-DD` dates (later − earlier). */
export function daysBetween(earlier: string, later: string): number {
  const toUtc = (label: string) => {
    const [y, m, d] = label.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(later) - toUtc(earlier)) / 86_400_000);
}

/** Today's local date as `YYYY-MM-DD`. */
export function localToday(now: Date = new Date()): string {
  return [
    String(now.getFullYear()).padStart(4, "0"),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

/** The rail's span in days: at least a month, so a young journal isn't stretched. */
export function railSpan(oldestDaysAgo: number): number {
  return Math.max(30, Math.ceil(oldestDaysAgo) + 1);
}

/** Position on the rail (0 = today … 1 = the oldest entry) for a fractional "days ago". */
export function railPosition(daysAgo: number, span: number): number {
  const d = Math.min(Math.max(daysAgo, 0), span);
  return Math.log1p(d) / Math.log1p(span);
}

/** The inverse: which "days ago" a rail position stands for. */
export function daysAgoAt(position: number, span: number): number {
  const p = Math.min(Math.max(position, 0), 1);
  return Math.expm1(p * Math.log1p(span));
}

export interface RailTick {
  daysAgo: number;
  label: string;
  /** A tier boundary of the journal itself (14 days, 90 days). Drawn stronger. */
  boundary: boolean;
}

const TICKS: readonly RailTick[] = [
  { daysAgo: 0, label: "Today", boundary: false },
  { daysAgo: 7, label: "1 wk", boundary: false },
  { daysAgo: 14, label: "2 wk", boundary: true },
  { daysAgo: 30, label: "1 mo", boundary: false },
  { daysAgo: 90, label: "3 mo", boundary: true },
  { daysAgo: 182, label: "6 mo", boundary: false },
  { daysAgo: 365, label: "1 yr", boundary: false },
  { daysAgo: 730, label: "2 yr", boundary: false },
  { daysAgo: 1095, label: "3 yr", boundary: false },
];

/** The ticks that fall inside the rail's span. */
export function railTicks(span: number): RailTick[] {
  return TICKS.filter((tick) => tick.daysAgo <= span);
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function parts(label: string): { y: number; m: number; d: number; weekday: string } {
  const [y, m, d] = label.split("-").map(Number) as [number, number, number];
  return { y, m, d, weekday: WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] as string };
}

/** "2 Nov" / "2 Nov 2026". */
export function shortDate(label: string, withYear = false): string {
  const { y, m, d } = parts(label);
  return `${d} ${(MONTHS[m - 1] as string).slice(0, 3)}${withYear ? ` ${y}` : ""}`;
}

export interface PeriodLike {
  tier: "day" | "week" | "month";
  label: string;
  first: string;
  last: string;
}

/** The large readout for a period: what the page says "you are here" with. */
export function periodHeading(period: PeriodLike): { title: string; detail: string } {
  if (period.tier === "day") {
    const { y, m, d, weekday } = parts(period.label);
    return { title: `${weekday} ${d} ${MONTHS[m - 1]}`, detail: String(y) };
  }
  if (period.tier === "week") {
    const week = Number(period.label.split("-W")[1]);
    return {
      title: `Week ${week}`,
      detail: `${shortDate(period.first)} – ${shortDate(period.last, true)}`,
    };
  }
  const { y, m } = parts(`${period.label}-01`);
  return { title: MONTHS[m - 1] as string, detail: String(y) };
}

/** "Today", "Yesterday", "5 days ago", "3 weeks ago", "4 months ago", "1 year ago". */
export function relativeAge(daysAgo: number): string {
  const d = Math.max(0, Math.round(daysAgo));
  if (d === 0) return "Today";
  if (d === 1) return "Yesterday";
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.round(d / 7)} weeks ago`;
  if (d < 365) {
    const months = Math.round(d / 30.4);
    return `${months} month${months === 1 ? "" : "s"} ago`;
  }
  const years = Math.round(d / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/**
 * Where in time the reader is, given the period crossing the reading line and how far
 * through it they have scrolled (0 = its top, the newest edge; 1 = its bottom, the
 * oldest edge). Returns fractional days ago, so the marker glides rather than jumps.
 */
export function readingDaysAgo(period: PeriodLike, progress: number, today: string): number {
  const p = Math.min(Math.max(progress, 0), 1);
  const newest = daysBetween(period.last, today);
  const oldest = daysBetween(period.first, today) + (period.tier === "day" ? 1 : 0);
  return newest + (oldest - newest) * p;
}
