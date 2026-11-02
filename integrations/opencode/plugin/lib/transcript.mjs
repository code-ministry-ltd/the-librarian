// OpenCode auto-capture adapter — message-list parsing + private filtering +
// conv_id derivation (pure, testable). Spec 2026-06-16-harness-auto-capture,
// Phase 2A (OpenCode).
//
// Node stdlib only — NO `@opencode-ai/*` import — so this module is directly
// unit-testable by vitest without the OpenCode runtime (mirrors the Codex
// adapter's dependency-free `.mjs` lib tree). The OpenCode-specific glue (the
// `chat.message` hook + the SDK `client.session.messages(...)` read) lives in the
// plugin entry (../librarian-capture.ts); this module is fed the already-fetched
// message list and turns it into the uniform `/transcript` delta.
//
// CONFIRMED `@opencode-ai/plugin` / `@opencode-ai/sdk` shape (SP-OpenCode): the
// session message list is `{ info: Message; parts: Part[] }[]`. `info.role` is
// "user" | "assistant"; `info.time.created` is epoch-ms. A `TextPart` is
// `{ type:"text", text, synthetic? }`. We capture PROSE only — real text parts —
// and drop `synthetic` (injected context), `reasoning`, `tool`, and every other
// non-text part (machine plumbing / private reasoning, not durable conversational
// fact). This mirrors mem0's `extractUserText` (`p.type==="text" && !p.synthetic`)
// but reads BOTH roles off the whole message list rather than only the user side.

/** The private-mode markers (AGENTS.md: never bypass private mode). */
export const PRIVATE_ON = "[librarian:private=on]";
export const PRIVATE_OFF = "[librarian:private=off]";

/**
 * Derive the stable conv_id for a `chat.message` fire. Capture keys ALL
 * per-conversation state (the in-memory cursor + the server buffer) by this id,
 * so it MUST be stable per conversation and MUST NOT collide across concurrent
 * same-machine sessions (spec §4.11). OpenCode hands us `input.sessionID` — a
 * stable per-conversation id, confirmed by the typed `chat.message` hook surface.
 * We use it and ONLY it: never `$USER` or `cwd`. mem0's OpenCode plugin keys
 * memories by `$USER`/`app_id` (and its Codex scripts fall back to
 * `default_${USER}`) — exactly the collision bug we avoid (two concurrent
 * same-machine OpenCode sessions would share a conv_id and cross-contaminate).
 *
 * @param {{sessionID?:string}} input - the `chat.message` hook input.
 * @returns {string|null} the trimmed sessionID, or null → caller no-ops.
 */
export function deriveConvId(input) {
  const sid = input && typeof input.sessionID === "string" ? input.sessionID.trim() : "";
  return sid || null;
}

/**
 * Flatten one message's parts to its prose. Keeps only real (`type:"text"`,
 * non-`synthetic`) parts; drops reasoning, tool, file, step, and every other
 * part type. Returns "" when the message carries no durable prose.
 */
function messageText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter(
      (p) =>
        p &&
        typeof p === "object" &&
        p.type === "text" &&
        p.synthetic !== true &&
        typeof p.text === "string",
    )
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/**
 * Map an OpenCode session message list (`{ info: Message; parts: Part[] }[]`) to
 * ordered user/assistant turns. Fail-soft + forward-only: a null/garbage list, a
 * message without a recognised role, or a message with no prose after extraction
 * (a tool-only assistant step) yields nothing rather than throwing — so a shape
 * the live API diverges on degrades to a clean no-op, never a plugin crash.
 *
 * @param {Array<{info?:{role?:string,time?:{created?:number}},parts?:unknown[]}>} messages
 * @returns {Array<{role:"user"|"assistant", text:string, ts?:string}>}
 */
export function messagesToTurns(messages) {
  if (!Array.isArray(messages)) return [];
  const turns = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const info = m.info;
    if (!info || typeof info !== "object") continue;
    const role = info.role;
    if (role !== "user" && role !== "assistant") continue;
    // OpenCode's compaction writes its recap of the conversation so far as an
    // assistant message flagged `summary: true` (@opencode-ai/sdk AssistantMessage).
    // Capturing it would re-feed everything it summarises to intake and the journal.
    if (info.summary === true) continue;

    const text = messageText(m.parts);
    if (!text) continue;

    const turn = { role, text };
    // `time.created` is epoch-ms; normalise to the ISO-8601 string the
    // /transcript contract's optional `ts` expects.
    const created = info.time && typeof info.time.created === "number" ? info.time.created : null;
    if (created !== null) turn.ts = new Date(created).toISOString();
    turns.push(turn);
  }
  return turns;
}

/**
 * Per-turn private-span filter. Tracks the `[private=on]/[private=off]` marker
 * state across turns AND across `chat.message` fires (via `startPrivate`). Any
 * turn while the span is open is SKIPPED; the marker-toggle turns are skipped too.
 * Forward-only: the caller advances the cursor past skipped turns so a private
 * turn is NEVER retroactively shipped. Within one turn the LAST-occurring marker
 * wins.
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
 * `{ conv_id, harness:"opencode", seq, turns[], ended?, project? }`. `ended` is
 * omitted unless true (the server treats its mere presence as the explicit-end
 * accelerator). `project` (spec 078) is the journal's project label; the caller sets
 * it only for a server whose /healthz advertises `journal`.
 */
export function buildPayload({ convId, seq, turns, ended, project }) {
  /** @type {Record<string, unknown>} */
  const payload = {
    conv_id: convId,
    harness: "opencode",
    seq,
    turns,
  };
  if (ended) payload.ended = true;
  if (project) payload.project = project;
  return payload;
}
