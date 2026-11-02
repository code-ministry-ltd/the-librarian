// Codex auto-capture adapter — transcript parsing + filtering + conv_id
// derivation (pure, testable). Node stdlib only.
//
// Codex's native rollout JSONL shape was confirmed against Codex 0.144.3 session
// files. Visible user prose has two adjacent representations: a model-facing
// `response_item/message` (which can also carry injected context) followed by the
// canonical `event_msg/user_message`. Visible assistant prose similarly has an
// `event_msg/agent_message` display event followed by the canonical
// `response_item/message` with `output_text` blocks. We deliberately consume ONE
// representation of each role: user event messages + assistant response items.
// That excludes injected developer/context messages and avoids double capture.

import { createHash } from "node:crypto";

/** The private-mode markers (AGENTS.md: never bypass private mode). */
export const PRIVATE_ON = "[librarian:private=on]";
export const PRIVATE_OFF = "[librarian:private=off]";

/** ASCII line feed — the JSONL record separator (one complete JSON object/line). */
const LF = 0x0a;

/** Non-conversational top-level records that are safe to drain as-is. */
const CODEX_METADATA_RECORD_TYPES = new Set([
  "session_meta",
  "world_state",
  "turn_context",
  "inter_agent_communication_metadata",
  "compacted",
]);

/** Event payload variants observed in Codex 0.144.3 rollout JSONL. */
const CODEX_EVENT_TYPES = new Set([
  "agent_message",
  "agent_reasoning",
  "context_compacted",
  "mcp_tool_call_end",
  "patch_apply_end",
  "sub_agent_activity",
  "task_complete",
  "task_started",
  "thread_goal_updated",
  "thread_settings_applied",
  "token_count",
  "turn_aborted",
  "user_message",
  "web_search_end",
]);

/** Non-message response-item variants that carry reasoning/tool plumbing. */
const CODEX_NON_MESSAGE_RESPONSE_TYPES = new Set([
  "agent_message",
  "custom_tool_call",
  "custom_tool_call_output",
  "function_call",
  "function_call_output",
  "reasoning",
  "tool_search_call",
  "tool_search_output",
]);

/**
 * Derive the stable conv_id for this Codex hook invocation. Capture keys ALL
 * per-conversation state (cursor, server buffer) by this id, so it MUST be stable
 * per conversation and MUST NOT collide across concurrent same-machine runs
 * (spec §4.11). The fallback chain degrades gracefully but NEVER reaches for
 * `$USER` or `cwd` — mem0's Codex scripts fall back to `/tmp/..._${USER}` /
 * `default_${USER}`, which is exactly the collision bug we avoid (two concurrent
 * Codex runs by one user, or two convs in one cwd, would share a conv_id and
 * cross-contaminate deltas).
 *
 * Chain:
 *   1. `session_id` — the hook's stable per-run id (preferred). mem0 confirms the
 *      Codex hook input carries `session_id`.
 *   2. `${stem}-${hash8}` — the transcript FILENAME stem (basename sans extension)
 *      combined with a short stable hash of the FULL normalized `transcript_path`.
 *      The hash is the discriminator: two concurrent runs whose transcript files
 *      share a basename in DIFFERENT directories (e.g. `…/projA/rollout.jsonl` and
 *      `…/projB/rollout.jsonl`) would otherwise BOTH derive `rollout` and collapse
 *      onto one cursor file AND one server buffer, cross-contaminating deltas (the
 *      exact SC5 collision). Folding the full path into the id keeps it stable per
 *      transcript yet distinct across dirs; the legible stem prefix keeps it
 *      debuggable rather than an opaque hash.
 *   3. null — caller fails soft to a clean no-op (NEVER cwd/$USER).
 *
 * @param {{session_id?:string, transcript_path?:string}} hook
 * @returns {string|null}
 */
export function deriveConvId(hook) {
  const sid = hook && typeof hook.session_id === "string" ? hook.session_id.trim() : "";
  if (sid) return sid;
  const tp = hook && typeof hook.transcript_path === "string" ? hook.transcript_path.trim() : "";
  if (tp) {
    // Basename without directory or extension. Forward AND back slashes so a
    // Windows-style path still reduces to a single segment.
    const base = tp.split(/[\\/]/).pop() || "";
    const stem = base.replace(/\.[^.]+$/, "");
    if (stem) {
      // Discriminate by the FULL path so two same-basename paths in different dirs
      // can't collapse. Short stable hash (8 hex of sha256), legible stem prefix.
      const hash8 = createHash("sha256").update(tp).digest("hex").slice(0, 8);
      return `${stem}-${hash8}`;
    }
  }
  // No stable id available — DO NOT key by cwd/$USER. The caller no-ops.
  return null;
}

/**
 * Find the byte offset just past the LAST complete line in a window Buffer (one
 * past the final `\n`). This is the precise, bounded boundary the cursor advances
 * to: everything before it is whole, parseable JSONL; a trailing partial line (a
 * hook firing mid-write) stays UNREAD until it completes. Operates on the BYTE
 * buffer so the count is a true byte offset under UTF-8 multibyte. Returns 0 when
 * the window holds no `\n`.
 *
 * @param {Buffer} buf
 * @returns {number}
 */
export function completeLineBytes(buf) {
  if (!buf || buf.length === 0) return 0;
  const lastLf = buf.lastIndexOf(LF);
  return lastLf === -1 ? 0 : lastLf + 1;
}

/**
 * Parse a chunk of append-only JSONL into entry objects. Forward-only + fail-soft:
 * a blank or partially-written trailing line is silently skipped, never thrown
 * (we get it next run once complete).
 *
 * @param {string} chunk
 * @returns {Array<Record<string, unknown>>}
 */
