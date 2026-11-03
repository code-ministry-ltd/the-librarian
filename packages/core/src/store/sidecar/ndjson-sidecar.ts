import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";

/**
 * A bounded, append-only NDJSON sidecar (spec 080). It carries the same guarantees as the
 * refusal log (spec 071): one serialised append queue, torn-tail repair before each append,
 * size-bounded rotation keeping exactly one previous generation, 0600 files, a token-bucket
 * admission limit whose shed writes are persisted as one counted `dropped` row, and fail-soft
 * error reporting (the first error once, later ones suppressed).
 *
 * The refusal log predates this engine and still carries its own copy; migrating it here is a
 * tracked follow-up (docs/tech-debt.md), deliberately kept out of the read-log change.
 */

export type SidecarErrorSink = (error: unknown) => void;

export interface NdjsonSidecarDeps<R> {
  filePath: string;
  /** False makes every write a no-op and never creates the file. */
  active: boolean;
  /** Every row is validated against this before it is written, and again when it is read. */
  schema: z.ZodType<R>;
  /** Build the counted row persisted for a burst of shed writes. */
  makeDropped(ts: string, count: number, windowStart: string): R;
  /** The count a dropped row carries, or 0 for any other row. */
  droppedCount(record: R): number;
  maxBytes: number;
  bucketCapacity: number;
  bucketRefillPerSecond: number;
  queueCapacity?: number;
  now?: () => Date;
  onError?: SidecarErrorSink;
}

export interface SidecarReadOptions<R> {
  limit?: number;
  offset?: number;
  filter?: (record: R) => boolean;
}

export interface SidecarReadResult<R> {
  rows: R[];
  total: number;
  dropped: number;
}

export interface NdjsonSidecar<R> {
  /** Admit one already-built row. Always resolves; a failure is reported, never thrown. */
  append(build: (ts: string) => R | undefined): Promise<void>;
  read(options?: SidecarReadOptions<R>): Promise<SidecarReadResult<R>>;
  flush(): Promise<void>;
  readonly active: boolean;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function createNdjsonSidecar<R>(deps: NdjsonSidecarDeps<R>): NdjsonSidecar<R> {
  const now = deps.now ?? (() => new Date());
  const capacity = deps.bucketCapacity;
  const refillPerSecond = deps.bucketRefillPerSecond;
  const queueCapacity = deps.queueCapacity ?? capacity;
  if (deps.maxBytes <= 0 || capacity <= 0 || refillPerSecond <= 0 || queueCapacity <= 0) {
    throw new Error("sidecar bounds must all be greater than zero");
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
      // Observability must stay fail-open even when its diagnostic sink fails.
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

  const takeDropped = (
    ts: string,
  ): { record: R; count: number; windowStart: string } | undefined => {
    if (droppedCount === 0 || droppedWindowStart === undefined) return undefined;
    const snapshot = {
      record: deps.makeDropped(ts, droppedCount, droppedWindowStart),
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
    if (currentSize === 0 || currentSize + lineBytes <= deps.maxBytes) return;
    const priorPath = `${deps.filePath}.1`;
    await fs.rm(priorPath, { force: true });
    try {
      await fs.rename(deps.filePath, priorPath);
      await fs.chmod(priorPath, 0o600);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  };

  const write = async (record: R): Promise<void> => {
    const parsed = deps.schema.safeParse(record);
    if (!parsed.success) throw new Error("sidecar record failed schema validation");
    const line = Buffer.from(`${JSON.stringify(parsed.data)}\n`, "utf8");
    if (line.byteLength > deps.maxBytes) {
      throw new Error("sidecar record exceeds the generation size bound");
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
      if (bytesWritten !== line.byteLength) throw new Error("sidecar append was incomplete");
    } finally {
      await handle.close();
    }
  };

  const enqueue = (record: R, onFailure?: () => void): Promise<void> => {
    pendingWrites += 1;
    const settled = queue
      .then(() => write(record))
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

  const append = (build: (ts: string) => R | undefined): Promise<void> => {
    if (!deps.active) return Promise.resolve();
    try {
      const at = now();
      const ts = at.toISOString();
      const record = build(ts);
      if (record === undefined || !deps.schema.safeParse(record).success) {
        reportError(new Error("sidecar record failed schema validation"));
        return Promise.resolve();
      }
      refill(at.getTime());
      let last: Promise<void> = Promise.resolve();
      if (droppedCount > 0 && tokens >= 1 && pendingWrites < queueCapacity) {
        const snapshot = takeDropped(ts);
        if (snapshot !== undefined) {
          tokens -= 1;
          last = enqueue(snapshot.record, () => restoreDropped(snapshot));
        }
      }
      if (tokens < 1 || pendingWrites >= queueCapacity) {
        droppedCount += 1;
        droppedWindowStart ??= ts;
        return last;
      }
      tokens -= 1;
      return enqueue(record);
    } catch (error) {
      reportError(error);
      return Promise.resolve();
    }
  };

  const readFile = async (filePath: string): Promise<R[]> => {
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
    const rows: R[] = [];
    for (const line of complete.split("\n")) {
      if (line.length === 0) continue;
      try {
        const parsed = deps.schema.safeParse(JSON.parse(line));
        if (parsed.success) rows.push(parsed.data);
      } catch {
        // Corrupt and torn rows are evidence gaps, never availability failures.
      }
    }
    return rows;
  };

  const performRead = async (options: SidecarReadOptions<R>): Promise<SidecarReadResult<R>> => {
    const [prior, current] = await Promise.all([
      readFile(`${deps.filePath}.1`),
      readFile(deps.filePath),
    ]);
    const newestFirst = [...prior, ...current].reverse();
    const filtered = options.filter ? newestFirst.filter(options.filter) : newestFirst;
    const limit = Math.max(1, Math.min(1_000, Math.trunc(options.limit ?? 200)));
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const rows = filtered.slice(offset, offset + limit);
    const dropped = rows.reduce((sum, record) => sum + deps.droppedCount(record), 0);
    return { rows, total: filtered.length, dropped };
  };

  const flush = (): Promise<void> => {
    try {
      if (deps.active) {
        const snapshot = takeDropped(now().toISOString());
        if (snapshot !== undefined) enqueue(snapshot.record, () => restoreDropped(snapshot));
      }
    } catch (error) {
      reportError(error);
    }
    return queue;
  };

  const read = (options: SidecarReadOptions<R> = {}): Promise<SidecarReadResult<R>> => {
    void flush();
    const result = queue
      .then(() => performRead(options))
      .catch((error: unknown) => {
        reportError(error);
        return { rows: [], total: 0, dropped: 0 };
      });
    queue = result.then(() => undefined);
    return result;
  };

  return { append, read, flush, active: deps.active };
}
