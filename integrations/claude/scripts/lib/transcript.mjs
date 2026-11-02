// Claude `Stop` adapter — transcript parsing + filtering (pure, testable).
// Spec 2026-06-16-harness-auto-capture, T3.
//
// Node stdlib only (no deps). This module owns the pure data transforms that the
// `Stop` hook drives: cursor-sliced JSONL → typed entries → user/assistant turns
// → private-span filter → the uniform delta payload. Nothing here does IO or
// network — the orchestrator (capture.mjs) wires those in so this stays trivially
// unit-testable and fail-soft (a malformed line is skipped, never thrown).
//
// The JSONL shape is the §6 live-confirmed Claude transcript: append-only, one
// complete JSON object per line, top-level `type` + `message.{role,content}`,
// per-entry `timestamp`/`cwd`/`gitBranch`/`isSidechain`/`sessionId`. Assistant
// content is an array of blocks (`text`/`thinking`/`tool_use`); user content is
// a string OR an array (e.g. `tool_result`). We capture prose only.

/** The private-mode markers (AGENTS.md: never bypass private mode). */
export const PRIVATE_ON = "[librarian:private=on]";
export const PRIVATE_OFF = "[librarian:private=off]";

/** ASCII line feed — the JSONL record separator (one complete JSON object/line). */
const LF = 0x0a;

/**
 * Find the byte offset just past the LAST complete line in a window Buffer —
 * i.e. one past the final `\n`. This is the precise, BOUNDED boundary the cursor
 * advances to (C1/I1): everything before it is whole, parseable lines; a trailing
 * partial line (a `Stop` firing mid-write) stays UNREAD until it completes next
 * run, so a completed-but-half-flushed line is never lost.
 *
 * Operates on the BYTE buffer (not the decoded string) so the returned count is a
 * true byte offset: a UTF-8 multibyte turn (emoji/unicode) makes a string index ≠
 * a byte offset, and the cursor is measured in bytes.
 *
 * Returns 0 when the window holds NO `\n` (one giant unterminated line — a
 * pathological single record longer than the read window). The caller treats a 0
 * here as "no complete line in this window" and decides whether to wait or
 * skip-and-advance past the window so the cursor can never livelock.
 *
 * @param {Buffer} buf - the bytes read from the cursor (a bounded window).
 * @returns {number} byte count of the complete-line prefix (one past the last \n),
 *          or 0 if there is no \n in the window.
 */
export function completeLineBytes(buf) {
  if (!buf || buf.length === 0) return 0;
  const lastLf = buf.lastIndexOf(LF);
  return lastLf === -1 ? 0 : lastLf + 1;
}

/**
 * Parse a chunk of append-only JSONL into entry objects. Forward-only and
 * fail-soft: a blank line or a partially-written trailing line (a mid-flush
 * Stop) is silently skipped rather than thrown — we get it next run once it is
 * complete (the cursor only advances over what we actually shipped).
 *
 * @param {string} chunk - raw text sliced from the cursor offset to EOF.
 * @returns {Array<Record<string, unknown>>} parsed entries, in file order.
 */
export function parseEntries(chunk) {
  const entries = [];
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Partial/last line mid-write, or corrupt — skip it. Forward-only: a real
      // line completes on a later run.
    }
  }
  return entries;
}

/**
 * Flatten an assistant content array to its prose, dropping `thinking`,
 * `tool_use`, and any non-text block. Thinking is private reasoning and tool_use
 * is machine plumbing — neither is durable conversational fact.
 */
function assistantText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Extract real user prose. A string is the prompt. An array is tool plumbing
 * (`tool_result`) — not user text — so it yields nothing.
 */
function userText(content) {
  if (typeof content === "string") return content.trim();
  // Arrays are tool_result / attachment plumbing, not prose.
  return "";
}

/**
 * Map parsed JSONL entries to user/assistant turns. Ignores everything that is
 * not a top-level conversational message:
 *   - non-message types (`mode`, `system`, `file-history-snapshot`, …)
 *   - sidechain/subagent entries (`isSidechain:true`) — defense in depth even
 *     though we only ever read the top-level `<session_id>.jsonl` (§6)
 *   - meta entries (`isMeta:true`, e.g. the local-command caveat banner)
 *   - empty-after-extraction turns (a tool-only assistant step, a tool_result
 *     user step)
 *
 * @returns {Array<{role:"user"|"assistant", text:string, ts?:string}>}
 */
export function entriesToTurns(entries) {
  const turns = [];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    if (e.isSidechain === true) continue;
    if (e.isMeta === true) continue;
    const type = e.type;
    if (type !== "user" && type !== "assistant") continue;
    const message = e.message;
    if (!message || typeof message !== "object") continue;
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = role === "user" ? userText(message.content) : assistantText(message.content);
    if (!text) continue;

    const turn = { role, text };
    if (typeof e.timestamp === "string") turn.ts = e.timestamp;
    turns.push(turn);
  }
  return turns;
}

/**
 * Per-turn private-span filter (Q4/Q6). Tracks the `[private=on]/[private=off]`
 * marker state across turns AND across runs (via `startPrivate`). Any turn while
 * the span is open is SKIPPED; the marker-toggle turns themselves are skipped
 * too (they carry no durable fact). Forward-only: the caller advances the cursor
 * past skipped turns so a private turn is NEVER retroactively shipped.
 *
 * Toggle semantics within a single turn's text: an `=off` anywhere closes the
 * span (turn still skipped, it is the boundary), an `=on` opens it. If both
 * appear we honor the LAST occurrence so a turn that re-opens privacy stays
 * private into the next turn.
 *
 * @param {Array<{role:string,text:string,ts?:string}>} turns
 * @param {{startPrivate:boolean}} opts - whether the previous run left an open span.
 * @returns {{kept:Array, endPrivate:boolean}} - the non-private turns + the
 *          span state to persist for the next run.
 */
export function filterPrivateSpans(turns, { startPrivate }) {
  let priv = Boolean(startPrivate);
  const kept = [];
  for (const turn of turns) {
    const text = turn.text;
    const hasOn = text.includes(PRIVATE_ON);
    const hasOff = text.includes(PRIVATE_OFF);
    const isMarkerTurn = hasOn || hasOff;

    // Resolve the new state from this turn's last-occurring marker.
    if (hasOn || hasOff) {
      const onAt = hasOn ? text.lastIndexOf(PRIVATE_ON) : -1;
      const offAt = hasOff ? text.lastIndexOf(PRIVATE_OFF) : -1;
      priv = onAt > offAt;
    }

    // Skip the turn if we are (or just entered) a private span, OR it is itself a
    // marker turn (boundary turns carry no durable fact and may contain the
    // private text alongside the marker).
    if (priv || isMarkerTurn) continue;
    kept.push(turn);
  }
  return { kept, endPrivate: priv };
}

/**
 * Build the uniform, harness-agnostic delta payload the server contract expects:
 * `{ conv_id, harness:"claude", seq, turns[], ended?, project? }`. `ended` is omitted unless
 * true (the server treats its mere presence as the explicit-end accelerator).
 */
export function buildPayload({ sessionId, seq, turns, ended, project }) {
  /** @type {Record<string, unknown>} */
  const payload = {
    conv_id: sessionId,
    harness: "claude",
    seq,
    turns,
  };
  if (ended) payload.ended = true;
  // Spec 077: the journal's project label. The caller sets it only for a server whose
  // /healthz advertises `journal` — older servers reject unknown keys.
  if (project) payload.project = project;
  return payload;
}
