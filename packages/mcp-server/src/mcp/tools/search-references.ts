// `search_references` MCP tool (plan 036 Phase 3 / spec 035 §F3-F4). Tier-0
// lookup over the vault's references/ — background reference docs that are NOT
// in default recall. Returns each match's pointer (vault-relative path) + the
// query-relevant section, so the agent can pull just the matched section.

import { elapsedMs, logRead, readEvidence } from "../read-evidence.js";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";

const searchReferences: ToolDefinition = {
  name: "search_references",
  description:
    "Search the long-form reference documents (background material the " +
    "operator filed under references/ — specs, manuals, design notes). " +
    "References are deliberately NOT auto-recalled and never appear in " +
    "`recall` results, so search here when the task needs that depth. " +
    "Returns each match's vault path + the query-relevant section.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What to look up across the operator's long-form reference documents.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: "Maximum number of reference matches to return.",
      },
    },
    required: ["query"],
  },
  async handler(store, args, context) {
    const startMs = performance.now();
    const query = typeof args.query === "string" ? args.query : "";
    if (!query.trim()) return textResult("search_references rejected: 'query' is required");
    // store.searchReferences clamps the limit (the invariant lives there).
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    // Principal-aware merged reference search (spec 062 SC 8c): search each of the principal's
    // `search` shelves in router order and merge with provenance labels (shelfId/shelfLabel present
    // IFF the materialised set > 1). Under the default (single-shelf) router this is byte-identical
    // to the legacy `store.searchReferences` — one shelf, plain hits, no shelf fields in the JSON.
    const hits = await store.searchReferencesForPrincipal(context.principal, query, limit);
    const text = JSON.stringify({ references: hits }, null, 2);
    logRead(store, () => ({
      kind: "search_references",
      query,
      ...(limit !== undefined && Number.isInteger(limit) && limit >= 0 ? { limit } : {}),
      returnedPaths: hits.map((hit) => hit.id),
      returnedCount: hits.length,
      resultChars: text.length,
      durationMs: elapsedMs(startMs),
      ...readEvidence(store, context.principal),
    }));
    return textResult(text);
  },
};

export default searchReferences;
