"use client";

// The Journal page (spec 077 PR D): read the dated history of your conversations
// with your agents, travel through it on a timeline, search it with the very engine
// agents use, and permanently delete anything that shouldn't be there.
//
// "You are here" is always unmistakable: a large Fraunces readout of the period at
// the reading line, and a marker on the timeline rail that glides as you scroll —
// fractional within a period, so it moves continuously rather than jumping. The
// rail is also a control: click or drag along it, or focus it and use the arrows.
//
// Keyboard: j / k = older / newer period · / = search · Esc (in search) = clear.

import type { JournalSearchHit, JournalViewPeriod } from "@librarian/core";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/brand/empty-state";
import { MemoryOrb } from "@/components/brand/memory-orb";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";
import { KeyHint } from "@/components/ui-v2/key-hint";
import { SectionLabel } from "@/components/ui-v2/section-label";
import { Select } from "@/components/ui-v2/select";
import { useSurfaceShortcuts } from "@/hooks/use-surface-shortcuts";
import { trpc } from "@/lib/trpc-client";
import { JournalDeleteDialog, type PendingDelete } from "./delete-dialog";
import { InlineText, PeriodSection } from "./period-section";
import { type RailHit, TimelineRail } from "./timeline-rail";
import {
  daysAgoAt,
  daysBetween,
  localToday,
  periodHeading,
  railSpan,
  railTicks,
  readingDaysAgo,
  relativeAge,
} from "./timeline";

/** The reading line: where on screen "now" is measured, as a fraction of the viewport. */
const READING_LINE = 0.32;

const TIER_DIVIDER: Record<JournalViewPeriod["tier"], string> = {
  day: "Day by day",
  week: "Summarised by week",
  month: "Summarised by month",
};

/**
 * Where "now" is measured on screen. Normally a fixed line near the top, but as the page
 * nears its end the line slides down to the bottom, so the last periods — which can
 * never scroll up to the line — still become "where you are".
 */
