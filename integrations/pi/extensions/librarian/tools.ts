// The Librarian's 7 agent verbs, registered natively in the extension.
//
// Pi's CORE has no MCP support (the `mcp.json` / mcpServers feature lives in
// third-party adapter extensions, not the runtime). So rather than ask every
// user to install an MCP adapter and hand-place a config file, the extension
// exposes the Librarian's tools to the model itself via `pi.registerTool`,
// proxying each call as a `tools/call` over HTTP. One `pi install`, zero config.
//
// Tool descriptions are the teaching surface (rethink spec §5.1): each one is
// copied VERBATIM from `@librarian/mcp-server/src/mcp/tools/<verb>.ts` so Pi
// users see exactly what every other harness sees. Schemas mirror the server's
// `inputSchema`s minus `agent_id` (the server resolves the caller from the
// bearer token) and the retired `conv_id`. Server fields typed
// `["string","null"]` are exposed here as optional strings — omission and null
// are equivalent for those filters, and a plain `string` type survives every
// provider's schema translation (Google's rejects type arrays). The
// schema-parity drift guard in `tests/schema-parity.test.ts` pins all of this
// against the server package mechanically.
//
// Fail-soft (AGENTS.md §2): a proxy NEVER throws into the harness. A network /
// server failure comes back as a short error string the model can read and
// route around — the user's turn is never broken by a Librarian outage.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { McpClientError, type McpClient } from "./mcp-client.js";

// Drop undefined values so optional args aren't sent as JSON nulls.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export interface LibrarianToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
}

/**
 * The 7-verb agent surface (rethink spec §5.1), one spec per server tool.
 * Exposed as a function (fresh schema objects per call) so tests can inspect
 * the specs without registering anything.
 */
export function librarianToolSpecs(): LibrarianToolSpec[] {
  return [
    {
      name: "recall",
      label: "Recall",
      description:
        "Search the owner's durable memories. Call this before answering anything " +
        "that may have prior context — at task start, and whenever a stored fact, " +
        "preference, or past decision could change your answer. Memories only: " +
        "long-form reference docs are NOT here — search those with " +
        "`search_references`. Query by free text; `tags` narrows to memories " +
        "carrying any of the supplied tags. Pass `include_ids: true` to prefix " +
        "each result with its memory id, so a memory that turns out to be wrong " +
        "can be passed straight to `flag_memory`.",
      parameters: Type.Object({
        query: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
        include_ids: Type.Optional(Type.Boolean()),
        limit: Type.Optional(Type.Number()),
      }),
    },
    {
      name: "remember",
      label: "Remember",
      description:
        "Save a durable fact, preference, or decision the moment you learn it — " +
        "not transient chatter. Fire-and-forget: submit and move on; the curator " +
        "files it asynchronously (dedupe, merge, link — no need to check first). " +
        "Give it a short `title` and a self-contained `body`; add `tags` so it " +
        "surfaces in the right context. Caller-supplied " +
        "`is_global` / `requires_approval` are ignored.",
      parameters: Type.Object({
        title: Type.String(),
        body: Type.String(),
        applies_to: Type.Optional(Type.Array(Type.String())),
        project_keys: Type.Optional(
          Type.Array(
            Type.String({
              minLength: 1,
              maxLength: 64,
              pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
            }),
            { maxItems: 20, uniqueItems: true },
          ),
        ),
        confidence: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
      }),
    },
    {
      name: "flag_memory",
      label: "Flag memory",
      description:
        "A recalled memory is wrong, misleading, or outdated — flag it with a short " +
        "free-text `reason` (required: say why). The flag routes the memory to human " +
        "review and demotes it below unflagged matches in recall; it never edits, " +
        "archives, or deletes, and there is no 'this was useful' counterpart. Use it " +
        "sparingly, only when a memory actively led you astray.",
      parameters: Type.Object({
        memory_id: Type.String(),
        reason: Type.String({ minLength: 1, maxLength: 2000 }),
      }),
    },
    {
      name: "store_handoff",
      label: "Store handoff",
      description:
        "Hand work off: persist a handoff document so another agent — on any " +
        "harness — can resume your work later. Call it when pausing mid-task or " +
        "ending a session that isn't finished. The document must carry exactly " +
        "these five sections — Start & intent, Journey, Current state, What's " +
        "left, Open questions — or it is rejected. The other side picks it up " +
        "with `list_handoffs` then `claim_handoff`.",
      parameters: Type.Object({
        title: Type.String({ minLength: 5, maxLength: 120 }),
        document_md: Type.String({ minLength: 100, maxLength: 50000 }),
        project_key: Type.Optional(Type.String()),
        source_ref: Type.Optional(Type.String()),
        cwd: Type.Optional(Type.String()),
        harness: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })),
      }),
    },
    {
      name: "list_handoffs",
      label: "List handoffs",
      description:
        "Take over work, step 1: list the unclaimed handoffs waiting to be picked " +
        "up, then `claim_handoff` the one you want. Default scope is the caller's " +
        "current project_key + cwd when both are supplied; drop either filter to " +
        "broaden when nothing matches.",
      parameters: Type.Object({
        project_key: Type.Optional(Type.String()),
        cwd: Type.Optional(Type.String()),
        harness: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
    },
    {
      name: "claim_handoff",
      label: "Claim handoff",
      description:
        "Take over work, step 2 (after `list_handoffs`): atomically claim a " +
        "handoff and receive its document to resume from. Claims race — 404 if " +
        "the id is unknown; 409 if another agent claimed first (the existing " +
        "claim is included so you can say who has it and since when).",
      parameters: Type.Object({
        handoff_id: Type.String({ minLength: 1 }),
        claiming_agent_id: Type.Optional(Type.String()),
        claiming_harness: Type.Optional(Type.String()),
        claiming_source_ref: Type.Optional(Type.String()),
        claiming_cwd: Type.Optional(Type.String()),
      }),
    },
    {
      name: "search_references",
      label: "Search references",
      description:
        "Search the long-form reference documents (background material the " +
        "operator filed under references/ — specs, manuals, design notes). " +
        "References are deliberately NOT auto-recalled and never appear in " +
        "`recall` results, so search here when the task needs that depth. " +
        "Returns each match's vault path + the query-relevant section.",
      parameters: Type.Object({
        query: Type.String({ description: "What to look up in the references." }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
    },
  ];
}

/** The 7 tool names this extension registers (for tests / smoke). */
export const LIBRARIAN_TOOL_NAMES = [
  "recall",
  "remember",
  "flag_memory",
  "store_handoff",
  "list_handoffs",
  "claim_handoff",
  "search_references",
] as const;

/**
 * Register the 7 Librarian verbs as native Pi tools. Each is a thin proxy:
 * forward to the remote MCP `tools/call`, return the server's prose. Failures
 * come back as an error STRING (never a throw): the model reads it, tells the
 * user, and keeps working — a Librarian outage must not break the turn.
 */
export function registerLibrarianTools(pi: ExtensionAPI, client: McpClient): void {
  for (const spec of librarianToolSpecs()) {
    pi.registerTool({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters,
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        try {
          const text = await client.callTool(spec.name, compact(params));
          return { content: [{ type: "text" as const, text }], details: {} };
        } catch (err) {
          // McpClientError messages are credential-free by construction; any
          // other throw gets a generic line so nothing unexpected leaks.
          const reason =
            err instanceof McpClientError
              ? err.message
              : `${spec.name} failed before reaching the Librarian`;
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Librarian unavailable — ${reason}. ` +
                  "Continue the user's work without it; do not block on memory.",
              },
            ],
            details: {},
          };
        }
      },
    });
  }
}
