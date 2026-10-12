// Sectioned memory index (spec 075 §3.1.2). The memory-only counterpart of the
// shared hybrid index: memories are matched section by section, then ranked as
// memories. Reciprocal Rank Fusion (k = 60, unweighted) over four lists:
//
//   - BM25 over sections, each memory placed by its best section;
//   - cosine over section vectors, each memory placed by its best section;
//   - BM25 over a title-weighted memory text (title ×3, body, tags), so a query
//     naming the memory's subject still finds it;
//   - the exact-phrase signal over the whole memory (multi-token queries).
//
// Measured on a real corpus (spec 075 §1): top result directly relevant for
// 72% of real agent queries (whole-memory hybrid: 50%).
//
// `buildHybridIndex` is left as it is: `search_references` still uses it.

import { tokenize } from "../memory-tokenize.js";
import { type Embedder, type HybridHit, countContiguous } from "./hybrid-index.js";
import { buildKeywordIndex } from "./keyword-index.js";
import { cosineSimilarity } from "./vector-index.js";

const RRF_K = 60;
const TITLE_WEIGHT = 3;

export interface SectionedMemoryDoc {
  id: string;
  title: string;
  body: string;
  tags: string[];
  /** The memory's sections, in body order (see splitMemorySections). */
  sections: string[];
  /** One vector per section, same order; embedded on demand when absent. */
  sectionVectors?: number[][];
}

/** A memory hit plus the text of the section that matched it best. */
export interface SectionedHit extends HybridHit {
  section: string;
}

export interface SectionedIndex {
  search(query: string, limit?: number): Promise<SectionedHit[]>;
}

/** The text a section is embedded as: titled, so the vector knows its subject. */
export function sectionEmbeddingText(title: string, section: string): string {
  return `${title}\n${section}`;
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export async function buildSectionedIndex(
  documents: SectionedMemoryDoc[],
  embedder: Embedder,
): Promise<SectionedIndex> {
  const sectionDocs: { id: string; text: string }[] = [];
  const sectionVectors: { memoryId: string; section: number; vector: number[] }[] = [];
  const sectionsById = new Map<string, string[]>();
  const tokensById = new Map<string, string[]>();
  const memoryDocs: { id: string; text: string }[] = [];

  for (const doc of documents) {
    const tags = doc.tags.join(" ");
    sectionsById.set(doc.id, doc.sections);
    tokensById.set(doc.id, tokenize(`${doc.title} ${doc.body} ${tags}`));
    memoryDocs.push({
      id: doc.id,
      text: `${Array.from({ length: TITLE_WEIGHT }, () => doc.title).join(" ")} ${doc.body} ${tags}`,
    });
    for (let i = 0; i < doc.sections.length; i++) {
      const section = doc.sections[i] ?? "";
      sectionDocs.push({ id: `${doc.id}#${i}`, text: `${doc.title}\n${section} ${tags}` });
      const vector =
        doc.sectionVectors?.[i] ?? (await embedder.embed(sectionEmbeddingText(doc.title, section)));
      sectionVectors.push({ memoryId: doc.id, section: i, vector });
    }
  }

  const sectionKeyword = buildKeywordIndex(sectionDocs);
  const memoryKeyword = buildKeywordIndex(memoryDocs);

  return {
    async search(query, limit) {
      const queryVector = await (embedder.embedQuery
        ? embedder.embedQuery(query)
        : embedder.embed(query));

      // Section keyword → memories, by best section. The keyword index already
      // breaks score ties by id, so the order is deterministic.
      const keywordBest = new Map<string, number>();
      const keywordList: { id: string }[] = [];
      for (const hit of sectionKeyword.search(query)) {
        const hash = hit.id.lastIndexOf("#");
        const memoryId = hit.id.slice(0, hash);
        if (keywordBest.has(memoryId)) continue;
        keywordBest.set(memoryId, Number(hit.id.slice(hash + 1)));
        keywordList.push({ id: memoryId });
      }

      // Section vectors → memories, by best (positive) section similarity.
      const vectorBest = new Map<string, { section: number; score: number }>();
      for (const entry of sectionVectors) {
        const score = cosineSimilarity(queryVector, entry.vector);
        if (score <= 0) continue;
        const best = vectorBest.get(entry.memoryId);
        if (!best || score > best.score) {
          vectorBest.set(entry.memoryId, { section: entry.section, score });
        }
      }
      const vectorList = [...vectorBest.entries()]
        .sort((a, b) => b[1].score - a[1].score || byId(a[0], b[0]))
        .map(([id]) => ({ id }));

      const titleList = memoryKeyword.search(query);

      // Exact phrase over the whole memory — unchanged semantics from the hybrid index.
      const phraseList: { id: string }[] = [];
      const queryTokens = tokenize(query);
      if (queryTokens.length >= 2) {
        const counted: { id: string; count: number }[] = [];
        for (const [id, tokens] of tokensById) {
          const count = countContiguous(tokens, queryTokens);
          if (count > 0) counted.push({ id, count });
        }
        counted.sort((a, b) => b.count - a.count || byId(a.id, b.id));
        phraseList.push(...counted);
      }

      const fused = new Map<string, number>();
      for (const list of [keywordList, vectorList, titleList, phraseList]) {
        list.forEach((hit, rank) => {
          fused.set(hit.id, (fused.get(hit.id) ?? 0) + 1 / (RRF_K + rank + 1));
        });
      }

      const ranked = [...fused.entries()]
        .sort((a, b) => b[1] - a[1] || byId(a[0], b[0]))
        .map(([id, score]) => {
          const sections = sectionsById.get(id) ?? [""];
          const index = vectorBest.get(id)?.section ?? keywordBest.get(id) ?? 0;
          return { id, score, section: sections[index] ?? sections[0] ?? "" };
        });
      return limit != null ? ranked.slice(0, limit) : ranked;
    },
  };
}