function readingLine(): number {
  const h = window.innerHeight;
  const base = h * READING_LINE;
  const runway = h - base;
  const remaining = Math.max(0, document.documentElement.scrollHeight - (window.scrollY + h));
  return remaining >= runway ? base : base + (runway - remaining);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export function JournalView({ intro }: { intro?: React.ReactNode }) {
  const entries = trpc.journal.entries.useQuery();
  const periods = useMemo(() => entries.data?.periods ?? [], [entries.data]);
  const today = useMemo(() => localToday(), []);

  const ageOf = useCallback(
    (period: JournalViewPeriod) => ({
      newest: daysBetween(period.last, today),
      oldest: daysBetween(period.first, today) + (period.tier === "day" ? 1 : 0),
    }),
    [today],
  );
  const span = useMemo(
    () => railSpan(periods.length ? ageOf(periods[periods.length - 1]!).oldest : 0),
    [periods, ageOf],
  );
  const ticks = useMemo(() => railTicks(span), [span]);

  // ── where the reader is ─────────────────────────────────────────────────────
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const [current, setCurrent] = useState(0);
  const [readerDaysAgo, setReaderDaysAgo] = useState(0);
  const [arrived, setArrived] = useState<{ path: string; key: string } | null>(null);

  const measure = useCallback(() => {
    if (periods.length === 0) return;
    const line = readingLine();
    let index = periods.length - 1;
    let progress = 1;
    for (let i = 0; i < periods.length; i += 1) {
      const el = sectionRefs.current.get(periods[i]!.path);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.bottom > line) {
        index = i;
        progress = rect.height > 0 ? (line - rect.top) / rect.height : 0;
        break;
      }
    }
    setCurrent(index);
    setReaderDaysAgo(readingDaysAgo(periods[index]!, progress, today));
  }, [periods, today]);

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [measure]);

  // ── travelling ──────────────────────────────────────────────────────────────
  const scrollToDaysAgo = useCallback(
    (daysAgo: number, instant: boolean) => {
      if (periods.length === 0) return;
      let index = periods.findIndex((p) => ageOf(p).oldest > daysAgo);
      if (index === -1) index = periods.length - 1;
      const period = periods[index]!;
      const el = sectionRefs.current.get(period.path);
      if (!el) return;
      const { newest, oldest } = ageOf(period);
      const progress =
        oldest > newest ? Math.min(Math.max((daysAgo - newest) / (oldest - newest), 0), 1) : 0;
      const rect = el.getBoundingClientRect();
      const top =
        window.scrollY + rect.top + rect.height * progress - window.innerHeight * READING_LINE;
      window.scrollTo({
        top: Math.max(0, top),
        behavior: instant || prefersReducedMotion() ? "auto" : "smooth",
      });
    },
    [periods, ageOf],
  );

  // A keyboard step counts from the period you're travelling TO, not from wherever a
  // smooth scroll happens to be mid-flight — otherwise Home then ↓ lands one short.
  const heading = useRef<{ index: number; at: number } | null>(null);

  const goTo = useCallback(
    (index: number) => {
      const clamped = Math.min(Math.max(index, 0), periods.length - 1);
      const period = periods[clamped];
      if (!period) return;
      heading.current = { index: clamped, at: Date.now() };
      // Land each period's top on the reading line.
      scrollToDaysAgo(ageOf(period).newest + 1e-6, false);
    },
    [periods, ageOf, scrollToDaysAgo],
  );

  const step = useCallback(
    (delta: number | "newest" | "oldest") => {
      if (delta === "newest") return goTo(0);
      if (delta === "oldest") return goTo(periods.length - 1);
      const travelling = heading.current && Date.now() - heading.current.at < 1_500;
      goTo((travelling ? heading.current!.index : current) + delta);
    },
    [goTo, current, periods.length],
  );

  // ── search: the same engine agents use ───────────────────────────────────────
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("");
  const [harness, setHarness] = useState("");
  const debounced = useDebounced(query.trim(), 250);
  const search = trpc.journal.search.useQuery(
    {
      query: debounced,
      limit: 50,
      ...(project ? { project } : {}),
      ...(harness ? { harness } : {}),
    },
    { enabled: debounced.length > 0 },
  );
  const searching = debounced.length > 0;
  const facets = useMemo(() => {
    const projects = new Set<string>();
    const harnesses = new Set<string>();
    for (const p of periods) {
      for (const e of p.episodes) {
        harnesses.add(e.harness);
        if (e.project) projects.add(e.project);
      }
    }
    return { projects: [...projects].sort(), harnesses: [...harnesses].sort() };
  }, [periods]);

  const hitId = (hit: JournalSearchHit) => `${hit.path}#${hit.episodeKey ?? "*"}`;
  const railHits: RailHit[] = useMemo(
    () =>
      searching
        ? (search.data?.hits ?? []).map((hit) => {
            const newest = daysBetween(hit.last, today);
            const oldest = daysBetween(hit.first, today) + (hit.tier === "day" ? 1 : 0);
            return {
              id: hitId(hit),
              daysAgo: (newest + oldest) / 2,
              label: `${periodHeading(hit).title} ${periodHeading(hit).detail}${hit.time ? ` · ${hit.time}` : ""}`,
            };
          })
        : [],
    [searching, search.data, today],
  );

  const openHit = useCallback((id: string) => {
    const [path, key] = id.split("#") as [string, string];
    setQuery("");
    setArrived({ path, key });
    // Wait for the chronology to render again, then travel there.
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => {
        const section = sectionRefs.current.get(path);
        const target =
          key === "*"
            ? section
            : section?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
        target?.scrollIntoView({
          block: "center",
          behavior: prefersReducedMotion() ? "auto" : "smooth",
        });
        section?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
      }),
    );
    window.setTimeout(() => setArrived(null), 1_800);
  }, []);

  useSurfaceShortcuts({
    j: () => step(1),
    k: () => step(-1),
    "/": () => searchRef.current?.focus(),
  });

  // ── delete ──────────────────────────────────────────────────────────────────
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  // ── render ──────────────────────────────────────────────────────────────────
  const early = (content: React.ReactNode) => (
    <div className="flex flex-col gap-5">
      {intro}
      {content}
    </div>
  );
  if (entries.isLoading) {
    return early(
      <div className="flex items-center gap-3 py-16 text-sm text-foreground/70">
        <MemoryOrb size={10} pulse /> Opening the journal…
      </div>,
    );
  }
  if (entries.error) {
    return early(
      <p
        role="alert"
        className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
      >
        Couldn&apos;t load the journal: {entries.error.message}
      </p>,
    );
  }
  if (periods.length === 0) {
    return early(
      entries.data?.active ? (
        <EmptyState title="Nothing in the journal yet">
          Entries appear once a captured conversation has gone quiet for 30 minutes, or when its
          session ends. Each one records what was decided, corrected and left open.
        </EmptyState>
      ) : (
        <EmptyState
          title="The journal is off"
          action={
            <Link href="/settings/curator">
              <Button variant="primary">Turn it on in Settings → Curator</Button>
            </Link>
          }
        >
          Keep a dated history of what you and your agents talked about — recent days in detail,
          older weeks and months summarised — and let agents read it back.
        </EmptyState>
      ),
    );
  }

  const here = periods[current] ?? periods[0]!;
  const hereHeading = periodHeading(here);
  const valueText = `${hereHeading.title} ${hereHeading.detail}`;
  const railProps = {
    span,
    ticks,
    readerDaysAgo,
    hits: railHits,
    index: current,
    count: periods.length,
    valueText,
    onSeek: (position: number, dragging: boolean) =>
      scrollToDaysAgo(daysAgoAt(position, span), dragging),
    onStep: step,
    onHit: openHit,
  };

  const readout = (
    <div key={here.path} className="journal-readout-in flex flex-col gap-1">
      <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-foreground/70">
        {relativeAge(readerDaysAgo)}
        {here.tier !== "day" ? ` · ${here.tier === "week" ? "week summary" : "month summary"}` : ""}
      </span>
      <span className="font-display text-[1.75rem] leading-[1.05] tracking-[-0.01em] text-foreground lg:text-[2.25rem]">
        {hereHeading.title}
      </span>
      <span className="font-mono text-sm text-foreground/70">{hereHeading.detail}</span>
    </div>
  );

  return (
    <div className="grid grid-cols-1 gap-x-12 lg:grid-cols-[15rem_minmax(0,1fr)]">
      {/* Narrow screens: the page intro first, then the pinned readout + horizontal rail. */}
      {intro ? <div className="pb-4 lg:hidden">{intro}</div> : null}
      <div className="sticky top-0 z-10 -mx-6 border-b border-ink-hairline bg-background px-6 pb-1 pt-3 lg:hidden">
        <div className="flex items-end justify-between gap-4" aria-hidden>
          {readout}
        </div>
        <TimelineRail orientation="horizontal" {...railProps} />
      </div>

      {/* Wide screens: the readout above a tall vertical rail, pinned beside the page. */}
      <aside aria-label="Where you are in the journal" className="hidden lg:block">
        <div className="sticky top-6 flex h-[calc(100vh-6rem)] flex-col gap-6 pb-2">
          <div aria-hidden>{readout}</div>
          <div className="min-h-0 flex-1">
            <TimelineRail orientation="vertical" {...railProps} />
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-foreground/70">
            <KeyHint shortcut="J" /> older · <KeyHint shortcut="K" /> newer
          </p>
        </div>
      </aside>

      <div className="min-w-0">
        {intro ? <div className="hidden pb-4 lg:block">{intro}</div> : null}
        <div role="search" className="flex flex-col gap-3 border-b border-ink-hairline pb-5 pt-2">
          <div className="flex items-end gap-3">
            <label className="flex flex-1 flex-col gap-1">
              <span className="flex items-center gap-2">
                <SectionLabel as="span" className="text-foreground/70!">
                  Search the journal
                </SectionLabel>
                <KeyHint shortcut="/" />
              </span>
              <Input
                ref={searchRef}
                type="search"
                value={query}
                placeholder="What did we decide about…"
                className="[&::-webkit-search-cancel-button]:appearance-none"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setQuery("");
                    event.currentTarget.blur();
                  }
                }}
              />
            </label>
            {query ? (
              <Button variant="ghost" onClick={() => setQuery("")} className="px-2 py-1 text-xs">
                Clear
              </Button>
            ) : null}
          </div>
          {facets.projects.length + facets.harnesses.length > 0 ? (
            <div className="flex flex-wrap gap-4">
              {facets.projects.length > 0 ? (
                <label className="flex items-center gap-2 text-sm text-foreground/70">
                  Project
                  <Select
                    value={project}
                    onChange={(e) => setProject(e.target.value)}
                    className="w-44"
                  >
                    <option value="">Any</option>
                    {facets.projects.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </Select>
                </label>
              ) : null}
              {facets.harnesses.length > 1 ? (
                <label className="flex items-center gap-2 text-sm text-foreground/70">
                  Harness
                  <Select
                    value={harness}
                    onChange={(e) => setHarness(e.target.value)}
                    className="w-36"
                  >
                    <option value="">Any</option>
                    {facets.harnesses.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </Select>
                </label>
              ) : null}
            </div>
          ) : null}
        </div>

        {searching ? (
          <SearchResults
            loading={search.isFetching && !search.data}
            error={search.error?.message ?? null}
            hits={search.data?.hits ?? []}
            range={search.data ? `${search.data.from} to ${search.data.to}` : ""}
            periods={periods}
            onOpen={(hit) => openHit(hitId(hit))}
          />
        ) : (
          <div>
            {periods.map((period, i) => (
              <div key={period.path}>
                {i > 0 && periods[i - 1]!.tier !== period.tier ? (
                  <div
                    className="flex items-center gap-4 pt-10"
                    role="separator"
                    aria-label={TIER_DIVIDER[period.tier]}
                  >
                    <span aria-hidden className="h-px flex-1 bg-ink-copper-soft" />
                    <SectionLabel as="span" className="text-foreground/70!">
                      {TIER_DIVIDER[period.tier]}
                    </SectionLabel>
                    <span aria-hidden className="h-px flex-1 bg-ink-copper-soft" />
                  </div>
                ) : null}
                <PeriodSection
                  ref={(el) => {
                    if (el) sectionRefs.current.set(period.path, el);
                    else sectionRefs.current.delete(period.path);
                  }}
                  period={period}
                  arrived={arrived?.path === period.path ? arrived.key : null}
                  onDelete={setPendingDelete}
                />
              </div>
            ))}
            <p className="border-t border-ink-hairline py-10 text-center font-mono text-xs text-foreground/70">
              The beginning of the journal
            </p>
          </div>
        )}
      </div>

      <JournalDeleteDialog
        pending={pendingDelete}
        onClose={() => setPendingDelete(null)}
        onDeleted={() => void entries.refetch()}
      />
    </div>
  );
}

