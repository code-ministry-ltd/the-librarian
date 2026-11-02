// The Librarian — OpenCode auto-capture plugin (spec 2026-06-16-harness-auto-capture,
// Phase 2A). A real OpenCode TS plugin: it rides the `chat.message` hook to ship a
// per-turn conversation DELTA to the Librarian server's POST /transcript endpoint,
// mirroring the Claude/Codex adapters' guarantees. Installed by the CLI into the
// OpenCode global plugin dir (~/.config/opencode/plugin/), where OpenCode loads it
// at startup.
//
// This file is the THIN SHELL. All decision logic lives in the dependency-free,
// unit-tested `.mjs` lib under ./lib/ (transcript / cursor / post / capture /
// runtime) — exactly the split the Codex adapter uses — so the guarantees are
// proven without a running OpenCode. This entry only adapts OpenCode's plugin
// context (the SDK `client`, the `chat.message` input/output, the `event` stream)
// to that pure core. Because it hard-imports `@opencode-ai/plugin` (a Bun-runtime
// peer, NOT a monorepo dependency), it is not type-checked by the repo's
// `pnpm -r typecheck`; the testable logic is covered by the .mjs unit tests.
//
// CONFIRMED `@opencode-ai/plugin@1.16.2` API (SP-OpenCode): the `chat.message`
// hook input carries a stable `sessionID` (our conv_id, never $USER/cwd) — pinned
// at @opencode-ai/plugin@1.16.2 dist/index.d.ts: "chat.message" input.sessionID:
// string (required); the full
// ordered message list (both roles, each with its text parts) is read via
// `client.session.messages({ path: { id: sessionID } })`. The `event` hook's
// `session.idle` is used as the explicit-end accelerator. SC1 e2e against a running
// OpenCode is DEFERRED (no opencode CLI on the build machine).
//
// FAIL-SOFT CONTRACT (AGENTS.md): a Librarian / network / parse failure must never
// throw out of the plugin, never block the user's turn, never leak a token or a
// stack trace into the model's context. Every hook body is wrapped so nothing
// escapes; `runCapture` is itself fully fail-soft. Capture is suppressed under the
// `LIBRARIAN_AUTO_SAVE=false` kill-switch and inert when the server intake gate is
// off (both enforced downstream).

import type { Plugin } from "@opencode-ai/plugin";
// The pure, unit-tested core. `.mjs` (Node stdlib only) so the same modules the
// vitest suite imports are the ones that ship — no build step, no drift.
import { runCapture } from "./lib/capture.mjs";
import { makeCursorStore } from "./lib/cursor.mjs";
import { makeJournalInjector } from "./lib/journal-inject.mjs";
import { isSessionEndEvent, readSessionMessages } from "./lib/runtime.mjs";

export const LibrarianCapture: Plugin = async ({ client, directory }) => {
  // One in-memory cursor store for the plugin's lifetime, keyed by sessionID, so
  // concurrent sessions in one OpenCode process never collide (SC5).
  const cursorStore = makeCursorStore();
  // Sessions seen idle since their last capture → ship `ended:true` next fire
  // (the explicit-end accelerator). Kept tiny; an id is cleared once consumed.
  const endedSessions = new Set<string>();
  // Spec 078: the recent journal window per session (fetched once, then cached so the
  // system prompt stays byte-stable) and the project label for capture (sent only
  // once /healthz shows the server accepts it). `directory` is the OpenCode
  // project directory; the label is its git repo's name, else the folder's.
  const journal = makeJournalInjector({ env: process.env });

  /** Run one capture pass for a session, fully fail-soft (never throws). */
  async function capture(sessionID: string, ended: boolean): Promise<void> {
    try {
      if (!sessionID) return;
      const messages = await readSessionMessages(client, sessionID);
      const project = await journal.projectFor(directory);
      await runCapture(
        { sessionID, messages, env: process.env, ended, project },
        { store: cursorStore },
      );
    } catch {
      // Absolute backstop: a capture failure must never surface to the user.
    }
  }

  return {
    // Per-turn capture. Fires when a user message is received; the session message
    // list (read here) carries the prior assistant reply too, so the delta catches
    // up the previous turn (the Claude "one turn behind" tolerance, spec §8.2).
    "chat.message": async (input) => {
      // `input.sessionID` is our conv_id. Source: @opencode-ai/plugin@1.16.2
      // dist/index.d.ts: "chat.message" input.sessionID: string (required). A
      // missing/blank id degrades to a clean no-op downstream (runCapture), never a
      // throw — the safe fail-direction.
      const sessionID = typeof input?.sessionID === "string" ? input.sessionID : "";
      const ended = endedSessions.delete(sessionID); // consume a pending idle signal
      await capture(sessionID, ended);
    },

    // Spec 078: the recent journal window in the system prompt, once per session.
    // `experimental.chat.system.transform` (confirmed in @opencode-ai/plugin@1.16.2
    // dist/index.d.ts: input `{ sessionID?, model }`, output `{ system: string[] }`)
    // runs before each LLM call; the window is cached per session, so every call sees
    // the same bytes. No sessionID → nothing is added. `LIBRARIAN_JOURNAL=off` skips it.
    "experimental.chat.system.transform": async (input, output) => {
      try {
        const text = await journal.systemFor(input?.sessionID);
        if (text && Array.isArray(output?.system)) output.system.push(text);
      } catch {
        // Fail-soft: the turn goes ahead without the journal.
      }
    },

    // Explicit-end accelerator: when a session goes idle, capture its tail now with
    // `ended:true` so the server settle-sweep extracts immediately. (If a new turn
    // arrives first, the pending flag is consumed by the next `chat.message`.)
    event: async ({ event }) => {
      try {
        const props = (event as { properties?: { sessionID?: string } })?.properties;
        const sessionID = typeof props?.sessionID === "string" ? props.sessionID : "";
        if (sessionID && isSessionEndEvent(event, sessionID)) {
          endedSessions.add(sessionID);
          await capture(sessionID, true);
        }
      } catch {
        // Fail-soft: losing the accelerator only falls back to the idle settle.
      }
    },
  };
};

export default LibrarianCapture;
