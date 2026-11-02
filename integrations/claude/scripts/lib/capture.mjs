// Claude `Stop` adapter — the orchestrator (testable; the hook entry is a thin
// shell over `runCapture`). Spec 2026-06-16-harness-auto-capture, T3.
//
// Wires the pure transforms (transcript.mjs), the durable cursor (cursor.mjs),
// and the network ship (post.mjs) into the one decision the `Stop` hook makes:
// since this session was last seen, ship the new NON-PRIVATE turns and advance
// the cursor ONLY on a server ack. Everything is fail-soft (Q6: err toward NOT
// capturing) — every path resolves, never throws; an error logs to the sidecar
// and the cursor stays put so the delta re-ships next run (idempotent; the
// server/curator dedup).
//
// The network `post` is INJECTED so the orchestration is unit-testable without a
// socket; the hook entry passes the real `postDelta`.

import fs from "node:fs";
import path from "node:path";
import { cursorPath, pruneOldCursors, readCursor, writeCursor } from "./cursor.mjs";
import { deriveProject, serverSupportsJournal } from "./journal.mjs";
import { deriveTranscriptUrl, postDelta } from "./post.mjs";
import {
  buildPayload,
  completeLineBytes,
  entriesToTurns,
  filterPrivateSpans,
  parseEntries,
} from "./transcript.mjs";

const PRUNE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // ~7 days (Q5: age-based, never clear-all)

// Per-run client ship cap (C1/I1). The cursor advances at most this many bytes
// per `Stop`, to a precise LINE boundary inside the window. Two jobs:
//   1. A first capture of a multi-MB session must NOT POST a body over the
//      server's maxBodyBytes (1 MiB default — see bin/http.ts): a 413 would hold
//      the cursor and re-ship forever (livelock), capturing nothing. 256 KiB of
//      raw JSONL is comfortably under 1 MiB even after the turns are JSON-encoded
//      into the delta payload (we ship a SUBSET of the bytes — prose only, no
//      thinking/tool_use — so the encoded body is always smaller than the window).
//   2. A large backlog therefore drains over multiple `Stop`s, a bounded chunk
//      each run, instead of one oversized POST.
const MAX_SHIP_BYTES = 256 * 1024; // 256 KiB — safely under the 1 MiB server cap

/**
 * Resolve the plugin data dir (cursor + sidecar-log home). Q5 default:
 * `${CLAUDE_PLUGIN_DATA:-$HOME/.librarian/claude-plugin-data}`.
 */
export function resolveDataDir(env) {
  const explicit = env.CLAUDE_PLUGIN_DATA;
  if (explicit && explicit.trim()) return explicit;
  const home = env.HOME || env.USERPROFILE || ".";
  return path.join(home, ".librarian", "claude-plugin-data");
}

/**
 * Append a one-line skip/error record to the local sidecar log (fail-soft, never
 * a stack trace into the model's context — AGENTS.md). Best-effort: a logging
 * failure is itself swallowed. NEVER logs turn text or the token.
 */
function logSidecar(dataDir, sessionId, message) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const line = `${new Date().toISOString()} [${sessionId ?? "?"}] ${message}\n`;
    fs.appendFileSync(path.join(dataDir, "capture.log"), line, "utf8");
  } catch {
    // last-resort: drop it. A log failure must never break the hook.
  }
}

/**
 * Is this Stop the end of the session (vs a mid-conversation turn stop)? Claude
 * fires `Stop` per turn-end; a true session end (close / `/clear`) surfaces as a
 * `SessionEnd` event name (when wired) — treat that as the explicit-end
 * accelerator (`ended:true`). Absent that signal, `ended` is omitted and the
 * server's idle settle-sweep handles it (spec §4.4 / SC3). Defensive across the
 * exact field name the harness uses.
 */
function isSessionEnd(hook) {
  const name = hook.hook_event_name || hook.hookEventName;
  return name === "SessionEnd";
}

/**
 * Run one capture pass for a `Stop` hook invocation.
 *
 * @param {{transcript_path?:string, session_id?:string, agent_id?:string,
 *          cwd?:string, hook_event_name?:string}} hook - the parsed hook JSON.
 * @param {Record<string,string|undefined>} env - process env (URL, token, data dir).
 * @param {{post?: typeof postDelta}} [deps] - injectable network ship (tests).
 * @returns {Promise<{posted:boolean, skipped?:string,
 *          ack?:{ok:boolean,status:number,buffered?:number}}>}
 */
