// OpenCode journal injection (spec 078) — the pure, testable core behind the
// plugin's `experimental.chat.system.transform` hook and the `project` label on
// /transcript.
//
//   - systemFor(sessionID): the recent window of the conversation journal, fetched
//     ONCE per session and then served from memory, so the system prompt is
//     byte-identical on every turn (prompt caching stays warm) and the server is
//     asked once, not per LLM call. Whatever the first fetch yields is what the
//     session keeps — a server that comes back mid-session doesn't change the prompt.
//   - projectFor(directory): the project label for capture, but only once a /healthz
//     probe has shown the server accepts `project` (an older server rejects the
//     unknown key and capture would stall). Probed once per plugin process.
//
// FAIL-SOFT (AGENTS.md): every function resolves; nothing throws. A failure means no
// journal in the prompt and no project on the payload — never a broken turn.

import { deriveProject, fetchJournal, probeJournalSupport } from "./journal.mjs";

/** Sessions remembered at once; the oldest is forgotten first. */
const MAX_SESSIONS = 200;

/**
 * @param {{env: Record<string,string|undefined>, fetch?: typeof globalThis.fetch}} options
 */
export function makeJournalInjector({ env, fetch }) {
  const deps = fetch ? { fetch } : {};
  /** @type {Map<string, Promise<string|null>>} */
  const windows = new Map();
  /** @type {Promise<boolean>|null} */
  let supported = null;

  return {
    /**
     * @param {string|undefined} sessionID
     * @returns {Promise<string|null>}
     */
    async systemFor(sessionID) {
      try {
        if (typeof sessionID !== "string" || !sessionID) return null;
        let pending = windows.get(sessionID);
        if (!pending) {
          pending = fetchJournal(env, deps).catch(() => null);
          windows.set(sessionID, pending);
          if (windows.size > MAX_SESSIONS) {
            const oldest = windows.keys().next().value;
            if (oldest !== undefined) windows.delete(oldest);
          }
        }
        return await pending;
      } catch {
        return null;
      }
    },

    /**
     * @param {string|undefined} directory
     * @returns {Promise<string|null>}
     */
    async projectFor(directory) {
      try {
        if (!supported) supported = probeJournalSupport(env, deps).catch(() => false);
        return (await supported) ? deriveProject(directory) : null;
      } catch {
        return null;
      }
    },
  };
}
