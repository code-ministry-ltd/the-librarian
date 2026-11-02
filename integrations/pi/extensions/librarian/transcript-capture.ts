// Auto-capture pure transforms (no IO, no network) — Phase 2B / T-Pi.
//
// The Pi `agent_end` hook hands the adapter the completed turn's messages
// IN-PAYLOAD (`event.messages: AgentMessage[]`) plus a stable session id from
// `ctx.sessionManager.getSessionId()`. That is the §11.2 expectation: the delta
// is built O(1) from the in-payload turn — there is NO cursor and NO transcript
// re-read (unlike the Claude `Stop` adapter, which byte-slices a JSONL file).
//
// CONFIRMED vs ASSUMED (build-pi-extension + the pinned SDK @0.75.5 types in
// node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts):
//   - CONFIRMED: `agent_end` fires once per user prompt with `messages:
//     AgentMessage[]` (the completed turn in-payload). `AgentMessage = Message |
//     custom`; `Message` (from @earendil-works/pi-ai) is UserMessage /
//     AssistantMessage / ToolResultMessage. UserMessage.content is `string |
//     (TextContent|ImageContent)[]`; AssistantMessage.content is
//     `(TextContent|ThinkingContent|ToolCall)[]`; every message carries a numeric
//     epoch-ms `timestamp`. We capture PROSE ONLY (text blocks), mirroring the
//     Claude adapter — dropping thinking, toolCall, images, and toolResult.
//   - ASSUMED (optimistic, no live `pi` to confirm e2e): that `agent_end` is the
//     right per-turn-end boundary to capture a whole exchange (vs `turn_end`,
//     which fires per LLM-response loop within one prompt and carries only one
//     `message`). The extraction here is structurally defensive: any unexpected
//     shape (a custom message, a non-text block, a missing field) yields a clean
//     skip, NEVER a throw or garbage capture — so a wrong assumption fails SAFE.
//
// This module owns the three pure transforms the hook drives; the orchestrator
// (capture.ts) wires the session state, the network ship, and the env gates
// around them. Everything here is trivially unit-testable and fail-soft.
//
// RUNTIME-IMPORT NOTE: a git/local-installed Pi package is not `npm install`ed,
// so `extensions/` may only value-import `typebox`, `node:` builtins, or relative
// paths (tests/runtime-imports.test.ts pins this). The Pi/AI types below are
// `import type` (erased at runtime); the rest is plain TS over globals.

// The private-mode markers (AGENTS.md: never bypass private mode). Same literals
// the harness toggles in-conversation and the server backstops on intake.
export const PRIVATE_ON = "[librarian:private=on]";
export const PRIVATE_OFF = "[librarian:private=off]";

export const HARNESS = "pi" as const;

/** A single already-non-private turn — the /transcript contract turn shape. */
export interface CaptureTurn {
  role: "user" | "assistant";
  text: string;
  ts?: string;
}

/** The uniform, harness-agnostic delta payload the server contract expects. */
export interface CapturePayload {
  conv_id: string;
  harness: typeof HARNESS;
  seq: number;
  turns: CaptureTurn[];
  ended?: true;
  /** Spec 078: the journal's project label — sent only to a server that accepts it. */
  project?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Flatten an assistant content array to its prose, dropping `thinking`,
 * `toolCall`, and any non-text block. Thinking is private reasoning and toolCall
 * is machine plumbing — neither is durable conversational fact. A plain string
 * (defensive: some message shapes carry a string) is returned as-is.
 */
function assistantText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: "text"; text: string } =>
        isRecord(b) && b.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Extract real user prose. A string is the prompt. An array is content blocks —
 * we keep only `text` blocks (an `image` block is not prose, and a `toolResult`
 * never appears as a user message here).
 */
function userText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: "text"; text: string } =>
        isRecord(b) && b.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Convert a numeric epoch-ms `timestamp` to an ISO-8601 string for the contract
 * `ts` field (which is an optional string). Returns undefined for anything that
 * is not a finite number (so a missing/garbage stamp simply omits `ts`).
 */
