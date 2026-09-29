#!/usr/bin/env node
// HTTP bin entrypoint.
//
// Reads env + runs the pre-store boot-time validation (credentials, agent-token
// map) and the staged-restore step, then hands the resolved values to
// `createLibrarianServer` (../librarian-server.ts) — the single composition root
// that owns store construction, both listeners, the schedulers, and shutdown
// (spec 060 T2, ADR 0011). All `process.env` reading + fatal boot validation
// lives here so the factory stays env-free and drivable from tests / integrators.

import fs from "node:fs";
import { applyPendingRestore, resolveBootCredentials, resolveDataDir } from "@librarian/core";
import { resolveBootstrapClaimHandle } from "../bootstrap-claim-config.js";
import {
  AgentTokensError,
  parseAgentTokenMap,
  parseCsv,
  resolveAllowNoAuth,
} from "../http/auth.js";
import { legacyIntakeEnvValue } from "../intake-config.js";
import { createLibrarianServer } from "../librarian-server.js";
import { logger } from "../logging.js";

const host = process.env.LIBRARIAN_HOST || process.env.LIBRARIAN_DASHBOARD_HOST || "127.0.0.1";
const port = Number(process.env.LIBRARIAN_PORT || process.env.LIBRARIAN_DASHBOARD_PORT || 3838);
// ADR 0008 P1: the admin tRPC API gets its OWN internal listener, off the
// published port. It defaults to loopback (the all-in-one) and an in-container
// port the dashboard reaches over the docker network (compose) — never
// published. Keep it on 127.0.0.1 unless you deliberately run a remote,
// separately-secured dashboard.
const trpcHost = process.env.LIBRARIAN_TRPC_HOST || "127.0.0.1";
const trpcPort = Number(process.env.LIBRARIAN_TRPC_PORT || 3840);

// Resolve the data volume first: the credential files live beside the store and
// must be in place before the store (which needs the key) is built. mkdir up front
// so a fresh install can persist them; a read-only volume falls back gracefully.
const dataDir = resolveDataDir();
try {
  fs.mkdirSync(dataDir, { recursive: true });
} catch {
  // Left to the credential resolver (no-secrets fallback) and the store to surface.
}

// D0 credential bootstrap: env wins, then ${dataDir}/secret.key, then generate.
// A present-but-bad key still fails loud. ADR 0008 P3: boot no longer resolves or
// generates an admin token — the internal tRPC listener is trusted (off the
// network), so the token is no longer a network gate.
let secretKey: Buffer | null;
try {
  const creds = resolveBootCredentials({ env: process.env, dataDir });
  secretKey = creds.secretKey;
  for (const signal of creds.signals) {
    if (signal.source !== "generated") continue;
    logger.warn(
      { path: signal.path },
      "Generated a new master key (LIBRARIAN_SECRET_KEY). SAVE THIS KEY — without it, restored secrets cannot be decrypted.",
    );
  }
} catch (error) {
  logger.fatal(`Invalid boot credentials: ${(error as Error).message}`);
  process.exit(1);
}

// The dashboard auth-enable land-grab token (ADR 0008 P3): NOT a network gate —
// it never grants a role (the internal listener is trusted by isolation). It's
// read straight from env ONLY so an operator who sets it can use the dashboard's
// "type the admin token to flip enforcement on" flow (the `auth.enable` compare).
// Unset → "" → that flow is unavailable, which is fine for the default deploy.
const adminToken = process.env.LIBRARIAN_ADMIN_TOKEN || process.env.LIBRARIAN_AUTH_TOKEN || "";

// First-owner bootstrap claim (spec 070): construct exactly one handle, pre-bound
// to the data dir and secret. The secret never travels through server/context
// options; a configured weak value aborts boot instead of arming silently.
let bootstrapClaim;
try {
  bootstrapClaim = resolveBootstrapClaimHandle(process.env, dataDir);
} catch (error) {
  logger.fatal(`Invalid bootstrap claim configuration: ${(error as Error).message}`);
  process.exit(1);
}

// Apply a dashboard-staged restore BEFORE the store opens — the vault dir is
// swapped while no store holds it. A failed restore leaves the live vault in place
// (or recovers it) and quarantines the marker for the operator.
{
  const restore = applyPendingRestore(dataDir);
  if (restore.applied) {
    logger.warn(
      { repo: restore.repo },
      "applied a staged restore (vault cloned from backup) on boot",
    );
  } else if (restore.error) {
    logger.error(
      { repo: restore.repo, reason: restore.error },
      "staged restore failed on boot; live vault left in place. The pending marker was " +
        "quarantined to restore.failed.json (not retried) — inspect it and re-stage to retry.",
    );
  }
}

const agentToken = process.env.LIBRARIAN_AGENT_TOKEN || "";

let agentTokenMap: Map<string, string>;
try {
  agentTokenMap = parseAgentTokenMap(process.env.LIBRARIAN_AGENT_TOKENS || "");
} catch (error) {
  if (error instanceof AgentTokensError) {
    logger.fatal(error.message);
    process.exit(1);
  }
  throw error;
}

