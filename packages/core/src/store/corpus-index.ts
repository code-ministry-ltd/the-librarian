// Vault → index bridge (plan 036 Phase 3/7 cutover / spec 035 §F2-F4, slimmed
// per the 2026-06-12 rethink D8). Two independent retrieval surfaces over the
// markdown vault:
//   - memories/<id>.md   → the recall index (active only; archived are excluded)
//   - references/**.md   → search_references (raw markdown, retrieved on demand)
//
// recall runs on the sectioned memory index (spec 075: each memory matched
// section by section, keyword+vector+title+phrase RRF) + the wikilink graph —
// no namespace wrapper. References are never part of the recall index
// (recall is memories-only by construction, S8); search_references builds its
// own references-only index per call.
//
// This is the disposable index — rebuildable from the vault at any time (the
// reindex / "delete .index/ → rebuild → equivalent hits" contract is just
// calling this again). Recall ids are memory ids (resolve via the store);
// reference ids are vault-relative paths (resolve via vault.readText).
//
// Built against the current memory-doc schema: title + body + tags compose the
// searchable text (like searchMemories; project_key is omitted — this is a
// different retrieval engine). The D16 frontmatter minimisation is a separable
// later cleanup and does not gate this.

import type { Shelf } from "../vault-router.js";
import { MemoryStatus } from "./../schemas/common.js";
import type { Vault } from "./corpus/vault.js";
import {
  type Embedder,
  type EmbeddingCache,
  type RecallOptions,
  type RecalledDoc,
  buildHybridIndex,
  buildLinkGraph,
  chunkReference,
  embedChunksWithCache,
  recallFromIndex,
} from "./index/index.js";
import { splitMemorySections } from "./index/memory-sections.js";
import {
  type SectionedMemoryDoc,
  buildSectionedIndex,
  sectionEmbeddingText,
} from "./index/sectioned-index.js";
import { parseMemoryDocument } from "./markdown/memory-doc.js";
import type { Memory } from "./memory-store.js";

const CORPUS_DIR = "memories";
const REFERENCES_DIR = "references";

export interface CorpusIndexOptions {
  embedder: Embedder;
  /**
   * Persistent embedding cache (rethink T23). When present, memory vectors are
   * resolved through it — a rebuild after a restart re-embeds nothing that
   * hasn't changed. Without it, behavior is the previous embed-on-build.
   */
  cache?: EmbeddingCache | null;
  /**
   * Prefix prepended to each shelf-relative memory path ONLY when keying the persistent
   * embedding cache (spec 062 T4). Per-shelf INDEXES share ONE embedding cache sidecar (keyed by
   * content hash + model id, so sharing is correct and memory-cheap); but the cache's on-disk
   * RECORD identity is the file PATH, and a shelf-scoped vault yields shelf-relative paths
   * (`memories/<id>.md`) that are NOT disjoint across shelves — two shelves would collide on the
   * same record and, worse, one shelf's prune (path-prefix scoped) would evict another's entries.
   * Passing the shelf's own prefix makes every cache key the FULL vault-relative path
   * (`<prefix>memories/<id>.md`), so records and prune scoping are globally disjoint per shelf.
   * Empty (the OSS default shelf, prefix "") ⇒ cache keys are BYTE-IDENTICAL to before this task.
   */
  cacheKeyPrefix?: string;
}

/** The built (disposable, cacheable) recall index over active memories. */
export interface CorpusIndex {
  /** Backlink-aware hybrid recall over active memories only. */
  recall(query: string, options?: RecallOptions): Promise<RecalledDoc[]>;
}

/** A reference hit: a pointer (vault-relative path) + score + the matched section. */
export interface ReferenceHit {
  id: string;
  score: number;
  /** The query-relevant markdown section of the reference doc (not the whole file). */
  section: string;
  /**
   * Heading breadcrumb of the matched chunk (e.g. "Manual > Tuning"; "" before
   * any heading). Additive — present on chunked search hits (rethink T24).
   */
  anchor?: string;
  /** Char offset (inclusive) of the matched chunk in the source file. Additive. */
  startChar?: number;
  /** Char offset (exclusive) of the matched chunk in the source file. Additive. */
  endChar?: number;
}

