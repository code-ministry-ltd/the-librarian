"use client";

// One period of the journal in the reading column (spec 077 §4.11): a day's
// conversation entries, or a week/month summary. Editorial set: a Fraunces heading,
// Plex Mono for every machine string (dates, times, harness, project), Newsreader
// for what was said. Deletes sit quietly beside what they remove.

import type { JournalViewPeriod } from "@librarian/core";
import { Trash2 } from "lucide-react";
import { forwardRef } from "react";
import ReactMarkdown from "react-markdown";
import { Pill } from "@/components/ui-v2/pill";
import type { PendingDelete } from "./delete-dialog";
import { periodHeading } from "./timeline";

/** Entries are plain text; set `backticked` names in mono, as everywhere machine strings appear. */
export function InlineText({ text }: { text: string }) {
  const parts = text.split(/`([^`]+)`/);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="font-mono text-[0.85em] text-foreground">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

interface Props {
  period: JournalViewPeriod;
  /** An entry (key) or the period itself ("*") the reader just jumped to. */
  arrived: string | null;
  onDelete: (pending: PendingDelete) => void;
}

const quietButton =
  "inline-flex items-center gap-1.5 px-1.5 py-1 text-xs text-foreground/70 transition-colors hover:text-destructive focus:outline-none focus-visible:text-destructive focus-visible:ring-2 focus-visible:ring-ink-accent";

export const PeriodSection = forwardRef<HTMLElement, Props>(function PeriodSection(
  { period, arrived, onDelete },
  ref,
) {
  const heading = periodHeading(period);
  const headingId = `journal-${period.path.replace(/[^a-z0-9]/gi, "-")}`;
  const kind =
    period.tier === "day"
      ? `${period.episodes.length} conversation${period.episodes.length === 1 ? "" : "s"}`
      : period.tier === "week"
        ? "Week summary"
        : "Month summary";
  const periodWhat =
    period.tier === "day" ? `all of ${heading.title} ${heading.detail}` : heading.title;

  return (
    <section
      ref={ref}
      aria-labelledby={headingId}
      data-path={period.path}
      className={`scroll-mt-28 py-8 ${arrived === "*" ? "journal-arrive" : ""}`}
    >
      <header className="mb-5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2
            id={headingId}
            tabIndex={-1}
            className="font-display text-2xl leading-tight text-foreground focus:outline-none"
          >
            {heading.title}
          </h2>
          <span className="font-mono text-xs text-foreground/70">
            {period.tier === "day" ? period.label : heading.detail} · {kind}
          </span>
        </div>
        <button
          type="button"
          className={quietButton}
          onClick={() =>
            onDelete({ target: { kind: "period", path: period.path }, what: periodWhat })
          }
        >
          <Trash2 aria-hidden className="h-3.5 w-3.5" />
          {period.tier === "day" ? "Delete day" : "Delete summary"}
        </button>
      </header>

      {period.tier === "day" ? (
        <ol className="flex flex-col">
          {period.episodes.map((entry) => (
            <li
              key={entry.key}
              data-key={entry.key}
              className={`group grid grid-cols-1 gap-2 border-t border-ink-hairline py-4 sm:grid-cols-[6.5rem_minmax(0,1fr)_auto] sm:gap-4 ${
                arrived === entry.key ? "journal-arrive" : ""
              }`}
            >
              <span className="pt-0.5 font-mono text-xs text-foreground/70">{entry.time}</span>
              <div className="flex min-w-0 flex-col gap-2">
                <div className="flex flex-wrap gap-1.5">
                  <Pill>{entry.harness}</Pill>
                  {entry.project ? <Pill>{entry.project}</Pill> : null}
                </div>
                <ul className="flex max-w-[68ch] list-none flex-col gap-1.5 text-[15px] leading-relaxed text-foreground">
                  {entry.bullets.map((bullet, i) => (
                    <li key={i} className="relative pl-4">
                      <span
                        aria-hidden
                        className="absolute left-0 top-[0.7em] h-px w-2 bg-ink-copper-soft"
                      />
                      <InlineText text={bullet} />
                    </li>
                  ))}
                </ul>
              </div>
              <div className="sm:pt-0.5">
                <button
                  type="button"
                  aria-label={`Delete the ${entry.time} entry on ${heading.title} ${heading.detail}`}
                  className={`${quietButton} sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100`}
                  onClick={() =>
                    onDelete({
                      target: { kind: "episode", date: period.label, key: entry.key },
                      what: `the ${entry.time} entry on ${heading.title}`,
                    })
                  }
                >
                  <Trash2 aria-hidden className="h-3.5 w-3.5" />
                  <span className="sm:sr-only">Delete entry</span>
                </button>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <div className="border-t border-ink-hairline pt-4">
          <div className="vault-prose max-w-[68ch]">
            {/* Stored summaries are entity-escaped; markdown shows those as literal text,
              and images are refused outright, so a summary can't load anything. */}
            <ReactMarkdown disallowedElements={["img"]} unwrapDisallowed>
              {period.body ?? ""}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </section>
  );
});
