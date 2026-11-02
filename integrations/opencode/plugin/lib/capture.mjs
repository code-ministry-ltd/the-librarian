// OpenCode auto-capture adapter — the orchestrator (testable; the plugin hook is a
// thin shell over `runCapture`). Spec 2026-06-16-harness-auto-capture, Phase 2A
// (OpenCode).
//
// Mirrors the Claude/Codex orchestrators' GUARANTEES: since this conversation was
// last seen, ship the new NON-PRIVATE turns and advance the cursor ONLY on a
// server ack. Everything is fail-soft — every path resolves, never throws; an
// error logs to the injected logger and the cursor stays put so the delta
// re-ships next fire (idempotent; server/curator dedup).
//
// OpenCode-specific differences from the Claude/Codex orchestrators:
//   1. The input is a structured MESSAGE LIST (`{info,parts}[]`, read by the
//      plugin entry via the SDK `client.session.messages(...)`), NOT an
//      append-only JSONL file read through a byte-offset cursor. So the cursor is
//      a TURN COUNT (turns already shipped/skipped) and is held IN-MEMORY for the
//      plugin's lifetime (see cursor.mjs), not a durable on-disk byte offset. By
//      design (NOT disk-persisted): an `opencode` restart re-ships the visible
//      conversation from turn 0 — correctness-safe because idempotency rests on the
//      curator's fact-level dedup + advance-on-ack (the contract `seq` is a
//      non-authoritative label the server does not replay-reject on).
//   2. conv_id = `sessionID` ONLY (deriveConvId) — never `$USER`/cwd (spec §4.11).
//   3. The `LIBRARIAN_AUTO_SAVE=false` per-machine kill-switch is enforced HERE as
//      a hard gate (ship nothing, advance nothing — slash-commands.md contract),
//      same as the Codex adapter.
//
// The cursor store and the network `post` are INJECTED so the orchestration is
// unit-testable without a running OpenCode or a socket; the plugin entry passes
// the real in-memory store + `postDelta`.

import { deriveTranscriptUrl, postDelta } from "./post.mjs";
import { buildPayload, deriveConvId, filterPrivateSpans, messagesToTurns } from "./transcript.mjs";

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
 * Run one capture pass for a `chat.message` fire.
 *
 * @param {{sessionID?:string, messages?:unknown[], env?:Record<string,string|undefined>,
 *          ended?:boolean, project?:string|null}} input - the fire context: the stable
 *          sessionID, the full session message list, the process env (URL + token +
 *          kill-switch), an explicit-end hint, and the journal's project label (set
 *          only for a server that accepts it — spec 078).
 * @param {{store:{read:Function,write:Function}, post?: typeof postDelta,
 *          log?: (msg:string)=>void}} deps - the in-memory cursor store, an
 *          injectable network ship (tests), and a fail-soft logger.
 * @returns {Promise<{posted:boolean, skipped?:string,
 *          ack?:{ok:boolean,status:number,buffered?:number}}>}
 */
export async function runCapture(input, deps) {
  const post = deps.post ?? postDelta;
  const store = deps.store;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const env = input.env ?? {};

  // conv_id FIRST — it keys the cursor + the server buffer, and a missing id is a
  // clean no-op (NEVER cwd/$USER). Resolved before any state is touched.
  const convId = deriveConvId(input);

  // KILL-SWITCH (slash-commands.md, SC4): LIBRARIAN_AUTO_SAVE=false ships nothing
  // and advances nothing on this machine. Hard gate, checked before any work.
  if (isAutoSaveOff(env)) {
    return { posted: false, skipped: "auto-save-off" };
  }

  try {
    if (!convId) {
      log("skip: no stable conv_id (no sessionID on the chat.message input)");
      return { posted: false, skipped: "no-conv-id" };
    }

    // CONFIG (fail-soft): without a URL + token there is nowhere to ship — a clean
    // no-op, cursor untouched, re-ships once configured.
    const url = deriveTranscriptUrl(env.LIBRARIAN_MCP_URL);
    const token = env.LIBRARIAN_AGENT_TOKEN;
    if (!url || !token) {
      log("skip: LIBRARIAN_MCP_URL / LIBRARIAN_AGENT_TOKEN not set");
      return { posted: false, skipped: "not-configured" };
    }

    // The full ordered turn list for the session, then the NEW tail since the
    // cursor. The cursor's `count` is how many turns we've already shipped/skipped;
    // a shrinking list (a session reset reusing an id) is defensive — restart from
    // 0 (re-ship is safe; the curator dedups).
    const allTurns = messagesToTurns(input.messages);
    const prior = store.read(convId);
    const start = prior.count <= allTurns.length ? prior.count : 0;
    const newTurns = allTurns.slice(start);

    // PRIVATE-SPAN FILTER (forward-only) over the NEW turns, carrying the private
    // state forward across fires. The cursor advances over ALL new turns
    // (including private ones we skipped) on a successful ship, so a private turn
    // is NEVER retroactively shipped (SC2).
    const { kept, endPrivate } = filterPrivateSpans(newTurns, { startPrivate: prior.private });

    const nextCount = allTurns.length;
    const ended = input.ended === true;

    // Nothing public to ship. If the conversation ended we still want the server to
    // know (a private-only tail shouldn't strand the buffer), so send an ended-only
    // empty delta; otherwise advance past the (private) turns we read and no-op.
    if (kept.length === 0 && !ended) {
      // Advance the cursor only when we actually consumed new (private/marker)
      // turns, so they're never retroactively shipped; otherwise it's a pure no-op.
      if (newTurns.length > 0) {
        store.write(convId, { count: nextCount, seq: prior.seq, private: endPrivate });
      }
      return { posted: false, skipped: "no-new-turns" };
    }

    const seq = prior.seq + 1;
    // Spec 078: the shell passes `project` only for a server that accepts it.
    const project = typeof input.project === "string" && input.project ? input.project : null;
    const payload = buildPayload({ convId, seq, turns: kept, ended, project });

    // SHIP. A non-2xx (`ok:false`) or a thrown network error → DO NOT advance the
    // cursor: the delta re-ships next fire (idempotent; server/curator dedup). A
    // 2xx → advance past every new turn we read and persist the new seq + private
    // state.
    let ack;
    try {
      ack = await post(url, payload, token);
    } catch (error) {
      log(`ship failed (transient, will retry): ${(error && error.message) || "network error"}`);
      return { posted: false, skipped: "post-failed" };
    }

    if (!ack || !ack.ok) {
      log(`ship not acked (status ${ack ? ack.status : "?"}); cursor held, will retry`);
      return { posted: false, skipped: "not-acked", ack };
    }

    store.write(convId, { count: nextCount, seq, private: endPrivate });
    return { posted: true, ack };
  } catch (error) {
    // Last-resort fail-soft: any unexpected error logs + exits a no-op. The cursor
    // is untouched on this path (no write reached), so the delta re-ships next fire.
    log(`unexpected error (no-op, fail-soft): ${(error && error.message) || "unknown"}`);
    return { posted: false, skipped: "error" };
  }
}
