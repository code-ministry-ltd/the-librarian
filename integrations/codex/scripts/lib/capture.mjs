// Codex auto-capture adapter — the orchestrator (testable; the hook entry is a
// thin shell over `runCapture`). Spec 2026-06-16-harness-auto-capture, Phase 2A.
//
// Mirrors the Claude orchestrator (integrations/claude/scripts/lib/capture.mjs):
// since this conversation was last seen, ship the new NON-PRIVATE turns and
// advance the cursor ONLY on a server ack. Everything is fail-soft — every path
// resolves, never throws; an error logs to the sidecar and the cursor stays put
// so the delta re-ships next run (idempotent; server/curator dedup).
//
// Codex-specific differences from the Claude orchestrator:
//   1. conv_id is DERIVED (transcript.deriveConvId): a stable hook `session_id`,
//      else the transcript filename stem + a short hash of the FULL path (so two
//      same-basename transcripts in different dirs can't collide — SC5), else NULL
//      → clean no-op. NEVER $USER/cwd
//      (spec §4.11) — mem0's Codex scripts key by `$USER`, the collision bug we
//      explicitly avoid. The cursor + server buffer are keyed by this conv_id.
//   2. The `LIBRARIAN_AUTO_SAVE=false` per-machine kill-switch is enforced HERE
//      as a hard gate (ship nothing, buffer nothing — slash-commands.md contract).
//      Codex has no SessionStart awareness banner in the mem0-style wiring, so the
//      kill-switch is honored in the capture path itself, not just surfaced.
//
// Codex 0.144.3 live capture confirmed the hook supplies the stable session id
// and rollout transcript path this orchestrator needs. The native rollout record
// shape and its deliberately asymmetric user/assistant parsing are documented in
// transcript.mjs. Every boundary remains fail-soft because future Codex releases
// may add records or fields; an unknown or malformed record holds the byte cursor
// instead of silently consuming data. Legacy cursors are upgraded by locally
// replaying their consumed prefix only to reconstruct private-mode state.
//
// The network `post` is INJECTED so the orchestration is unit-testable without a
// socket; the hook entry passes the real `postDelta`.

import fs from "node:fs";
import path from "node:path";
import { CURSOR_VERSION, cursorPath, readCursor, writeCursor } from "./cursor.mjs";
import { deriveProject, serverSupportsJournal } from "./journal.mjs";
import { deriveTranscriptUrl, postDelta } from "./post.mjs";
import {
  buildPayload,
  completeLineBytes,
  deriveConvId,
  entriesToTurns,
  filterPrivateSpans,
  hasOnlySupportedCodexEntries,
  parseCompleteEntries,
} from "./transcript.mjs";

// Per-run client ship cap. The cursor advances at most this many bytes per hook,
// to a precise LINE boundary inside the window: (1) a first capture of a multi-MB
// session must NOT POST a body over the server's maxBodyBytes (1 MiB default) — a
// 413 would hold the cursor and re-ship forever (livelock); (2) a large backlog
// drains over multiple hook firings, a bounded chunk each run.
const MAX_SHIP_BYTES = 256 * 1024; // 256 KiB — safely under the 1 MiB server cap
// A single native JSONL record may exceed the normal window. Extend far enough to
// capture ordinary large prompts while retaining payload headroom under the
// server's 1 MiB default. Anything larger is HELD, never skipped or advanced.
const MAX_SINGLE_RECORD_BYTES = 768 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Resolve the plugin data dir (cursor + sidecar-log home):
 * `${CODEX_PLUGIN_DATA:-$HOME/.librarian/codex-plugin-data}`.
 */
export function resolveDataDir(env) {
  const explicit = env.CODEX_PLUGIN_DATA;
  if (explicit && explicit.trim()) return explicit;
  const home = env.HOME || env.USERPROFILE || ".";
  return path.join(home, ".librarian", "codex-plugin-data");
}

/**
 * Is the local auto-save kill-switch OFF? True ONLY for the exact string "false"
 * (case-insensitive); anything else (unset, "", "true", …) is default-ON
 * (slash-commands.md "two gates"). Pure + total.
 */
export function isAutoSaveOff(env) {
  const v = env && env.LIBRARIAN_AUTO_SAVE;
  return typeof v === "string" && v.trim().toLowerCase() === "false";
}

