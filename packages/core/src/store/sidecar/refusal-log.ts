import { constants } from "node:fs";
import fs from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { z } from "zod";
import type { Principal } from "../../caller-identity.js";
import { redactSecrets } from "../../grooming-redaction.js";
import { IsoTimestampSchema } from "../../schemas/common.js";

/**
 * The one principal→refusal-evidence mapping. Every surface that records a
 * refusal must attribute it through here so the rows stay forensically
 * comparable across denial kinds.
 */
export function principalRefusalEvidence(
  principal: Pick<Principal, "actorId" | "roles" | "tokenId"> | undefined,
): { actorId?: string; roles?: string[]; tokenId?: string } {
  if (principal === undefined) return {};
  return {
    actorId: principal.actorId,
    roles: [...principal.roles],
    ...(principal.tokenId === undefined ? {} : { tokenId: principal.tokenId }),
  };
}

export const REFUSAL_LOG_FILE = "refusal-log.ndjson";
export const REFUSAL_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const REFUSAL_LOG_BUCKET_CAPACITY = 120;
export const REFUSAL_LOG_REFILL_PER_SECOND = 2;

const IDENTIFIER_MAX_LENGTH = 128;
const ROLE_MAX_LENGTH = 64;
const ROLES_MAX_COUNT = 16;
const PATH_MAX_LENGTH = 512;
const NETWORK_MAX_LENGTH = 512;

function hasUnsafeCharacters(value: string): boolean {
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      /\p{Bidi_Control}/u.test(char)
    ) {
      return true;
    }
  }
  return false;
}

function safeStringSchema(maxLength: number): z.ZodType<string> {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => !hasUnsafeCharacters(value), "must not contain control characters")
    .refine((value) => redactSecrets(value).count === 0, "must not contain secret-shaped material");
}

const IdentifierSchema = safeStringSchema(IDENTIFIER_MAX_LENGTH);
const RoleSchema = safeStringSchema(ROLE_MAX_LENGTH);
const PathSchema = safeStringSchema(PATH_MAX_LENGTH);
const IpSchema = safeStringSchema(64).refine(
  (value) => isIP(value) !== 0,
  "expected an IP address",
);
const ForwardedForSchema = safeStringSchema(NETWORK_MAX_LENGTH).refine(
  (value) => value.split(", ").every((entry) => isIP(entry) !== 0),
  "expected a canonical IP chain",
);
const OriginSchema = safeStringSchema(NETWORK_MAX_LENGTH).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.username === "" && parsed.password === "" && canonicalOrigin(value) === value;
  } catch {
    return false;
  }
}, "expected a canonical origin");

export const RefusalDenialKindSchema = z.enum([
  "bearer-missing",
  "bearer-invalid",
  "bearer-wrong-scope",
  "provider-refused",
  "origin-blocked",
  "rate-limited",
  "trpc-unauthorized",
  "tool-admin-only",
  "password-failed",
  "password-lockout",
  "setup-link-refused",
  "enable-refused",
  "claim-refused",
  "shelf-not-writable",
  "shelf-outside-write-set",
]);

export const RefusalSurfaceSchema = z.enum(["public", "internal", "store"]);
export const RefusalOutcomeSchema = z.union([
  z.literal(401),
  z.literal(403),
  z.literal(429),
  z.literal("locked"),
  z.literal("refused"),
]);

export const RefusalDenialSchema = z
  .object({
    v: z.literal(1),
    ts: IsoTimestampSchema,
    kind: RefusalDenialKindSchema,
    surface: RefusalSurfaceSchema,
    outcome: RefusalOutcomeSchema,
    path: PathSchema.optional(),
    procedure: IdentifierSchema.optional(),
    tool: IdentifierSchema.optional(),
    username: IdentifierSchema.optional(),
    actorId: IdentifierSchema.optional(),
    roles: z.array(RoleSchema).max(ROLES_MAX_COUNT).optional(),
    tokenId: IdentifierSchema.optional(),
    tokenHash: z
      .string()
      .regex(/^[0-9a-f]{12}$/)
      .optional(),
    ip: IpSchema.optional(),
    forwardedFor: ForwardedForSchema.optional(),
    origin: OriginSchema.optional(),
    detail: PathSchema.optional(),
    shelfId: IdentifierSchema.optional(),
    shelfLabel: IdentifierSchema.optional(),
  })
  .strict();

export const RefusalDroppedSchema = z
  .object({
    v: z.literal(1),
    ts: IsoTimestampSchema,
    kind: z.literal("dropped"),
    count: z.number().int().positive(),
    windowStart: IsoTimestampSchema,
  })
  .strict();

export const RefusalRecordSchema = z.discriminatedUnion("kind", [
  RefusalDenialSchema,
  RefusalDroppedSchema,
]);

