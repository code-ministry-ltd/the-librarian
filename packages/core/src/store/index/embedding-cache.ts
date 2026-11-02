// Persistent embedding cache (rethink T23 / spec §9 D5). A sidecar directory
// (by convention `<data-dir>/embeddings-cache/` — OUTSIDE the vault, so it is
// never git-committed or pushed) that stores per-file chunk embeddings keyed
// by (relative file path, content hash, embedder model id). It exists so a
// process restart never re-embeds unchanged files: the in-memory
// createCachingEmbedder dies with the process, and under the real model
// (EmbeddingGemma on CPU) re-embedding a large references/ tree on first
// search costs minutes.
//
// Layout: `<dir>/<urlencode(modelId)>/<urlencode(relPath)>.json`, one record
// per source file. The model id lives in the path (not just the record) so
// switching embedders (hash ↔ llama) can never serve a wrong-model vector and
// switching back doesn't thrash. Filenames are URL-encoded so the original
// path is recoverable for pruning without reading every record.
//
// Invalidation is per file and all-or-nothing: a record is valid only when its
// content hash AND its ordered chunk-text hashes match what the caller derived
// from the live file — so both a content edit and a chunker-parameter change
// (same content, different chunks) force a clean re-embed. Every disk
// operation is fail-soft: a missing/corrupt/torn record is a cache miss, a
// failed write is a no-op — the cache can be deleted wholesale at any time.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Embedder } from "./hybrid-index.js";

export interface EmbeddingCacheOptions {
  /** Cache root, e.g. `<data-dir>/embeddings-cache` (must be outside the vault). */
  dir: string;
  /** Stable embedder/model identity (see `Embedder.modelId`); part of the key. */
  modelId: string;
}

/** One persisted vector, validated against the sha256 of the chunk text it embeds. */
export interface CachedChunkVector {
  sha: string;
  vector: number[];
}

interface CacheRecord {
  version: 1;
  modelId: string;
  path: string;
  contentHash: string;
  entries: CachedChunkVector[];
}

export interface EmbeddingCache {
  readonly modelId: string;
  /**
   * The file's cached chunk vectors, in chunk order — or null when anything
   * mismatches (content hash, chunk hashes, model, or a corrupt record).
   */
  get(relPath: string, contentHash: string, chunkShas: string[]): number[][] | null;
  /** Persist the file's chunk vectors (overwrites any prior record). */
  put(relPath: string, contentHash: string, entries: CachedChunkVector[]): void;
  /**
   * Opportunistic orphan cleanup: delete records whose path starts with
   * `prefix` but is not in `livePaths` (i.e. the source file was deleted).
   * Prefix-scoped so a references/ sweep can't evict memories/ entries.
   */
  prune(prefix: string, livePaths: Iterable<string>): void;
}

