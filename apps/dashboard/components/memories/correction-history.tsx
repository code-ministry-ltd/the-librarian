import type { CorrectionHistoryRow } from "@/components/memories/types";

export function CorrectionHistory({
  rows,
  error,
}: {
  rows: CorrectionHistoryRow[];
  error: string | null;
}) {
  return (
    <section aria-labelledby="correction-history-heading" className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <h2 id="correction-history-heading" className="font-display text-lg text-foreground">
          Recent corrections
        </h2>
        <p className="text-sm text-foreground/60">Applied corrections from the past 30 days.</p>
      </header>
      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          Failed to load correction history: {error}
        </p>
      ) : rows.length === 0 ? (
        <p role="status" className="text-sm text-foreground/60">
          No corrections in the past 30 days.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((correction) => (
            <li
              key={`${correction.shelf_id}:${correction.source_memory_id}:${correction.applied_at}:${correction.proposal_id ?? "direct"}`}
              className="flex flex-col gap-1 border border-ink-hairline bg-ink-surface px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
            >
              <p className="text-sm text-foreground/80">
                <span className="font-medium text-foreground">
                  {correction.outcome === "proposal_approved"
                    ? "Approved correction"
                    : "Applied correction"}
                </span>{" "}
                to <span className="font-medium">{correction.title || "(untitled memory)"}</span>
                <span className="text-foreground/60">
                  {" "}
                  on {correction.shelf_label ?? correction.shelf_id}
                </span>
              </p>
              <time
                dateTime={correction.applied_at}
                className="shrink-0 font-mono text-[11px] text-foreground/50"
              >
                {new Date(correction.applied_at).toLocaleDateString()}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
