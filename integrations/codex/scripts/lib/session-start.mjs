// Codex `SessionStart` journal injection (spec 078) — the testable orchestrator
// behind scripts/on-session-start.mjs.
//
// Codex runs `SessionStart` hooks when a session starts, resumes, is cleared, forks,
// or has just been compacted (`source`: startup | resume | clear | fork | compact),
// so the window survives compaction exactly as it does in Claude Code. The hook's
// JSON `hookSpecificOutput.additionalContext` reaches the model as developer context.
// Codex spills additionalContext over ~2,500 tokens to a file by default; the hook
// entry in hooks/codex-hooks.json raises that with `additionalContextLimit`, and the
// window itself is capped at JOURNAL_MAX_CHARS (the same size Claude Code gets).
//
// It also records whether the server accepts `project` on /transcript, so the
// capture hook (lib/capture.mjs) labels journal entries only for a server that
// understands the field.
//
// FAIL-SOFT (AGENTS.md): every path resolves; nothing throws. No config,
// `LIBRARIAN_JOURNAL=off`, server down, journal off or empty — the result is null and
// the hook prints nothing. The token is sent in the Authorization header only.

import { resolveDataDir } from "./capture.mjs";
import { fetchJournal, probeJournalSupport, writeServerFeatures } from "./journal.mjs";

/**
 * Run the session-start work for one Codex hook invocation.
 *
 * @param {{agent_id?: string, source?: string}} hook - the parsed hook JSON.
 * @param {Record<string,string|undefined>} env
 * @param {{fetch?: typeof globalThis.fetch}} [deps]
 * @returns {Promise<string|null>} the JSON line to print on stdout, or null.
 */
export async function runSessionStart(hook, env, deps = {}) {
  try {
    // A subagent's session starts too; the journal is for the top-level
    // conversation, as capture is.
    if (hook && hook.agent_id) return null;
    const [supported, journal] = await Promise.all([
      probeJournalSupport(env, deps),
      fetchJournal(env, deps),
    ]);
    writeServerFeatures(resolveDataDir(env), { journalSupported: supported });
    if (!journal) return null;
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: journal },
    });
  } catch {
    return null;
  }
}
