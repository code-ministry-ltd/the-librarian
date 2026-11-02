// Claude `SessionStart` awareness + capture-status banner — pure builder
// (testable). Spec 2026-06-16-harness-auto-capture, T5 (SC9).
//
// Node stdlib only. This module owns the DETERMINISTIC banner the SessionStart
// hook emits at conversation start (mem0-style). The banner does two things:
//   1. AWARENESS (always): remind the agent it HAS The Librarian — `recall` /
//      `remember` — so the reminder survives a compaction (SessionStart re-fires
//      and the line is re-injected). This is the passive half of D9's recall nudge.
//   2. CAPTURE STATUS: tell the agent whether automatic capture is live, or WARN
//      (naming the reason + the fix) when it is off — either because the server has
//      both curator intake and the journal off, or because LIBRARIAN_AUTO_SAVE=false
//      on this machine (the local kill-switch). When capture is on for the journal
//      only (intake off), it says memories are NOT being filed, so the agent keeps
//      calling `remember`.
//
// FAIL-SOFT (spec §4.10 / SC9): the status query can fail (server down). When it
// does, the builder STILL emits the static awareness line — no warning (we don't
// know capture is off), no throw. The hook entry never blocks the session.
//
// The builder is PURE over `{ status, env, shipping }` so the impure probes (the
// network /healthz query and the local cursor read) are injected by the hook
// entry and the banner text is unit-testable.

import fs from "node:fs";
import { cursorsDir } from "./cursor.mjs";

/**
 * Derive the /healthz URL from LIBRARIAN_MCP_URL (same origin as /mcp, dropping
 * any /mcp suffix/query/hash). Returns null for an unusable URL so the caller
 * fails soft to "unreachable". Mirrors post.mjs#deriveTranscriptUrl.
 *
 * @param {string|undefined} mcpUrl
 * @returns {string|null}
 */
