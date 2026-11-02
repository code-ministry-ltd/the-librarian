// The `journal` verb's engine (spec 077 §4.5): retrieve the journal by date range, or
// search it with BM25, optionally filtered by project and harness. Pure over a shelf's
// journal files + an injected "today", so every mode and boundary is unit-testable.
//
// UNITS. A day file contributes one unit per episode (so filters and search work per
// conversation); a week or month file is one unit. A unit is in range when its period
// overlaps `[from, to]`.
//
// FILTERS on rolled-up units. Week and month summaries carry no per-episode tags, so a
// `project` / `harness` filter matches them by text, and the result says so — the agent
// should know the match is looser.

import { buildKeywordIndex } from "../store/index/keyword-index.js";
import type { JournalFileStore } from "../store/journal-types.js";
import { parseDay } from "./format.js";
import { type JournalFile, listJournalFiles, renderForAgent } from "./journal.js";
import { type JournalPeriod, addDays, isLocalDate, overlaps } from "./periods.js";

export const JOURNAL_QUERY_DEFAULTS = {
  retrieveDays: 30,
  searchDays: 365,
  limit: 10,
  maxLimit: 50,
  maxTokens: 8_000,
  minTokens: 1_000,
  maxMaxTokens: 40_000,
} as const;

/** A caller mistake, phrased for the agent to fix and retry. */
export class JournalQueryError extends Error {}

export interface JournalQueryInput {
  query?: string;
  from?: string;
  to?: string;
  project?: string;
  harness?: string;
  limit?: number;
  maxTokens?: number;
}

interface Unit {
  period: JournalPeriod;
  /** Sort key: the unit's last date (newest-first tie-breaks). */
  date: string;
  text: string;
  /** Episode metadata (day units only). */
  key: string | null;
  time: string | null;
  harness: string | null;
  project: string | null;
  tierLabel: string;
}

function str(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new JournalQueryError(`Expected \`${field}\` to be a string, got ${typeof value}`);
  }
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length > max) {
    throw new JournalQueryError(
      `\`${field}\` is ${trimmed.length} characters; the limit is ${max}`,
    );
  }
  return trimmed;
}

function date(value: unknown, field: string): string | undefined {
  const raw = str(value, field, 10);
  if (raw === undefined) return undefined;
  if (!isLocalDate(raw)) {
    throw new JournalQueryError(`Expected \`${field}\` as YYYY-MM-DD, got '${raw}'`);
  }
  return raw;
}

function int(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new JournalQueryError(
      `Expected \`${field}\` as a whole number from ${min} to ${max}, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Validate raw tool arguments into a typed query. Throws {@link JournalQueryError}. */
export function parseJournalQueryArgs(args: Record<string, unknown>): JournalQueryInput {
  const d = JOURNAL_QUERY_DEFAULTS;
  const input: JournalQueryInput = {};
  const query = str(args.query, "query", 500);
  const from = date(args.from, "from");
  const to = date(args.to, "to");
  const project = str(args.project, "project", 200);
  const harness = str(args.harness, "harness", 50);
  const limit = int(args.limit, "limit", 1, d.maxLimit);
  const maxTokens = int(args.max_tokens, "max_tokens", d.minTokens, d.maxMaxTokens);
  if (query !== undefined) input.query = query;
  if (from !== undefined) input.from = from;
  if (to !== undefined) input.to = to;
  if (project !== undefined) input.project = project;
  if (harness !== undefined) input.harness = harness;
  if (limit !== undefined) input.limit = limit;
  if (maxTokens !== undefined) input.maxTokens = maxTokens;
  if (from && to && from > to) {
    throw new JournalQueryError(`\`from\` (${from}) is after \`to\` (${to})`);
  }
  return input;
}

