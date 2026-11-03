import { createHash } from "node:crypto";
import { z } from "zod";
import { redactSecrets } from "../../grooming-redaction.js";
import { IsoTimestampSchema } from "../../schemas/common.js";
import { createNdjsonSidecar, type SidecarErrorSink } from "./ndjson-sidecar.js";

/**
 * The read log (spec 080): one row per read an agent makes of the Librarian, so an operator can
 * see what agents ask for, what they get back, and what startup injection costs. Opt-in (the
 * operator turns it on in the dashboard, spec 081) because query text can be as sensitive as the
 * memories themselves; it never leaves the server's data directory.
 */

export const READ_LOG_FILE = "read-log.ndjson";
/** The settings key behind the dashboard switch. Absent or anything but `"true"` means off. */
export const READ_LOG_ENABLED_KEY = "observability.readLog.enabled";
export const READ_LOG_MAX_BYTES = 20 * 1024 * 1024;
export const READ_LOG_BUCKET_CAPACITY = 240;
export const READ_LOG_REFILL_PER_SECOND = 4;
export const READ_LOG_QUERY_MAX_LENGTH = 1_000;
export const READ_LOG_MAX_ITEMS = 50;

const IDENTIFIER_MAX_LENGTH = 128;
const PATH_MAX_LENGTH = 512;
const TAG_MAX_LENGTH = 128;

const Identifier = z.string().min(1).max(IDENTIFIER_MAX_LENGTH);
const Count = z.number().int().nonnegative();

const Common = {
  v: z.literal(1),
  ts: IsoTimestampSchema,
  actorId: Identifier.optional(),
  tokenId: Identifier.optional(),
  shelfIds: z.array(Identifier).max(16).optional(),
  durationMs: Count.optional(),
};

export const RecallReadSchema = z
  .object({
    ...Common,
    kind: z.literal("recall"),
    mode: z.enum(["search", "ids"]),
    query: z.string().max(READ_LOG_QUERY_MAX_LENGTH).optional(),
    tags: z.array(z.string().min(1).max(TAG_MAX_LENGTH)).max(READ_LOG_MAX_ITEMS).optional(),
    limit: Count.optional(),
    requestedIds: z.array(Identifier).max(READ_LOG_MAX_ITEMS).optional(),
    returnedIds: z.array(Identifier).max(READ_LOG_MAX_ITEMS),
    returnedCount: Count,
    excerpts: z.boolean(),
    resultChars: Count,
  })
  .strict();

export const ReferenceReadSchema = z
  .object({
    ...Common,
    kind: z.literal("search_references"),
    query: z.string().max(READ_LOG_QUERY_MAX_LENGTH),
    limit: Count.optional(),
    returnedPaths: z.array(z.string().min(1).max(PATH_MAX_LENGTH)).max(READ_LOG_MAX_ITEMS),
    returnedCount: Count,
    resultChars: Count,
  })
  .strict();

export const PrimerReadSchema = z
  .object({
    ...Common,
    kind: z.literal("primer"),
    resultChars: Count,
    primerHash: z.string().regex(/^[0-9a-f]{12}$/),
  })
  .strict();

export const JournalReadSchema = z
  .object({
    ...Common,
    kind: z.literal("journal"),
    resultChars: Count,
    maxChars: Count.optional(),
  })
  .strict();

export const ReadDroppedSchema = z
  .object({
    v: z.literal(1),
    ts: IsoTimestampSchema,
    kind: z.literal("dropped"),
    count: z.number().int().positive(),
    windowStart: IsoTimestampSchema,
  })
  .strict();

export const ReadRecordSchema = z.discriminatedUnion("kind", [
  RecallReadSchema,
  ReferenceReadSchema,
  PrimerReadSchema,
  JournalReadSchema,
  ReadDroppedSchema,
]);

export type ReadRecord = z.infer<typeof ReadRecordSchema>;
export type ReadKind = ReadRecord["kind"];

type Unstamped<T> = T extends unknown ? Omit<T, "v" | "ts"> : never;
/** What a call site supplies: any read row except `dropped`, without `v`/`ts`. */
export type RecordReadInput = Unstamped<Exclude<ReadRecord, { kind: "dropped" }>>;

export interface ReadReadsOptions {
  limit?: number;
  offset?: number;
  kind?: ReadKind;
}

export interface ReadReadsResult {
  rows: ReadRecord[];
  total: number;
  dropped: number;
}

