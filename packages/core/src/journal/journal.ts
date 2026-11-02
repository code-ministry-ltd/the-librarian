// Journal operations over one shelf's journal files (spec 077 §4.1/§4.4): append an
// episode idempotently, delete an episode or a period, and assemble the recent
// window that session-start injection serves.
//
// Appends are TEXT appends (the existing file is kept byte-for-byte and the new block
// added after it), so an owner's hand edit in the vault explorer is never rewritten
// by the next episode.

import { commitSubject } from "../store/commit-message.js";
import type { JournalFileStore } from "../store/journal-types.js";
import { type JournalEpisode, parseDay, parseRollup, renderEpisode } from "./format.js";
import {
  RECENT_WINDOW_WEEKS,
  comparePeriods,
  dayPeriod,
  localDate,
  periodFromPath,
  type JournalPeriod,
} from "./periods.js";

// ── episodes from a transcript buffer ─────────────────────────────────────────

const TURN_TS_RE = /^### (?:user|assistant) \(seq=\d+ ts=([^)\s]+)\)$/gm;

function localTime(value: Date): string {
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}

/**
 * The local date + `HH:MM–HH:MM` range of a buffer, from its turn timestamps. A buffer
 * without usable timestamps is dated `fallback` (the time it settled), shown as a
 * single `HH:MM`. A conversation that spans midnight is dated by its LAST turn.
 */
export function episodeTiming(bufferText: string, fallback: Date): { date: string; time: string } {
  const stamps: Date[] = [];
  for (const match of bufferText.matchAll(TURN_TS_RE)) {
    const parsed = new Date(match[1] ?? "");
    if (Number.isFinite(parsed.getTime())) stamps.push(parsed);
  }
  if (stamps.length === 0) return { date: localDate(fallback), time: localTime(fallback) };
  stamps.sort((a, b) => a.getTime() - b.getTime());
  const first = stamps[0] as Date;
  const last = stamps[stamps.length - 1] as Date;
  const start = localTime(first);
  const end = localTime(last);
  return { date: localDate(last), time: start === end ? start : `${start}–${end}` };
}

const TURN_HEAD_RE = /^### (user|assistant) \(seq=/;

/**
 * Does the buffer hold an actual exchange — at least one user turn AND one assistant
 * turn? A lone prompt with no reply (or a lone reply) has nothing worth journalling.
 */
export function hasExchange(bufferText: string): boolean {
  return /^### user \(seq=/m.test(bufferText) && /^### assistant \(seq=/m.test(bufferText);
}

/**
 * The most buffer text one episode summarises. An episode is capped at a few bullets
 * (EPISODE_MAX_CHARS), so a long unbroken working session summarised whole lost most of
 * what happened; it is split into consecutive segments of at most this size instead,
 * each its own episode.
 */
export const EPISODE_SEGMENT_MAX_CHARS = 30_000;

/**
 * Split a buffer into consecutive segments of at most `maxChars`, cutting only between
 * turns (a single oversized turn stays whole, as its own segment). A buffer that fits
 * is returned as one segment, unchanged.
 */
