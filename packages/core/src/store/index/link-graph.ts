// Backlink graph for the disposable index (plan 036 Phase 3 / spec 035
// §F2, §F3). Turns the corpus's wikilinks into outbound + inbound (backlink)
// adjacency so backlink-aware recall can return a fact filed under EITHER
// entity from the other — the "co-mention problem" (G1/S2). Pure: built from
// `parseWikilinks` over document bodies; rebuildable from the markdown at
// any time (the graph is part of the disposable `.index/`).

import { parseWikilinks } from "../corpus/index.js";

export interface LinkGraph {
  /** Ids this document links to (deduped). */
  outbound(id: string): string[];
  /** Ids that link to this document — its backlinks (deduped). */
  inbound(id: string): string[];
  /** Outbound ∪ inbound, deduped, excluding the document itself. */
  neighbors(id: string): string[];
}

export interface LinkGraphOptions {
  /**
   * Drop edges whose target is not one of the supplied documents (dangling
   * links, or non-memory paths such as references). Off by default so the
   * general graph still surfaces dangling targets (link-rot detection, F12);
   * the recall index turns it ON so backlink expansion can never surface an
   * id that isn't an indexed memory.
   */
  restrictToKnownIds?: boolean;
  /**
   * Map a link's target to a document id before adding the edge (spec 076 §4):
   * the recall index resolves `[[Title]]` links, which is how the curator writes
   * them, to memory ids. Returning undefined keeps the raw target.
   */
  resolveTarget?: (target: string) => string | undefined;
}

export function buildLinkGraph(
  documents: { id: string; body: string }[],
  options: LinkGraphOptions = {},
): LinkGraph {
  const outbound = new Map<string, Set<string>>();
  const inbound = new Map<string, Set<string>>();
  const knownIds = options.restrictToKnownIds ? new Set(documents.map((doc) => doc.id)) : null;

  const add = (map: Map<string, Set<string>>, key: string, value: string): void => {
    let set = map.get(key);
    if (!set) {
      set = new Set<string>();
      map.set(key, set);
    }
    set.add(value);
  };

  for (const doc of documents) {
    for (const link of parseWikilinks(doc.body)) {
      const target = options.resolveTarget?.(link.target) ?? link.target;
      if (knownIds && !knownIds.has(target)) continue; // skip dangling / non-indexed targets
      add(outbound, doc.id, target);
      add(inbound, target, doc.id);
    }
  }

  const list = (map: Map<string, Set<string>>, id: string): string[] => [...(map.get(id) ?? [])];

  return {
    outbound: (id) => list(outbound, id),
    inbound: (id) => list(inbound, id),
    neighbors: (id) => {
      const out = new Set<string>([...list(outbound, id), ...list(inbound, id)]);
      out.delete(id); // a self-link is not a neighbour
      return [...out];
    },
  };
}
