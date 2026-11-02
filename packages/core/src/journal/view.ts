// The dashboard's view of a journal (spec 077 §4.11): every file as a structured
// period, NEWEST first, so the Journal page can render day entries and week/month
// summaries without parsing markdown in the browser.

import type { JournalFileStore } from "../store/journal-types.js";
import { parseDay, parseRollup } from "./format.js";
import { listJournalFiles } from "./journal.js";
import type { JournalTier } from "./periods.js";

export interface JournalViewEpisode {
  /** Idempotency key — the handle `deleteEpisode` takes. */
  key: string;
  /** `HH:MM–HH:MM` or `HH:MM`, local. */
  time: string;
  harness: string;
  project: string | null;
  /** Plain text, entities decoded — render as text, never as HTML. */
  bullets: string[];
}

export interface JournalViewPeriod {
  tier: JournalTier;
  /** `2026-11-02`, `2026-W44`, `2026-10`. */
  label: string;
  /** Inclusive first / last local dates. */
  first: string;
  last: string;
  /** Journal-relative path — the handle `deletePeriod` takes. */
  path: string;
  /** Day files: their entries, in file order. */
  episodes: JournalViewEpisode[];
  /**
   * Week/month files: the summary markdown, still entity-encoded so a markdown renderer
   * shows `&lt;`/`&#33;[` as literal text rather than markup.
   */
  body: string | null;
}

/** Undo the journal's write-time escaping for text that is rendered as plain text. */
export function decodeJournalText(value: string): string {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&#33;[", "![");
}

/** Every journal file on the shelf as a structured period, newest first. */
export function journalView(files: JournalFileStore): JournalViewPeriod[] {
  return listJournalFiles(files)
    .map((file): JournalViewPeriod => {
      const base = {
        tier: file.period.tier,
        label: file.period.label,
        first: file.period.first,
        last: file.period.last,
        path: file.period.path,
      };
      if (file.period.tier === "day") {
        return {
          ...base,
          episodes: parseDay(file.period.label, file.raw).episodes.map((e) => ({
            key: e.key,
            time: e.time,
            harness: e.harness,
            project: e.project,
            bullets: e.bullets.map(decodeJournalText),
          })),
          body: null,
        };
      }
      return { ...base, episodes: [], body: parseRollup(file.raw).body };
    })
    .reverse();
}