export type RefusalDenialKind = z.infer<typeof RefusalDenialKindSchema>;
export type RefusalSurface = z.infer<typeof RefusalSurfaceSchema>;
export type RefusalOutcome = z.infer<typeof RefusalOutcomeSchema>;
export type RefusalDenial = z.infer<typeof RefusalDenialSchema>;
export type RefusalDropped = z.infer<typeof RefusalDroppedSchema>;
export type RefusalRecord = z.infer<typeof RefusalRecordSchema>;
export type RecordRefusalInput = Omit<RefusalDenial, "v" | "ts">;

export interface ReadRefusalsOptions {
  limit?: number;
  offset?: number;
  kind?: RefusalRecord["kind"];
}

export interface ReadRefusalsResult {
  rows: RefusalRecord[];
  total: number;
  dropped: number;
}

export type RefusalLogErrorSink = (error: unknown) => void;

export interface RefusalLog {
  record(input: RecordRefusalInput): Promise<void>;
  read(options?: ReadRefusalsOptions): Promise<ReadRefusalsResult>;
  /** Every valid row in both generations, oldest first, for a download (spec 081). */
  exportAll(): Promise<RefusalRecord[]>;
  /** Persist accepted writes and one counted row for any finite dropped burst. */
  flush(): Promise<void>;
}

/**
 * Construction dependencies for the bounded sidecar. The sizing/rate options
 * are internal test seams; production callers use the exported fixed defaults.
 */
export interface RefusalLogDeps {
  filePath: string;
  armed: boolean;
  onError?: RefusalLogErrorSink;
  now?: () => Date;
  maxBytes?: number;
  bucketCapacity?: number;
  bucketRefillPerSecond?: number;
  /** Maximum accepted append operations waiting on disk; defaults to the bucket capacity. */
  queueCapacity?: number;
}

const EMPTY_RESULT: ReadRefusalsResult = { rows: [], total: 0, dropped: 0 };

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function sanitiseString(value: string, maxLength: number): string | undefined {
  const redacted = redactSecrets(value).redacted;
  let result = "";
  let length = 0;
  for (const char of redacted) {
    if (hasUnsafeCharacters(char)) continue;
    result += char;
    length += 1;
    if (length === maxLength) break;
  }
  return result.length === 0 ? undefined : result;
}

function canonicalIp(value: string): string | undefined {
  const sanitised = sanitiseString(value.trim(), 64);
  return sanitised !== undefined && isIP(sanitised) !== 0 ? sanitised : undefined;
}

function canonicalForwardedFor(value: string): string | undefined {
  const entries = value
    .split(",")
    .map((entry) => canonicalIp(entry))
    .filter((entry): entry is string => entry !== undefined)
    .slice(0, 8);
  return entries.length === 0 ? undefined : entries.join(", ");
}

function canonicalOrigin(value: string): string | undefined {
  const sanitised = sanitiseString(value, NETWORK_MAX_LENGTH);
  if (sanitised === undefined) return undefined;
  try {
    const parsed = new URL(sanitised);
    if (parsed.protocol.length === 0 || parsed.host.length === 0) return undefined;
    return sanitiseString(`${parsed.protocol}//${parsed.host}`, NETWORK_MAX_LENGTH);
  } catch {
    return undefined;
  }
}

function assignString(
  target: Record<string, unknown>,
  key: string,
  value: string | undefined,
  maxLength: number,
): void {
  if (value === undefined) return;
  const sanitised = sanitiseString(value, maxLength);
  if (sanitised !== undefined) target[key] = sanitised;
}

function sanitiseDenial(input: RecordRefusalInput, ts: string) {
  const candidate: Record<string, unknown> = {
    v: 1,
    ts,
    kind: input.kind,
    surface: input.surface,
    outcome: input.outcome,
  };
  assignString(candidate, "path", input.path, PATH_MAX_LENGTH);
  assignString(candidate, "procedure", input.procedure, IDENTIFIER_MAX_LENGTH);
  assignString(candidate, "tool", input.tool, IDENTIFIER_MAX_LENGTH);
  assignString(candidate, "username", input.username, IDENTIFIER_MAX_LENGTH);
  assignString(candidate, "actorId", input.actorId, IDENTIFIER_MAX_LENGTH);
  assignString(candidate, "tokenId", input.tokenId, IDENTIFIER_MAX_LENGTH);
  assignString(candidate, "detail", input.detail, PATH_MAX_LENGTH);
  assignString(candidate, "shelfId", input.shelfId, IDENTIFIER_MAX_LENGTH);
  assignString(candidate, "shelfLabel", input.shelfLabel, IDENTIFIER_MAX_LENGTH);
  if (input.roles !== undefined) {
    candidate.roles = input.roles
      .slice(0, ROLES_MAX_COUNT)
      .map((role) => sanitiseString(role, ROLE_MAX_LENGTH))
      .filter((role): role is string => role !== undefined);
  }
  if (input.tokenHash !== undefined) candidate.tokenHash = input.tokenHash;
  if (input.ip !== undefined) {
    const ip = canonicalIp(input.ip);
    if (ip !== undefined) candidate.ip = ip;
  }
  if (input.forwardedFor !== undefined) {
    const forwardedFor = canonicalForwardedFor(input.forwardedFor);
    if (forwardedFor !== undefined) candidate.forwardedFor = forwardedFor;
  }
  if (input.origin !== undefined) {
    const origin = canonicalOrigin(input.origin);
    if (origin !== undefined) candidate.origin = origin;
  }
  return RefusalDenialSchema.safeParse(candidate);
}

