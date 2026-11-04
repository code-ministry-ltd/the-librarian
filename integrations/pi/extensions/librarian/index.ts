// The Librarian — Pi coding-agent extension (rethink spec §7, D14).
//
// Ported from the standalone the-librarian-pi-extension repo. The 2026-06-12
// rethink retires the conv-state injection, the per-turn conv_state fetch, and
// the 3-tool limitation; what survives is exactly:
//
//   - the 8 agent verbs (recall / remember / flag_memory / store_handoff /
//     list_handoffs / claim_handoff / search_references / journal) as native Pi tool
//     proxies over the Librarian's stateless /mcp endpoint — see `tools.ts`;
//   - the ≤2KB primer, fetched from `GET /primer.md` once per process and
//     appended to the system prompt via `before_agent_start` — see `primer.ts`;
//   - the recent window of the conversation journal, fetched once per session and
//     appended after the primer (spec 078) — see `journal.ts`;
//   - three user-facing slash commands (`/handoff`, `/takeover`, `/toggle-private`) as thin prompt templates — see `commands.ts`.
//
// Private mode is purely in-conversation: an `[librarian:private=on|off]`
// marker the LLM owns. There is no server flag, no on-disk state, and no
// privacy hook here.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCaptureHook, resolveDataDir } from "./capture.js";
import { registerCommands } from "./commands.js";
import { readConfig } from "./config.js";
import { createJournalSource, registerJournalHook } from "./journal.js";
import { createMcpClient } from "./mcp-client.js";
import { createPrimerSource, registerPrimerHook } from "./primer.js";
import { registerLibrarianTools } from "./tools.js";

const CONFIG_HINT =
  "The Librarian is not configured. Set LIBRARIAN_MCP_URL and LIBRARIAN_AGENT_TOKEN.";

const COMMAND_VERBS = ["handoff", "takeover", "toggle-private"] as const;

export default function librarian(pi: ExtensionAPI): void {
  const config = readConfig();

  if (!config) {
    // Dormant: no endpoint/token → no tools, no hook, no automatic calls.
    // Still register the commands so they explain the missing configuration
    // instead of being "unknown command".
    for (const verb of COMMAND_VERBS) {
      pi.registerCommand(verb, {
        description: `${verb} (Librarian not configured)`,
        handler: async (_args, ctx) => {
          ctx.ui.notify(CONFIG_HINT, "warning");
        },
      });
    }
    return;
  }

  // One shared MCP client for all 8 tool proxies.
  const mcp = createMcpClient({
    endpoint: config.endpoint,
    token: config.token,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
  });

  // Expose the Librarian's 8 verbs to the model directly (no mcp.json needed).
  registerLibrarianTools(pi, mcp);

  // Primer → system prompt, once per turn, cached per process, fail-soft.
  registerPrimerHook(pi, createPrimerSource({ endpoint: config.endpoint }));

  // Spec 078: the recent journal window → system prompt, after the primer; fetched
  // once per Pi session, fail-soft, `LIBRARIAN_JOURNAL=off` skips it. The same source
  // labels captured conversations with their project once /healthz shows the server
  // accepts the field.
  const journal = createJournalSource({ endpoint: config.endpoint, token: config.token });
  registerJournalHook(pi, journal);

  // Auto-capture (Phase 2B, spec 2026-06-16-harness-auto-capture): wire the
  // `agent_end` hook so each completed turn's NON-PRIVATE prose ships as a
  // per-turn delta to POST /transcript. Default-on; the LIBRARIAN_AUTO_SAVE=false
  // kill-switch + forward-only private mode are enforced at fire time inside the
  // handler (so a mid-session env change takes effect without a re-install), and
  // it stays inert when the server's capture gate (intake and journal) is off. The hook
  // is registered only when the extension is configured (the dormant branch above
  // returns before reaching here, so an unconfigured install captures nothing).
  registerCaptureHook(pi, resolveDataDir(process.env), (cwd) => journal.projectFor(cwd));

  // The three user-facing slash commands (optional sugar, D9).
  registerCommands(pi);
}