export interface ReadLog {
  record(input: RecordReadInput): Promise<void>;
  read(options?: ReadReadsOptions): Promise<ReadReadsResult>;
  /** Every retained row, oldest first, for a download. */
  exportAll(): Promise<ReadRecord[]>;
  flush(): Promise<void>;
  /** True when this process writes rows; call sites skip building a row when it is false. */
  readonly active: boolean;
}

export interface ReadLogDeps {
  filePath: string;
  armed: boolean;
  onError?: SidecarErrorSink;
  now?: () => Date;
  /** The operator's switch, consulted on every read; absent means off. */
  enabled?: boolean | (() => boolean);
  maxBytes?: number;
  bucketCapacity?: number;
  bucketRefillPerSecond?: number;
}

/** First 12 hex characters of the SHA-256 of a text: enough to tell primer versions apart. */
export function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function clean(value: string, maxLength: number): string | undefined {
  let result = "";
  let length = 0;
  for (const char of redactSecrets(value).redacted) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) continue;
    if (/\p{Bidi_Control}/u.test(char)) continue;
    result += char;
    length += 1;
    if (length === maxLength) break;
  }
  return result.length === 0 ? undefined : result;
}

function cleanList(values: readonly string[] | undefined, maxLength: number): string[] | undefined {
  if (values === undefined) return undefined;
  return values
    .slice(0, READ_LOG_MAX_ITEMS)
    .map((value) => clean(value, maxLength))
    .filter((value): value is string => value !== undefined);
}

function stripUndefined<T extends Record<string, unknown>>(row: T): T {
  for (const key of Object.keys(row)) if (row[key] === undefined) delete row[key];
  return row;
}

/** Sanitise caller-controlled strings, stamp `v`/`ts`, and drop absent optional fields. */
export function buildReadRecord(input: RecordReadInput, ts: string): ReadRecord | undefined {
  const row: Record<string, unknown> = { ...input, v: 1, ts };
  row.actorId =
    input.actorId === undefined ? undefined : clean(input.actorId, IDENTIFIER_MAX_LENGTH);
  row.tokenId =
    input.tokenId === undefined ? undefined : clean(input.tokenId, IDENTIFIER_MAX_LENGTH);
  row.shelfIds = cleanList(input.shelfIds, IDENTIFIER_MAX_LENGTH)?.slice(0, 16);
  if (input.kind === "recall") {
    row.query =
      input.query === undefined ? undefined : clean(input.query, READ_LOG_QUERY_MAX_LENGTH);
    row.tags = cleanList(input.tags, TAG_MAX_LENGTH);
    row.requestedIds = cleanList(input.requestedIds, IDENTIFIER_MAX_LENGTH);
    row.returnedIds = cleanList(input.returnedIds, IDENTIFIER_MAX_LENGTH) ?? [];
  }
  if (input.kind === "search_references") {
    row.query = clean(input.query, READ_LOG_QUERY_MAX_LENGTH) ?? "";
    row.returnedPaths = cleanList(input.returnedPaths, PATH_MAX_LENGTH) ?? [];
  }
  const parsed = ReadRecordSchema.safeParse(stripUndefined(row));
  return parsed.success ? parsed.data : undefined;
}

export function createReadLog(deps: ReadLogDeps): ReadLog {
  const enabled = deps.enabled ?? false;
  const sidecar = createNdjsonSidecar<ReadRecord>({
    filePath: deps.filePath,
    active: () => deps.armed && (typeof enabled === "boolean" ? enabled : enabled()),
    schema: ReadRecordSchema,
    makeDropped: (ts, count, windowStart) => ({ v: 1, ts, kind: "dropped", count, windowStart }),
    droppedCount: (record) => (record.kind === "dropped" ? record.count : 0),
    maxBytes: deps.maxBytes ?? READ_LOG_MAX_BYTES,
    bucketCapacity: deps.bucketCapacity ?? READ_LOG_BUCKET_CAPACITY,
    bucketRefillPerSecond: deps.bucketRefillPerSecond ?? READ_LOG_REFILL_PER_SECOND,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.onError ? { onError: deps.onError } : {}),
  });
  return {
    record: (input) => sidecar.append((ts) => buildReadRecord(input, ts)),
    read: (options = {}) =>
      sidecar.read({
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...(options.offset === undefined ? {} : { offset: options.offset }),
        ...(options.kind === undefined ? {} : { filter: (row) => row.kind === options.kind }),
      }),
    exportAll: sidecar.exportAll,
    flush: sidecar.flush,
    get active() {
      return sidecar.active;
    },
  };
}
