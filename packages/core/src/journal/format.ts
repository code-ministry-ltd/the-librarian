// Journal file format (spec 077 §4.1/§4.3): render and parse the markdown the
// journal is stored as. The SERVER owns every structural line — headings, the
// `<!-- episode: … -->` idempotency key, the `<!-- sources: … -->` roll-up ledger —
// and model output only ever lands as sanitised bullet/body text beneath them, so a
// model can never forge a key or a heading.

import { createHash } from "node:crypto";
import type { JournalPeriod } from "./periods.js";

/** One episode: one settled conversation generation, as stored in a day file. */
export interface JournalEpisode {
  /** Idempotency key, `<conv_id>#<n>`. */
  key: string;
  /** `HH:MM–HH:MM` or `HH:MM` (local). */
  time: string;
  harness: string;
  /** Project name, or null when unknown (rendered as `—`). */
  project: string | null;
  bullets: string[];
}

/** A parsed day file. */
export interface JournalDay {
  date: string;
  episodes: JournalEpisode[];
}

const UNKNOWN_PROJECT = "—";
const SEP = " · ";

/**
 * Make model-authored text passive and single-purpose: no raw HTML (so it can never
 * open an HTML comment and forge a key), no image/embed syntax, no newlines inside a
 * bullet. Mirrors Chronicle's sanitiser, plus line flattening for bullets.
 */
export function sanitizeJournalText(value: string): string {
  return value.replaceAll("![", "&#33;[").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function flattenBullet(value: string): string {
  return sanitizeJournalText(value)
    .replace(/\s*\n\s*/g, " ")
    .replace(/^[-*•]\s+/, "")
    .trim();
}

/**
 * A heading field (harness / project): one line, no separator, no markup, bounded.
 * The heading is the source of truth for the verb's filters, so it must parse back
 * exactly.
 */
export function cleanHeadingField(value: string, max: number): string {
  const cleaned = Array.from(value, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? " " : ch;
  })
    .join("")
    .replaceAll("·", "-")
    .replace(/[<>#`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
  return cleaned;
}

/** Render one episode block (no trailing blank line). */
export function renderEpisode(episode: JournalEpisode): string {
  const harness = cleanHeadingField(episode.harness, 50) || "unknown";
  const project = episode.project ? cleanHeadingField(episode.project, 200) : "";
  const lines = [
    `## ${episode.time}${SEP}${harness}${SEP}${project || UNKNOWN_PROJECT}`,
    `<!-- episode: ${episode.key.replace(/--|>|\s/g, "_")} -->`,
    ...episode.bullets.map((b) => `- ${flattenBullet(b)}`).filter((line) => line !== "- "),
  ];
  return lines.join("\n");
}

/** Render a whole day file. */
export function renderDay(day: JournalDay): string {
  const blocks = day.episodes.map(renderEpisode);
  return `# ${day.date}\n\n${blocks.join("\n\n")}\n`;
}

const HEADING_RE = /^## (.+)$/;
const KEY_RE = /^<!-- episode: (\S+) -->$/;

/**
 * Parse a day file. Tolerant: anything that is not a well-formed episode (a hand
 * edit gone wrong) is skipped rather than thrown, so one bad block never hides the
 * rest of the day.
 */
export function parseDay(date: string, raw: string): JournalDay {
  const episodes: JournalEpisode[] = [];
  const lines = raw.split("\n");
  let current: JournalEpisode | null = null;
  const flush = (): void => {
    if (current && current.key) episodes.push(current);
    current = null;
  };
  for (const line of lines) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flush();
      const parts = (heading[1] ?? "").split(SEP);
      const [time = "", harness = "unknown", ...rest] = parts;
      const projectRaw = rest.join(SEP).trim();
      current = {
        key: "",
        time: time.trim(),
        harness: harness.trim(),
        project: projectRaw === "" || projectRaw === UNKNOWN_PROJECT ? null : projectRaw,
        bullets: [],
      };
      continue;
    }
    if (!current) continue;
    const key = KEY_RE.exec(line.trim());
    if (key && !current.key) {
      current.key = key[1] ?? "";
      continue;
    }
    const bullet = /^- (.*)$/.exec(line);
    if (bullet && bullet[1]) current.bullets.push(bullet[1]);
  }
  flush();
  return { date, episodes };
}

/** Short content hash used in the roll-up sources ledger. */
export function contentHash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

/** One entry in a rolled-up file's sources ledger. */
export interface RollupSource {
  /** Journal-relative path of a source file. */
  path: string;
  /** {@link contentHash} of the source's content when it was rolled in. */
  hash: string;
}

/** A parsed week or month file. */
export interface JournalRollup {
  sources: RollupSource[];
  /** The summary body (sanitised markdown). */
  body: string;
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function humanDate(label: string, withYear: boolean): string {
  const [y, m, d] = label.split("-").map(Number) as [number, number, number];
  return `${d} ${MONTH_NAMES[m - 1]}${withYear ? ` ${y}` : ""}`;
}

/** The `# …` title line of a rolled-up file. */
export function rollupTitle(period: JournalPeriod): string {
  if (period.tier === "week") {
    return `# Week ${period.label} (${humanDate(period.first, false)} – ${humanDate(period.last, true)})`;
  }
  const [y, m] = period.label.split("-").map(Number) as [number, number];
  const full = new Date(y, m - 1, 1).toLocaleString("en-GB", { month: "long" });
  return `# ${full} ${y}`;
}

const SOURCES_RE = /^<!-- sources: (.*) -->$/;

/** Render a week/month file with its sources ledger. */
export function renderRollup(period: JournalPeriod, rollup: JournalRollup): string {
  const ledger = rollup.sources.map((s) => `${s.path}@${s.hash}`).join(", ");
  return `${rollupTitle(period)}\n<!-- sources: ${ledger} -->\n\n${rollup.body.trim()}\n`;
}

/** Parse a week/month file. A missing ledger parses as no sources. */
export function parseRollup(raw: string): JournalRollup {
  const lines = raw.split("\n");
  let sources: RollupSource[] = [];
  let bodyStart = 0;
  for (let i = 0; i < Math.min(lines.length, 4); i += 1) {
    const line = lines[i] ?? "";
    if (i === 0 && line.startsWith("# ")) {
      bodyStart = 1;
      continue;
    }
    const match = SOURCES_RE.exec(line.trim());
    if (match) {
      sources = (match[1] ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const at = part.lastIndexOf("@");
          return at === -1
            ? { path: part, hash: "" }
            : { path: part.slice(0, at), hash: part.slice(at + 1) };
        });
      bodyStart = i + 1;
      break;
    }
  }
  return { sources, body: lines.slice(bodyStart).join("\n").trim() };
}

/** Strip the structural comment lines so text served to an agent stays clean. */
export function stripStructuralComments(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => !KEY_RE.test(line.trim()) && !SOURCES_RE.test(line.trim()))
    .join("\n");
}
