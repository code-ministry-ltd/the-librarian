// MCP dispatch — thin router over the tool registry in `./tools/`.
//
// Owns the JSON-RPC envelope (`handleMcpPayload` / `handleMcpMessage`)
// and the `initialize` / `tools/list` / `tools/call` / `resources/*`
// methods. Every callable tool lives in `./tools/<verb>.ts`.

import {
  DEFAULT_AGENT_ID,
  formatRecall,
  type LibrarianStore,
  type Principal,
  readPrimer,
  SYSTEM_ACTOR_IDS,
} from "@librarian/core";
import { logger } from "../logging.js";
import { handleMcpMessage, handleMcpPayload } from "./rpc.js";
import type { ToolContext, ToolDefinition, ToolRegistry } from "./tool.js";
import { coreToolRegistry, tools } from "./tools/index.js";
import { visibleResourceMemories } from "./visibility.js";

export { handleMcpMessage, handleMcpPayload, tools };

/**
 * The identity a dispatch caller supplies (spec 061 T2). A `principal` is the preferred input —
 * the HTTP `/mcp` route and the stdio bin resolve a real {@link Principal} and pass it here. The
 * legacy `{ role, agentId }` pair remains accepted for older direct callers and existing tests;
 * {@link legacyPrincipal} lifts it into an equivalent principal so the tool layer only ever reads
 * one identity shape.
 */
export interface DispatchContext {
  principal?: Principal;
  /** @deprecated supply `principal` instead — legacy role-based context. */
  role?: ToolContext["role"];
  /** @deprecated supply `principal` instead — legacy token-bound id. */
  agentId?: string | undefined;
  /** Post-persist wake for a durable flagged-correction work marker. */
  wakeMemoryCorrection?: ToolContext["wakeMemoryCorrection"];
}

export async function dispatchMcp(
  store: LibrarianStore,
  method: string,
  params: Record<string, unknown> = {},
  context: DispatchContext = {},
  // The registry to list/dispatch through. Defaults to the core registry, so the
  // stdio bin and any direct caller keep exactly today's tool surface; the HTTP
  // factory threads a merged core+plugin registry here (spec 060 T3).
  registry: ToolRegistry = coreToolRegistry,
): Promise<unknown> {
  const toolContext = toToolContext(context);
  const role = toolContext.role;

  if (method === "initialize") {
    // The primer rides the initialize result's `instructions` field (rethink
    // T11 / D10) — the connect-time teaching channel every MCP harness renders
    // into the system layer. Read per connection (the store caches the file and
    // refreshes on write), never snapshotted at process start, so an admin edit
    // reaches the next session without a restart. Fail-soft: an unreadable or
    // operator-disabled ("") primer omits the field rather than blocking init.
    const instructions = readPrimer(store);
    return {
      protocolVersion: (params.protocolVersion as string) || "2025-06-18",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "the-librarian", version: "0.1.0" },
      ...(instructions ? { instructions } : {}),
    };
  }
  if (method === "tools/list") return { tools: toolsForRole(registry, role).map(toWireTool) };
  if (method === "tools/call") {
    return callTool(
      store,
      registry,
      params.name as string,
      (params.arguments as Record<string, unknown>) || {},
      toolContext,
    );
  }
  if (method === "resources/list") {
    return {
      resources: [
        {
          uri: "librarian://memories",
          name: "The Librarian Memories",
          description:
            role === "admin"
              ? "Human-readable memory snapshot."
              : "Human-readable common memory snapshot.",
          mimeType: "text/markdown",
        },
      ],
    };
  }
  if (method === "resources/read" && params.uri === "librarian://memories") {
    const memories = visibleResourceMemories(store, toolContext);
    return {
      contents: [
        {
          uri: "librarian://memories",
          mimeType: "text/markdown",
          text: formatRecall(memories, "The Librarian Memories"),
        },
      ],
    };
  }
  throw new Error(`Unsupported method: ${method}`);
}

/**
 * Resolve a {@link DispatchContext} to the {@link ToolContext} the tool layer reads (spec 061
 * T2). A supplied `principal` is used verbatim; a legacy `{ role, agentId }` context is lifted
 * via {@link legacyPrincipal}. The deprecated `role`/`agentId` fields are the derived mirror —
 * role from the principal's roles, agentId from its cryptographic binding — kept consistent for
 * any handler still reading them.
 */
function toToolContext(context: DispatchContext): ToolContext {
  const principal = context.principal ?? legacyPrincipal(context);
  return {
    principal,
    role: principal.roles.includes("admin") ? "admin" : "agent",
    agentId: principal.boundActorId,
    ...(context.wakeMemoryCorrection ? { wakeMemoryCorrection: context.wakeMemoryCorrection } : {}),
  };
}

/**
 * Lift a legacy `{ role, agentId }` dispatch context into a {@link Principal} (spec 061 T2),
 * preserving today's semantics EXACTLY: `admin` → the trusted dashboard-admin actor, but a passed
 * `agentId` is RETAINED as the admin's binding (both `actorId` and `boundActorId`) so
 * `store_handoff` attributes `created_by_agent_id` to it, exactly as the old `{ role: "admin",
 * agentId }` context did (spec 061 review fix 1); an agent carrying a bound `agentId` → that id in
 * both `actorId` and `boundActorId` (so the impersonation guard still fires on a mismatched body
 * id); an agent with no id → the `unknown-agent` fallback. The sentinel supersession (SC 3)
 * deliberately does NOT happen here: a bare role/agentId pair carries no auth provenance, so its
 * no-id fallback stays `unknown-agent`; the sentinel appears only where a real provider-produced
 * principal exists (the HTTP `/mcp` route and the stdio bin, which pass `principal` directly).
 */