export function splitEpisodeSegments(
  bufferText: string,
  maxChars = EPISODE_SEGMENT_MAX_CHARS,
): string[] {
  if (bufferText.length <= maxChars) return [bufferText];
  const turns: string[] = [];
  let current: string[] = [];
  for (const line of bufferText.split("\n")) {
    if (TURN_HEAD_RE.test(line) && current.length > 0) {
      turns.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) turns.push(current.join("\n"));
  const segments: string[] = [];
  let segment = "";
  for (const turn of turns) {
    if (segment && segment.length + 1 + turn.length > maxChars) {
      segments.push(segment);
      segment = turn;
    } else {
      segment = segment ? `${segment}\n${turn}` : turn;
    }
  }
  if (segment.trim()) segments.push(segment);
  return segments;
}

/** Is an episode with this key already in its day file? */
export function episodeExists(files: JournalFileStore, date: string, key: string): boolean {
  const raw = files.read(dayPeriod(date).path);
  return raw !== null && parseDay(date, raw).episodes.some((e) => e.key === key);
}

export type AppendOutcome = "written" | "exists" | "empty";

/**
 * Append one episode to its day file. Idempotent on the episode key: a retry of a
 * conversation whose episode already landed writes nothing (spec 077 SC1). An episode
 * with no bullets writes nothing.
 */
export function appendEpisode(
  files: JournalFileStore,
  date: string,
  episode: JournalEpisode,
): AppendOutcome {
  if (episode.bullets.length === 0) return "empty";
  const period = dayPeriod(date);
  const existing = files.read(period.path);
  if (existing !== null && parseDay(date, existing).episodes.some((e) => e.key === episode.key)) {
    return "exists";
  }
  const block = renderEpisode(episode);
  const next =
    existing === null || existing.trim() === ""
      ? `# ${date}\n\n${block}\n`
      : `${existing.trimEnd()}\n\n${block}\n`;
  files.write(period.path, next, commitSubject.journalEpisode(date));
  return "written";
}

// ── owner deletes (dashboard) ────────────────────────────────────────────────

/**
 * Delete one episode from a day file, keeping every other byte. The day file is
 * removed when its last episode goes. Returns false when the episode isn't there.
 */
export function deleteEpisode(files: JournalFileStore, date: string, key: string): boolean {
  const period = dayPeriod(date);
  const raw = files.read(period.path);
  if (raw === null) return false;
  const lines = raw.split("\n");
  const keyLine = lines.findIndex((line) => line.trim() === `<!-- episode: ${key} -->`);
  if (keyLine === -1) return false;
  let start = keyLine;
  while (start > 0 && !lines[start]?.startsWith("## ")) start -= 1;
  let end = keyLine + 1;
  while (end < lines.length && !lines[end]?.startsWith("## ")) end += 1;
  const remaining = [...lines.slice(0, start), ...lines.slice(end)];
  const next = `${remaining.join("\n").trimEnd()}\n`;
  const subject = commitSubject.journalDelete(`${period.path}#${key}`);
  if (parseDay(date, next).episodes.length === 0) {
    files.remove([period.path], subject);
  } else {
    files.write(period.path, next, subject);
  }
  return true;
}

/** Delete a whole day/week/month file. Returns false when it isn't there. */
export function deletePeriod(files: JournalFileStore, relPath: string): boolean {
  if (periodFromPath(relPath) === null || files.read(relPath) === null) return false;
  files.remove([relPath], commitSubject.journalDelete(relPath));
  return true;
}

// ── reading ───────────────────────────────────────────────────────────────────

/** A journal file with its parsed period and raw content. */
export interface JournalFile {
  period: JournalPeriod;
  raw: string;
}

/** Every readable journal file on the shelf, oldest first. */
export function listJournalFiles(files: JournalFileStore): JournalFile[] {
  const out: JournalFile[] = [];
  for (const rel of files.list()) {
    const period = periodFromPath(rel);
    if (!period) continue;
    const raw = files.read(rel);
    if (raw === null) continue;
    out.push({ period, raw });
  }
  return out.sort((a, b) => comparePeriods(a.period, b.period));
}

/** Rough token estimate (spec 077 §4.4): characters ÷ 4, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** A journal file as an agent should read it: no structural comments. */
export function renderForAgent(file: JournalFile): string {
  if (file.period.tier === "day") {
    const day = parseDay(file.period.label, file.raw);
    const blocks = day.episodes.map((e) =>
      [
        `## ${file.period.label} ${e.time} · ${e.harness} · ${e.project ?? "—"}`,
        ...e.bullets.map((b) => `- ${b}`),
      ].join("\n"),
    );
    return blocks.join("\n\n");
  }
  const rollup = parseRollup(file.raw);
  const title = file.raw.split("\n")[0]?.replace(/^# /, "") ?? file.period.label;
  return `## ${title}\n\n${rollup.body}`;
}

export const RECENT_WINDOW_HEADER = `# Journal — what you and the user have worked on recently

Oldest first. Recent days are detailed; earlier weeks are summarised. This covers about the last six weeks. For anything older, or to search by project or topic, call the \`journal\` tool. Facts live in memory (\`recall\`); this is the story of how you got here.`;

/** Appended when the recent window had to leave older entries out. */
export const RECENT_WINDOW_TRIMMED_NOTE =
  "Older entries were left out to fit — call the `journal` tool to read further back.";

/** One block of the recent window: a single episode, or a whole week summary. */
function windowBlocks(file: JournalFile): string[] {
  if (file.period.tier !== "day") return [renderForAgent(file)];
  return parseDay(file.period.label, file.raw).episodes.map((e) =>
    [
      `## ${file.period.label} ${e.time} · ${e.harness} · ${e.project ?? "—"}`,
      ...e.bullets.map((b) => `- ${b}`),
    ].join("\n"),
  );
}

/**
 * The recent window (spec 077 §4.4): every day file still on disk (normally the last
 * 14 days — older ones exist only until compaction rolls them) plus the 4 most recent
 * week summaries, oldest first. It is trimmed oldest-first, one episode or summary at a
 * time, to the smaller of `budgetTokens` (× 4 chars) and `options.maxChars` — the total
 * including the header and the trimmed note. The newest block is always kept (cut if it
 * alone is too long), so a session never starts without its latest entry. Null when
 * there is nothing to serve.
 */
export function renderRecentWindow(
  files: JournalFileStore,
  budgetTokens: number,
  options: { maxChars?: number } = {},
): string | null {
  const all = listJournalFiles(files);
  const days = all.filter((f) => f.period.tier === "day");
  const weeks = all.filter((f) => f.period.tier === "week").slice(-RECENT_WINDOW_WEEKS);
  const window = [...weeks, ...days].sort((a, b) => comparePeriods(a.period, b.period));
  const blocks = window.flatMap(windowBlocks).filter((text) => text.trim() !== "");
  if (blocks.length === 0) return null;

  const limit = Math.min(budgetTokens * 4, options.maxChars ?? Number.POSITIVE_INFINITY);
  const render = (kept: string[], trimmed: boolean): string =>
    `${RECENT_WINDOW_HEADER}\n\n${kept.join("\n\n")}\n` +
    (trimmed ? `\n${RECENT_WINDOW_TRIMMED_NOTE}\n` : "");

  let start = 0;
  let text = render(blocks, false);
  while (text.length > limit && start < blocks.length - 1) {
    start += 1;
    text = render(blocks.slice(start), true);
  }
  if (text.length > limit) {
    // Only the newest block is left and it is still too long: cut it to fit.
    const room = limit - render([""], true).length - 1;
    const newest = blocks[blocks.length - 1] as string;
    text = render([`${newest.slice(0, Math.max(0, room)).trimEnd()}…`], true);
  }
  return text;
}
