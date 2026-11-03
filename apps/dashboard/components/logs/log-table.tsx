// The Logs page's table (spec 081). One shape for every source: when, what happened, a tone
// in words (never colour alone), and the stored record in full behind a disclosure.
// Presentational only; rows arrive already shaped by the server.

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui-v2/table";

export type LogTone = "ok" | "warn" | "error" | "neutral";

export interface LogTableRow {
  id: string;
  at: string;
  title: string;
  detail: string | null;
  tone: LogTone;
  raw?: unknown;
}

const TONE: Record<LogTone, { label: string; className: string }> = {
  ok: { label: "OK", className: "text-foreground/60" },
  warn: { label: "Note", className: "text-ink-accent" },
  error: { label: "Error", className: "text-destructive" },
  neutral: { label: "Info", className: "text-foreground/60" },
};

export function formatLogTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function LogTable({ rows }: { rows: readonly LogTableRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[11rem]">When</TableHead>
          <TableHead className="w-[4rem]">Kind</TableHead>
          <TableHead>What happened</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const tone = TONE[row.tone];
          return (
            <TableRow key={row.id} className="align-top">
              <TableCell className="whitespace-nowrap py-2 font-mono text-xs text-foreground/70">
                <time dateTime={row.at} title={row.at}>
                  {formatLogTime(row.at)}
                </time>
              </TableCell>
              <TableCell className={`py-2 text-xs ${tone.className}`}>{tone.label}</TableCell>
              <TableCell className="py-2">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="break-words text-sm text-foreground">{row.title}</span>
                  {row.detail ? (
                    <span className="break-words font-mono text-xs text-foreground/60">
                      {row.detail}
                    </span>
                  ) : null}
                  <details className="text-xs">
                    <summary className="w-fit cursor-pointer text-foreground/60 hover:text-foreground">
                      Full record
                    </summary>
                    <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-all bg-foreground/[0.04] p-2 font-mono text-[11px] text-foreground/80">
                      {JSON.stringify(row.raw, null, 2)}
                    </pre>
                  </details>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