export async function runCapture(hook, env, deps = {}) {
  const post = deps.post ?? postDelta;
  const dataDir = resolveDataDir(env);
  const sessionId = hook.session_id;

  // SUBAGENT SKIP (§6): an `agent_id`-present Stop is a subagent's; only the
  // top-level session is captured. No-op, no cursor touched.
  if (hook.agent_id) {
    return { posted: false, skipped: "subagent" };
  }

  // Age-based cursor pruning (Q5 / SC15) — opportunistic, fail-soft, NEVER
  // clear-all (a fresh sibling cursor is a live concurrent session).
  pruneOldCursors(dataDir, PRUNE_MAX_AGE_MS);

  try {
    if (!sessionId) {
      logSidecar(dataDir, sessionId, "skip: no session_id on hook input");
      return { posted: false, skipped: "no-session" };
    }

    // CONFIG (fail-soft, Q6 transient): without a URL + token there is nowhere to
    // ship — a clean no-op, cursor untouched, re-ships once configured.
    const url = deriveTranscriptUrl(env.LIBRARIAN_MCP_URL);
    const token = env.LIBRARIAN_AGENT_TOKEN;
    if (!url || !token) {
      logSidecar(dataDir, sessionId, "skip: LIBRARIAN_MCP_URL / LIBRARIAN_AGENT_TOKEN not set");
      return { posted: false, skipped: "not-configured" };
    }

    // READ TRANSCRIPT from the cursor offset to EOF (the new bytes since last run).
    const transcriptPath = hook.transcript_path;
    if (!transcriptPath) {
      logSidecar(dataDir, sessionId, "skip: no transcript_path on hook input");
      return { posted: false, skipped: "no-transcript" };
    }

    let size;
    try {
      size = fs.statSync(transcriptPath).size;
    } catch {
      logSidecar(dataDir, sessionId, "skip: transcript_path unreadable (stat failed)");
      return { posted: false, skipped: "no-transcript" };
    }

    const prior = readCursor(dataDir, sessionId);
    // The transcript is append-only (§6). If it shrank (rotation / a different
    // file reused the id), the offset is stale — restart from 0 (re-ship is safe).
    const start = prior.offset <= size ? prior.offset : 0;

    // READ A BOUNDED WINDOW from the cursor (C1/I1): at most MAX_SHIP_BYTES so a
    // huge first delta never POSTs a body over the server cap (no 413 livelock),
    // and a large backlog drains over multiple `Stop`s. We slice to a precise LINE
    // boundary inside this window so a half-flushed trailing line (a `Stop` firing
    // mid-write) is never lost or shipped torn.
    let buf = Buffer.alloc(0);
    const readLen = Math.min(size - start, MAX_SHIP_BYTES);
    if (readLen > 0) {
      let fd;
      try {
        fd = fs.openSync(transcriptPath, "r");
        buf = Buffer.alloc(readLen);
        const bytesRead = fs.readSync(fd, buf, 0, readLen, start);
        // Defensive: a short read (concurrent truncate) — only trust what we got.
        if (bytesRead < readLen) buf = buf.subarray(0, bytesRead);
      } catch {
        logSidecar(dataDir, sessionId, "skip: transcript read failed");
        return { posted: false, skipped: "no-transcript" };
      } finally {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {
            /* ignore */
          }
        }
      }
    }

    // BYTE-ACCURATE LINE BOUNDARY. Find the last `\n` in the window (byte-exact,
    // not a decoded-string index — UTF-8 multibyte makes string index ≠ byte
    // offset). `consumed` is one past that newline: everything before it is whole
    // JSON lines; a trailing partial line stays unread until it completes (C1).
    const consumed = completeLineBytes(buf);

    // PATHOLOGICAL: a window full of bytes with NO newline is one giant line
    // longer than MAX_SHIP_BYTES (e.g. a single multi-MB turn). We can never ship
    // it (it would exceed the server cap) and waiting forever would livelock. Only
    // when the window is FULL (more bytes remain) do we skip-and-advance past it so
    // the cursor still progresses; if it is the file tail it is just an
    // in-progress write — wait for the `\n`. (I1: never livelock.)
    const windowIsFull = readLen === MAX_SHIP_BYTES && buf.length === MAX_SHIP_BYTES;
    if (consumed === 0 && windowIsFull) {
      logSidecar(
        dataDir,
        sessionId,
        `skip: a single line exceeds MAX_SHIP_BYTES (${MAX_SHIP_BYTES}); advancing past the window to avoid livelock`,
      );
      // Advance past the oversized window; carry private/seq unchanged.
      writeCursor(dataDir, sessionId, {
        offset: start + buf.length,
        seq: prior.seq,
        private: prior.private,
      });
      return { posted: false, skipped: "oversized-line" };
    }

    // The complete-line prefix we will actually parse/ship; the byte offset we
    // advance the cursor TO on a successful ack is `start + consumed` (NOT `size`).
    const completeBytes = buf.subarray(0, consumed);
    const chunk = completeBytes.toString("utf8");
    const nextOffset = start + consumed;

    // PARSE → turns → PRIVATE-SPAN FILTER (forward-only). The cursor advances over
    // the complete-line prefix regardless of whether anything was kept
    // (skip-and-advance, Q6) — but ONLY after a successful ship of the kept turns
    // (or when there is nothing to ship). Private state is carried forward.
    const allTurns = entriesToTurns(parseEntries(chunk));
    const { kept, endPrivate } = filterPrivateSpans(allTurns, { startPrivate: prior.private });

    // Did we read the whole remaining file in this window? If a backlog is still
    // draining we must NOT mark the session `ended` yet — the explicit-end
    // accelerator only applies on the final, file-tail-reaching window.
    const drainedToEof = nextOffset >= size;
    const ended = isSessionEnd(hook) && drainedToEof;

    // Nothing public to ship in this window. Advance the cursor past the complete
    // lines we read (any private turns are now behind it — NEVER retroactively
    // shipped, SC4) and persist the carried private state, then return. A backlog
    // still has more bytes, so the next `Stop` (or this one's siblings) keeps
    // draining. If the conversation ended AND we reached EOF we still want the
    // server to know (a private-only tail shouldn't strand the buffer), so send an
    // ended-only empty delta in that case; otherwise it's a no-op for this window.
    if (kept.length === 0 && !ended) {
      writeCursor(dataDir, sessionId, { offset: nextOffset, seq: prior.seq, private: endPrivate });
      return { posted: false, skipped: "no-new-turns" };
    }

    const seq = prior.seq + 1;
    // Spec 077: label the journal entry with the project — only for a server known to
    // accept the field (the SessionStart probe records that).
    const project = serverSupportsJournal(dataDir) ? deriveProject(hook.cwd) : null;
    const payload = buildPayload({ sessionId, seq, turns: kept, ended, project });

    // SHIP. A non-2xx (`ok:false`) or a thrown network error → DO NOT advance the
    // cursor: the delta re-ships next run (idempotent; server/curator dedup). A
    // 2xx → advance past everything we read (including the private turns we
    // skipped) and persist the new seq + private state.
    let ack;
    try {
      ack = await post(url, payload, token);
    } catch (error) {
      // Transient/infra (Q6 skip-and-retry): log + leave the cursor. Never leak a
      // stack trace into the model context.
      logSidecar(
        dataDir,
        sessionId,
        `ship failed (transient, will retry): ${(error && error.message) || "network error"}`,
      );
      return { posted: false, skipped: "post-failed" };
    }

    if (!ack || !ack.ok) {
      logSidecar(
        dataDir,
        sessionId,
        `ship not acked (status ${ack ? ack.status : "?"}); cursor held, will retry`,
      );
      return { posted: false, skipped: "not-acked", ack };
    }

    // ACKED → advance to the precise complete-line boundary (NOT raw EOF): a
    // trailing partial line stays unread, and a backlog drains over more runs.
    writeCursor(dataDir, sessionId, { offset: nextOffset, seq, private: endPrivate });
    return { posted: true, ack };
  } catch (error) {
    // Last-resort fail-soft: any unexpected error logs to the sidecar and exits a
    // no-op. The cursor is untouched on this path (no writeCursor reached), so the
    // delta re-ships next run.
    logSidecar(
      dataDir,
      sessionId,
      `unexpected error (no-op, fail-soft): ${(error && error.message) || "unknown"}`,
    );
    return { posted: false, skipped: "error" };
  }
}

// Re-export the cursor path helper so the hook entry / diagnostics can locate a
// session's cursor without reaching into cursor.mjs.
export { cursorPath };