function toIsoTs(timestamp: unknown): string | undefined {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return undefined;
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return undefined;
  }
}

/**
 * Map the `agent_end` payload's AgentMessage[] to ordered user/assistant turns.
 * Forward-only and fail-soft: a non-array input, a null/garbage entry, a
 * toolResult message, a custom (roleless) message, or a turn that is empty after
 * prose extraction is silently skipped rather than thrown. We accept `unknown[]`
 * so a wrong-shape payload (the optimistic assumption being off) is a clean
 * no-op, never garbage capture.
 *
 * @param messages - `event.messages` from the `agent_end` hook (the completed turn).
 */
export function messagesToTurns(messages: unknown[]): CaptureTurn[] {
  if (!Array.isArray(messages)) return [];
  const turns: CaptureTurn[] = [];
  for (const m of messages) {
    if (!isRecord(m)) continue;
    const role = m.role;
    // Only top-level conversational messages. `toolResult` is plumbing; a custom
    // AgentMessage has no LLM role at all — both skipped.
    if (role !== "user" && role !== "assistant") continue;

    const text = role === "user" ? userText(m.content) : assistantText(m.content);
    if (!text) continue;

    const turn: CaptureTurn = { role, text };
    const ts = toIsoTs(m.timestamp);
    if (ts) turn.ts = ts;
    turns.push(turn);
  }
  return turns;
}

/**
 * Per-turn private-span filter (mirrors the Claude/Hermes adapters). Tracks the
 * `[private=on]/[private=off]` marker state across the turns in this delta AND
 * across deltas via `startPrivate` (whether the previous delta left an open
 * span). Any turn while the span is open is SKIPPED; the marker-toggle turns
 * themselves are skipped too (they carry no durable fact). Forward-only: the
 * orchestrator advances past skipped turns so a private turn is NEVER
 * retroactively shipped.
 *
 * Within a single turn's text the LAST-occurring marker wins, so a turn that
 * re-opens privacy stays private into the next turn.
 *
 * @returns the non-private turns + the span state to carry into the next delta.
 */
export function filterPrivateSpans(
  turns: CaptureTurn[],
  { startPrivate }: { startPrivate: boolean },
): { kept: CaptureTurn[]; endPrivate: boolean } {
  let priv = Boolean(startPrivate);
  const kept: CaptureTurn[] = [];
  for (const turn of turns) {
    const text = turn.text;
    const hasOn = text.includes(PRIVATE_ON);
    const hasOff = text.includes(PRIVATE_OFF);
    const isMarkerTurn = hasOn || hasOff;

    // Resolve the new state from this turn's last-occurring marker.
    if (isMarkerTurn) {
      const onAt = hasOn ? text.lastIndexOf(PRIVATE_ON) : -1;
      const offAt = hasOff ? text.lastIndexOf(PRIVATE_OFF) : -1;
      priv = onAt > offAt;
    }

    // Skip if we're (or just entered) a private span, OR this is itself a
    // boundary marker turn (it may carry private text alongside the marker).
    if (priv || isMarkerTurn) continue;
    kept.push(turn);
  }
  return { kept, endPrivate: priv };
}

/**
 * Build the uniform, harness-agnostic delta the server contract expects:
 * `{ conv_id, harness:"pi", seq, turns[], ended?, project? }`. `ended` is omitted
 * unless true (the server treats its mere presence as the explicit-end accelerator).
 * `project` is set only by a caller that knows the server accepts it (spec 078).
 */
export function buildPayload({
  convId,
  seq,
  turns,
  ended = false,
  project = null,
}: {
  convId: string;
  seq: number;
  turns: CaptureTurn[];
  ended?: boolean;
  project?: string | null;
}): CapturePayload {
  const payload: CapturePayload = { conv_id: convId, harness: HARNESS, seq, turns };
  if (ended) payload.ended = true;
  if (project) payload.project = project;
  return payload;
}