export async function buildCorpusIndex(
  vault: Vault,
  options: CorpusIndexOptions,
): Promise<CorpusIndex> {
  const cache = options.cache ?? null;
  // Full vault-relative cache key (see cacheKeyPrefix): keeps a SHARED embedding cache's records
  // and prune scoping disjoint across shelves. Empty for the OSS default shelf ⇒ unchanged keys.
  const keyPrefix = options.cacheKeyPrefix ?? "";
  const docs: SectionedMemoryDoc[] = [];
  const linkTexts: { id: string; body: string }[] = [];
  const liveMemoryPaths: string[] = [];

  for (const relPath of vault.listMarkdown(CORPUS_DIR)) {
    const cacheKey = keyPrefix + relPath; // full vault-relative — the cache is shared across shelves
    liveMemoryPaths.push(cacheKey); // any file under memories/ keeps its cache entry

    // Fail-soft: a hand-edited / foreign .md under memories/ that doesn't parse
    // as a memory is skipped, so one bad file can't take down all recall. (The
    // vault is git-pushed + hand-editable; surfacing corrupt files is a
    // dashboard/health concern, not a reason to fail the whole index build.)
    let memory;
    try {
      memory = parseMemoryDocument(vault.readText(relPath));
    } catch {
      continue;
    }
    // Active only — matches searchMemories' recall filter; proposals (pending
    // approval) and archived memories must not surface in recall.
    if (memory.status !== MemoryStatus.Active) continue;
    const text = `${memory.title} ${memory.body} ${memory.tags.join(" ")}`;
    const sections = splitMemorySections(memory.body);
    // Persistent cache (T23): one vector per section (spec 075), keyed under the
    // memory's file path like a reference's chunks. The content hash covers the
    // composed text, so any title/body/tag change re-embeds; a frontmatter-only
    // edit stays a hit.
    const sectionVectors = cache
      ? await embedChunksWithCache(
          cache,
          options.embedder,
          cacheKey,
          text,
          sections.map((section) => sectionEmbeddingText(memory.title, section)),
        )
      : undefined;
    docs.push({
      id: memory.id,
      title: memory.title,
      body: memory.body,
      tags: memory.tags,
      sections,
      ...(sectionVectors ? { sectionVectors } : {}),
    });
    linkTexts.push({ id: memory.id, body: text });
  }
  // Opportunistic orphan cleanup: entries for memory files that no longer exist
  // (archived = moved out of memories/, or deleted) leave the cache. Prune is scoped to THIS
  // shelf's `<prefix>memories/` so it never evicts another shelf's records.
  cache?.prune(`${keyPrefix}${CORPUS_DIR}/`, liveMemoryPaths);

  const hybrid = await buildSectionedIndex(docs, options.embedder);
  // restrictToKnownIds: recall is memories-only (spec §5.1), so a memory that
  // wikilinks a reference path or a dangling target must not pull that non-memory
  // id into recall via backlink expansion.
  const linkGraph = buildLinkGraph(linkTexts, { restrictToKnownIds: true });

  return {
    recall: (query, recallOptions) => recallFromIndex({ hybrid, linkGraph }, query, recallOptions),
  };
}

const DEFAULT_REFERENCE_LIMIT = 12;
const MAX_REFERENCE_LIMIT = 100;

/** Bound the caller-supplied limit at the store level; invalid → the default. */
function clampReferenceLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_REFERENCE_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_REFERENCE_LIMIT);
}

export interface SearchReferencesOptions {
  /** Max FILES returned (best chunk per file); invalid/absent → default 12. */
  limit?: number;
  /**
   * Persistent embedding cache (rethink T23). When present, unchanged files'
   * chunk vectors come from disk — the expensive part of the per-call index
   * build disappears after the first search over a given file/model.
   */
  cache?: EmbeddingCache | null;
  /**
   * Shelf prefix prepended to each reference path when keying the SHARED embedding cache — the
   * same disjointness contract as {@link CorpusIndexOptions.cacheKeyPrefix}, for `references/`.
   * Empty (OSS default shelf) ⇒ cache keys are byte-identical to before spec 062 T4. Note the
   * returned {@link ReferenceHit.id} stays shelf-relative — only the cache key is prefixed.
   */
  cacheKeyPrefix?: string;
}

