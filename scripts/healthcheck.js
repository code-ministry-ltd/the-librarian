#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLibrarianStore } from "@librarian/core";

// These checks exercise the in-process store (the markdown vault) + the disposable
// recall index, plus spawned servers (which inherit process.env).
//
// Pin the hash embedder so the recall-backed check never pulls the real
// EmbeddingGemma model (a ~333 MB download); the index is exercised with
// deterministic hash embeddings.
if (!process.env.LIBRARIAN_EMBEDDER) process.env.LIBRARIAN_EMBEDDER = "hash";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STDIO_BIN = path.join(REPO_ROOT, "packages", "mcp-server", "dist", "bin", "stdio.js");
const HTTP_BIN = path.join(REPO_ROOT, "packages", "mcp-server", "dist", "bin", "http.js");

const LOCAL_CHECKS = [
  { name: "Vault durability", fn: checkVaultDurability },
  { name: "Index rebuild", fn: checkIndexDisposability },
  { name: "MCP stdio reachability", fn: checkMcpStdio },
  { name: "MCP tool surface", fn: checkMcpToolSurface },
  { name: "HTTP MCP reachability + auth", fn: () => checkHttpMcpLocal() },
];

// The pinned 7-verb agent surface (rethink spec §5.1, D8/D10/D12) — EXACTLY
// these, no internal tools: three memory verbs (`recall`, `remember`,
// `flag_memory` — route-to-review, replaced `verify_memory`), the
// cross-harness handoff trio that replaced the retired session subsystem, and
// `search_references` (a separate verb BY DESIGN, D12 — references are
// deliberately not auto-recalled). Admin capabilities live on the dashboard
// tRPC surface only. The check asserts the exact set both ways (nothing
// missing, nothing extra), so doc/spec drift is caught at boot, not by an
// agent quietly calling a tool that no longer exists. Mirrors
// packages/mcp-server/tests/mcp/tool-registry.test.ts.
const EXPECTED_TOOLS = {
  memory: ["recall", "remember", "flag_memory"],
  handoff: ["store_handoff", "list_handoffs", "claim_handoff"],
  references: ["search_references"],
};