function unitsOf(file: JournalFile): Unit[] {
  if (file.period.tier !== "day") {
    const label = file.period.tier === "week" ? "week summary" : "month summary";
    return [
      {
        period: file.period,
        date: file.period.last,
        text: renderForAgent(file),
        key: null,
        time: null,
        harness: null,
        project: null,
        tierLabel: label,
      },
    ];
  }
  return parseDay(file.period.label, file.raw).episodes.map((e) => ({
    period: file.period,
    date: file.period.label,
    text: [
      `## ${file.period.label} ${e.time} · ${e.harness} · ${e.project ?? "—"}`,
      ...e.bullets.map((b) => `- ${b}`),
    ].join("\n"),
    key: e.key,
    time: e.time,
    harness: e.harness,
    project: e.project,
    tierLabel: "entry",
  }));
}

const eq = (a: string | null, b: string): boolean =>
  a !== null && a.toLowerCase() === b.toLowerCase();
const mentions = (text: string, needle: string): boolean =>
  text.toLowerCase().includes(needle.toLowerCase());

/** Apply the project/harness filters; returns the unit with a looser-match flag, or null. */
function filterUnit(unit: Unit, input: JournalQueryInput): { unit: Unit; byText: boolean } | null {
  const filters = [input.project, input.harness].filter((f): f is string => f !== undefined);
  if (filters.length === 0) return { unit, byText: false };
  if (unit.period.tier === "day") {
    if (input.project !== undefined && !eq(unit.project, input.project)) return null;
    if (input.harness !== undefined && !eq(unit.harness, input.harness)) return null;
    return { unit, byText: false };
  }
  return filters.every((f) => mentions(unit.text, f)) ? { unit, byText: true } : null;
}

function describeFilters(input: JournalQueryInput): string {
  const parts: string[] = [];
  if (input.project) parts.push(`project "${input.project}"`);
  if (input.harness) parts.push(`harness "${input.harness}"`);
  return parts.length ? `, ${parts.join(", ")}` : "";
}

function headed(unit: Unit, byText: boolean, withLabel: boolean): string {
  if (!withLabel) return unit.text;
  const range =
    unit.period.first === unit.period.last
      ? unit.period.first
      : `${unit.period.first} to ${unit.period.last}`;
  const note = byText ? " — matched by text" : "";
  return `[${unit.tierLabel}, ${range}${note}]\n${unit.text}`;
}

type Candidate = { unit: Unit; byText: boolean };

/** The units in range after filters — shared by retrieve, search and the dashboard. */
function candidatesFor(
  files: JournalFileStore,
  input: JournalQueryInput,
  from: string,
  to: string,
): Candidate[] {
  return listJournalFiles(files)
    .filter((file) => overlaps(file.period, from, to))
    .flatMap(unitsOf)
    .map((unit) => filterUnit(unit, input))
    .filter((hit): hit is Candidate => hit !== null);
}

/**
 * Text as the journal indexes it. The shared tokenizer keeps `.`, `/` and `-` so
 * `config.ts` and `1.2.3` stay whole — which also leaves a sentence's last word as
 * `importer.`, unmatchable by `importer`. Journal entries are prose, so drop that
 * punctuation where it ENDS a word (inner dots survive). Applied to query and text alike.
 */