/**
 * Reference lookup: search the vault's `references/` only (never the recall
 * index). Chunked (rethink T24): every reference is split by heading/size
 * (chunkReference), each chunk indexed keyword+vector (RRF via the hybrid
 * index), and the best-ranked chunk per file is returned — path id + heading
 * anchor + the chunk's char range + a bounded excerpt. This replaces the old
 * whole-doc embed, whose ~2K-token truncation made everything past the head of
 * a large document invisible to the vector signal.
 *
 * The keyword+vector index structures are still rebuilt per call (cheap, and
 * search_references is infrequent); the embeddings — the expensive part — are
 * served from the persistent cache when one is supplied (rethink T23).
 */
export async function searchReferences(
  vault: Vault,
  embedder: Embedder,
  query: string,
  options: SearchReferencesOptions = {},
): Promise<ReferenceHit[]> {
  const relPaths = vault.listMarkdown(REFERENCES_DIR);
  // No references → nothing to search; return early so we never load/download a
  // model just to embed the query against an empty index.
  if (relPaths.length === 0) return [];
  const cache = options.cache ?? null;
  // Full vault-relative cache key (see cacheKeyPrefix): a SHARED embedding cache stays disjoint
  // across shelves. Empty for the OSS default shelf ⇒ unchanged keys.
  const keyPrefix = options.cacheKeyPrefix ?? "";
  // Opportunistic orphan cleanup: cache entries for deleted references go now — scoped to THIS
  // shelf's `<prefix>references/` so it never evicts another shelf's records.
  cache?.prune(
    `${keyPrefix}${REFERENCES_DIR}/`,
    relPaths.map((relPath) => keyPrefix + relPath),
  );

  const chunkDocs: { id: string; text: string; vector?: number[] }[] = [];
  const chunkById = new Map<
    string,
    { relPath: string; anchor: string; start: number; end: number; text: string }
  >();
  for (const relPath of relPaths) {
    const content = vault.readText(relPath);
    const chunks = chunkReference(content);
    const vectors = cache
      ? await embedChunksWithCache(
          cache,
          embedder,
          keyPrefix + relPath, // full vault-relative — the cache is shared across shelves
          content,
          chunks.map((chunk) => chunk.text),
        )
      : null;
    chunks.forEach((chunk, i) => {
      // chunk ids are internal to this call; results carry the file path
      const id = `${relPath}#${i}`;
      const vector = vectors?.[i];
      chunkDocs.push({ id, text: chunk.text, ...(vector ? { vector } : {}) });
      chunkById.set(id, { relPath, ...chunk });
    });
  }

  const index = await buildHybridIndex(chunkDocs, embedder);
  const ranked = await index.search(query); // all chunks, ranked — bounded below
  const limit = clampReferenceLimit(options.limit);
  const seenFiles = new Set<string>();
  const out: ReferenceHit[] = [];
  for (const hit of ranked) {
    const chunk = chunkById.get(hit.id);
    if (!chunk || seenFiles.has(chunk.relPath)) continue; // best chunk per file only
    seenFiles.add(chunk.relPath);
    out.push({
      id: chunk.relPath,
      score: hit.score,
      section: chunk.text.trim(), // bounded by the chunker's max chunk size
      anchor: chunk.anchor,
      startChar: chunk.start,
      endChar: chunk.end,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export interface RecallMemoriesDeps {
  /** A built (and ideally cached) corpus index — see buildCorpusIndex. */
  index: CorpusIndex;
  getMemory: (id: string) => Memory | null;
}

export interface RecallMemoriesOptions {
  /** Any-match tag filter. */
  tags?: string[] | undefined;
  limit?: number | undefined;
}

/**
 * Index-backed memory recall: rank active memories by the (caller-supplied,
 * cacheable) hybrid index, then apply the same tag any-match filter
 * searchMemories does and bound to `limit`. Over-fetches from the index so the
 * post-filter still fills the limit. The no-query / filter-only path stays on
 * searchMemories (caller's concern).
 *
 * Recall-quality note: the candidate pool is bounded (over-fetch + the index's
 * internal seed cap), so a very selective filter (e.g. a rare tag held only by
 * deep-ranked memories) can return fewer than `limit` even when more matches
 * exist. Acceptable for typical limits; revisit if it bites.
 */
export async function recallMemories(
  deps: RecallMemoriesDeps,
  query: string,
  options: RecallMemoriesOptions = {},
): Promise<RecalledMemory[]> {
  const limit = options.limit ?? 8;
  const hits = await deps.index.recall(query, { limit: Math.max(limit * 4, 24) });
  const tagSet = new Set(options.tags ?? []);
  const out: RecalledMemory[] = [];
  for (const hit of hits) {
    const memory = deps.getMemory(hit.id);
    if (!memory) continue; // stale id (vault changed mid-flight) — skip
    if (tagSet.size && !(memory.tags ?? []).some((tag) => tagSet.has(tag))) continue;
    // The best-matching section rides along for the agent-facing excerpt (spec
    // 075); consumers that read only title/body (intake navigation) ignore it.
    out.push(hit.section !== undefined ? { ...memory, matchedSection: hit.section } : memory);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * A recall hit tagged with its shelf of origin (spec 062 SC 5, T5). `shelfId` / `shelfLabel` are
 * present ONLY in a MULTI-shelf merged recall — a principal whose materialised recall shelf set has
 * length > 1. Under the default / single-shelf router they are ABSENT and the object is a plain
 * {@link Memory}, so the wire result and the MCP text token are BYTE-IDENTICAL to before this task
 * (the inertness rule). When present, `shelfLabel` rides only if the shelf carries a label; the id
 * is always present because labels are renamable, plugin-authored text (spec 062 §6).
 */
export interface RecalledMemory extends Memory {
  shelfId?: string;
  shelfLabel?: string;
  /** The memory's best-matching section for this query (spec 075); absent for backlink hits. */
  matchedSection?: string;
}

/** One shelf's ranked recall hits (index 0 = best), paired with the shelf they came from. */
export interface ShelfRecall {
  shelf: Shelf;
  /** This shelf's OWN ranked recall (already limit-bounded by the per-shelf recall). */
  hits: Memory[];
}

/**
 * Merge per-shelf recall results into ONE ordered list (spec 062 SC 5 — the DECIDED rule, §6).
 *
 * Semantics, EXACTLY as decided (spec 062 §6, no head-start):
 *   - PER-SHELF RANK INTERLEAVE, STRICT ALTERNATION, router-order priority on equal rank: a
 *     shelf-order pass over rank 0 (shelf A's #1, then B's #1, …), THEN rank 1, … skipping shelves
 *     already exhausted at that rank. So A(2 hits) before B(5 hits) merges A1, B1, A2, B2, B3, B4,
 *     B5. A fixed head-start for any shelf was explicitly deferred (empirical Teams question).
 *   - DEDUPE by memory id, FIRST (highest-precedence) occurrence wins — a memory present on two
 *     shelves is emitted once, tagged with the EARLIER (router-order) shelf; its later copy drops.
 *   - The `limit` applies AFTER the merge.
 *
 * We deliberately do NOT compare scores across shelves. The per-shelf hybrid scores are rank
 * reciprocals (RRF, `hybrid-index.ts`) from INDEPENDENTLY built shelf indexes — they are not
 * comparable across shelves, which is the whole reason the merge is a rank interleave and not a
 * score sort (spec 062 SC 5 / §4). Only each hit's POSITION within its own shelf list is read here.
 */
export function mergeShelfRecalls(
  perShelf: readonly ShelfRecall[],
  limit: number,
): RecalledMemory[] {
  const out: RecalledMemory[] = [];
  const seen = new Set<string>();
  const deepest = perShelf.reduce((max, s) => Math.max(max, s.hits.length), 0);
  for (let rank = 0; rank < deepest; rank++) {
    for (const { shelf, hits } of perShelf) {
      const memory = hits[rank];
      if (!memory) continue; // this shelf is exhausted at this rank — strict alternation over survivors
      if (seen.has(memory.id)) continue; // dedupe: an earlier (higher-precedence) shelf already emitted it
      seen.add(memory.id);
      out.push({
        ...memory,
        shelfId: shelf.id,
        ...(shelf.label !== undefined ? { shelfLabel: shelf.label } : {}),
      });
      // Bounding here is identical to slicing the full merged list to `limit` (order is already
      // final), and stops us walking deeper ranks we'd only discard.
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * A reference-search hit tagged with its shelf of origin (spec 062 SC 8c, T6) — the reference-search
 * analogue of {@link RecalledMemory}. `shelfId` / `shelfLabel` are present ONLY in a MULTI-shelf
 * merged search (a principal whose materialised `search` shelf set has length > 1). Under the
 * default / single-shelf router they are ABSENT and the object is a plain {@link ReferenceHit}, so
 * the `search_references` JSON is BYTE-IDENTICAL to before this task (the inertness rule).
 */
export interface RecalledReference extends ReferenceHit {
  shelfId?: string;
  shelfLabel?: string;
}

/** One shelf's ranked reference hits (index 0 = best), paired with the shelf they came from. */
export interface ShelfReferenceHits {
  shelf: Shelf;
  /** This shelf's OWN ranked reference hits (already limit-bounded by the per-shelf search). */
  hits: ReferenceHit[];
}

/**
 * Merge per-shelf reference-search results into ONE ordered list (spec 062 SC 8c, T6) — the SAME
 * decided rule as {@link mergeShelfRecalls}, over reference hits instead of memories:
 *   - PER-SHELF RANK INTERLEAVE, STRICT ALTERNATION, router-order priority on equal rank.
 *   - DEDUPE by the FULL vault-relative path (`shelf.prefix + hit.id`), FIRST (highest-precedence)
 *     occurrence wins. This is the review-C fix: a reference's `hit.id` is SHELF-RELATIVE
 *     (`references/x.md`), so deduping on it alone dropped two DISTINCT documents that merely share a
 *     relative path across shelves (`members/x/references/x.md` vs `team/references/x.md`) — the only
 *     "collision" that can occur, since disjoint prefixes mean the same file is never reachable from
 *     two shelves. Prefixing the key by `shelf.prefix` keys on the true document identity, so both
 *     distinct docs survive; a genuine same-path collision is impossible under disjoint prefixes,
 *     making the dedupe defensive (kept parallel to {@link mergeShelfRecalls}, whose per-frontmatter-id
 *     dedupe is correct as-is — a memory id IS globally unique). The `limit` applies AFTER the merge.
 * Scores are NOT compared across shelves (each shelf's index is built independently; the scores are
 * RRF rank reciprocals from `hybrid-index.ts`), so — exactly as recall does — only each hit's
 * POSITION within its own shelf list is read.
 */
export function mergeShelfReferenceHits(
  perShelf: readonly ShelfReferenceHits[],
  limit: number,
): RecalledReference[] {
  const out: RecalledReference[] = [];
  const seen = new Set<string>();
  const deepest = perShelf.reduce((max, s) => Math.max(max, s.hits.length), 0);
  for (let rank = 0; rank < deepest; rank++) {
    for (const { shelf, hits } of perShelf) {
      const hit = hits[rank];
      if (!hit) continue; // this shelf is exhausted at this rank — strict alternation over survivors
      const key = shelf.prefix + hit.id; // the FULL vault-relative path — the true document identity
      if (seen.has(key)) continue; // dedupe by full path: an earlier (higher-precedence) shelf won
      seen.add(key);
      out.push({
        ...hit,
        shelfId: shelf.id,
        ...(shelf.label !== undefined ? { shelfLabel: shelf.label } : {}),
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
