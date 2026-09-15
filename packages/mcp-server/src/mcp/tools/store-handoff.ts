// `store_handoff` MCP tool (sessions-rethink spec §6.1).
//
// Called by the outgoing agent at the end of `/handoff`. The MCP boundary
// validates the input shape (Zod), resolves the caller's identity server-side,
// and asks the store to persist. The store layer trusts validated input —
// the heading/length contract is enforced here, not there.

import { StoreHandoffInputSchema } from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";

const storeHandoff: ToolDefinition = {
  name: "store_handoff",
  description:
    "Hand work off: persist a handoff document so another agent — on any " +
    "harness — can resume your work later. Only call it when the user has " +
    "explicitly asked for a handoff — never spontaneously, even when pausing " +
    "mid-task or ending a session. The document must carry exactly " +
    "these five sections — Start & intent, Journey, Current state, What's " +
    "left, Open questions — or it is rejected. The other side picks it up " +
    "with `list_handoffs` then `claim_handoff`.",
  inputSchema: {
    type: "object",
    required: ["title", "document_md"],
    properties: {
      title: {
        type: "string",
        minLength: 5,
        maxLength: 120,
        description:
          "A short, human-scannable title for the handoff, shown in the takeover picker.",
      },
      document_md: {
        type: "string",
        minLength: 100,
        maxLength: 50000,
        description:
          "The handoff document in Markdown. It must contain exactly the five required sections — " +
          "Start & intent, Journey, Current state, What's left, Open questions — or it is rejected.",
      },
      project_key: {
        type: ["string", "null"],
        description:
          "Optional project this handoff belongs to, used to scope the takeover picker to the right project.",
      },
      source_ref: {
        type: ["string", "null"],
        description:
          "Optional stable reference to where the work lives — a harness conversation/run id, or " +
          "a cwd-prefixed absolute path — so the next agent can resume in place.",
      },
      cwd: {
        type: ["string", "null"],
        description:
          "Optional working directory the handoff was created in, used as a default takeover filter.",
      },
      harness: {
        type: ["string", "null"],
        description:
          "Optional name of the harness the handoff was created in (e.g. claude-code, codex), recorded for context.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
        description: "Optional labels for the handoff, to aid discovery in the picker.",
      },
    },
  },
  handler(store, args, context) {
    const parsed = StoreHandoffInputSchema.safeParse(args);
    if (!parsed.success) {
      const reason = parsed.error.issues[0]?.message ?? "invalid handoff input";
      return textResult(`Handoff rejected: ${reason}`);
    }
    // Write-target enforcement (spec 062 SC 6): the handoff lands under this principal's
    // `writeTarget` shelf (`<prefix>handoffs/`). Resolve + validate, then persist through the
    // scoped handle. Default router → the main shelf → byte-identical.
    const shelf = store.forShelf(store.resolveWriteTarget(context.principal), context.principal);
    const result = shelf.handoffs.store(parsed.data, {
      created_by_agent_id: context.agentId ?? null,
    });
    return textResult(
      `Handoff stored.\n\nhandoff_id: ${result.handoff_id}\ncreated_at:  ${result.created_at}\n\nPick it up from another agent with /takeover.`,
    );
  },
};

export default storeHandoff;