function SearchResults({
  loading,
  error,
  hits,
  range,
  periods,
  onOpen,
}: {
  loading: boolean;
  error: string | null;
  hits: JournalSearchHit[];
  range: string;
  periods: JournalViewPeriod[];
  onOpen: (hit: JournalSearchHit) => void;
}) {
  const byPath = useMemo(() => new Map(periods.map((p) => [p.path, p])), [periods]);
  if (error) {
    return (
      <p role="alert" className="py-6 text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (loading) {
    return (
      <p role="status" className="py-10 font-mono text-xs text-foreground/70">
        Searching…
      </p>
    );
  }
  return (
    <div className="py-6">
      <p role="status" className="mb-4 font-mono text-xs text-foreground/70">
        {hits.length === 0
          ? `No matches, ${range}. Try other words or drop a filter.`
          : `${hits.length} best match${hits.length === 1 ? "" : "es"}, ${range} — the same search your agents run`}
      </p>
      <ol className="flex flex-col">
        {hits.map((hit) => {
          const period = byPath.get(hit.path);
          const heading = periodHeading(hit);
          const entry = hit.episodeKey
            ? period?.episodes.find((e) => e.key === hit.episodeKey)
            : null;
          const excerpt = entry
            ? entry.bullets.slice(0, 3)
            : (period?.body ?? "")
                .split("\n")
                .map((line) =>
                  line
                    .replace(/^[-*]\s+/, "")
                    .replace(/\*\*/g, "")
                    .trim(),
                )
                .filter(Boolean)
                .slice(0, 3);
          return (
            <li
              key={`${hit.path}#${hit.episodeKey ?? "*"}`}
              className="border-t border-ink-hairline"
            >
              <button
                type="button"
                onClick={() => onOpen(hit)}
                className="flex w-full flex-col gap-1.5 px-1 py-4 text-left transition-colors hover:bg-foreground/[0.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
              >
                <span className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-display text-lg text-foreground">{heading.title}</span>
                  <span className="font-mono text-xs text-foreground/70">
                    {heading.detail}
                    {hit.time ? ` · ${hit.time}` : ""}
                    {hit.tier !== "day" ? ` · ${hit.tier} summary` : ""}
                    {hit.project ? ` · ${hit.project}` : ""}
                    {hit.matchedByText ? " · matched by text" : ""}
                  </span>
                </span>
                {excerpt.map((line, i) => (
                  <span
                    key={i}
                    className="max-w-[68ch] text-[15px] leading-relaxed text-foreground/85"
                  >
                    <InlineText text={line} />
                  </span>
                ))}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
