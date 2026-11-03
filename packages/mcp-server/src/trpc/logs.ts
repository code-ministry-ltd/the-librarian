// The Logs page's admin surface (spec 081): one place to read and download every log the
// Librarian keeps, plus the dashboard switch for the read log (spec 080).
//
// Each source keeps its own storage and its own paging (file offsets for the NDJSON sidecars,
// run-id and commit-hash cursors for the run histories and the vault). This router hides that
// behind one shape: `page` returns display rows (a time, a one-line title, an optional detail,
// a tone, and the raw record), and `export` returns every retained raw record, oldest first,
// for a download. Admin-only throughout: refusals carry network attribution and token hashes,
// and reads carry query text.

import {
  type BackupRun,
  type CurationRun,
  type IngestLogRecord,
  type IntakeRun,
  type LibrarianStore,
  READ_LOG_ENABLED_KEY,
  type ReadRecord,
  type RefusalRecord,
  type VaultActivityEntry,
  listBackupRuns,
  listRecent,
} from "@librarian/core";
import { z } from "zod";
import { adminProcedure, router } from "./trpc.js";

export const LOG_SOURCES = [
  "reads",
  "refusals",
  "captures",
  "intake",
  "curation",
  "backups",
  "vault",
] as const;
export type LogSource = (typeof LOG_SOURCES)[number];
const LogSourceSchema = z.enum(LOG_SOURCES);

export type LogTone = "ok" | "warn" | "error" | "neutral";

/** One display row. `raw` is the stored record, unchanged, so the page can show it in full. */
export interface LogRow {
  id: string;
  at: string;
  title: string;
  detail: string | null;
  tone: LogTone;
  raw: unknown;
}

export interface LogPage {
  rows: LogRow[];
  /** Pass back as `cursor` for the next (older) page; null at the end. */
  nextCursor: string | null;
  /** Rows in the whole log when the source can say cheaply; null when it cannot. */
  total: number | null;
}

export interface LogExport {
  source: LogSource;
  rows: unknown[];
  /** True when the source holds more than the export cap and the oldest rows were left out. */
  truncated: boolean;
}

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
/** Run and commit histories are walked a page at a time up to this many rows per download. */
export const EXPORT_CAP = 20_000;
/** Captures and backups keep a short history; this reads all of it. */
const SHORT_HISTORY = 1_000;

const PageInput = z.strictObject({
  source: LogSourceSchema,
  cursor: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(MAX_PAGE).optional(),
});