export function parseCompleteEntries(chunk) {
  const entries = [];
  let invalidLines = 0;
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      invalidLines += 1;
    }
  }
  return { entries, invalidLines };
}

/**
 * Backward-compatible fail-soft parser for pure callers/tests that may include a
 * trailing partial line. Capture itself passes only complete-line chunks and uses
 * `parseCompleteEntries` so a malformed complete record can hold its cursor.
 */
export function parseEntries(chunk) {
  return parseCompleteEntries(chunk).entries;
}

/**
 * Flatten a Codex assistant response item's visible prose. Only `output_text`
 * blocks are user-visible assistant messages; reasoning, tool calls/results, and
 * every other response item stay out of automatic capture.
 */
function assistantText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b) => b && typeof b === "object" && b.type === "output_text" && typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** Extract the canonical visible user message from a Codex event payload. */
function userText(payload) {
  return typeof payload.message === "string" ? payload.message.trim() : "";
}

/**
 * Does a parsed chunk contain at least one native Codex rollout record? Capture
 * uses this to distinguish a legitimate tool/metadata-only chunk (safe to
 * consume) from a valid-JSON but unknown transcript schema (hold the cursor so a
 * future compatible adapter can retry it instead of silently losing prose).
 */
export function hasOnlySupportedCodexEntries(entries) {
  return entries.length > 0 && entries.every(isSupportedCodexEntry);
}

function isSupportedCodexEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (CODEX_METADATA_RECORD_TYPES.has(entry.type)) return true;

  const payload = entry.payload;
  if (!payload || typeof payload !== "object") return false;

  if (entry.type === "event_msg") {
    if (!CODEX_EVENT_TYPES.has(payload.type)) return false;
    if (payload.type === "user_message" || payload.type === "agent_message") {
      return typeof payload.message === "string";
    }
    return true;
  }

  if (entry.type !== "response_item") return false;
  if (CODEX_NON_MESSAGE_RESPONSE_TYPES.has(payload.type)) return true;
  if (payload.type !== "message" || !Array.isArray(payload.content)) return false;

  const expectedBlockType =
    payload.role === "assistant"
      ? "output_text"
      : payload.role === "user" || payload.role === "developer"
        ? "input_text"
        : null;
  if (!expectedBlockType) return false;
  return payload.content.every(
    (block) =>
      block &&
      typeof block === "object" &&
      block.type === expectedBlockType &&
      typeof block.text === "string",
  );
}

/**
 * Map native Codex rollout records to visible user/assistant turns. Consume only
 * the canonical representation for each role so adjacent display/model copies do
 * not duplicate a turn:
 *   - user: `event_msg` → `payload.type:"user_message"` → `payload.message`
 *   - assistant: `response_item` → `payload.type:"message"`, role assistant →
 *     `payload.content[].type:"output_text"`
 *
 * @returns {Array<{role:"user"|"assistant", text:string, ts?:string}>}
 */
export function entriesToTurns(entries) {
  const turns = [];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const payload = e.payload;
    if (!payload || typeof payload !== "object") continue;

    let role;
    let text;
    if (e.type === "event_msg" && payload.type === "user_message") {
      role = "user";
      text = userText(payload);
    } else if (
      e.type === "response_item" &&
      payload.type === "message" &&
      payload.role === "assistant"
    ) {
      role = "assistant";
      text = assistantText(payload.content);
    } else {
      continue;
    }

    if (!text) continue;

    const turn = { role, text };
    if (typeof e.timestamp === "string") turn.ts = e.timestamp;
    turns.push(turn);
  }
  return turns;
}

/**
 * Per-turn private-span filter. Tracks the `[private=on]/[private=off]` marker
 * state across turns AND across runs (via `startPrivate`). Any turn while the span
 * is open is SKIPPED; the marker-toggle turns are skipped too. Forward-only: the
 * caller advances the cursor past skipped turns so a private turn is NEVER
 * retroactively shipped. Within one turn the LAST-occurring marker wins.
 *
 * @param {Array<{role:string,text:string,ts?:string}>} turns
 * @param {{startPrivate:boolean}} opts
 * @returns {{kept:Array, endPrivate:boolean}}
 */
export function filterPrivateSpans(turns, { startPrivate }) {
  let priv = Boolean(startPrivate);
  const kept = [];
  for (const turn of turns) {
    const text = turn.text;
    const hasOn = text.includes(PRIVATE_ON);
    const hasOff = text.includes(PRIVATE_OFF);
    const isMarkerTurn = hasOn || hasOff;

    if (hasOn || hasOff) {
      const onAt = hasOn ? text.lastIndexOf(PRIVATE_ON) : -1;
      const offAt = hasOff ? text.lastIndexOf(PRIVATE_OFF) : -1;
      priv = onAt > offAt;
    }

    if (priv || isMarkerTurn) continue;
    kept.push(turn);
  }
  return { kept, endPrivate: priv };
}

/**
 * Build the uniform, harness-agnostic delta payload the server contract expects:
 * `{ conv_id, harness:"codex", seq, turns[], ended?, project? }`. `ended` is omitted unless
 * true (the server treats its mere presence as the explicit-end accelerator).
 * `project` (spec 078) is the journal's project label; the caller sets it only for a
 * server whose /healthz advertises `journal` — older servers reject unknown keys.
 */
export function buildPayload({ convId, seq, turns, ended, project }) {
  /** @type {Record<string, unknown>} */
  const payload = {
    conv_id: convId,
    harness: "codex",
    seq,
    turns,
  };
  if (ended) payload.ended = true;
  if (project) payload.project = project;
  return payload;
}
