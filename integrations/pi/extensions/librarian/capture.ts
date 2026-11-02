// Pi auto-capture adapter — the orchestrator + the `agent_end` hook wiring.
// Spec 2026-06-16-harness-auto-capture, Phase 2B (Pi / T-Pi).
//
// Wires the pure transforms (transcript-capture.ts), the durable per-session
// state (capture-state.ts), and the network ship (transcript-post.ts) into the
// one decision the per-turn-end handler makes: ship this completed turn's
// NON-PRIVATE prose to POST /transcript and advance seq ONLY on a server 2xx ack.
// Everything is fail-soft (AGENTS.md: a Librarian/network/parse failure must
// never throw out of a harness hook, never block the user's turn, never leak a
// stack trace) — every path resolves; an error logs to the injected logger and
// seq stays put so the delta re-ships next turn (idempotent; server/curator dedup).
//
// ─── The Pi event/session API: CONFIRMED vs ASSUMED ───────────────────────────
// Confirmed against the pinned @earendil-works/pi-coding-agent@0.75.5 SDK types
// (node_modules/.../dist/core/extensions/types.d.ts) and the bundled
// docs/extensions.md, plus the build-pi-extension skill:
//   - CONFIRMED `pi.on("agent_end", handler)` exists; AgentEndEvent =
//     `{ type:"agent_end", messages: AgentMessage[] }`, fired ONCE per user
//     prompt with the completed turn's messages IN-PAYLOAD. This is the §11.2
//     "per-turn-end event handing the completed turn in-payload" — so the delta
//     is O(1) (no cursor, no transcript re-read).
//   - CONFIRMED `ctx.sessionManager.getSessionId(): string` is the stable session
//     id. The spec's "conv_id = Pi's getSessionId()" maps to THIS. conv_id is the
//     session id ONLY — NEVER $USER/cwd (concurrent same-machine sessions must
//     not collide, spec §4.11 / SC5). No stable id → fail soft to a no-op.
//   - ASSUMED (OPTIMISTIC — there is no `pi` CLI on this machine, so SC1 e2e is
//     DEFERRED): that `agent_end` (the whole-prompt boundary) is the right hook
//     vs `turn_end` (which fires per LLM-response loop within one prompt and
//     carries a single `message`, not the full exchange). We pick `agent_end` per
//     the §11.2 expectation and make a wrong shape fail SAFE: messagesToTurns
//     skips any unexpected message/block shape → a wrong event or payload is a
//     clean no-op, never a throw or garbage capture. The hook also guards its
//     whole body so a thrown getSessionId()/handler error can never escape.
//
// The network `post` + the dataDir are INJECTED so the orchestration is
// unit-testable without a running Pi or a socket; registerCaptureHook passes the
// real postDelta + the resolved data dir.

import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pruneOldState, readCaptureState, writeCaptureState } from "./capture-state.js";
import { buildPayload, filterPrivateSpans, messagesToTurns } from "./transcript-capture.js";
import { type CaptureAck, deriveTranscriptUrl, postDelta } from "./transcript-post.js";

// Age-based pruning of stale per-session capture state (~7 days), opportunistic
// and fail-soft — NEVER clear-all (a fresh sibling is a live concurrent session).
const PRUNE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** A fail-soft logger; capture never logs turn text or the token. */
export type CaptureLogger = (message: string) => void;

/** The injected dependencies the orchestration needs (testable). */
export interface CaptureDeps {
  /** Plugin data dir (per-session state home). */
  dataDir: string;
  /** Injectable network ship (tests pass a fake; the hook passes postDelta). */
  post?: typeof postDelta;
  /** Fail-soft logger (defaults to a no-op). */
  log?: CaptureLogger;
}

