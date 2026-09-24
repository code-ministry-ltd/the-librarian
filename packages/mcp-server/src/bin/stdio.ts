#!/usr/bin/env node
// MCP stdio bin entrypoint.
//
// Reads newline-delimited JSON-RPC messages on stdin, dispatches them
// through `handleMcpMessage`, and writes responses to stdout. Roles
// come from `LIBRARIAN_STDIO_ROLE` / `LIBRARIAN_STDIO_AGENT_ID`.

import fs from "node:fs";
import {
  applyPendingRestore,
  createLibrarianStore,
  resolveBootCredentials,
  resolveDataDir,
  seedPrimer,
} from "@librarian/core";
import { createMemoryCorrectionRuntime } from "../memory-correction-runtime.js";
import { handleMcpMessage } from "../mcp/rpc.js";
import { resolveStdioPrincipal } from "./stdio-principal.js";

// LIBRARIAN_SECRET_KEY (optional) unlocks encrypted admin settings. D0: when unset,
// resolve it from (or generate it to) ${dataDir}/secret.key so a fresh local install
// gets secret support with no env. stdio never binds to the network, so no admin
// token is provisioned. present-but-bad → fail loud (to stderr; stdout is the RPC channel).
const dataDir = resolveDataDir();
try {
  fs.mkdirSync(dataDir, { recursive: true });
} catch {
  // Read-only volume → the resolver falls back to the no-secrets path.
}
let secretKey: Buffer | null;
try {
  const creds = resolveBootCredentials({ env: process.env, dataDir });
  secretKey = creds.secretKey;
  if (creds.signals.some((s) => s.credential === "secret-key" && s.source === "generated")) {
    process.stderr.write(
      "Generated a new master key (LIBRARIAN_SECRET_KEY) on the data volume. SAVE THIS KEY — without it, restored secrets cannot be decrypted.\n",
    );
  }
} catch (error) {
  process.stderr.write(`Invalid LIBRARIAN_SECRET_KEY: ${(error as Error).message}\n`);
  process.exit(1);
}
// Apply a dashboard-staged restore BEFORE the store opens — the vault dir is
// swapped while nothing holds it. A failed restore leaves the live vault in place.
{
  const restore = applyPendingRestore(dataDir);
  if (restore.error) {
    process.stderr.write(
      `Staged restore failed on boot; live vault left in place (quarantined to restore.failed.json): ${restore.error}\n`,
    );
  }
}

const store = createLibrarianStore({ secretKey, dataDir });

// Primer seed-on-boot (rethink T11, spec §5.2): vault/primer.md must exist
// before the first `initialize` reads it into the `instructions` field.
// Idempotent + no-clobber — an operator-edited primer is never touched.
seedPrimer(store);

const memoryCorrectionRuntime = createMemoryCorrectionRuntime(store);
memoryCorrectionRuntime.scheduler.start();
void memoryCorrectionRuntime.scheduler.runNow();

process.stdin.setEncoding("utf8");

let buffer = "";
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    void handleLine(line);
  }
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function handleLine(line: string): Promise<void> {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: `Parse error: ${(error as Error).message}` },
    });
    return;
  }

  const method = message.method as string | undefined;
  if (!message.id && method?.startsWith("notifications/")) return;

  const response = await handleMcpMessage(store, message, {
    principal: resolveStdioPrincipal(),
    wakeMemoryCorrection: memoryCorrectionRuntime.wake,
  });
  if (response) send(response);
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let shutdownStarted = false;

async function shutdown(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  memoryCorrectionRuntime.scheduler.stop();
  try {
    await memoryCorrectionRuntime.drain();
  } catch {
    process.stderr.write("Flagged-memory correction worker drain failed during shutdown.\n");
  }
  try {
    store.close();
  } finally {
    process.exit(0);
  }
}