const allowedOrigins = parseCsv(process.env.LIBRARIAN_ALLOWED_ORIGINS || "");
const allowedHosts = parseCsv(process.env.LIBRARIAN_ALLOWED_HOSTS || "");
const maxBodyBytes = Number(process.env.LIBRARIAN_MAX_BODY_BYTES || 1024 * 1024);

// The no-auth bypass (ADR 0008 P3 regression fix). Resolved AFTER the agent
// credentials are parsed because the implicit loopback bypass must NOT fire when
// an agent token is configured — a configured token is enforced regardless of
// host. The explicit LIBRARIAN_ALLOW_NO_AUTH=true opt-out (the all-in-one
// localhost path) still fires even with a token set. See resolveAllowNoAuth.
const allowNoAuth = resolveAllowNoAuth({
  allowNoAuthEnv: process.env.LIBRARIAN_ALLOW_NO_AUTH,
  host,
  agentToken,
  agentTokenMap,
});

// ADR 0008 P3: the admin token is no longer a network gate — there is no longer
// an "admin token required when bound beyond localhost" fatal check, and no
// admin↔agent collision check (a value reused as the enable-flow token can't
// also grant a role on /mcp, so a collision is harmless). The AGENT token is now
// the sole /mcp gate; the relevant misconfig warning is about IT.
if (!allowNoAuth && !agentToken && !agentTokenMap.size) {
  logger.warn(
    "Bound beyond localhost with NO agent token set — /mcp is unreachable until you " +
      "set LIBRARIAN_AGENT_TOKEN or per-agent LIBRARIAN_AGENT_TOKENS (or mint a token in the dashboard).",
  );
}

if (allowNoAuth) {
  logger.warn(
    "Starting with the localhost no-auth bypass — /mcp grants AGENT role without a token. " +
      "Use only on localhost or a private development machine.",
  );
}

// Scheduler cadences (all LIBRARIAN_*): each `*_TICK_MS`/`*_POLL` poll interval
// gates its scheduler on > 0 (0 disables that timer + its boot scan). The
// transcript idle/size tunables default in @librarian/core when the env is unset,
// so they pass through only when present. See createLibrarianServer for how each
// scheduler self-gates on its dashboard setting.
const backupTickMs = Number(process.env.LIBRARIAN_BACKUP_TICK_MS ?? 5 * 60_000);
const intakePollMs = Number(process.env.LIBRARIAN_CONSOLIDATOR_TICK_MS ?? 60_000);
const groomingPollMs = Number(process.env.LIBRARIAN_GROOMING_TICK_MS ?? 15 * 60_000);
const chroniclePollMs = Number(process.env.LIBRARIAN_CHRONICLE_TICK_MS ?? 15 * 60_000);
const transcriptSweepTickMs = Number(process.env.LIBRARIAN_TRANSCRIPT_SWEEP_TICK_MS ?? 5 * 60_000);
const transcriptIdleMs = process.env.LIBRARIAN_TRANSCRIPT_IDLE_MS
  ? Number(process.env.LIBRARIAN_TRANSCRIPT_IDLE_MS)
  : undefined;
const transcriptMaxBytes = process.env.LIBRARIAN_TRANSCRIPT_MAX_BYTES
  ? Number(process.env.LIBRARIAN_TRANSCRIPT_MAX_BYTES)
  : undefined;

// The legacy LIBRARIAN_CONSOLIDATOR opt-in (spec 043 D-E), read at this boundary
// only: it seeds curator.intake.enabled once and drives the deprecation notice.
const legacyIntakeEnv = legacyIntakeEnvValue();

const server = createLibrarianServer({
  // The default OSS build ships no build-time plugins (SC 1, ADR 0011): the bin is a
  // thin wrapper that calls the factory with an empty plugin set. A downstream
  // integrator (the Teams edition) composes the same factory with its own plugins.
  plugins: [],
  dataDir,
  secretKey,
  host,
  port,
  trpcHost,
  trpcPort,
  adminToken,
  bootstrapClaim,
  agentToken,
  agentTokenMap,
  allowedOrigins,
  allowedHosts,
  allowNoAuth,
  maxBodyBytes,
  backupTickMs,
  intakePollMs,
  groomingPollMs,
  chroniclePollMs,
  transcriptSweepTickMs,
  ...(transcriptIdleMs !== undefined ? { transcriptIdleMs } : {}),
  ...(transcriptMaxBytes !== undefined ? { transcriptMaxBytes } : {}),
  ...(legacyIntakeEnv !== undefined ? { legacyIntakeEnv } : {}),
});

server.start();

function onSignal(): void {
  // The factory's stop() runs the load-bearing shutdown order (schedulers →
  // store.close() → both listeners) and resolves once both sockets are released;
  // exit(0) only then so neither listener leaks on SIGTERM/SIGINT.
  void server.stop().then(() => process.exit(0));
}

process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