/** The fire context the handler hands the orchestrator. */
export interface CaptureInput {
  /** Pi's getSessionId() — the conv_id. Empty/missing → a clean no-op. */
  convId: string;
  /** The completed turn's AgentMessage[] (agent_end's in-payload turn). */
  messages: unknown[];
  /** Process env: the URL + token + the LIBRARIAN_AUTO_SAVE kill-switch. */
  env: Record<string, string | undefined>;
  /** Explicit-end hint (the session is ending) — the settle-sweep accelerator. */
  ended?: boolean;
  /** Spec 078: the journal's project label, or null when the server can't take it. */
  project?: string | null;
}

/** The orchestration outcome (mostly for tests / diagnostics). */
export interface CaptureResult {
  posted: boolean;
  skipped?: string;
  ack?: CaptureAck;
}

/**
 * Is the local auto-save kill-switch OFF? True ONLY for the exact string "false"
 * (case-insensitive); anything else (unset, "", "true", …) is default-ON
 * (slash-commands.md "two gates"). Pure + total.
 */
export function isAutoSaveOff(env: Record<string, string | undefined>): boolean {
  const v = env?.LIBRARIAN_AUTO_SAVE;
  return typeof v === "string" && v.trim().toLowerCase() === "false";
}

/**
 * Resolve the plugin data dir (per-session state home). Default:
 * `${LIBRARIAN_PI_DATA:-$HOME/.librarian/pi-extension-data}` — mirrors the
 * Claude adapter's `CLAUDE_PLUGIN_DATA → $HOME/.librarian/claude-plugin-data`.
 */
export function resolveDataDir(env: Record<string, string | undefined>): string {
  const explicit = env.LIBRARIAN_PI_DATA;
  if (explicit && explicit.trim()) return explicit;
  const home = env.HOME || env.USERPROFILE || ".";
  return path.join(home, ".librarian", "pi-extension-data");
}

/**
 * Run one capture pass for a completed turn (`agent_end`). Ships the new
 * NON-PRIVATE prose and advances seq ONLY on a 2xx ack. Never throws — every
 * failure path resolves to a clean no-op and (best-effort) logs.
 */
