import { formatRecall, type RecallItem } from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";

/** How many memories one `ids` fetch returns at most (spec 075 D3); extras are ignored. */
export const MAX_RECALL_IDS = 10;

const recall: ToolDefinition = {
  name: "recall",
  description:
    "Search the owner's durable memories. Call this before answering anything " +
    "that may have prior context — at task start, and whenever a stored fact, " +
    "preference, or past decision could change your answer. Memories only: " +
    "long-form reference docs are NOT here — search those with " +
    "`search_references`. Query by free text; `tags` narrows to memories " +
    "carrying any of the supplied tags. Long memories come back as the " +
    "best-matching excerpt; pass `ids` to fetch whole memories. Pass " +
    "`include_ids: true` to prefix each result with its memory id, so a memory " +
    "that turns out to be wrong can be passed straight to `flag_memory`.",
  inputSchema: {
    type: "object",
    properties: {
      agent_id: {
        type: "string",
        description:
          "Server-populated from your authenticated token, not supplied by you — it identifies " +
          "the calling agent.",
      },
      query: {
        type: "string",
        description:
          "Free-text search over the owner's durable memories; matches are ranked by relevance.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Narrow the search to memories carrying any of these tags.",
      },
      ids: {
        type: "array",
        items: { type: "string" },
        description:
          "Fetch these memories whole (up to 10), e.g. the id named in an excerpt's footer. " +
          "When given, query, tags and limit are ignored.",
      },
      include_ids: {
        type: "boolean",
        description:
          "When true, prefix each result with its memory id, so a memory that turns out to be " +
          "wrong can be passed straight to flag_memory.",
      },
      limit: { type: "number", description: "Maximum number of memories to return." },
    },
  },
  async handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    // conv_id was a domain-routing signal, not a search field.
    delete scoped.conv_id;
    const includeIds = scoped.include_ids === true;

    // Fetch by id (spec 075 §3.1.7): whole bodies, active only, in the order asked. Ids resolve
    // through the principal's recall shelves, and an id that is off-shelf, archived, proposed or
    // unknown is simply absent — the output never says which, so it is no existence oracle.
    const ids = Array.isArray(scoped.ids)
      ? [...new Set(scoped.ids.filter((id): id is string => typeof id === "string"))]
      : [];
    if (ids.length > 0) {
      // The same shelf set, order and provenance rule as merged recall (spec 062 §6): the first
      // shelf holding the id wins, and the shelf label renders only when the set has length > 1.
      const shelves = store.shelvesForPrincipal(context.principal);
      const memories: RecallItem[] = [];
      for (const id of ids.slice(0, MAX_RECALL_IDS)) {
        for (const shelf of shelves) {
          const memory = store.forShelf(shelf, context.principal).getMemory(id);
          if (!memory) continue;
          if (memory.status === "active") {
            memories.push({
              ...memory,
              ...(shelves.length > 1 ? { shelfId: shelf.id } : {}),
              ...(shelves.length > 1 && shelf.label !== undefined
                ? { shelfLabel: shelf.label }
                : {}),
            });
          }
          break;
        }
      }
      return textResult(formatRecall(memories, "Relevant Memories", { includeIds }));
    }

    // Principal-aware merged recall (spec 062 SC 5): index-backed (sectioned hybrid, spec 075) per
    // shelf, consulted in router order and merged with provenance labels. Under the default
    // (single-shelf) router this is the plain `store.recall` path — one shelf, no shelf fields.
    const memories = await store.recallForPrincipal(context.principal, scoped);
    return textResult(formatRecall(memories, "Relevant Memories", { includeIds, excerpts: true }));
  },
};

export default recall;
