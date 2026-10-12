// Backlink-aware recall (plan 036 Phase 3 / spec 035 §F3, S2). Combines the
// hybrid index (keyword + vector) with the link graph: the query's direct
// matches PLUS their backlink neighbours (both directions, decayed), so a
// fact filed under EITHER entity is retrievable from the other and the result
// is self-contained — the caller can bundle the neighbours' content without
// ID-chasing (the "co-mention problem", G1/S2).
//
// Returns ranked ids + provenance; fetching + formatting the markdown bundle
// is the caller's (recall verb) concern.

import type { HybridHit, HybridIndex } from "./hybrid-index.js";
import type { LinkGraph } from "./link-graph.js";

export interface RecalledDoc {
  id: string;
  score: number;
  /** True = matched the query; false = pulled in via a backlink neighbour. */
  matchedDirectly: boolean;
  /**
   * The memory's best-matching section (spec 075), when the index is sectioned.
   * Direct matches only — a backlink neighbour matched nothing itself.
   */
  section?: string;
}

export interface RecallDeps {
  hybrid: HybridIndex;
  linkGraph: LinkGraph;
}

export interface RecallOptions {
  /** Max results returned (direct-first), default 12. */
  limit?: number;
  /** Pull in backlink neighbours of the direct matches (default true). */
  expandBacklinks?: boolean;
  /** Neighbour score = parent score × this (default 0.5). */
  neighborDecay?: number;
}

// Seed cap: how many hybrid hits to expand from. Generous headroom over the
// default limit so neighbours have room to compete; the final slice bounds the
// output. Seeded with max(SEED_CAP, limit) so a large `limit` never silently
// drops direct matches before expansion runs.
const SEED_CAP = 50;

export async function recallFromIndex(
  deps: RecallDeps,
  query: string,
  options: RecallOptions = {},
): Promise<RecalledDoc[]> {
  const limit = options.limit ?? 12;
  const expand = options.expandBacklinks ?? true;
  const decay = options.neighborDecay ?? 0.5; // expected in [0,1]; neighbours are decayed, never boosted

  const primary: (HybridHit & { section?: string })[] = await deps.hybrid.search(
    query,
    Math.max(SEED_CAP, limit),
  );
  const entries = new Map<string, { score: number; direct: boolean; section?: string }>();
  for (const hit of primary) {
    entries.set(hit.id, {
      score: hit.score,
      direct: true,
      ...(hit.section !== undefined ? { section: hit.section } : {}),
    });
  }

  if (expand) {
    // Single-hop only: neighbours of the direct matches (never neighbours of
    // neighbours). Neighbours of every seed compete globally by decayed score.
    for (const hit of primary) {
      const neighborScore = hit.score * decay;
      for (const neighborId of deps.linkGraph.neighbors(hit.id)) {
        const existing = entries.get(neighborId);
        if (!existing) {
          entries.set(neighborId, { score: neighborScore, direct: false });
        } else if (!existing.direct) {
          // keep the strongest backlink path; never downgrade a direct match
          existing.score = Math.max(existing.score, neighborScore);
        }
      }
    }
  }

  const ranked: RecalledDoc[] = [...entries.entries()].map(([id, value]) => ({
    id,
    score: value.score,
    matchedDirectly: value.direct,
    ...(value.section !== undefined ? { section: value.section } : {}),
  }));
  // Direct matches outrank decayed neighbours; id tie-break for determinism.
  ranked.sort(
    (a, b) =>
      Number(b.matchedDirectly) - Number(a.matchedDirectly) ||
      b.score - a.score ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return ranked.slice(0, limit);
}