function offsetOf(cursor: string | undefined): number {
  const n = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function quoted(text: string | undefined, max = 120): string {
  if (text === undefined || text.length === 0) return "(no query)";
  return `“${text.length > max ? `${text.slice(0, max - 1)}…` : text}”`;
}

function who(row: {
  actorId?: string | undefined;
  durationMs?: number | undefined;
}): string | null {
  const parts = [
    row.actorId,
    row.durationMs === undefined ? undefined : `${row.durationMs} ms`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? null : parts.join(" · ");
}

export function readRow(row: ReadRecord, index: number): LogRow {
  const base = { id: `${row.ts}#${index}`, at: row.ts, raw: row };
  switch (row.kind) {
    case "recall": {
      const title =
        row.mode === "ids"
          ? `Recall by id: ${plural(row.requestedIds?.length ?? 0, "id")} asked, ${row.returnedCount} returned`
          : `Recall ${quoted(row.query)}: ${plural(row.returnedCount, "result")}`;
      const tags = row.tags && row.tags.length > 0 ? `tags ${row.tags.join(", ")}` : undefined;
      const detail = [who(row), tags, `${row.resultChars.toLocaleString("en-GB")} chars`]
        .filter(Boolean)
        .join(" · ");
      return { ...base, title, detail, tone: row.returnedCount === 0 ? "warn" : "ok" };
    }
    case "search_references":
      return {
        ...base,
        title: `Reference search ${quoted(row.query)}: ${plural(row.returnedCount, "result")}`,
        detail: [who(row), `${row.resultChars.toLocaleString("en-GB")} chars`]
          .filter(Boolean)
          .join(" · "),
        tone: row.returnedCount === 0 ? "warn" : "ok",
      };
    case "primer":
      return {
        ...base,
        title: `Primer delivered: ${row.resultChars.toLocaleString("en-GB")} chars`,
        detail: [who(row), `version ${row.primerHash}`].filter(Boolean).join(" · "),
        tone: "neutral",
      };
    case "journal":
      return {
        ...base,
        title: `Journal served at session start: ${row.resultChars.toLocaleString("en-GB")} chars`,
        detail: who(row),
        tone: "neutral",
      };
    case "dropped":
      return {
        ...base,
        title: `${plural(row.count, "read")} not logged (rate limit)`,
        detail: `from ${row.windowStart}`,
        tone: "warn",
      };
  }
}

export function refusalRow(row: RefusalRecord, index: number): LogRow {
  const base = { id: `${row.ts}#${index}`, at: row.ts, raw: row };
  if (row.kind === "dropped") {
    return {
      ...base,
      title: `${plural(row.count, "refusal")} not logged (rate limit)`,
      detail: `from ${row.windowStart}`,
      tone: "warn",
    };
  }
  const where = row.tool ?? row.procedure ?? row.path;
  const detail = [where, row.actorId ?? row.username, row.ip, row.detail]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
  return {
    ...base,
    title: `${row.kind} (${String(row.outcome)}) on the ${row.surface} surface`,
    detail: detail.length > 0 ? detail : null,
    tone: "error",
  };
}

export function captureRow(row: IngestLogRecord): LogRow {
  return {
    id: row.id,
    at: row.created_at,
    title: `${row.status === "success" ? "Saved" : row.status === "failed" ? "Failed" : "Pending"}: ${row.source}`,
    detail: [row.via, row.error ?? row.result_path].filter(Boolean).join(" · ") || null,
    tone: row.status === "success" ? "ok" : row.status === "failed" ? "error" : "neutral",
    raw: row,
  };
}

function runTone(status: string): LogTone {
  if (status === "completed" || status === "ok") return "ok";
  if (status === "failed" || status === "error") return "error";
  if (status === "skipped") return "neutral";
  return "warn";
}

function model(run: { model_provider?: string | null; model_name?: string | null }): string | null {
  if (!run.model_name) return null;
  return run.model_provider ? `${run.model_provider}/${run.model_name}` : run.model_name;
}

export function intakeRow(run: IntakeRun): LogRow {
  const counts = `${run.consolidated} filed, ${run.errored} errored, ${run.judge_errors} unusable`;
  return {
    id: run.id,
    at: run.created_at,
    title: `Intake ${run.status} (${run.trigger}): ${counts}`,
    detail:
      [run.error ?? run.summary, model(run), run.shelf_label].filter(Boolean).join(" · ") || null,
    tone: runTone(run.status),
    raw: run,
  };
}

export function curationRow(run: CurationRun): LogRow {
  return {
    id: run.id,
    at: run.created_at,
    title: `Curation ${run.status} (${run.trigger}, ${run.mode}): ${run.input_memory_ids.length} ${
      run.input_memory_ids.length === 1 ? "memory" : "memories"
    }`,
    detail:
      [run.error ?? run.summary, model(run), run.shelf_label].filter(Boolean).join(" · ") || null,
    tone: runTone(run.status),
    raw: run,
  };
}

export function backupRow(run: BackupRun): LogRow {
  return {
    id: run.id,
    at: run.created_at,
    title: `Backup ${run.status} (${run.trigger})${run.target ? ` to ${run.target}` : ""}`,
    detail: run.error ?? (run.bytes > 0 ? `${run.bytes.toLocaleString("en-GB")} bytes` : null),
    tone: runTone(run.status),
    raw: run,
  };
}

export function vaultRow(entry: VaultActivityEntry): LogRow {
  return {
    id: entry.hash,
    at: entry.date,
    title: entry.subject,
    detail: [entry.source, entry.author, plural(entry.files.length, "file")].join(" · "),
    tone: "neutral",
    raw: entry,
  };
}

function sliceByOffset<T>(
  all: readonly T[],
  cursor: string | undefined,
  limit: number,
  toRow: (item: T, index: number) => LogRow,
): LogPage {
  const offset = offsetOf(cursor);
  const slice = all.slice(offset, offset + limit);
  const next = offset + slice.length;
  return {
    rows: slice.map((item, i) => toRow(item, offset + i)),
    nextCursor: next < all.length ? String(next) : null,
    total: all.length,
  };
}

export async function logPage(
  store: LibrarianStore,
  source: LogSource,
  cursor: string | undefined,
  limit = DEFAULT_PAGE,
): Promise<LogPage> {
  switch (source) {
    case "reads": {
      const offset = offsetOf(cursor);
      const page = await store.readReads({ limit, offset });
      const next = offset + page.rows.length;
      return {
        rows: page.rows.map((row, i) => readRow(row, offset + i)),
        nextCursor: next < page.total ? String(next) : null,
        total: page.total,
      };
    }
    case "refusals": {
      const offset = offsetOf(cursor);
      const page = await store.readRefusals({ limit, offset });
      const next = offset + page.rows.length;
      return {
        rows: page.rows.map((row, i) => refusalRow(row, offset + i)),
        nextCursor: next < page.total ? String(next) : null,
        total: page.total,
      };
    }
    case "captures":
      return sliceByOffset(listRecent(store, SHORT_HISTORY), cursor, limit, captureRow);
    case "backups":
      return sliceByOffset(listBackupRuns(store, SHORT_HISTORY), cursor, limit, backupRow);
    case "intake": {
      const runs = store.listIntakeRuns({ limit, ...(cursor ? { before: cursor } : {}) });
      return {
        rows: runs.map(intakeRow),
        nextCursor: runs.length === limit ? (runs.at(-1)?.id ?? null) : null,
        total: null,
      };
    }
    case "curation": {
      const runs = store.listCurationRuns({ limit, ...(cursor ? { before: cursor } : {}) });
      return {
        rows: runs.map(curationRow),
        nextCursor: runs.length === limit ? (runs.at(-1)?.id ?? null) : null,
        total: null,
      };
    }
    case "vault": {
      const entries = store.vaultActivity({ limit, ...(cursor ? { before: cursor } : {}) });
      return {
        rows: entries.map(vaultRow),
        nextCursor: entries.length === limit ? (entries.at(-1)?.hash ?? null) : null,
        total: null,
      };
    }
  }
}

/** Walk a newest-first cursor listing to the cap, then return it oldest first. */
function walk<T>(
  fetch: (before: string | undefined) => T[],
  cursorOf: (item: T) => string,
): { rows: T[]; truncated: boolean } {
  const rows: T[] = [];
  let before: string | undefined;
  for (;;) {
    const page = fetch(before);
    rows.push(...page);
    if (page.length < MAX_PAGE) return { rows: rows.reverse(), truncated: false };
    if (rows.length >= EXPORT_CAP) {
      return { rows: rows.slice(0, EXPORT_CAP).reverse(), truncated: true };
    }
    before = cursorOf(page[page.length - 1] as T);
  }
}

export async function logExport(store: LibrarianStore, source: LogSource): Promise<LogExport> {
  switch (source) {
    case "reads":
      return { source, rows: await store.exportReads(), truncated: false };
    case "refusals":
      return { source, rows: await store.exportRefusals(), truncated: false };
    case "captures":
      return { source, rows: listRecent(store, SHORT_HISTORY).reverse(), truncated: false };
    case "backups":
      return { source, rows: listBackupRuns(store, SHORT_HISTORY).reverse(), truncated: false };
    case "intake": {
      const { rows, truncated } = walk(
        (before) => store.listIntakeRuns({ limit: MAX_PAGE, ...(before ? { before } : {}) }),
        (run) => run.id,
      );
      return {
        source,
        rows: rows.map((run) => ({ ...run, operations: store.getIntakeOperations(run.id) })),
        truncated,
      };
    }
    case "curation": {
      const { rows, truncated } = walk(
        (before) => store.listCurationRuns({ limit: MAX_PAGE, ...(before ? { before } : {}) }),
        (run) => run.id,
      );
      return {
        source,
        rows: rows.map((run) => ({ ...run, operations: store.getCurationOperations(run.id) })),
        truncated,
      };
    }
    case "vault": {
      const { rows, truncated } = walk(
        (before) => store.vaultActivity({ limit: MAX_PAGE, ...(before ? { before } : {}) }),
        (entry) => entry.hash,
      );
      return { source, rows, truncated };
    }
  }
}

export interface ReadLogConfig {
  /** The operator's switch. */
  enabled: boolean;
  /** Whether this server process records reads at all (only the HTTP server does). */
  recording: boolean;
}

function readLogConfig(store: LibrarianStore): ReadLogConfig {
  return {
    enabled: store.getSetting(READ_LOG_ENABLED_KEY) === "true",
    recording: store.readLogActive,
  };
}

export const logsRouter = router({
  page: adminProcedure
    .input(PageInput)
    .query(({ ctx, input }) => logPage(ctx.store, input.source, input.cursor, input.limit)),

  export: adminProcedure
    .input(z.strictObject({ source: LogSourceSchema }))
    .query(({ ctx, input }) => logExport(ctx.store, input.source)),

  readLogConfig: adminProcedure.query(({ ctx }) => readLogConfig(ctx.store)),

  setReadLog: adminProcedure
    .input(z.strictObject({ enabled: z.boolean() }))
    .mutation(({ ctx, input }) => {
      ctx.store.setSetting(READ_LOG_ENABLED_KEY, input.enabled ? "true" : "false");
      return readLogConfig(ctx.store);
    }),
});
