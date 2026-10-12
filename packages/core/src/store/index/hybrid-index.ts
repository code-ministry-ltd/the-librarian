// Hybrid index for the disposable index (plan 036 Phase 3 / spec 035 §F2).
// Fuses the keyword + vector signals with Reciprocal Rank Fusion (RRF) —
// robust and normalization-free (the two signals' raw scores are
// incomparable: keyword tf vs cosine in [-1,1]). The embedder is pluggable
// and async so the real model (`createLlamaEmbedder`, node-llama-cpp +
// EmbeddingGemma) is a drop-in; the bundled `createHashEmbedder` is a
// deterministic, zero-dependency fallback (also the test double) usable when no
// model is configured.

import { tokenize } from "../memory-tokenize.js";
import { buildKeywordIndex } from "./keyword-index.js";
import { buildVectorIndex } from "./vector-index.js";

export interface Embedder {
  /** Embed a document/passage for indexing. */
  embed(text: string): Promise<number[]>;
  /**
   * Optionally embed a search query with query-specific handling (some models
   * — e.g. EmbeddingGemma — use asymmetric query vs document prompts). When
   * absent, the index embeds queries with `embed` (symmetric models like the
   * hash embedder need nothing more).
   */
  embedQuery?(text: string): Promise<number[]>;
  /**
   * Stable identity of the underlying model (e.g. "hash-fnv1a-256",
   * "llama:embeddinggemma-300M-Q8_0.gguf"). The persistent embedding cache
   * keys on it, so vectors from different models can never be confused.
   */
  modelId?: string;
}

/**
 * Deterministic, zero-dependency fallback embedder: hashes each token (FNV-1a)
 * into a fixed-width bag-of-buckets vector. Shared tokens → shared buckets →
 * positive cosine. Lexical, not semantic — a functional fallback / test
 * double; `createLlamaEmbedder` (node-llama-cpp) is the quality embedder.
 */
export function createHashEmbedder(dimensions = 256): Embedder {
  return {
    modelId: `hash-fnv1a-${dimensions}`,
    embed(text) {
      const vector = new Array<number>(dimensions).fill(0);
      for (const term of tokenize(text)) {
        let hash = 2166136261;
        for (let i = 0; i < term.length; i++) {
          hash ^= term.charCodeAt(i);
          hash = Math.imul(hash, 16777619);
        }
        const bucket = (hash >>> 0) % dimensions;
        vector[bucket] = (vector[bucket] ?? 0) + 1;
      }
      return Promise.resolve(vector);
    },
  };
}

export interface HybridHit {
  id: string;
  score: number;
}

export interface HybridIndex {
  /** Fused (keyword + vector) ranking for the query, RRF-scored. */
  search(query: string, limit?: number): Promise<HybridHit[]>;
}

/** How many times `needle` appears as a contiguous run of tokens in `hay`. */
export function countContiguous(hay: string[], needle: string[]): number {
  if (needle.length === 0 || needle.length > hay.length) return 0;
  let count = 0;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) count++;
  }
  return count;
}

export async function buildHybridIndex(
  documents: { id: string; text: string; vector?: number[] }[],
  embedder: Embedder,
  options: { rrfK?: number } = {},
): Promise<HybridIndex> {
  const rrfK = options.rrfK ?? 60;
  const keyword = buildKeywordIndex(documents.map((doc) => ({ id: doc.id, text: doc.text })));
  // Token sequences per doc, for the exact-phrase signal (a contiguous match of
  // the query's tokens is a strong relevance cue keyword+vector both miss).
  const tokensById = new Map<string, string[]>();
  const vectors: { id: string; vector: number[] }[] = [];
  // A doc may arrive with a precomputed vector (the persistent embedding cache
  // resolves them upstream, where the file identity lives); only embed the rest.
  for (const doc of documents) {
    tokensById.set(doc.id, tokenize(doc.text));
    vectors.push({ id: doc.id, vector: doc.vector ?? (await embedder.embed(doc.text)) });
  }
  const vector = buildVectorIndex(vectors);

  return {
    async search(query, limit) {
      // Use the query-specific embedding when the model provides one (asymmetric
      // models); otherwise the symmetric `embed`.
      const queryVector = await (embedder.embedQuery
        ? embedder.embedQuery(query)
        : embedder.embed(query));
      const keywordHits = keyword.search(query);
      // Only positive cosine counts as a semantic match (drop orthogonal/opposite).
      const vectorHits = vector.search(queryVector).filter((hit) => hit.score > 0);

      // Exact-phrase signal: docs containing the query's tokens contiguously,
      // ranked by occurrence count. Only for multi-token queries — a single
      // token is already the keyword signal, so there's no phrase to add.
      const queryTokens = tokenize(query);
      const phraseHits: { id: string; count: number }[] = [];
      if (queryTokens.length >= 2) {
        for (const [id, toks] of tokensById) {
          const count = countContiguous(toks, queryTokens);
          if (count > 0) phraseHits.push({ id, count });
        }
        phraseHits.sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      }

      // RRF: a doc's fused score is the sum of 1/(k + rank) across the lists
      // it appears in. No score normalization needed; docs ranking high in
      // multiple signals win.
      const fused = new Map<string, number>();
      const contribute = (hits: { id: string }[]): void => {
        hits.forEach((hit, rank) => {
          fused.set(hit.id, (fused.get(hit.id) ?? 0) + 1 / (rrfK + rank + 1));
        });
      };
      contribute(keywordHits);
      contribute(vectorHits);
      contribute(phraseHits);

      const ranked = [...fused.entries()].map(([id, score]) => ({ id, score }));
      ranked.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return limit != null ? ranked.slice(0, limit) : ranked;
    },
  };
}