/**
 * Append a one-line skip/error record to the local sidecar log (fail-soft, never
 * a stack trace into the model's context). Best-effort. NEVER logs turn text or
 * the token.
 */
function logSidecar(dataDir, convId, message) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const line = `${new Date().toISOString()} [${convId ?? "?"}] ${message}\n`;
    fs.appendFileSync(path.join(dataDir, "capture.log"), line, "utf8");
  } catch {
    // last-resort: drop it. A log failure must never break the hook.
  }
}

/** Read exactly one bounded region (or fewer bytes at EOF) from an open file. */
function readAt(fd, position, length) {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(length);
  const bytesRead = fs.readSync(fd, buf, 0, length, position);
  return bytesRead === length ? buf : buf.subarray(0, bytesRead);
}

/**
 * Read the normal bounded window, but extend when its FIRST record alone exceeds
 * 256 KiB. A record over MAX_SINGLE_RECORD_BYTES is returned as `oversized:true`
 * with the cursor untouched; a compatible future transport can retry it.
 */
function readCaptureWindow(transcriptPath, start, size) {
  if (start >= size) return { buf: Buffer.alloc(0), oversized: false };
  const fd = fs.openSync(transcriptPath, "r");
  try {
    let buf = readAt(fd, start, Math.min(size - start, MAX_SHIP_BYTES));
    if (completeLineBytes(buf) > 0 || buf.length < MAX_SHIP_BYTES) {
      return { buf, oversized: false };
    }

    while (
      completeLineBytes(buf) === 0 &&
      start + buf.length < size &&
      buf.length < MAX_SINGLE_RECORD_BYTES
    ) {
      const more = readAt(
        fd,
        start + buf.length,
        Math.min(
          READ_CHUNK_BYTES,
          size - (start + buf.length),
          MAX_SINGLE_RECORD_BYTES - buf.length,
        ),
      );
      if (more.length === 0) break;
      buf = Buffer.concat([buf, more]);
    }

    const oversized =
      completeLineBytes(buf) === 0 &&
      buf.length >= MAX_SINGLE_RECORD_BYTES &&
      start + buf.length < size;
    return { buf, oversized };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Legacy v1 cursors may point into the middle of a record because the old
 * oversized-line path advanced a raw 256 KiB window. Move only FORWARD to the
 * next complete-line boundary so migration never uploads already-consumed bytes.
 */
function legacyBoundaryAtOrAfter(transcriptPath, offset, size) {
  if (offset === 0) return 0;
  if (offset > size) return 0; // transcript rotated/reused: treat it as a new file

  const fd = fs.openSync(transcriptPath, "r");
  try {
    const previous = readAt(fd, offset - 1, 1);
    if (previous.length === 1 && previous[0] === 0x0a) return offset;

    let position = offset;
    while (position < size) {
      const chunk = readAt(fd, position, Math.min(READ_CHUNK_BYTES, size - position));
      if (chunk.length === 0) break;
      const lf = chunk.indexOf(0x0a);
      if (lf !== -1) return position + lf + 1;
      position += chunk.length;
    }
    return null; // the record is still partial; wait for its terminating newline
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Upgrade a pre-native-parser cursor without uploading its consumed prefix.
 * Locally replay complete native records from byte zero through the old offset
 * solely to reconstruct private-mode state. Unknown/malformed prefix data fails
 * closed: no new transcript bytes are shipped until a compatible adapter exists.
 */
function recoverLegacyCursor(transcriptPath, prior, size) {
  const boundary = legacyBoundaryAtOrAfter(transcriptPath, prior.offset, size);
  if (boundary === null) return null;
  if (boundary === 0) {
    return { offset: 0, seq: prior.seq, private: false, version: CURSOR_VERSION };
  }

  const fd = fs.openSync(transcriptPath, "r");
  let position = 0;
  let pending = Buffer.alloc(0);
  let privateState = false;
  try {
    while (position < boundary) {
      const bytes = readAt(fd, position, Math.min(MAX_SHIP_BYTES, boundary - position));
      if (bytes.length === 0) return null;
      position += bytes.length;
      pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;

      const complete = completeLineBytes(pending);
      if (complete === 0) continue;
      const { entries, invalidLines } = parseCompleteEntries(
        pending.subarray(0, complete).toString("utf8"),
      );
      if (invalidLines > 0 || (entries.length > 0 && !hasOnlySupportedCodexEntries(entries))) {
        return null;
      }
      privateState = filterPrivateSpans(entriesToTurns(entries), {
        startPrivate: privateState,
      }).endPrivate;
      pending = pending.subarray(complete);
    }
  } finally {
    fs.closeSync(fd);
  }

  if (pending.length > 0) return null;
  return {
    offset: boundary,
    seq: prior.seq,
    private: privateState,
    version: CURSOR_VERSION,
  };
}

/**
 * Is this the end of the conversation (vs a mid-conversation turn)? A true end
 * (close / `/clear`) surfaces as a `SessionEnd` event name — treat that as the
 * explicit-end accelerator (`ended:true`). Absent it, `ended` is omitted and the
 * server's idle settle-sweep handles timing. Defensive across the exact field name.
 */
function isSessionEnd(hook) {
  const name = hook.hook_event_name || hook.hookEventName;
  return name === "SessionEnd";
}

/**
 * Run one capture pass for a Codex hook invocation.
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

  // conv_id FIRST — it keys the cursor + the server buffer, and a missing id is a
  // clean no-op (NEVER cwd/$USER). Resolved before any state is touched.
  const convId = deriveConvId(hook);

  // SUBAGENT SKIP: an `agent_id`-present hook is a subagent's; only the top-level
  // conversation is captured. No-op, no cursor touched (mirrors mem0's on_stop).
  if (hook.agent_id) {
    return { posted: false, skipped: "subagent" };
  }

  // KILL-SWITCH (slash-commands.md, SC4): LIBRARIAN_AUTO_SAVE=false ships nothing
  // and buffers nothing on this machine. Hard gate — checked before any IO so a
  // disabled machine never reads a transcript or writes a cursor.
  if (isAutoSaveOff(env)) {
    return { posted: false, skipped: "auto-save-off" };
  }

  try {
    if (!convId) {
      logSidecar(dataDir, convId, "skip: no stable conv_id (no session_id / transcript_path)");
      return { posted: false, skipped: "no-conv-id" };
    }

    // CONFIG (fail-soft): without a URL + token there is nowhere to ship — a clean
    // no-op, cursor untouched, re-ships once configured.
    const url = deriveTranscriptUrl(env.LIBRARIAN_MCP_URL);
    const token = env.LIBRARIAN_AGENT_TOKEN;
    if (!url || !token) {
      logSidecar(dataDir, convId, "skip: LIBRARIAN_MCP_URL / LIBRARIAN_AGENT_TOKEN not set");
      return { posted: false, skipped: "not-configured" };
    }

    const transcriptPath = hook.transcript_path;
    if (!transcriptPath) {
      logSidecar(dataDir, convId, "skip: no transcript_path on hook input");
      return { posted: false, skipped: "no-transcript" };
    }

    let size;
    try {
      size = fs.statSync(transcriptPath).size;
    } catch {
      logSidecar(dataDir, convId, "skip: transcript_path unreadable (stat failed)");
      return { posted: false, skipped: "no-transcript" };
    }

    let prior = readCursor(dataDir, convId);
    if (prior.version > CURSOR_VERSION) {
      logSidecar(
        dataDir,
        convId,
        `skip: cursor version ${prior.version} is newer than adapter version ${CURSOR_VERSION}`,
      );
      return { posted: false, skipped: "newer-cursor-version" };
    }
    if (prior.version < CURSOR_VERSION) {
      const recovered = recoverLegacyCursor(transcriptPath, prior, size);
      if (!recovered) {
        logSidecar(
          dataDir,
          convId,
          "skip: legacy cursor private-state recovery is waiting for compatible complete records",
        );
        return { posted: false, skipped: "legacy-cursor-recovery-pending" };
      }
      prior = recovered;
      writeCursor(dataDir, convId, recovered);
    }

    // The transcript is append-only. If it shrank (rotation / a reused id), the
    // offset is stale — restart from 0 (re-ship is safe).
    const start = prior.offset <= size ? prior.offset : 0;

    // READ A BOUNDED COMPLETE-LINE WINDOW. A first record may extend beyond the
    // normal 256 KiB batch, but a record beyond the safe single-record ceiling is
    // held in place rather than skipped.
    let window;
    try {
      window = readCaptureWindow(transcriptPath, start, size);
    } catch {
      logSidecar(dataDir, convId, "skip: transcript read failed");
      return { posted: false, skipped: "no-transcript" };
    }
    const { buf } = window;
    if (window.oversized) {
      logSidecar(
        dataDir,
        convId,
        `skip: a single Codex record exceeds ${MAX_SINGLE_RECORD_BYTES} bytes; cursor held`,
      );
      return { posted: false, skipped: "oversized-record" };
    }

    // BYTE-ACCURATE LINE BOUNDARY. `consumed` is one past the last `\n`: everything
    // before it is whole JSON lines; a trailing partial line stays unread.
    const consumed = completeLineBytes(buf);

    const completeBytes = buf.subarray(0, consumed);
    const chunk = completeBytes.toString("utf8");
    const nextOffset = start + consumed;

    // PARSE → turns → PRIVATE-SPAN FILTER (forward-only). The cursor advances over
    // the complete-line prefix regardless of whether anything was kept — but ONLY
    // after a successful ship of the kept turns (or when nothing is to ship).
    const { entries, invalidLines } = parseCompleteEntries(chunk);
    // An invalid complete line or an unsupported native discriminator must not be
    // treated as "nothing to ship": doing so advances the byte cursor and
    // permanently loses its prose.
    // Hold the cursor and fail soft so an updated adapter can retry it. Native
    // metadata/tool-only chunks still advance because they contain recognized
    // top-level Codex record types even when they yield zero visible turns.
    if (invalidLines > 0 || (entries.length > 0 && !hasOnlySupportedCodexEntries(entries))) {
      logSidecar(
        dataDir,
        convId,
        "skip: unrecognized Codex transcript schema; cursor held for a compatible adapter",
      );
      return { posted: false, skipped: "unknown-transcript-format" };
    }

    const allTurns = entriesToTurns(entries);
    const { kept, endPrivate } = filterPrivateSpans(allTurns, { startPrivate: prior.private });

    // Only the FINAL, file-tail-reaching window can mark the conversation `ended`.
    const drainedToEof = nextOffset >= size;
    const ended = isSessionEnd(hook) && drainedToEof;

    // Nothing public to ship in this window. Advance the cursor past the complete
    // lines we read (private turns now behind it — NEVER retroactively shipped) and
    // persist the carried private state. If the conversation ended AND we reached
    // EOF, still send an ended-only empty delta so a private-only tail doesn't
    // strand the buffer; otherwise it's a no-op for this window.
    if (kept.length === 0 && !ended) {
      writeCursor(dataDir, convId, { offset: nextOffset, seq: prior.seq, private: endPrivate });
      return { posted: false, skipped: "no-new-turns" };
    }

    const seq = prior.seq + 1;
    // Spec 078: label the journal entry with the project — only for a server known to
    // accept the field (the SessionStart probe recorded it); older servers reject it.
    const project = serverSupportsJournal(dataDir) ? deriveProject(hook.cwd) : null;
    const payload = buildPayload({ convId, seq, turns: kept, ended, project });

    // SHIP. A non-2xx (`ok:false`) or a thrown network error → DO NOT advance the
    // cursor: the delta re-ships next run (idempotent; server/curator dedup). A
    // 2xx → advance past everything we read and persist the new seq + private state.
    let ack;
    try {
      ack = await post(url, payload, token);
    } catch (error) {
      logSidecar(
        dataDir,
        convId,
        `ship failed (transient, will retry): ${(error && error.message) || "network error"}`,
      );
      return { posted: false, skipped: "post-failed" };
    }

    if (!ack || !ack.ok) {
      logSidecar(
        dataDir,
        convId,
        `ship not acked (status ${ack ? ack.status : "?"}); cursor held, will retry`,
      );
      return { posted: false, skipped: "not-acked", ack };
    }

    // ACKED → advance to the precise complete-line boundary (NOT raw EOF): a
    // trailing partial line stays unread, and a backlog drains over more runs.
    writeCursor(dataDir, convId, { offset: nextOffset, seq, private: endPrivate });
    return { posted: true, ack };
  } catch (error) {
    // Last-resort fail-soft: any unexpected error logs to the sidecar and exits a
    // no-op. The cursor is untouched on this path, so the delta re-ships next run.
    logSidecar(
      dataDir,
      convId,
      `unexpected error (no-op, fail-soft): ${(error && error.message) || "unknown"}`,
    );
    return { posted: false, skipped: "error" };
  }
}

// Re-export the cursor path helper so the hook entry / diagnostics can locate a
// conversation's cursor without reaching into cursor.mjs.
export { cursorPath };
