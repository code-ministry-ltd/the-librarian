// Logs (spec 081): every log the Librarian keeps, in one place, each readable page by page and
// downloadable in full. The server shapes each source into the same display rows
// (`logs.page`); this page only picks the source from the URL, so a tab is a link you can share.

import Link from "next/link";
import { EmptyState } from "@/components/brand/empty-state";
import { LogTable, type LogTableRow } from "@/components/logs/log-table";
import { SectionLabel } from "@/components/ui-v2/section-label";
import { LOG_SOURCES, type LogSourceId, isLogSourceId } from "@/lib/log-sources";
import { serverTRPC } from "@/lib/trpc-server";

export const metadata = { title: "Logs · Librarian" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

function href(source: LogSourceId, cursor?: string): string {
  const params = new URLSearchParams({ source });
  if (cursor) params.set("cursor", cursor);
  return `/logs?${params.toString()}`;
}

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; cursor?: string }>;
}) {
  const params = await searchParams;
  const source: LogSourceId = isLogSourceId(params.source) ? params.source : "reads";
  const cursor = params.cursor && params.cursor.length > 0 ? params.cursor : undefined;
  const info = LOG_SOURCES.find((s) => s.id === source) ?? LOG_SOURCES[0]!;

  let rows: LogTableRow[] = [];
  let nextCursor: string | null = null;
  let total: number | null = null;
  let readLog: { enabled: boolean; recording: boolean } | null = null;
  let error: string | null = null;
  try {
    const [page, config] = await Promise.all([
      serverTRPC.logs.page.query({ source, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }),
      source === "reads" ? serverTRPC.logs.readLogConfig.query() : Promise.resolve(null),
    ]);
    rows = page.rows;
    nextCursor = page.nextCursor;
    total = page.total;
    readLog = config;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-xl text-foreground">Logs</h1>
        <p className="max-w-[65ch] text-sm text-foreground/60">
          Everything the Librarian records about what happens to it, newest first. Download any log
          in full as NDJSON, one record per line, to analyse elsewhere.
        </p>
      </header>

      <nav aria-label="Logs" className="overflow-x-auto">
        <ul className="inline-flex min-w-max items-end gap-4 border-b border-ink-hairline">
          {LOG_SOURCES.map((s) => {
            const active = s.id === source;
            return (
              <li key={s.id}>
                <Link
                  href={href(s.id)}
                  aria-current={active ? "page" : undefined}
                  className={`-mb-px inline-flex h-9 items-center border-b-2 px-1 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent pointer-coarse:h-11 ${
                    active
                      ? "border-ink-accent text-foreground"
                      : "border-transparent text-foreground/60 hover:text-foreground"
                  }`}
                >
                  {s.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <section aria-label={info.label} className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex max-w-[65ch] flex-col gap-1.5">
            <SectionLabel as="h2">{info.label}</SectionLabel>
            <p className="text-sm text-foreground/60">{info.description}</p>
            {info.fullView ? (
              <p className="text-xs text-foreground/60">
                A fuller view is on the{" "}
                <Link
                  href={info.fullView.href}
                  className="text-ink-accent underline underline-offset-2 hover:no-underline"
                >
                  {info.fullView.label}
                </Link>{" "}
                page.
              </p>
            ) : null}
          </div>
          <a
            href={`/logs/download?source=${source}`}
            download
            className="inline-flex items-center gap-2 border border-foreground/20 px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-foreground/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent pointer-coarse:min-h-11"
          >
            Download {info.label.toLowerCase()}
          </a>
        </div>

        {readLog ? <ReadLogStatus {...readLog} /> : null}

        {error ? (
          <p
            role="alert"
            className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
          >
            Failed to load this log: {error}
          </p>
        ) : null}

        {!error && rows.length === 0 ? (
          <EmptyState title="Nothing recorded yet">
            <p>
              {source === "reads" && readLog && !readLog.enabled
                ? "Turn the read log on and agents' reads will appear here as they happen."
                : "Entries will appear here as they happen, newest first."}
            </p>
          </EmptyState>
        ) : null}

        {rows.length > 0 ? (
          <>
            {total !== null ? (
              <p className="text-xs text-foreground/60">
                {total.toLocaleString("en-GB")} {total === 1 ? "entry" : "entries"} kept
              </p>
            ) : null}
            <LogTable rows={rows} />
            <div className="flex items-center gap-4 text-sm">
              {cursor ? (
                <Link href={href(source)} className="text-ink-accent underline underline-offset-2">
                  Back to newest
                </Link>
              ) : null}
              {nextCursor ? (
                <Link
                  href={href(source, nextCursor)}
                  className="text-ink-accent underline underline-offset-2"
                >
                  Older entries
                </Link>
              ) : null}
            </div>
          </>
        ) : null}
      </section>
    </main>
  );
}

function ReadLogStatus({ enabled, recording }: { enabled: boolean; recording: boolean }) {
  const text = !enabled
    ? "The read log is off."
    : recording
      ? "The read log is on."
      : "The read log is switched on, but this server process doesn't record reads.";
  return (
    <p className="border border-ink-hairline bg-ink-surface p-3 text-sm text-foreground/80">
      {text} Change it in{" "}
      <Link
        href="/settings/dashboard"
        className="text-ink-accent underline underline-offset-2 hover:no-underline"
      >
        Settings → Dashboard
      </Link>
      .
    </p>
  );
}