export async function runCapture(input: CaptureInput, deps: CaptureDeps): Promise<CaptureResult> {
  const post = deps.post ?? postDelta;
  const log: CaptureLogger = typeof deps.log === "function" ? deps.log : () => {};
  const dataDir = deps.dataDir;
  const env = input.env ?? {};

  // KILL-SWITCH (slash-commands.md, SC4): LIBRARIAN_AUTO_SAVE=false ships nothing
  // and advances nothing on this machine. Hard gate, checked before any work.
  if (isAutoSaveOff(env)) {
    return { posted: false, skipped: "auto-save-off" };
  }

  try {
    // conv_id keys the per-session state + the server buffer; a missing id is a
    // clean no-op (NEVER cwd/$USER, so concurrent sessions never collide).
    const convId = input.convId;
    if (!convId) {
      log("skip: no stable conv_id (getSessionId() empty)");
      return { posted: false, skipped: "no-conv-id" };
    }

    // CONFIG (fail-soft): without a URL + token there is nowhere to ship — a clean
    // no-op, state untouched, re-ships once configured.
    const url = deriveTranscriptUrl(env.LIBRARIAN_MCP_URL);
    const token = env.LIBRARIAN_AGENT_TOKEN;
    if (!url || !token) {
      log("skip: LIBRARIAN_MCP_URL / LIBRARIAN_AGENT_TOKEN not set");
      return { posted: false, skipped: "not-configured" };
    }

    // Build this turn's prose turns and apply the forward-only private-span filter,
    // carrying the open-span state forward across turns. A garbage payload yields
    // [] (messagesToTurns is fail-soft) → a clean no-op below.
    const prior = readCaptureState(dataDir, convId);
    const allTurns = messagesToTurns(input.messages);
    const { kept, endPrivate } = filterPrivateSpans(allTurns, { startPrivate: prior.private });

    const ended = input.ended === true;

    // Nothing public to ship. If the conversation ended we still send an
    // ended-only delta (a private-only / empty tail shouldn't strand the server
    // buffer). Otherwise persist any changed private state (so the next turn stays
    // private) and no-op — a private turn is now behind us, NEVER retroactively shipped.
    if (kept.length === 0 && !ended) {
      if (endPrivate !== prior.private) {
        writeCaptureState(dataDir, convId, { seq: prior.seq, private: endPrivate });
      }
      return { posted: false, skipped: "no-new-turns" };
    }

    const seq = prior.seq + 1;
    const payload = buildPayload({
      convId,
      seq,
      turns: kept,
      ended,
      project: input.project ?? null,
    });

    // SHIP. A non-2xx (`ok:false`) or a thrown network error → DO NOT advance seq:
    // the delta re-ships next turn (idempotent; server/curator dedup). A 2xx →
    // advance seq + persist the carried private state.
    let ack: CaptureAck;
    try {
      ack = await post(url, payload, token);
    } catch (error) {
      // Transient/infra: log + hold seq. Never leak the token (postDelta guarantees
      // it stays in the header) or a stack trace into the model's context.
      log(`ship failed (transient, will retry): ${errMsg(error)}`);
      return { posted: false, skipped: "post-failed" };
    }

    if (!ack || !ack.ok) {
      log(`ship not acked (status ${ack ? ack.status : "?"}); seq held, will retry`);
      return { posted: false, skipped: "not-acked", ack };
    }

    writeCaptureState(dataDir, convId, { seq, private: endPrivate });
    return { posted: true, ack };
  } catch (error) {
    // Last-resort fail-soft: any unexpected error logs + exits a no-op. State is
    // untouched on this path (no write reached), so the delta re-ships next turn.
    log(`unexpected error (no-op, fail-soft): ${errMsg(error)}`);
    return { posted: false, skipped: "error" };
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/**
 * Read Pi's stable session id from the handler ctx, fail-soft. The spec's
 * "conv_id = getSessionId()" maps to `ctx.sessionManager.getSessionId()`. Any
 * throw / non-string → "" so the orchestrator no-ops (NEVER cwd/$USER).
 */
export function readSessionId(ctx: unknown): string {
  try {
    const sm = (ctx as { sessionManager?: { getSessionId?: () => unknown } })?.sessionManager;
    const id = sm?.getSessionId?.();
    return typeof id === "string" ? id : "";
  } catch {
    return "";
  }
}

/** The session's working directory from the handler ctx (`ctx.cwd`), fail-soft. */
export function readCwd(ctx: unknown): string | undefined {
  try {
    const cwd = (ctx as { cwd?: unknown })?.cwd;
    return typeof cwd === "string" ? cwd : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wire auto-capture into Pi's `agent_end` event — fired ONCE per completed user
 * prompt with the turn's messages in-payload (the §11.2 per-turn-end hook). The
 * whole body is guarded so a Librarian/network/parse failure can NEVER throw out
 * of the handler or block the turn (AGENTS.md fail-soft). conv_id is the stable
 * getSessionId(); the delta re-ships next turn on any non-2xx.
 *
 * @param dataDir - the resolved plugin data dir (per-session state home).
 * @param projectFor - the journal's project label for a cwd, or null (spec 078).
 */
export function registerCaptureHook(
  pi: ExtensionAPI,
  dataDir: string,
  projectFor: (cwd: string | undefined) => Promise<string | null> = async () => null,
): void {
  // Opportunistic, fail-soft pruning of stale sibling state (never clear-all).
  try {
    pruneOldState(dataDir, PRUNE_MAX_AGE_MS);
  } catch {
    // pruning is best-effort; a failure must not break extension load.
  }

  pi.on("agent_end", async (event, ctx) => {
    try {
      const convId = readSessionId(ctx);
      const messages = Array.isArray((event as { messages?: unknown }).messages)
        ? (event as { messages: unknown[] }).messages
        : [];
      const project = await projectFor(readCwd(ctx));
      await runCapture({ convId, messages, env: process.env, project }, { dataDir });
    } catch {
      // Defensive net — runCapture already swallows its own errors, but a
      // top-level throw must never break the user's turn or leak a stack trace.
    }
  });
}
