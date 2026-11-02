// Tool registry — collects every per-tool definition under `./` into
// the array `tools` and the lookup `toolsByName`. New tools added here
// become callable by `dispatch.ts` automatically.

import type { ToolDefinition, ToolRegistry } from "../tool.js";
import claimHandoff from "./claim-handoff.js";
import flagMemory from "./flag-memory.js";
import journal from "./journal.js";
import listHandoffs from "./list-handoffs.js";
import recall from "./recall.js";
import remember from "./remember.js";
import searchReferences from "./search-references.js";
import storeHandoff from "./store-handoff.js";

export const tools: ToolDefinition[] = [
  recall,
  remember,
  flagMemory,
  storeHandoff,
  listHandoffs,
  claimHandoff,
  searchReferences,
  journal,
];

export const toolsByName: Map<string, ToolDefinition> = new Map(
  tools.map((tool) => [tool.name, tool]),
);

/**
 * The core tool registry — the built-in verbs and nothing else. This is the
 * DEFAULT the dispatcher uses on every non-factory path (the stdio bin, a direct
 * `handleMcpPayload` call, the existing tests), so the core tool surface is
 * unchanged when no plugin registers a tool. The HTTP factory threads a MERGED
 * registry (core + plugin tools) instead when `plugins` contribute tools
 * (`buildToolRegistry`, spec 060 T3).
 */
export const coreToolRegistry: ToolRegistry = { tools, byName: toolsByName };
