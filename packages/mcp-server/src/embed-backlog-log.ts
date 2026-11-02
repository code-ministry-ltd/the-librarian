// Server-log policy for embedding cache misses (the core `onEmbedBacklog` sink).
//
// Every index build reports its misses, including the one-memory rebuild after each
// `remember`. Those are routine, so they go to debug. A batch of LARGE_BATCH_CHUNKS or
// more — a cold or invalidated cache, a big new reference — goes to info: on a CPU-only
// host that is minutes of busy cores, and the server should say so rather than leave
// the operator to find it in `top`. A failed batch is always a warning.
//
// Value-free: the event carries counts and timing only, and so does every line here.

import type { EmbedBacklogEvent } from "@librarian/core";

/** Miss batches at or above this many chunks log at info; smaller ones at debug. */
export const LARGE_BATCH_CHUNKS = 10;

/** The slice of a pino logger this needs (keeps the policy testable without pino). */
export interface EmbedBacklogLogger {
  debug(details: object, msg: string): void;
  info(details: object, msg: string): void;
  warn(details: object, msg: string): void;
}

export function logEmbedBacklog(logger: EmbedBacklogLogger, event: EmbedBacklogEvent): void {
  const { scope, files, chunks } = event;
  const level = chunks >= LARGE_BATCH_CHUNKS ? "info" : "debug";
  if (event.phase === "start") {
    logger[level](
      { scope, files, chunks },
      `embedding ${chunks} chunk(s) from ${files} ${scope} file(s) missing from the embedding cache; this runs on the CPU and large batches can take minutes`,
    );
    return;
  }
  const seconds = Math.round(event.durationMs / 100) / 10;
  const details = { scope, files, chunks, durationMs: event.durationMs };
  if (event.failed) {
    logger.warn(
      details,
      `embedding ${scope} stopped after an error ${seconds}s in; the next index build retries the files that were not cached`,
    );
    return;
  }
  logger[level](
    details,
    `embedded ${chunks} chunk(s) from ${files} ${scope} file(s) in ${seconds}s`,
  );
}