function legacyPrincipal(context: DispatchContext): Principal {
  const role = context.role ?? "agent";
  const boundId = context.agentId?.trim();
  if (role === "admin") {
    if (boundId) {
      return { kind: "admin", actorId: boundId, boundActorId: boundId, roles: ["admin"] };
    }
    return { kind: "admin", actorId: SYSTEM_ACTOR_IDS.dashboardAdmin, roles: ["admin"] };
  }
  if (boundId) {
    return { kind: "agent", actorId: boundId, boundActorId: boundId, roles: ["agent"] };
  }
  return { kind: "agent", actorId: DEFAULT_AGENT_ID, roles: ["agent"] };
}

function callTool(
  store: LibrarianStore,
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): ReturnType<ToolDefinition["handler"]> {
  const tool = registry.byName.get(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (tool.adminOnly && context.role !== "admin") {
    void store.recordRefusal({
      kind: "tool-admin-only",
      surface: "public",
      outcome: "refused",
      tool: name,
      actorId: context.principal.actorId,
      roles: [...context.principal.roles],
      ...(context.principal.tokenId === undefined ? {} : { tokenId: context.principal.tokenId }),
    });
    throw new Error(`Tool ${name} requires admin authorization.`);
  }
  warnIfMissingIdentity(name, args, context);
  return tool.handler(store, args, context);
}

// Soft-migration observability (§9 Phase 1). When an agent call carries no
// identity — no token-bound id and no request-body `agent_id` — the resolver
// falls back to the `unknown-agent` sentinel. Log each such call so we can
// confirm the Stage 4 hard-enforcement gate ("no new unknown-agent rows for
// 7 consecutive days") before flipping it. Admin calls don't carry an agent
// identity by design, so they're exempt.
//
// The predicate below mirrors the resolver's own fallback condition
// (`firstSupplied`/`hasValue` in core's caller-identity, fed by `scopeAgentArgs`).
// It's re-derived here because this is the only layer with the tool name; keep
// it in sync if `scopeAgentArgs` ever starts feeding the resolver new id sources.
function warnIfMissingIdentity(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): void {
  if (context.role !== "agent") return;
  if (context.agentId && context.agentId.trim() !== "") return;
  if (typeof args.agent_id === "string" && args.agent_id.trim() !== "") return;

  // The fallback actor is now the principal's `actorId` (spec 061 SC 3): the documented
  // sentinel (`env-token-agent` / `local-agent`) on the real HTTP/stdio paths, or the legacy
  // `unknown-agent` for a bare role-based context. Log the actual value so the migration
  // signal names the row that will be written, not a stale constant.
  const fallbackActor = context.principal.actorId;
  const bindings: Record<string, unknown> = { tool: name, actor_id: fallbackActor };
  if (typeof args.harness === "string") bindings.harness = args.harness;
  if (typeof args.source_ref === "string") bindings.source_ref = args.source_ref;
  logger.warn(
    bindings,
    `agent call to "${name}" supplied no identity; falling back to ${fallbackActor} (soft-migration)`,
  );
}

function toolsForRole(
  registry: ToolRegistry,
  role: ToolContext["role"],
): readonly ToolDefinition[] {
  if (role === "admin") return registry.tools;
  return registry.tools.filter((tool) => !tool.adminOnly);
}

// The agent-facing wire shape: name + tool-level teaching description + the
// lean input schema. Per-parameter human descriptions are authored inline on
// each `inputSchema` as the single source of truth for the docs generator, but
// they are docs-only — stripped here so a `tools/list` payload never spends an
// agent's context on prose it can't act on (docs-site spec K7). The tool-level
// `description` is the deliberate teaching surface and is preserved verbatim.
type JsonSchemaValue =
  null | boolean | number | string | JsonSchemaValue[] | { [key: string]: JsonSchemaValue };

interface WireTool {
  name: string;
  description: string;
  inputSchema: { [key: string]: JsonSchemaValue };
}

function toWireTool(tool: ToolDefinition): WireTool {
  const inputSchema = stripSchemaDescriptions(tool.inputSchema);
  if (inputSchema === null || Array.isArray(inputSchema) || typeof inputSchema !== "object") {
    throw new Error("MCP tool input schema must be a JSON object.");
  }
  return { name: tool.name, description: tool.description, inputSchema };
}

// Deep-clone a JSON-Schema value with every `description` key removed, so no
// per-property prose survives onto the wire. Operates on a copy — the registry
// objects (and the docs generator's source of truth) keep their descriptions.
function stripSchemaDescriptions(value: unknown): JsonSchemaValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(stripSchemaDescriptions);
  if (typeof value === "object") {
    const out: { [key: string]: JsonSchemaValue } = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "description") continue;
      out[key] = stripSchemaDescriptions(child);
    }
    return out;
  }
  throw new Error("MCP tool input schema must contain only JSON-compatible values.");
}