/**
 * One process-local refusal sink. Callers arm exactly one instance in the HTTP
 * process; all other stores retain the inert writer while sharing this read API.
 */
export function createRefusalLog(deps: RefusalLogDeps): RefusalLog {
  const active = deps.armed && process.env.LIBRARIAN_REFUSAL_LOG !== "false";
  const now = deps.now ?? (() => new Date());
  const maxBytes = deps.maxBytes ?? REFUSAL_LOG_MAX_BYTES;
  const capacity = deps.bucketCapacity ?? REFUSAL_LOG_BUCKET_CAPACITY;
  const refillPerSecond = deps.bucketRefillPerSecond ?? REFUSAL_LOG_REFILL_PER_SECOND;
  const queueCapacity = deps.queueCapacity ?? capacity;

  if (maxBytes <= 0 || capacity <= 0 || refillPerSecond <= 0 || queueCapacity <= 0) {
    throw new Error("refusal-log bounds must all be greater than zero");
  }

  let tokens = capacity;
  let lastRefillMs: number | undefined;
  let droppedCount = 0;
  let droppedWindowStart: string | undefined;
  let errorReported = false;
  let queue: Promise<void> = Promise.resolve();
  let pendingWrites = 0;

  const reportError = (error: unknown): void => {
    if (errorReported) return;
    errorReported = true;
    try {
      deps.onError?.(error);
    } catch {
      // Observability must remain fail-open even when its diagnostic sink fails.
    }
  };

  const refill = (atMs: number): void => {
    if (lastRefillMs === undefined) {
      lastRefillMs = atMs;
      return;
    }
    const elapsedMs = Math.max(0, atMs - lastRefillMs);
    tokens = Math.min(capacity, tokens + (elapsedMs / 1_000) * refillPerSecond);
    lastRefillMs = atMs;
  };

  const noteDrop = (ts: string): void => {
    droppedCount += 1;
    droppedWindowStart ??= ts;
  };

  const takeDropped = (
    ts: string,
  ): { record: RefusalDropped; count: number; windowStart: string } | undefined => {
    if (droppedCount === 0 || droppedWindowStart === undefined) return undefined;
    const snapshot = {
      record: {
        v: 1 as const,
        ts,
        kind: "dropped" as const,
        count: droppedCount,
        windowStart: droppedWindowStart,
      },
      count: droppedCount,
      windowStart: droppedWindowStart,
    };
    droppedCount = 0;
    droppedWindowStart = undefined;
    return snapshot;
  };

  const restoreDropped = (snapshot: { count: number; windowStart: string }): void => {
    droppedCount += snapshot.count;
    if (
      droppedWindowStart === undefined ||
      Date.parse(snapshot.windowStart) < Date.parse(droppedWindowStart)
    ) {
      droppedWindowStart = snapshot.windowStart;
    }
  };

  const repairTornTail = async (): Promise<void> => {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(deps.filePath, "r+");
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    try {
      const size = (await handle.stat()).size;
      if (size === 0) return;
      const finalByte = Buffer.allocUnsafe(1);
      await handle.read(finalByte, 0, 1, size - 1);
      if (finalByte[0] === 0x0a) return;

      const chunkSize = 64 * 1024;
      let cursor = size;
      while (cursor > 0) {
        const start = Math.max(0, cursor - chunkSize);
        const chunk = Buffer.allocUnsafe(cursor - start);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, start);
        const newline = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
        if (newline !== -1) {
          await handle.truncate(start + newline + 1);
          return;
        }
        cursor = start;
      }
      await handle.truncate(0);
    } finally {
      await handle.close();
    }
  };

  const rotateIfNeeded = async (lineBytes: number): Promise<void> => {
    let currentSize = 0;
    try {
      currentSize = (await fs.stat(deps.filePath)).size;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (currentSize === 0 || currentSize + lineBytes <= maxBytes) return;

    const priorPath = `${deps.filePath}.1`;
    await fs.rm(priorPath, { force: true });
    try {
      await fs.rename(deps.filePath, priorPath);
      await fs.chmod(priorPath, 0o600);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  };

  const append = async (record: RefusalRecord): Promise<void> => {
    const parsed = RefusalRecordSchema.safeParse(record);
    if (!parsed.success) {
      throw new Error("refusal record failed schema validation");
    }
    const line = Buffer.from(`${JSON.stringify(parsed.data)}\n`, "utf8");
    if (line.byteLength > maxBytes) {
      throw new Error("refusal record exceeds the refusal-log generation bound");
    }
    await fs.mkdir(path.dirname(deps.filePath), { recursive: true });
    await repairTornTail();
    await rotateIfNeeded(line.byteLength);
    const handle = await fs.open(
      deps.filePath,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.chmod(0o600);
      const { bytesWritten } = await handle.write(line, 0, line.byteLength, null);
      if (bytesWritten !== line.byteLength) {
        throw new Error("refusal-log append was incomplete");
      }
    } finally {
      await handle.close();
    }
  };

  const enqueueAppend = (record: RefusalRecord, onFailure?: () => void): Promise<void> => {
    pendingWrites += 1;
    const operation = queue.then(() => append(record));
    const settled = operation
      .catch((error: unknown) => {
        onFailure?.();
        reportError(error);
      })
      .then(() => {
        pendingWrites -= 1;
      });
    queue = settled;
    return settled;
  };

  const record = (input: RecordRefusalInput): Promise<void> => {
    if (!active) return Promise.resolve();
    try {
      const at = now();
      const ts = at.toISOString();
      const denial = sanitiseDenial(input, ts);
      if (!denial.success) {
        reportError(new Error("refusal record failed schema validation"));
        return Promise.resolve();
      }

      refill(at.getTime());
      let lastOperation: Promise<void> = Promise.resolve();
      if (droppedCount > 0 && tokens >= 1 && pendingWrites < queueCapacity) {
        const snapshot = takeDropped(ts);
        if (snapshot !== undefined) {
          tokens -= 1;
          lastOperation = enqueueAppend(snapshot.record, () => restoreDropped(snapshot));
        }
      }

      if (tokens < 1 || pendingWrites >= queueCapacity) {
        noteDrop(ts);
        return lastOperation;
      }

      tokens -= 1;
      return enqueueAppend(denial.data);
    } catch (error) {
      reportError(error);
      return Promise.resolve();
    }
  };

  const readFile = async (filePath: string): Promise<RefusalRecord[]> => {
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const complete = content.endsWith("\n")
      ? content
      : content.slice(0, content.lastIndexOf("\n") + 1);
    if (complete.length === 0) return [];
    const rows: RefusalRecord[] = [];
    for (const line of complete.split("\n")) {
      if (line.length === 0) continue;
      try {
        const parsed = RefusalRecordSchema.safeParse(JSON.parse(line));
        if (parsed.success) rows.push(parsed.data);
      } catch {
        // Corrupt and torn rows are evidence gaps, never availability failures.
      }
    }
    return rows;
  };

  const readGenerations = async (): Promise<RefusalRecord[]> => {
    const [prior, current] = await Promise.all([
      readFile(`${deps.filePath}.1`),
      readFile(deps.filePath),
    ]);
    return [...prior, ...current];
  };

  const performRead = async (options: ReadRefusalsOptions): Promise<ReadRefusalsResult> => {
    const newestFirst = (await readGenerations()).reverse();
    const filtered =
      options.kind === undefined
        ? newestFirst
        : newestFirst.filter((record) => record.kind === options.kind);
    const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 200)));
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const rows = filtered.slice(offset, offset + limit);
    const dropped = rows.reduce(
      (sum, record) => sum + (record.kind === "dropped" ? record.count : 0),
      0,
    );
    return { rows, total: filtered.length, dropped };
  };

  const flush = (): Promise<void> => {
    try {
      if (active) {
        const ts = now().toISOString();
        const snapshot = takeDropped(ts);
        if (snapshot !== undefined) {
          enqueueAppend(snapshot.record, () => restoreDropped(snapshot));
        }
      }
    } catch (error) {
      reportError(error);
    }
    return queue;
  };

  const read = (options: ReadRefusalsOptions = {}): Promise<ReadRefusalsResult> => {
    void flush();
    const operation = queue.then(() => performRead(options));
    const result = operation.catch((error: unknown) => {
      reportError(error);
      return { ...EMPTY_RESULT };
    });
    queue = result.then(() => undefined);
    return result;
  };

  const exportAll = (): Promise<RefusalRecord[]> => {
    void flush();
    const result = queue.then(readGenerations).catch((error: unknown) => {
      reportError(error);
      return [] as RefusalRecord[];
    });
    queue = result.then(() => undefined);
    return result;
  };

  return { record, read, exportAll, flush };
}
