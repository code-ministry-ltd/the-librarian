// Native Pi slash commands for The Librarian — optional sugar (rethink D9).
//
// Four thin prompt templates aligned with docs/slash-commands.md and the
// 7-verb surface. Each handler injects a user message that drives the LLM
// through the corresponding tool flow; the tools (and the primer) carry the
// actual protocol, so these stay deliberately skeletal. Pi's `registerCommand`
// is one call per verb — cheap enough to keep.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const HANDOFF_PROMPT =
  "Author a five-section handoff document with these exact headings: " +
  "`## Start & intent`, `## Journey`, `## Current state`, `## What's left`, " +
  "`## Open questions`. Then call `store_handoff` with the document (plus " +
  "project_key / cwd / harness when known) and report the returned handoff_id.";

const TAKEOVER_PROMPT =
  "Call `list_handoffs` scoped to the current project_key + cwd (drop filters " +
  "to broaden when nothing matches), present the candidates to the user — " +
  "never auto-select — then `claim_handoff` the chosen id and continue the " +
  "work its document describes. If the user supplied a handoff id, claim it directly.";

const LEARN_PROMPT =
  "Extract durable lessons from this conversation and feed user-approved ones " +
  "to `remember`, one call per lesson — fire-and-forget: the user picking a " +
  "lesson is the review, so submit and move on; the curator dedupes, merges, " +
  "and files each one asynchronously.";

const TOGGLE_ON =
  "Private mode is ON. `[librarian:private=on]` — do not call `remember`, " +
  "`store_handoff`, or `flag_memory` until told otherwise. `recall` and " +
  "`search_references` stay allowed; note that read queries still reach the " +
  "Librarian server's logs. Private mode is an in-conversation instruction; " +
  "the server cannot verify its marker. A correction job queued by a flag " +
  "from public context may still finish after switching private; the toggle " +
  "does not cancel queued work. Remain in this state until explicitly toggled off.";

const TOGGLE_OFF = "Private mode is OFF. `[librarian:private=off]` — normal operation resumed.";

const TOGGLE_PROMPT =
  "Toggle in-conversation private mode. Inject the inverse of the most recent " +
  `\`[librarian:private=on|off]\` marker. If ON: emit \`${TOGGLE_OFF}\`. If ` +
  `OFF or no marker: emit \`${TOGGLE_ON}\`.`;

export const COMMAND_SPECS = [
  {
    name: "handoff",
    description: "Author and persist a cross-harness handoff document",
    prompt: HANDOFF_PROMPT,
  },
  {
    name: "takeover",
    description: "Pick up a handoff from another agent / harness",
    prompt: TAKEOVER_PROMPT,
  },
  {
    name: "learn",
    description: "Extract durable lessons from this conversation into durable memory",
    prompt: LEARN_PROMPT,
  },
  {
    name: "toggle-private",
    description: "Toggle in-conversation private mode (no server state, no hook)",
    prompt: TOGGLE_PROMPT,
  },
] as const;

export function registerCommands(pi: ExtensionAPI): void {
  for (const spec of COMMAND_SPECS) {
    pi.registerCommand(spec.name, {
      description: spec.description,
      handler: async (args: string, _ctx: ExtensionCommandContext) => {
        // `sendUserMessage` always triggers a turn, so the template actually
        // drives the flow (a UI notify would only reach the human).
        const input = args.trim();
        pi.sendUserMessage(input ? `${spec.prompt}\n\nUser input: ${input}` : spec.prompt);
      },
    });
  }
}
