// MCP tool registry types.
//
// Each tool under `./tools/` exports a default `ToolDefinition` —
// `dispatch.ts` builds a name→definition map from these and dispatches
// `tools/call` requests through it.

import type { LibrarianStore, Principal } from "@librarian/core";

export interface MemoryCorrectionWakeRequest {
  memory_id: string;
  snapshot_digest: string;
  principal: Principal;
}

export interface ToolContext {
  /**
   * The resolved caller (spec 061 SC 4) — the one identity currency the tool layer reads.
   * `scopeAgentArgs` threads `principal.boundActorId` as `resolveCaller`'s authenticated
   * (token-bound) id and `principal.actorId` as the no-id fallback actor.
   */
  principal: Principal;
  /** @deprecated derive from principal: `principal.roles.includes("admin") ? "admin" : "agent"`. */
  role: "admin" | "agent";
  /** @deprecated derive from principal: `principal.boundActorId`. */
  agentId?: string | undefined;
  /** Wake durable correction work after a successful flag+marker persist. */
  wakeMemoryCorrection?: (request: MemoryCorrectionWakeRequest) => void;
}

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpTextResult {
  content: McpTextContent[];
}

export type ToolHandler = (
  store: LibrarianStore,
  args: Record<string, unknown>,
  context: ToolContext,
) => McpTextResult | Promise<McpTextResult>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  adminOnly?: boolean;
  handler: ToolHandler;
}

/**
 * A resolved tool registry the MCP dispatcher reads: `tools` is the ordered list
 * `tools/list` role-filters, `byName` is the lookup `tools/call` dispatches
 * through. The core registry (`coreToolRegistry` in `./tools/index.ts`) is the
 * default on every non-factory path; the HTTP factory threads a MERGED registry
 * (core + plugin tools) when plugins register tools (spec 060 T3, ADR 0011).
 */
export interface ToolRegistry {
  readonly tools: readonly ToolDefinition[];
  readonly byName: ReadonlyMap<string, ToolDefinition>;
}
