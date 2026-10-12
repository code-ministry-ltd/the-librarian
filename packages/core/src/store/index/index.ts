// Disposable hybrid index (plan 036 Phase 3 / spec 035 §F2) — embed +
// keyword + wikilink graph over the markdown corpus, rebuildable from the
// source at any time. The backlink graph lands first (the "co-mention problem"
// core); keyword + vector indexes follow.

export { type LinkGraph, type LinkGraphOptions, buildLinkGraph } from "./link-graph.js";
export { type KeywordHit, type KeywordIndex, buildKeywordIndex } from "./keyword-index.js";
export {
  type VectorHit,
  type VectorIndex,
  buildVectorIndex,
  cosineSimilarity,
} from "./vector-index.js";
export {
  type Embedder,
  type HybridHit,
  type HybridIndex,
  buildHybridIndex,
  createHashEmbedder,
} from "./hybrid-index.js";
export {
  type LlamaEmbedderOptions,
  type EmbeddingModel,
  createLlamaEmbedder,
  truncateToTokenLimit,
} from "./llama-embedder.js";
export { type ResolveEmbedderOptions, resolveEmbedder } from "./resolve-embedder.js";
export { createCachingEmbedder } from "./caching-embedder.js";
export {
  type CachedChunkVector,
  type EmbeddingCache,
  type EmbeddingCacheOptions,
  contentSha,
  createEmbeddingCache,
  embedChunksWithCache,
} from "./embedding-cache.js";
export {
  type ChunkOptions,
  type ReferenceChunk,
  DEFAULT_CHUNK_OVERLAP_CHARS,
  DEFAULT_MAX_CHUNK_CHARS,
  chunkReference,
} from "./reference-chunker.js";
export {
  type RecallDeps,
  type RecallOptions,
  type RecalledDoc,
  recallFromIndex,
} from "./recall.js";
export { extractRelevantSection } from "./reference-section.js";
export { MAX_SECTION_WORDS, splitMemorySections } from "./memory-sections.js";
export {
  type SectionedHit,
  type SectionedIndex,
  type SectionedMemoryDoc,
  buildSectionedIndex,
  sectionEmbeddingText,
} from "./sectioned-index.js";
