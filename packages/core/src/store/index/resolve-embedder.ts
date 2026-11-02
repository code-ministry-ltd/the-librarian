// Embedder selection (plan 036 Phase 3/7 / spec 035 §F2). Picks the embedder
// the index + recall run on, from the environment:
//
//   LIBRARIAN_EMBEDDER=hash   → the deterministic, zero-dependency hash embedder
//   LIBRARIAN_EMBEDDER=llama  → EmbeddingGemma via node-llama-cpp
//   (unset) under a test run  → hash (a vitest run must NEVER download a model)
//   (unset) otherwise         → llama (the production default)
//
// Model file: LIBRARIAN_MODEL_PATH if set (air-gapped / pre-provisioned),
// otherwise the bundled default GGUF (EmbeddingGemma-300M Q8_0) is downloaded +
// cached lazily on first embed (≈333 MB). The embedder is lazy, so selecting
// llama costs nothing until something actually embeds.
//
// CPU threads: LIBRARIAN_EMBED_THREADS (a positive integer) if set, otherwise half
// the host's cores, never more than node-llama-cpp's own default of 6 — so the
// default can only lower what an install used before, never raise it.

import os from "node:os";
import path from "node:path";
import { type Embedder, createHashEmbedder } from "./hybrid-index.js";
import { createLlamaEmbedder } from "./llama-embedder.js";

const DEFAULT_MODEL_URI = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

/** node-llama-cpp v3's own embedding-context thread default — the ceiling we never exceed by default. */
const LIBRARY_DEFAULT_THREADS = 6;

/**
 * Default embedding threads for a host with `cpuCount` cores: half of them (at least 1),
 * capped at node-llama-cpp's default of 6. Embedding bursts then share the box instead of
 * saturating it; on hosts with 12+ cores this is exactly the library's previous default.
 */
export function defaultEmbedThreads(cpuCount: number): number {
  const half = Math.floor(cpuCount / 2);
  return Math.min(LIBRARY_DEFAULT_THREADS, Math.max(1, half));
}

/**
 * Resolve the embedding thread count from a raw `LIBRARIAN_EMBED_THREADS` value. Unset or
 * blank ⇒ {@link defaultEmbedThreads}. Anything else must be a positive whole number; a typo
 * throws at boot rather than silently falling back, matching `LIBRARIAN_EMBEDDER`.
 */
export function resolveEmbedThreads(
  raw: string | undefined,
  cpuCount: number = os.availableParallelism(),
): number {
  const value = raw?.trim();
  if (!value) return defaultEmbedThreads(cpuCount);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(
      `LIBRARIAN_EMBED_THREADS must be a whole number of CPU threads, 1 or more (got "${raw}"). ` +
        `Unset it to use the default: half this host's cores, at most ${LIBRARY_DEFAULT_THREADS} ` +
        `(here: ${defaultEmbedThreads(cpuCount)}).`,
    );
  }
  return Number(value);
}

export interface ResolveEmbedderOptions {
  /** Data dir; a downloaded model is cached under `<dataDir>/models`. */
  dataDir: string;
}

export function resolveEmbedder(options: ResolveEmbedderOptions): Embedder {
  const choice = process.env.LIBRARIAN_EMBEDDER;
  // Fail fast on a typo'd value rather than silently falling through to a
  // surprise model download (e.g. "Hash" / "llamaa").
  if (choice && choice !== "hash" && choice !== "llama") {
    throw new Error(`LIBRARIAN_EMBEDDER must be "hash" or "llama" (got "${choice}")`);
  }
  if (choice === "hash") return createHashEmbedder();
  // Never download a model inside a test run unless explicitly asked for llama.
  if (choice !== "llama" && process.env.VITEST) return createHashEmbedder();
  return createLlamaEmbedder({
    modelPath: () => resolveModelPath(options.dataDir),
    threads: resolveEmbedThreads(process.env.LIBRARIAN_EMBED_THREADS),
    // Stable identity for the persistent embedding cache. The basename (not the
    // full override path) so relocating a pre-provisioned model file doesn't
    // invalidate every cached vector; a different model FILE is a different id.
    modelId: `llama:${
      process.env.LIBRARIAN_MODEL_PATH
        ? path.basename(process.env.LIBRARIAN_MODEL_PATH)
        : DEFAULT_MODEL_URI
    }`,
  });
}

async function resolveModelPath(dataDir: string): Promise<string> {
  const override = process.env.LIBRARIAN_MODEL_PATH;
  if (override) return override;
  const { resolveModelFile } = await import("node-llama-cpp");
  return resolveModelFile(DEFAULT_MODEL_URI, { directory: path.join(dataDir, "models") });
}
