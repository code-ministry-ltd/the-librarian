import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLibrarianStore } from "@librarian/core";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTTP_BIN = path.join(REPO_ROOT, "packages", "mcp-server", "dist", "bin", "http.js");

export function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "librarian-test-"));
}

export function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function withStore(testFn) {
  const dataDir = makeTempDir();
  const store = createLibrarianStore({ dataDir });
  const close = () => {
    try {
      store.close();
    } catch {}
    cleanupTempDir(dataDir);
  };
  return Promise.resolve()
    .then(() => testFn(store, dataDir))
    .finally(close);
}

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "0.0.0.0", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

export async function startHttpServer(options = {}) {
  // `getFreePort` is inherently racy under parallelism: it binds port 0, reads
  // the OS-assigned port, closes, and returns the NUMBER — so between that close
  // and the spawned child binding it, a concurrent test can grab the same port
  // (EADDRINUSE → the child crashes → /healthz never comes up). ADR 0008 P1's
  // listener split DOUBLED the allocations per server (public + internal tRPC),
  // widening that window. The fix is to make the port ALLOCATION resilient:
  // retry the spawn with freshly allocated ports on an early-exit/bind failure.
  // The test body still runs exactly once, against a server confirmed healthy —
  // this hardens setup, it does not paper over a flaky assertion. A genuine
  // start failure (a real bug) still surfaces: it just fails after the retries.
  const maxAttempts = 5;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await tryStartHttpServer(options);
    if (result.ok) return result.server;
    lastError = result.error;
  }
  throw lastError ?? new Error("startHttpServer: exhausted port-allocation retries");
}

async function tryStartHttpServer({
  dataDir,
  token = "test-token",
  agentToken = "agent-token",
  agentTokens = "",
  allowedOrigins = "",
  secretKey = "",
  // Seed `curator.intake.enabled` at boot (LIBRARIAN_CONSOLIDATOR is the seed-only
  // env; migrateJobEnablement writes the setting). Lets a test exercise the
  // capture happy-path (intake gate ON) vs the gate-refuse path (gate OFF, the
  // default for a fresh spawn). Does NOT start the sweep timer — TICK_MS stays 0.
  intake = "",
} = {}) {
  const port = await getFreePort();
  // ADR 0008 P1: the admin tRPC surface now lives on a SEPARATE internal
  // listener (loopback), off the published port. Pick a free port for it too.
  const trpcPort = await getFreePort();
  const child = spawn(process.execPath, ["--no-warnings", HTTP_BIN], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...(secretKey ? { LIBRARIAN_SECRET_KEY: secretKey } : {}),
      LIBRARIAN_DATA_DIR: dataDir,
      LIBRARIAN_HOST: "0.0.0.0",
      LIBRARIAN_PORT: String(port),
      // Bind the internal tRPC listener on 0.0.0.0 too so the test harness (a
      // sibling process, not strictly loopback) can reach it. Production
      // defaults to 127.0.0.1; this only widens the bind for the test.
      LIBRARIAN_TRPC_HOST: "0.0.0.0",
      LIBRARIAN_TRPC_PORT: String(trpcPort),
      LIBRARIAN_AUTH_TOKEN: token,
      LIBRARIAN_AGENT_TOKEN: agentToken,
      LIBRARIAN_AGENT_TOKENS: agentTokens,
      LIBRARIAN_ALLOWED_ORIGINS: allowedOrigins,
      // Pin the automatic curation timers OFF for the spawned test server unless a
      // caller opts in. Without this, the unconditional grooming/intake schedulers
      // run a boot-scan pass at startup — which, for a test that seeds grooming
      // enabled+configured before boot, grooms the test corpus before the test's own
      // action and pollutes its assertions (auto-applied/proposed memories the test
      // didn't expect). Tests drive curation explicitly via run-now / dry-run /
      // re-evaluate, which bypass the schedulers. A test that needs the timers can
      // override these. (TICK_MS=0 also skips the boot scan; see bin/http.ts.)
      LIBRARIAN_GROOMING_TICK_MS: process.env.LIBRARIAN_GROOMING_TICK_MS || "0",
      LIBRARIAN_CONSOLIDATOR_TICK_MS: process.env.LIBRARIAN_CONSOLIDATOR_TICK_MS || "0",
      LIBRARIAN_JOURNAL_TICK_MS: process.env.LIBRARIAN_JOURNAL_TICK_MS || "0",
      // Opt-in: seed the intake-enabled setting at boot (see option doc above).
      ...(intake ? { LIBRARIAN_CONSOLIDATOR: intake } : {}),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  // Defensive (EPIPE teardown leak): when the child is SIGTERM'd mid-write the
  // parent end of the stderr pipe can emit an `'error'` (EPIPE / ECONNRESET) AFTER
  // the test has finished. With no handler it is an unhandled 'error' event on a
  // Socket → it crashes the vitest json reporter. Swallow it; the child is going
  // away and a teardown-time pipe error is not a test failure. Same for the child
  // object itself (a kill after exit can surface as an error).
  child.stderr.on("error", () => {});
  child.on("error", () => {});

  // Fail FAST if the child dies before both listeners are healthy (an EADDRINUSE
  // port race crashes it immediately) — otherwise waitForHttp would burn its
  // full 5s deadline before the retry. Race the health-wait against early exit.
  let exited = false;
  const exitPromise = new Promise((resolve) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
  });

  try {
    // Wait for BOTH listeners: the public one (/healthz) and the internal tRPC
    // one (health.ping is the public tRPC probe). A test that hits /trpc must
    // not race the internal listener's bind.
    await Promise.race([
      (async () => {
        await waitForHttp(`http://0.0.0.0:${port}/healthz`, () => stderr);
        await waitForHttp(`http://0.0.0.0:${trpcPort}/trpc/health.ping`, () => stderr);
      })(),
      exitPromise.then(() => {
        throw new Error(`http server exited before becoming healthy\n${stderr}`);
      }),
    ]);
  } catch (error) {
    if (!exited) {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
    return { ok: false, error };
  }

  return {
    ok: true,
    server: {
      port,
      url: `http://0.0.0.0:${port}`,
      trpcPort,
      // The internal listener that serves /trpc/*. Append `/trpc/<proc>` to call it.
      trpcUrl: `http://0.0.0.0:${trpcPort}`,
      token,
      agentToken,
      child,
      stop: async () => {
        child.kill("SIGTERM");
        await waitForExit(child);
        // Tear the stderr pipe down explicitly once the child is gone so no
        // lingering pipe socket can emit a late 'error' into a finished test
        // (EPIPE teardown leak). `destroy()` is idempotent + error-guarded above.
        try {
          child.stderr.removeAllListeners("data");
          child.stderr.destroy();
        } catch {
          /* already closed */
        }
      },
    },
  };
}

export async function postJson(url, payload, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  return { response, json };
}

export function assertIncludes(haystack, needle) {
  assert.match(haystack, new RegExp(escapeRegExp(needle)));
}

async function waitForHttp(url, getStderr) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await wait(100);
  }
  const stderr = typeof getStderr === "function" ? getStderr() : getStderr;
  throw new Error(`Timed out waiting for ${url}\n${stderr}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve();
    }, 2000);
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