function searchable(text: string): string {
  return text.replace(/[./-]+(?=\s|$|[)\]"'»”])/g, "");
}

/** BM25 over the candidates; newest first among equal scores. */
function rankUnits(
  candidates: Candidate[],
  query: string,
  limit: number,
): (Candidate & { score: number })[] {
  const byId = new Map(candidates.map((c, i) => [String(i), c]));
  return buildKeywordIndex(
    candidates.map((c, i) => ({ id: String(i), text: searchable(c.unit.text) })),
  )
    .search(searchable(query))
    .flatMap((hit) => {
      const entry = byId.get(hit.id);
      return entry ? [{ ...entry, score: hit.score }] : [];
    })
    .sort((a, b) => b.score - a.score || (a.unit.date < b.unit.date ? 1 : -1))
    .slice(0, limit);
}

/** One ranked match, structured for a UI (the dashboard's Journal search). */
export interface JournalSearchHit {
  tier: JournalPeriod["tier"];
  label: string;
  first: string;
  last: string;
  path: string;
  /** The entry's key for a day hit; null for a week/month summary. */
  episodeKey: string | null;
  time: string | null;
  harness: string | null;
  project: string | null;
  /** True when a project/harness filter matched a summary by its text (a looser match). */
  matchedByText: boolean;
  score: number;
}

/**
 * The `journal` tool's search (spec 077 §4.5) as structured hits — same range
 * defaults, filters, BM25 ranking and tie-break the agents get, so the dashboard
 * finds exactly what an agent would. `input.query` is required.
 */
export function searchJournal(
  files: JournalFileStore,
  input: JournalQueryInput,
  today: string,
): { from: string; to: string; hits: JournalSearchHit[] } {
  const d = JOURNAL_QUERY_DEFAULTS;
  if (input.query === undefined) throw new JournalQueryError("`query` is required to search");
  const to = input.to ?? today;
  const from = input.from ?? addDays(to, -d.searchDays);
  const hits = rankUnits(
    candidatesFor(files, input, from, to),
    input.query,
    input.limit ?? d.limit,
  );
  return {
    from,
    to,
    hits: hits.map(({ unit, byText, score }) => ({
      tier: unit.period.tier,
      label: unit.period.label,
      first: unit.period.first,
      last: unit.period.last,
      path: unit.period.path,
      episodeKey: unit.key,
      time: unit.time,
      harness: unit.harness,
      project: unit.project,
      matchedByText: byText,
      score,
    })),
  };
}

/**
 * Run a journal query (spec 077 §4.5) and return the text the agent receives. Retrieve
 * mode (no `query`) returns every unit in range oldest-first, dropping the OLDEST when
 * over `maxTokens` and saying how to page back. Search mode ranks by BM25, newest first
 * among ties.
 */
export function queryJournal(
  files: JournalFileStore,
  input: JournalQueryInput,
  today: string,
): string {
  const d = JOURNAL_QUERY_DEFAULTS;
  const search = input.query !== undefined;
  const to = input.to ?? today;
  const from = input.from ?? addDays(to, -(search ? d.searchDays : d.retrieveDays));
  const maxChars = (input.maxTokens ?? d.maxTokens) * 4;
  const scope = `${from} to ${to}${describeFilters(input)}`;

  const candidates = candidatesFor(files, input, from, to);

  if (!search) {
    if (candidates.length === 0) {
      return `No journal entries for ${scope}. Try a wider range (\`from\`) or drop a filter.`;
    }
    const blocks = candidates.map((c) => headed(c.unit, c.byText, c.byText));
    let start = 0;
    let total = blocks.reduce((sum, b) => sum + b.length + 2, 0);
    while (blocks.length - start > 1 && total > maxChars) {
      total -= (blocks[start] as string).length + 2;
      start += 1;
    }
    const kept = blocks.slice(start);
    const lines = [`# Journal, ${scope} (oldest first)`, "", kept.join("\n\n")];
    if (start > 0) {
      const earliest = candidates[start]?.unit.period.first ?? from;
      lines.push(
        "",
        `Older entries omitted to fit max_tokens — call again with \`to: ${addDays(earliest, -1)}\` ` +
          "to read further back.",
      );
    }
    return `${lines.join("\n")}\n`;
  }

  const query = input.query as string;
  const hits = rankUnits(candidates, query, input.limit ?? d.limit);
  if (hits.length === 0) {
    return (
      `No journal entries match "${query}" in ${scope}. ` +
      "Try other words, a wider range (`from`), or drop a filter."
    );
  }
  const blocks: string[] = [];
  let total = 0;
  for (const entry of hits) {
    const block = headed(entry.unit, entry.byText, true);
    if (blocks.length > 0 && total + block.length > maxChars) break;
    blocks.push(block);
    total += block.length + 2;
  }
  const more =
    blocks.length < hits.length
      ? ` (${hits.length - blocks.length} more cut to fit max_tokens)`
      : "";
  return `# Journal search: "${query}", ${scope} — ${blocks.length} best match${blocks.length === 1 ? "" : "es"}${more}\n\n${blocks.join("\n\n")}\n`;
}