/** sha256 hex of a text — the content/chunk hash the cache keys on. */
export function contentSha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function createEmbeddingCache(options: EmbeddingCacheOptions): EmbeddingCache {
  const { modelId } = options;
  const modelDir = path.join(options.dir, encodeURIComponent(modelId));
  const recordPath = (relPath: string): string =>
    path.join(modelDir, `${encodeURIComponent(relPath)}.json`);

  function readRecord(relPath: string): CacheRecord | null {
    try {
      const raw = fs.readFileSync(recordPath(relPath), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return null;
      const record = parsed as Partial<CacheRecord>;
      if (record.version !== 1 || record.modelId !== modelId || record.path !== relPath) {
        return null;
      }
      if (typeof record.contentHash !== "string" || !Array.isArray(record.entries)) return null;
      return record as CacheRecord;
    } catch {
      return null; // missing, unreadable, or torn — all just a miss
    }
  }

  return {
    modelId,
    get(relPath, contentHash, chunkShas) {
      const record = readRecord(relPath);
      if (!record || record.contentHash !== contentHash) return null;
      if (record.entries.length !== chunkShas.length) return null;
      const vectors: number[][] = [];
      for (let i = 0; i < chunkShas.length; i++) {
        const entry = record.entries[i];
        if (!entry || entry.sha !== chunkShas[i] || !Array.isArray(entry.vector)) return null;
        vectors.push(entry.vector);
      }
      return vectors;
    },
    put(relPath, contentHash, entries) {
      const record: CacheRecord = { version: 1, modelId, path: relPath, contentHash, entries };
      try {
        fs.mkdirSync(modelDir, { recursive: true });
        // Plain write, no tmp+rename: a torn record fails JSON.parse → miss →
        // re-embed. Cheap correctness over write atomicity.
        fs.writeFileSync(recordPath(relPath), JSON.stringify(record), "utf8");
      } catch {
        /* fail-soft: an unwritable cache only costs a future re-embed */
      }
    },
    prune(prefix, livePaths) {
      const live = new Set(livePaths);
      try {
        for (const name of fs.readdirSync(modelDir)) {
          if (!name.endsWith(".json")) continue;
          const relPath = decodeURIComponent(name.slice(0, -".json".length));
          if (!relPath.startsWith(prefix) || live.has(relPath)) continue;
          fs.rmSync(path.join(modelDir, name), { force: true });
        }
      } catch {
        /* fail-soft: a missing/unreadable dir means nothing to prune */
      }
    },
  };
}

/**
 * Resolve a file's chunk vectors through the cache: serve all of them from
 * disk when the file is unchanged, else embed every chunk (sequentially, like
 * the index build does) and persist the fresh record. Returns vectors in
 * chunk order. This is THE call sites' seam — they never touch get/put
 * directly, so hit/miss/persist stay consistent everywhere.
 */
export async function embedChunksWithCache(
  cache: EmbeddingCache,
  embedder: Embedder,
  relPath: string,
  content: string,
  chunkTexts: string[],
): Promise<number[][]> {
  const contentHash = contentSha(content);
  const chunkShas = chunkTexts.map(contentSha);
  const hit = cache.get(relPath, contentHash, chunkShas);
  if (hit) return hit;
  const vectors: number[][] = [];
  for (const text of chunkTexts) vectors.push(await embedder.embed(text));
  cache.put(
    relPath,
    contentHash,
    vectors.map((vector, i) => ({ sha: chunkShas[i] ?? "", vector })),
  );
  return vectors;
}

/** Which corpus a batch of embeddings belongs to. */
export type EmbedScope = "memories" | "references";

/**
 * Progress for a batch of cache misses, reported around the expensive part of an index
 * build. VALUE-FREE by contract: counts and timing only — never a path, title, or text —
 * so a sink can log it without leaking vault content.
 *
 * Why it exists: on a CPU-only host a cold or invalidated cache (a fresh data dir, a
 * model or chunker change, a large new reference) can keep the embedder busy for a long
 * time with nothing else in the logs. `start` says how much work is queued; `done` says
 * how long it took.
 */
export type EmbedBacklogEvent =
  | { phase: "start"; scope: EmbedScope; files: number; chunks: number }
  | {
      phase: "done";
      scope: EmbedScope;
      files: number;
      chunks: number;
      durationMs: number;
      /** True when an embed threw part-way; the error still propagates to the caller. */
      failed: boolean;
    };

export type EmbedBacklogSink = (event: EmbedBacklogEvent) => void;

/** One file to resolve through the cache: its cache key, full content, and chunk texts. */
export interface EmbedFileInput {
  key: string;
  content: string;
  chunkTexts: string[];
}

export interface EmbedFilesOptions {
  scope: EmbedScope;
  /** Observer for the miss batch. Absent ⇒ no reporting. A throwing sink is ignored. */
  onBacklog?: EmbedBacklogSink;
  /** Clock for `durationMs` (test seam). Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Resolve many files' chunk vectors through the cache in one pass. Behaves exactly like
 * calling {@link embedChunksWithCache} per file — hits are served from disk, misses are
 * embedded sequentially and persisted — but checks every file FIRST, so the size of the
 * miss batch is known (and reported via `onBacklog`) before any embedding starts.
 * Returns one vector list per input file, in input order.
 */
export async function embedFilesWithCache(
  cache: EmbeddingCache,
  embedder: Embedder,
  files: readonly EmbedFileInput[],
  options: EmbedFilesOptions,
): Promise<number[][][]> {
  const now = options.now ?? Date.now;
  const report = (event: EmbedBacklogEvent): void => {
    try {
      options.onBacklog?.(event);
    } catch {
      /* observability only — a broken sink must never fail an index build */
    }
  };

  const results: (number[][] | null)[] = [];
  const misses: { index: number; contentHash: string; chunkShas: string[] }[] = [];
  files.forEach((file, index) => {
    const contentHash = contentSha(file.content);
    const chunkShas = file.chunkTexts.map(contentSha);
    const hit = cache.get(file.key, contentHash, chunkShas);
    results.push(hit);
    if (!hit) misses.push({ index, contentHash, chunkShas });
  });
  if (misses.length === 0) return results as number[][][];

  const missFiles = misses.length;
  const missChunks = misses.reduce((sum, miss) => sum + miss.chunkShas.length, 0);
  report({ phase: "start", scope: options.scope, files: missFiles, chunks: missChunks });
  const startedAt = now();
  const done = (failed: boolean): void =>
    report({
      phase: "done",
      scope: options.scope,
      files: missFiles,
      chunks: missChunks,
      durationMs: Math.max(0, now() - startedAt),
      failed,
    });

  try {
    for (const miss of misses) {
      const file = files[miss.index]!;
      const vectors: number[][] = [];
      for (const text of file.chunkTexts) vectors.push(await embedder.embed(text));
      cache.put(
        file.key,
        miss.contentHash,
        vectors.map((vector, i) => ({ sha: miss.chunkShas[i] ?? "", vector })),
      );
      results[miss.index] = vectors;
    }
  } catch (error) {
    done(true);
    throw error;
  }
  done(false);
  return results as number[][][];
}
