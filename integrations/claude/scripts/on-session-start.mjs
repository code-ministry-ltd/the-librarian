#!/usr/bin/env node
// Claude `SessionStart` hook entry — the THIN shell over the pure banner builder
// in scripts/lib/banner.mjs. Spec 2026-06-16-harness-auto-capture, T5 (SC9).
//
// Wiring (integrations/claude/hooks/hooks.json): a `SessionStart` entry runs
// `node ${CLAUDE_PLUGIN_ROOT}/scripts/on-session-start.mjs`. Claude adds the hook's
// STDOUT to the session as additional context — so we print a deterministic
// awareness + capture-status banner and `exit 0`. SessionStart re-fires after a
// compaction, so the awareness line is re-injected and survives compaction (D9).
//
// What it does: query the server's `/healthz` (derived from LIBRARIAN_MCP_URL,
// same origin as the MCP config) to read the capture gate (`capture:"enabled"`),
// then hand `{ status, env }` to `buildBanner`. The banner names the LIBRARIAN_AUTO_SAVE
// kill-switch and the server intake gate.
//
// FAIL-SOFT CONTRACT (spec §4.10, AGENTS.md): the status probe can fail (server
// down, no URL). When it does we STILL print the static awareness line — no
// warning, no throw, no stack trace. We never block the session: any error exits 0
// with at most the awareness line. The token is sent in the HEADER only, never
// logged (privacy is the product); `redirect:"error"` so a 3xx can't bounce it
// cross-origin.

import process from "node:process";
import { buildBanner, probeShipping, probeStatus } from "./lib/banner.mjs";
import { resolveDataDir } from "./lib/capture.mjs";
import { writeServerFeatures } from "./lib/journal.mjs";

async function main() {
  let status;
  try {
    status = await probeStatus(process.env);
  } catch {
    status = { reachable: false };
  }
  // Spec 077: remember whether this server accepts `project` on /transcript, so the Stop
  // hook can label journal entries. Only a successful probe updates it — an outage keeps
  // the last known answer. Best-effort; never affects the banner.
  if (status.reachable) {
    try {
      writeServerFeatures(resolveDataDir(process.env), {
        journalSupported: status.journalSupported === true,
      });
    } catch {
      // fail-soft
    }
  }
  // Local capture-health: has THIS client ever shipped (any cursor under the
  // resolved $CLAUDE_PLUGIN_DATA)? Fail-soft to undefined → the banner keeps its
  // historical behavior, so a probe error never changes the awareness output.
  let shipping;
  try {
    shipping = probeShipping(resolveDataDir(process.env));
  } catch {
    shipping = undefined;
  }
  let text;
  try {
    text = buildBanner({ status, env: process.env, shipping });
  } catch {
    // Last-resort: never throw out of the hook. Print nothing rather than a
    // partial/broken banner.
    return;
  }
  // Claude adds SessionStart stdout to the session context.
  process.stdout.write(`${text}\n`);
}

main()
  .catch(() => {
    // Absolute backstop: never propagate; the session must start regardless.
  })
  .finally(() => {
    process.exit(0);
  });
