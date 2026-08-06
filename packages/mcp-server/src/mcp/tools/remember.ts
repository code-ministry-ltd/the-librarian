import { type InboxSubmissionHints, type ShelfScopedStore, isIntakeEnabled } from "@librarian/core";
import { ProjectKeysSchema } from "@librarian/core/schemas";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";
import { memoryInputSchema } from "./schemas.js";

/** The submitter's filing/ownership hints, carried onto the consolidated memory. */
function submissionHints(scoped: Record<string, unknown>): InboxSubmissionHints {
  const hints: InboxSubmissionHints = {};
  if (typeof scoped.agent_id === "string") hints.agentId = scoped.agent_id;
  if (Array.isArray(scoped.tags)) {
    hints.tags = scoped.tags.filter((t): t is string => typeof t === "string");
  }
  if (Array.isArray(scoped.applies_to)) {
    hints.appliesTo = scoped.applies_to.filter((a): a is string => typeof a === "string");
  }
  if (Array.isArray(scoped.project_keys)) {
    hints.projectKeys = scoped.project_keys.filter((key): key is string => typeof key === "string");
  }
  return hints;
}

function validateProjectKeys(scoped: Record<string, unknown>, shelf: ShelfScopedStore): void {
  if (scoped.project_keys === undefined) return;
  const keys = ProjectKeysSchema.parse(scoped.project_keys);
  const inactive = keys.filter((key) => shelf.projects.getByKey(key)?.status !== "active");
  if (inactive.length > 0) {
    throw new Error(
      `project_keys must name active projects on the destination shelf: ${inactive.join(", ")}`,
    );
  }
  scoped.project_keys = keys;
}

const remember: ToolDefinition = {
  name: "remember",
  description:
    "Save a durable fact, preference, or decision the moment you learn it — " +
    "not transient chatter. Fire-and-forget: submit and move on; the curator " +
    "files it asynchronously (dedupe, merge, link — no need to check first). " +
    "Give it a short `title` and a self-contained `body`; add `tags` so it " +
    "surfaces in the right context. Caller-supplied " +
    "`is_global` / `requires_approval` are ignored.",
  inputSchema: memoryInputSchema(),
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    // conv_id was a domain-routing signal (retired with conv_state, rethink
    // T2), never a memory field; un-updated plugins may still send it.
    delete scoped.conv_id;

    // Write-target enforcement (spec 062 SC 6): this principal's new, self-attributed material
    // lands on `writeTarget(principal)`'s shelf. Resolve + validate it (a non-writable / out-of-set
    // target throws a typed error the MCP boundary surfaces cleanly), then confine the submit /
    // write to that shelf's scoped handle. With the default router this is the main shelf — the
    // handle IS the top-level store's own path, so this is byte-identical.
    const shelf = store.forShelf(store.resolveWriteTarget(context.principal), context.principal);
    validateProjectKeys(scoped, shelf);

    // Inbox cutover: when intake is enabled (the dashboard setting
    // `curator.intake.enabled`, spec 043 D-E), `remember` is a fire-and-forget
    // submission — stored raw in the inbox and filed asynchronously by the
    // intake (navigate→judge→edit), preserving the submitter's scope via
    // hints. Otherwise the legacy direct write.
    if (isIntakeEnabled(store)) {
      const title = typeof scoped.title === "string" ? scoped.title : "";
      const body = typeof scoped.body === "string" ? scoped.body : "";
      const text = title ? `${title}\n\n${body}` : body;
      // An empty submission has nothing to file. Fall through to the
      // legacy write (which terminally files an "Untitled memory") rather than
      // enqueueing an empty inbox item — navigate→judge can't make a plan from
      // empty text, so it would only loop on the reaper TTL.
      if (text.trim()) {
        shelf.submitToInbox(text, submissionHints(scoped));
        return textResult(
          "Noted — queued for consolidation. The curator will file it into your memory shortly.",
        );
      }
    }

    // The write always lands `active`: createMemory is called with EMPTY
    // options, and routeMemoryWrite only lands `proposed` via the trusted
    // options channel (requires_approval/status) — never from agent input.
    // (The old "saved as a proposal" suffix branch was unreachable; rethink
    // T12 / S2 removed it.)
    const result = shelf.createMemory(scoped, {});
    const duplicateText = result.duplicates?.length
      ? `\n\nPossible duplicates:\n${result.duplicates
          .map((memory) => `- ${memory.title}: ${memory.body}`)
          .join("\n")}`
      : "";
    return textResult(
      `Memory saved.\n\n${result.memory.title}: ${result.memory.body}${duplicateText}`,
    );
  },
};

export default remember;