export function deriveHealthzUrl(mcpUrl) {
  if (!mcpUrl || typeof mcpUrl !== "string") return null;
  let parsed;
  try {
    parsed = new URL(mcpUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return `${parsed.origin}/healthz`;
}

/**
 * Probe /healthz for capture status. Returns `{ reachable, captureEnabled }`.
 * NEVER throws: any failure (no URL, network error, non-2xx, non-JSON) resolves
 * to `{ reachable: false }` so the banner degrades to awareness-only. A 2s
 * timeout bounds a hung server so SessionStart can't hang. `fetch` is injectable
 * for tests; the hook entry passes the global.
 *
 * @param {Record<string,string|undefined>} env
 * @param {{fetch?: typeof globalThis.fetch}} [deps]
 * @returns {Promise<{reachable: boolean, captureEnabled?: boolean, intakeEnabled?: boolean,
 *   journalSupported?: boolean}>}
 */
export async function probeStatus(env, deps = {}) {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const url = deriveHealthzUrl(env && env.LIBRARIAN_MCP_URL);
  if (!url || typeof doFetch !== "function") return { reachable: false };
  const token = env.LIBRARIAN_AGENT_TOKEN;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    // /healthz is unauthenticated; send the bearer if we have it (header only,
    // never the URL/logs) for parity with the other calls — it is ignored here.
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const response = await doFetch(url, { headers, redirect: "error", signal: controller.signal });
    if (!response.ok) return { reachable: false };
    const json = await response.json();
    const isObject = Boolean(json && typeof json === "object");
    return {
      reachable: true,
      captureEnabled: isObject && json.capture === "enabled",
      // Whether captured turns are mined for memories. Older servers have no `intake`
      // key — there capture was only ever on WITH intake, so it follows `capture`.
      intakeEnabled:
        isObject && Object.prototype.hasOwnProperty.call(json, "intake")
          ? json.intake === "enabled"
          : isObject && json.capture === "enabled",
      // Spec 077: the `journal` key's PRESENCE (enabled or not) means this server accepts
      // the optional `project` on /transcript.
      journalSupported: isObject && Object.prototype.hasOwnProperty.call(json, "journal"),
    };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Has THIS client ever shipped a capture delta? Reads the cursors dir under the
 * resolved plugin data dir (`$CLAUDE_PLUGIN_DATA`, which Claude Code sets for
 * plugin hooks, else the fallback). ANY cursor file means the per-turn capture
 * hook has run and acked at least once on this machine. NEVER throws — a missing
 * dir / odd entry resolves to `{ everShipped: false }` (fail-soft). `fs` is
 * injectable for tests.
 *
 * @param {string} dataDir
 * @param {{fs?: typeof import("node:fs")}} [deps]
 * @returns {{everShipped: boolean}}
 */
export function probeShipping(dataDir, deps = {}) {
  const fsDep = deps.fs ?? fs;
  try {
    const names = fsDep.readdirSync(cursorsDir(dataDir));
    // A real cursor file is a session id; ignore dotfiles and the atomic-write
    // temp files (`<id>.tmp-<pid>`).
    const real = names.filter((n) => n && !n.startsWith(".") && !n.includes(".tmp-"));
    return { everShipped: real.length > 0 };
  } catch {
    return { everShipped: false };
  }
}

/** The static awareness line — always present, the part that survives compaction. */
export const AWARENESS_LINE =
  "The Librarian is this environment's durable memory: you have `recall` and " +
  "`remember`. Call `recall` before answering when prior context may exist " +
  "(especially after a compaction or reset), and `remember` durable facts, " +
  "preferences, and decisions as you learn them.";

/**
 * Is the local auto-save kill-switch OFF? True ONLY for the exact string "false"
 * (case-insensitive); anything else (unset, "", "true", …) is default-ON
 * (spec §4.7). Pure + total.
 *
 * @param {Record<string,string|undefined>} env
 * @returns {boolean}
 */
export function isAutoSaveOff(env) {
  const v = env && env.LIBRARIAN_AUTO_SAVE;
  return typeof v === "string" && v.trim().toLowerCase() === "false";
}

/**
 * Build the deterministic SessionStart banner text.
 *
 * @param {{
 *   status: {reachable: boolean, captureEnabled?: boolean, intakeEnabled?: boolean},
 *   env: Record<string,string|undefined>,
 *   shipping?: {everShipped: boolean},
 * }} input
 *   - `status.reachable` — did the /healthz query succeed?
 *   - `status.captureEnabled` — when reachable, is the server capturing (intake OR journal)?
 *   - `status.intakeEnabled` — are captured turns mined for memories? Absent ⇒ assumed
 *     to follow `captureEnabled` (older callers / servers).
 *   - `env` — the process env (read for the LIBRARIAN_AUTO_SAVE kill-switch).
 *   - `shipping` — OPTIONAL local-capture probe (`probeShipping`). When present and
 *     `everShipped:false`, the server gate is on but THIS client has never shipped,
 *     so the banner cautions instead of claiming "active". Absent ⇒ historical
 *     behavior (assume active when the gate is on).
 * @returns {string} the banner to inject. Never throws.
 */
export function buildBanner({ status, env, shipping }) {
  const lines = [AWARENESS_LINE];
  const e = env || {};
  const s = status || { reachable: false };

  // The LOCAL kill-switch takes precedence: if auto-save is off on this machine,
  // NOTHING ships regardless of the server gate — so warn about the env first.
  if (isAutoSaveOff(e)) {
    lines.push(
      "⚠ Automatic capture is OFF on this machine: LIBRARIAN_AUTO_SAVE=false. " +
        "Nothing from this session will be saved automatically. To re-enable, " +
        "unset LIBRARIAN_AUTO_SAVE (or set it to anything but `false`) and restart " +
        "Claude Code. You can still `remember` facts explicitly.",
    );
    return lines.join("\n\n");
  }

  // Status unreachable (server down / query failed): fail-soft — awareness only,
  // NO warning (we cannot prove capture is off), NO throw.
  if (!s.reachable) {
    return lines.join("\n\n");
  }

  // Reachable: report the server's capture gate.
  if (s.captureEnabled && s.intakeEnabled === false) {
    // Journal-only: conversations are captured for the journal, but intake is off, so no
    // memories are filed from them — the agent must not stop calling `remember`.
    lines.push(
      "Automatic capture is on for the journal only: your conversations are kept as a " +
        "dated history, but curator intake is off, so no memories are filed from them. " +
        "`remember` durable facts explicitly so they are not lost.",
    );
  } else if (s.captureEnabled) {
    // The gate being ON ≠ THIS client shipping: the SessionStart hook (this
    // banner) can fire while the per-turn capture hook does not. When the resolved
    // $CLAUDE_PLUGIN_DATA shows no cursors (never shipped), caution instead of
    // over-claiming "active" — the false-positive that masked a non-firing hook.
    // `shipping` is OPTIONAL: absent (probe failed / older caller) keeps "active".
    if (shipping && shipping.everShipped === false) {
      lines.push(
        "⚠ The Librarian server's capture is ON, but this client has not shipped " +
          "any transcript yet (no capture cursors under $CLAUDE_PLUGIN_DATA). If capture " +
          "does not begin after a turn or two, the per-turn capture hook may not be " +
          "firing even though this SessionStart hook did — check the cursors dir. Until " +
          "confirmed, `remember` durable facts explicitly so they are not lost.",
      );
    } else {
      lines.push(
        "Automatic capture is active: your turns are captured and durable lessons " +
          "filed for you — no need to call `remember` for routine facts.",
      );
    }
  } else {
    lines.push(
      "⚠ Automatic capture is OFF server-side: curator intake and the journal are " +
        "both disabled, so nothing is being captured or extracted. To re-enable, turn " +
        "intake on in the Librarian dashboard (Settings → Curator → Intake). Until " +
        "then, `remember` durable facts explicitly so they are not lost.",
    );
  }

  return lines.join("\n\n");
}