const RETIRED_TOOLS = [
  "verify_memory",
  "delete_memory",
  "confirm_memory",
  "reject_memory",
  "resolve_conflict",
  // ADR 0006 PR-4 — redundant/admin verbs removed from the agent tool surface;
  // their capabilities remain on the dashboard tRPC surface.
  "start_context",
  "propose_memory",
  "update_memory",
  "archive_memory",
  "list_proposals",
  "approve_proposal",
  // ADR 0006 — `find_skills`/`session_manifest` retired first; rethink T1 then
  // deleted the skills subsystem entirely (`list_skills` / `get_skill`).
  "find_skills",
  "session_manifest",
  "list_skills",
  "get_skill",
  // rethink T2 (D10) — conv_state deleted, not hidden; the awareness primer
  // it carried moves to MCP initialize `instructions` (rethink T11).
  "conv_state_get",
  "conv_state_upsert",
  "conv_state_clear",
  "start_session",
  "get_session",
  "list_sessions",
  "list_session_events",
  "search_sessions",
  "record_session_event",
  "checkpoint_session",
  "pause_session",
  "end_session",
  "attach_session",
  "continue_session",
  "promote_session_fact",
  "archive_session",
  "restore_session",
  "delete_session",
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  const bar = "=".repeat(60);
  console.log("The Librarian healthcheck");
  console.log(bar);

  const checks = args.remote
    ? [
        {
          name: "Remote HTTP reachability + auth",
          fn: () => checkHttpMcpRemote(args.remote, args),
        },
      ]
    : LOCAL_CHECKS;

  if (args.remote) {
    console.log(`mode: remote (${args.remote})`);
    console.log(bar);
  }

  let failed = 0;
  for (const check of checks) {
    const start = Date.now();
    try {
      await check.fn();
      console.log(`PASS  ${check.name}  (${Date.now() - start}ms)`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL  ${check.name}  (${Date.now() - start}ms)`);
      console.log(`        reason: ${error.message}`);
      if (error.hint) console.log(`        hint: ${error.hint}`);
    }
  }

  console.log(bar);
  if (failed) {
    console.log(`${failed} of ${checks.length} checks failed`);
    process.exit(1);
  }
  console.log(`${checks.length} of ${checks.length} checks passed`);
  process.exit(0);
}

function parseArgs(argv) {
  const result = { help: false, remote: null, agentToken: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--remote") result.remote = argv[++i];
    else if (arg.startsWith("--remote=")) result.remote = arg.slice("--remote=".length);
    else if (arg === "--agent-token") result.agentToken = argv[++i];
    else if (arg.startsWith("--agent-token="))
      result.agentToken = arg.slice("--agent-token=".length);
  }
  if (!result.agentToken) {
    result.agentToken = process.env.LIBRARIAN_HEALTHCHECK_AGENT_TOKEN || null;
  }
  return result;
}

async function checkVaultDurability() {
  const dir = makeTempDir();
  try {
    let store = createLibrarianStore({ dataDir: dir });
    let memoryId;
    try {
      memoryId = store.createMemory({
        agent_id: "healthcheck",
        title: "durable memory",
        body: "Persisted to the git-backed vault and survives a store reopen.",
      }).memory.id;
    } finally {
      store.close();
    }

    // The markdown vault is the durable store: a memory written by one store
    // instance must be readable by a fresh instance, because it lives as a
    // committed .md file on disk — not just in process memory.
    store = createLibrarianStore({ dataDir: dir });
    try {
      const memory = store.getMemory(memoryId);
      if (!memory) {
        throw hint(
          new Error("Memory did not survive a store reopen."),
          "the write isn't being persisted to the vault on disk.",
        );
      }
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function checkIndexDisposability() {
  const dir = makeTempDir();
  let store;
  try {
    store = createLibrarianStore({ dataDir: dir });
    const memoryId = store.createMemory({
      agent_id: "healthcheck",
      title: "rebuildable",
      body: "Survives an index wipe and is recalled from the vault.",
    }).memory.id;

    // The disposable recall index is built from the markdown vault. First
    // confirm the freshly-written memory is recallable through it...
    const before = await store.recall({ query: "rebuildable index wipe vault", limit: 5 });
    if (!before.some((m) => m.id === memoryId)) {
      throw hint(
        new Error("New memory was not recalled before the index rebuild."),
        "the corpus index isn't picking up vault writes.",
      );
    }

    // ...then drop the cached index and recall again. The git vault is
    // canonical and the index holds no durable state, so reindex() must
    // rebuild equivalent recall from scratch (the disposability contract).
    store.reindex();
    const after = await store.recall({ query: "rebuildable index wipe vault", limit: 5 });
    if (!after.some((m) => m.id === memoryId)) {
      throw hint(
        new Error("Memory did not survive an index rebuild."),
        "the disposable index is not being rebuilt from the vault on recall.",
      );
    }
  } finally {
    if (store) store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function checkMcpStdio() {
  const dir = makeTempDir();
  const child = spawn(process.execPath, ["--no-warnings", STDIO_BIN], {
    cwd: REPO_ROOT,
    env: { ...process.env, LIBRARIAN_DATA_DIR: dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    for (const line of chunk.split("\n").filter(Boolean)) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        /* ignore non-JSON */
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n",
    );

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const initOk = messages.some(
        (m) => m.id === 1 && m.result?.serverInfo?.name === "the-librarian",
      );
      const listOk = messages.some((m) => m.id === 2 && Array.isArray(m.result?.tools));
      if (initOk && listOk) return;
      await wait(50);
    }

    throw hint(
      new Error("MCP stdio did not respond to initialize + tools/list."),
      `packages/mcp-server/dist/bin/stdio.js may be failing on startup. stderr:\n${stderr || "(empty)"}`,
    );
  } finally {
    child.kill("SIGTERM");
    await waitForExit(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function checkMcpToolSurface() {
  const dir = makeTempDir();
  // The final agent-facing surface has no `adminOnly` tools (the admin verbs
  // were removed in ADR 0006 PR-4), so the default agent role lists everything
  // EXPECTED_TOOLS asserts. Spawn with admin role anyway as a belt-and-braces
  // check that no retired admin verb sneaks back in under the admin listing.
  const child = spawn(process.execPath, ["--no-warnings", STDIO_BIN], {
    cwd: REPO_ROOT,
    env: { ...process.env, LIBRARIAN_DATA_DIR: dir, LIBRARIAN_STDIO_ROLE: "admin" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    for (const line of chunk.split("\n").filter(Boolean)) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        /* ignore non-JSON */
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n",
    );

    const deadline = Date.now() + 3000;
    let listMessage;
    while (Date.now() < deadline) {
      listMessage = messages.find((m) => m.id === 2 && Array.isArray(m.result?.tools));
      if (listMessage) break;
      await wait(50);
    }
    if (!listMessage) {
      throw hint(
        new Error("MCP stdio did not respond to tools/list."),
        `stderr:\n${stderr || "(empty)"}`,
      );
    }

    const expected = [
      ...EXPECTED_TOOLS.memory,
      ...EXPECTED_TOOLS.handoff,
      ...EXPECTED_TOOLS.references,
    ];
    const advertised = new Set(listMessage.result.tools.map((t) => t.name));
    const missing = expected.filter((name) => !advertised.has(name));
    const present = RETIRED_TOOLS.filter((name) => advertised.has(name));
    // The pin is exact (rethink §5.1): any tool beyond the 7 — retired or
    // brand-new internal — is drift.
    const extra = [...advertised].filter((name) => !expected.includes(name));

    if (missing.length || present.length || extra.length) {
      const lines = [];
      if (missing.length) lines.push(`missing: ${missing.join(", ")}`);
      if (present.length) lines.push(`retired tools still advertised: ${present.join(", ")}`);
      const unexpected = extra.filter((name) => !RETIRED_TOOLS.includes(name));
      if (unexpected.length) lines.push(`unexpected tools advertised: ${unexpected.join(", ")}`);
      throw hint(
        new Error(`MCP tool surface drifted from the pinned 7-verb contract (rethink §5.1).`),
        `${lines.join(" | ")}. See docs/specs/2026-06-12-rethink.md §5.1 + tests/mcp/tool-registry.test.ts.`,
      );
    }
  } finally {
    child.kill("SIGTERM");
    await waitForExit(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function checkHttpMcpLocal() {
  const dir = makeTempDir();
  const port = await getFreePort();
  let trpcPort = await getFreePort();
  while (trpcPort === port) trpcPort = await getFreePort();
  const child = spawn(process.execPath, ["--no-warnings", HTTP_BIN], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      LIBRARIAN_DATA_DIR: dir,
      LIBRARIAN_HOST: "127.0.0.1",
      LIBRARIAN_PORT: String(port),
      // The local probe owns both listeners. Do not inherit a configured or
      // default admin port that another running Librarian may already occupy.
      LIBRARIAN_TRPC_HOST: "127.0.0.1",
      LIBRARIAN_TRPC_PORT: String(trpcPort),
      LIBRARIAN_AUTH_TOKEN: "hc-admin-token",
      LIBRARIAN_AGENT_TOKEN: "hc-agent-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const url = `http://127.0.0.1:${port}`;
    await waitForHttp(`${url}/healthz`, stderr);
    await probeHttpMcp(url, { agentToken: "hc-agent-token" });
  } finally {
    child.kill("SIGTERM");
    await waitForExit(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function checkHttpMcpRemote(remoteUrl, args) {
  const url = remoteUrl.replace(/\/+$/, "");
  await waitForHttp(`${url}/healthz`, "");

  const agentToken =
    args.agentToken ||
    process.env.LIBRARIAN_HEALTHCHECK_AGENT_TOKEN ||
    process.env.LIBRARIAN_AGENT_TOKEN ||
    process.env.LIBRARIAN_ADMIN_TOKEN;
  if (!agentToken) {
    throw hint(
      new Error("No bearer token available to probe /mcp."),
      "Pass --agent-token <token> or set LIBRARIAN_HEALTHCHECK_AGENT_TOKEN (admin or agent) before running --remote.",
    );
  }
  await probeHttpMcp(url, { agentToken });
}

async function probeHttpMcp(url, { agentToken }) {
  const unauthorized = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  if (unauthorized.status !== 401) {
    throw hint(
      new Error(`Unauthorized request returned ${unauthorized.status}, expected 401.`),
      "MCP auth is not being enforced.",
    );
  }

  const authorized = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  if (!authorized.ok) {
    throw hint(
      new Error(`Authorized request failed with status ${authorized.status}.`),
      "Bearer auth or dispatch wiring is broken.",
    );
  }
  const json = await authorized.json();
  if (json.result?.serverInfo?.name !== "the-librarian") {
    throw hint(
      new Error("HTTP MCP initialize returned an unexpected payload."),
      "Dispatch chain may not be wired correctly.",
    );
  }
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "librarian-healthcheck-"));
}

function hint(error, hintText) {
  error.hint = hintText;
  return error;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

async function waitForHttp(url, stderr) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* server may not be ready yet */
    }
    await wait(100);
  }
  throw hint(new Error(`Timed out waiting for ${url}.`), `Server stderr:\n${stderr || "(empty)"}`);
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

function usage() {
  return [
    "Usage: node scripts/healthcheck.js [--remote <url>] [--agent-token <token>] [--help]",
    "",
    "Default (local) mode runs end-to-end checks against a temporary Librarian:",
    "  - Vault durability (a written memory survives a store reopen)",
    "  - Index rebuild (the disposable recall index rebuilds from the vault)",
    "  - MCP stdio reachability (packages/mcp-server/dist/bin/stdio.js)",
    "  - MCP tool surface (exactly the 7 memory/handoff/reference verbs; retired verbs absent)",
    "  - HTTP MCP reachability + auth (packages/mcp-server/dist/bin/http.js)",
    "",
    "Remote mode (--remote http://host:port) skips in-process checks and only",
    "probes the supplied URL: /healthz reachability, /mcp 401 without a token,",
    "and /mcp initialize with a bearer token. The bearer comes from",
    "--agent-token, LIBRARIAN_HEALTHCHECK_AGENT_TOKEN, LIBRARIAN_AGENT_TOKEN, or",
    "LIBRARIAN_ADMIN_TOKEN (first non-empty wins).",
    "",
    "Each named check prints PASS or FAIL with a reason and a hint when it fails.",
    "Exit 0 when every check passes, 1 otherwise.",
  ].join("\n");
}

main().catch((error) => {
  console.error(`healthcheck crashed: ${error.message}`);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
