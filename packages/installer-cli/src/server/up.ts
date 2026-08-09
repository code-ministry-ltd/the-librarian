// `librarian server up` — pull a stable release (or build a source ref) and run
// the all-in-one container.
//
// This is the loop-closer: on a fresh Docker host it resolves and validates the
// stable release image (or clones/builds an arbitrary `--ref`), mints the master
// key + agent token into a 0600 deploy env-file, creates and starts the
// all-in-one container with `docker create --env-file` (ADR 0008 P4 — secrets
// off argv), waits for it to
// report healthy, surfaces the CLI-MINTED master key ONCE, and prints the MCP URL
// + dashboard URL + the agent token ready to paste into `librarian install`.
//
// ADR 0008 P3: there is no admin token. The admin tRPC API is served only on the
// trusted internal listener (off the network), so `server up` neither reads back
// nor surfaces an admin token, regardless of bind host.
//
// Bind host (spec §5.3 / §6): the default is `127.0.0.1` (host loopback only).
// `--host <addr>` sets it explicitly. Best-effort, an interactive run with no
// `--host` is OFFERED a detected Tailscale tailnet IP. Binding to `0.0.0.0`
// (all interfaces) is ask-first. We NEVER default to `0.0.0.0`, and a
// non-interactive/`--yes` run never silently exposes the server beyond
// localhost.
//
// The bind choice drives the localhost no-auth bypass via `LIBRARIAN_ALLOW_NO_AUTH`
// (the image always binds `0.0.0.0` internally, so the server can't see the host
// publish address — spec §6). Post ADR 0008 P4 it lives in the deploy env-file,
// not inline on argv:
//   - `127.0.0.1`        → env-file carries `LIBRARIAN_ALLOW_NO_AUTH=true`; /mcp
//                          grants the agent role without a token (loopback bypass).
//   - tailnet / `0.0.0.0`→ OMIT it; /mcp requires the agent token. (The admin
//                          tRPC API is off the network entirely — ADR 0008.)
//
// EVERYTHING that touches the system is injected (`docker.ts` runner — which
// also routes the Tailscale probe, the latest-release fetcher, the prompter,
// `home`, the interactivity flag, and the health-poll sleep), so the whole flow
// is exercised in tests WITHOUT a real daemon, network, git, or tailscale.
//
// Security (AGENTS.md): the agent token, master key, and optional bootstrap
// claim secret ride ONLY in the 0600 deploy env-file fed to
// `docker create --env-file` (ADR 0008 P4) — never inline on argv. `--env-file`
// keeps them off the process argv (and out of any
// argv-echoing error); it does NOT hide them from `docker inspect .Config.Env`
// (docker expands the file client-side into the same env list) — that's an
// accepted trade-off (the wins are off-argv + off `/data`; truly hiding from
// `docker inspect` would need a mounted-file+entrypoint approach we deliberately
// did not build). The agent token may ALSO (if the user accepts) land in
// `~/.librarian/env` via env.ts. The master key is surfaced to stdout exactly
// once and is NEVER written to any host file other than the 0600 deploy env-file.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { readEnvFile, writeEnvFile } from "../env.js";
import { librarianDir } from "../paths.js";
import type { Prompter } from "../prompt.js";
import { fetchLatestVersion } from "../status.js";
import { enableBoot } from "./boot.js";
import {
  deployStatePath,
  readDeployState,
  writeDeployState,
  type DeployState,
} from "./deploy-state.js";
import {
  CANONICAL_IMAGE_NAME,
  prepareRegistryImage,
  isReleasedVersionRef,
  selectDeploymentTarget,
  shortImageDigest,
  type PreparedRegistryImage,
} from "./deployment-image.js";
import { run, stream, which, type RunResult } from "./docker.js";
import { dockerPreflight, sourcePreflight } from "./preflight.js";
import { redactSecrets } from "./redact.js";
import { acquireUpdateLock, updateLockPath } from "./update-lock.js";

// Re-exported from its shared home so existing importers (`update.ts`) keep
// working; new code should import from `./redact.js` directly.
export { redactSecrets } from "./redact.js";

/** The repository the deploy dir clones (same repo the latest-tag fetch targets). */
export const REPO_URL = "https://github.com/code-ministry-ltd/the-librarian";

/** The container name every `server` command operates on (single instance per host). */
export const CONTAINER_NAME = "the-librarian";

/** The named data volume default (`--data-volume` overrides). The volume is sacred. */
export const DEFAULT_DATA_VOLUME = "librarian_data";

/** Host loopback — the default, only-reachable-locally bind (spec §5/§6). */
export const LOCALHOST = "127.0.0.1";

/** Bind-all-interfaces — never the default; ask-first (spec §5.3, §11). */
export const ALL_INTERFACES = "0.0.0.0";

/**
 * The default HOST port the dashboard is published on (`-p <host>:<port>:3000`).
 * 3042 (not 3000) because 3000 is the most collision-prone port on a dev box.
 * The container always listens internally on 3000 — only the published side moves.
 * Overridable per-deploy via `--dashboard-port` (persisted in deploy-state).
 */
export const DEFAULT_DASHBOARD_PORT = 3042;

/**
 * The published dashboard port a deploy-state written BEFORE `dashboardPort`
 * existed is treated as — its historical hard-coded value. `update` uses this so
 * an existing server keeps :3000 (no silent port jump under the operator); only a
 * fresh `up` defaults to {@link DEFAULT_DASHBOARD_PORT}.
 */
export const LEGACY_DASHBOARD_PORT = 3000;

/** The host port the MCP endpoint is published on — `--dashboard-port` may not collide with it. */
export const MCP_PUBLISHED_PORT = 3838;

/**
 * Resolve + validate the dashboard's published host port from the raw `--dashboard-port`
 * flag. Absent/empty → {@link DEFAULT_DASHBOARD_PORT}. Teaching errors (AGENTS.md):
 * must be an integer in `1..65535`, and may not be {@link MCP_PUBLISHED_PORT} (the
 * MCP endpoint already publishes there — both on the same host would clash).
 */
export function resolveDashboardPort(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_DASHBOARD_PORT;
  // Number(...) accepts "3050.5"/"0x..." etc.; require plain digits so a malformed
  // value teaches instead of silently truncating.
  if (!/^\d+$/.test(trimmed)) {
    throw new UpError(
      `Invalid --dashboard-port '${raw}': expected a whole number from 1 to 65535 (e.g. 3042).`,
    );
  }
  const port = Number(trimmed);
  if (port < 1 || port > 65535) {
    throw new UpError(
      `Invalid --dashboard-port '${raw}': a TCP port must be from 1 to 65535 (got ${port}).`,
    );
  }
  if (port === MCP_PUBLISHED_PORT) {
    throw new UpError(
      `--dashboard-port ${port} collides with the MCP endpoint (also published on ${MCP_PUBLISHED_PORT}). ` +
        "Pick a different dashboard port.",
    );
  }
  return port;
}

/** The warning printed beside the one-time master-key surfacing (spec §5.4). */
export const SAVE_KEY_WARNING = "SAVE THIS KEY — excluded from backups";

/**
 * The 0600 deploy env-file fed to `docker run --env-file` (ADR 0008 P4). It
 * lives in the deploy dir (alongside `deploy-state.json`) and carries the agent
 * token + master key + (loopback) `LIBRARIAN_ALLOW_NO_AUTH`. It is DISTINCT from
 * the client `~/.librarian/env` (env.ts). 0600, by construction.
 */
export const DEPLOY_ENV_FILE = "deploy.env";

/** Prefix for invocation-private credentials used while a candidate starts. */
export const STAGED_DEPLOY_ENV_FILE = "deploy.env.next";

/** `<deployDir>/deploy.env` — the 0600 deploy env-file path within a deploy dir. */
export function deployEnvFilePath(deployDir: string): string {
  return path.join(deployDir, DEPLOY_ENV_FILE);
}

/** An invocation-private staged env path, promoted only after health succeeds. */
export function stagedDeployEnvFilePath(deployDir: string, invocationId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(invocationId)) {
    throw new UpError("Could not create a safe invocation ID for the staged deploy env-file.");
  }
  return path.join(deployDir, `${STAGED_DEPLOY_ENV_FILE}-${invocationId}`);
}

export type StagedEnvIdMinter = () => string;

const realStagedEnvIdMinter: StagedEnvIdMinter = () => randomBytes(12).toString("hex");
let stagedEnvIdMinter = realStagedEnvIdMinter;

/** Inject the non-secret staged-file suffix (tests only). */
export function setStagedEnvIdMinter(next: StagedEnvIdMinter): void {
  stagedEnvIdMinter = next;
}

export function resetStagedEnvIdMinter(): void {
  stagedEnvIdMinter = realStagedEnvIdMinter;
}

export type FinalizationRenamer = (source: string, destination: string) => void;

const realFinalizationRenamer: FinalizationRenamer = (source, destination) =>
  fs.renameSync(source, destination);
let finalizationRenamer = realFinalizationRenamer;

/** Inject the two final promotion operations (tests force the second to fail). */
export function setFinalizationRenamer(next: FinalizationRenamer): void {
  finalizationRenamer = next;
}

export function resetFinalizationRenamer(): void {
  finalizationRenamer = realFinalizationRenamer;
}

export type FinalizationRestorer = (file: string, snapshot: FileSnapshot) => void;
let finalizationRestorer: FinalizationRestorer = restoreFile;

/** Inject prior-file restoration failures (tests only). */
export function setFinalizationRestorer(next: FinalizationRestorer): void {
  finalizationRestorer = next;
}

export function resetFinalizationRestorer(): void {
  finalizationRestorer = restoreFile;
}

// --- injectable health-poll sleep ---------------------------------------

/** A sleep used between health polls. Injectable so tests don't actually wait. */
export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let sleepImpl: Sleep = realSleep;

/** Override the health-poll sleep (tests inject a no-op so polling is instant). */
export function setSleep(next: Sleep): void {
  sleepImpl = next;
}

/** Restore the real sleep (tests). */
export function resetSleep(): void {
  sleepImpl = realSleep;
}

// --- injectable agent-token mint ----------------------------------------

/** Mint one CSPRNG agent token. Injectable so tests assert a deterministic value. */
export type TokenMinter = () => string;

const realMinter: TokenMinter = () => randomBytes(32).toString("hex");

let minter: TokenMinter = realMinter;

/** Override the agent-token minter (tests). */
export function setTokenMinter(next: TokenMinter): void {
  minter = next;
}

/** Restore the real CSPRNG minter (tests). */
export function resetTokenMinter(): void {
  minter = realMinter;
}

/**
 * Mint one agent token through the CURRENT minter. Exported so `update` mints a
 * fresh token (when the old container's token can't be read back) via the same
 * injectable seam `up` uses — a single deterministic value in tests.
 */
export function mintAgentToken(): string {
  return minter();
}

// --- injectable master-key mint -----------------------------------------

/**
 * Mint one CSPRNG master key (`LIBRARIAN_SECRET_KEY`). The format MUST be one
 * `resolveSecretKey` (core) accepts — a 64-char hex string — so the server boots
 * with the CLI-supplied key (env wins) and never writes `/data/secret.key`.
 * Injectable so tests assert a deterministic value (mirrors {@link TokenMinter}).
 */
export type SecretKeyMinter = () => string;

const realKeyMinter: SecretKeyMinter = () => randomBytes(32).toString("hex");

let keyMinter: SecretKeyMinter = realKeyMinter;

/** Override the master-key minter (tests). */
export function setSecretKeyMinter(next: SecretKeyMinter): void {
  keyMinter = next;
}

/** Restore the real CSPRNG master-key minter (tests). */
export function resetSecretKeyMinter(): void {
  keyMinter = realKeyMinter;
}

/**
 * Mint one master key through the CURRENT minter. Exported so `update` can mint a
 * fresh key (only when the old container's key can't be read back) via the same
 * injectable seam `up` uses — a single deterministic value in tests.
 */
export function mintSecretKey(): string {
  return keyMinter();
}

// --- options + result ----------------------------------------------------

export interface UpOptions {
  /** Pinned ref (`vX.Y.Z` tag or `main`). Default: the latest release tag. */
  ref?: string | undefined;
  /** Deploy dir override. Default: `~/.librarian/server`. */
  dir?: string | undefined;
  /**
   * Bind host. Default `127.0.0.1` (loopback only). `--host <addr>` sets it
   * explicitly; `0.0.0.0` (all interfaces) is ask-first. An interactive run
   * with no `--host` may be offered a detected Tailscale IP instead (§5.3).
   */
  host?: string | undefined;
  /** Named data volume. Default: `librarian_data`. */
  dataVolume?: string | undefined;
  /**
   * The host port to publish the dashboard on (raw `--dashboard-port` value;
   * resolved + validated by {@link resolveDashboardPort}). Default `3042`.
   * Persisted in deploy-state so `update`/autoupdate reuse it; re-run `up` to
   * change it. The container side stays 3000.
   */
  dashboardPort?: string | undefined;
  /**
   * Bind-mount a host directory at `/data` instead of a Docker named volume — so
   * the vault lives at a path you choose (back it up, put it on a specific disk,
   * copy it to another host). The container runs as the directory's owner
   * (uid:gid) so the data stays owned by, and writable by, the operator rather
   * than the image user. Absolute path; created if missing. Mutually exclusive
   * with `dataVolume`.
   */
  dataDir?: string | undefined;
  /**
   * Enable boot persistence after a successful `up` (S6). On Linux, installs +
   * enables the systemd unit; on macOS, prints the deferred notice and the `up`
   * still succeeds. Opt-in: a plain `up` never enables boot silently.
   */
  enableBoot?: boolean | undefined;
  /** Auto-accept prompts (loop-closer `~/.librarian/env` offer). */
  yes?: boolean | undefined;
  /** Health-wait bound: how many polls before declaring failure (small in tests). */
  healthAttempts?: number | undefined;
  /** Milliseconds between health polls (0 in tests). */
  healthIntervalMs?: number | undefined;
  /** Lines of `docker logs` to surface on a failed health-wait. */
  logTailLines?: number | undefined;
}

export interface UpDeps {
  /** Override home (tests). */
  home?: string | undefined;
  /**
   * Process environment carrying an optional bootstrap-claim secret. Injected
   * in tests so a developer's real environment can never arm a fixture deploy.
   */
  env?: NodeJS.ProcessEnv | undefined;
  /** Prompter for the loop-closer env offer and the bind-host offers. */
  prompter: Prompter;
  /** Platform for preflight's daemon hint. Default `process.platform`. */
  platform?: NodeJS.Platform | undefined;
  /**
   * Whether the run is interactive (a TTY is attached). Gates the best-effort
   * Tailscale offer and the `0.0.0.0` confirm — a non-interactive run never
   * silently exposes the server beyond localhost. Default `true`.
   */
  interactive?: boolean | undefined;
  /**
   * Sink for human-facing PROGRESS lines (a multi-minute `up` was otherwise a
   * blank line — no sense of what's happening or how long). Defaults to a
   * `process.stderr` writer; progress is stderr so it never pollutes the stdout
   * result (the master key). Tests inject a recorder / no-op.
   */
  log?: ((line: string) => void) | undefined;
}

/** A teaching error from `up`; the runtime renders `.message` as one stderr line. */
export class UpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpError";
  }
}

/** Deployment-file promotion failed; tells update whether exact prior bytes were restored. */
export class DeploymentFinalizationError extends UpError {
  constructor(
    message: string,
    readonly priorFilesRestored: boolean,
  ) {
    super(message);
    this.name = "DeploymentFinalizationError";
  }
}

// --- the docker run argv seam -------------------------------------------

export interface RunArgsInput {
  host: string;
  dataVolume: string;
  /** The host port the dashboard is published on (container side stays 3000). */
  dashboardPort: number;
  /** Absolute host path bind-mounted at `/data` instead of the named volume (when set). */
  dataDir?: string | undefined;
  /** `uid:gid` to run the container as — set for a bind-mount so files stay host-owned. */
  runAsUser?: string | undefined;
  /** Restart policy to preserve during update recovery. Fresh deployments default to unless-stopped. */
  restartPolicy?: string | undefined;
  /** Exact local tag or digest-pinned registry reference passed to `docker run`. */
  imageRef: string;
  /**
   * Absolute path to the 0600 deploy env-file ({@link writeDeployEnvFile}). The
   * secrets (`LIBRARIAN_AGENT_TOKEN`, `LIBRARIAN_SECRET_KEY`, and optional
   * `LIBRARIAN_BOOTSTRAP_CLAIM_SECRET`) plus the loopback
   * `LIBRARIAN_ALLOW_NO_AUTH` are delivered via `--env-file <path>`, never
   * inline on argv (ADR 0008 P4).
   */
  envFile: string;
}

/**
 * Construct the `docker run` argv (everything after `docker`). The SINGLE place
 * the run vector is assembled.
 *
 * Secrets are delivered via `--env-file <path>` — NOT inline `-e` — so the agent
 * token, the master key, optional bootstrap-claim secret, and (loopback only)
 * `LIBRARIAN_ALLOW_NO_AUTH` never appear on argv (ADR 0008 P4). `--env-file`
 * keeps them off argv (and out of any argv-echoing error); it does NOT hide
 * them from `docker inspect .Config.Env`
 * (docker expands the file client-side into the same env list) — an accepted
 * trade-off (the wins are off-argv + the master key off `/data`).
 *
 * The image runs `tini` as PID 1, so `--init` is deliberately omitted. The
 * publish address is derived from `host`; the loopback no-auth bypass
 * (`LIBRARIAN_ALLOW_NO_AUTH`) lives INSIDE the env-file (loopback-only — see
 * {@link writeDeployEnvFile}), not on this argv.
 */
export function buildRunArgs(input: RunArgsInput): string[] {
  const {
    host,
    dataVolume,
    dashboardPort,
    dataDir,
    runAsUser,
    restartPolicy = "unless-stopped",
    imageRef,
    envFile,
  } = input;
  const args = [
    "run",
    "-d",
    "--name",
    CONTAINER_NAME,
    "--restart",
    restartPolicy,
    // Publish the dashboard on the chosen HOST port; the container always listens
    // on 3000 internally (image PORT=3000), so only the left side varies.
    "-p",
    `${host}:${dashboardPort}:3000`,
    "-p",
    `${host}:${MCP_PUBLISHED_PORT}:${MCP_PUBLISHED_PORT}`,
    // A host data dir (bind-mount) takes precedence over the named volume.
    "-v",
    `${dataDir ?? dataVolume}:/data`,
    "--env-file",
    envFile,
  ];
  // For a bind-mount, run as the directory's owner so the vault stays owned by —
  // and writable by — the operator, not the image's default user.
  if (runAsUser) args.push("--user", runAsUser);
  args.push(imageRef);
  return args;
}

/** Build the detached candidate configuration without starting it. */
export function buildCreateArgs(input: RunArgsInput): string[] {
  const runArgs = buildRunArgs(input);
  return ["create", ...runArgs.slice(2)];
}

/**
 * The `uid:gid` that owns a path — the user the container runs as for a
 * bind-mounted data dir, so the vault stays host-owned and operator-writable.
 */
export function dirOwner(dir: string): string {
  const st = fs.statSync(dir);
  return `${st.uid}:${st.gid}`;
}

/** The secrets the deploy env-file carries (off argv, into `--env-file`). */
export interface DeployEnvInput {
  /** The agent token (`LIBRARIAN_AGENT_TOKEN`) — minted by `up`, reused by `update`. */
  agentToken: string;
  /**
   * The master key (`LIBRARIAN_SECRET_KEY`). `up` always supplies the CLI-minted
   * key. `update` supplies the PRESERVED key read back from the old container, or
   * OMITS it (undefined/empty) when the old env is unreadable — then the server
   * resolves the key from `/data/secret.key` (env → file → generate), never a
   * destructive fresh mint that would orphan already-encrypted secrets.
   */
  secretKey?: string | undefined;
  /**
   * Optional one-shot first-owner arming secret. It is supplied through the
   * caller's environment, persisted only in this 0600 file, and preserved by
   * `up`/`update` until explicitly removed.
   */
  bootstrapClaimSecret?: string | undefined;
  /**
   * The resolved bind host — drives the loopback-only `LIBRARIAN_ALLOW_NO_AUTH`.
   * `127.0.0.1` → write `LIBRARIAN_ALLOW_NO_AUTH=true` (loopback no-auth bypass);
   * beyond localhost → omit it so /mcp requires the agent token (spec §6).
   */
  host: string;
}

/**
 * Write the 0600 deploy env-file `docker run --env-file` reads, returning its
 * path. It carries `LIBRARIAN_AGENT_TOKEN`, `LIBRARIAN_SECRET_KEY` (when
 * supplied), optional `LIBRARIAN_BOOTSTRAP_CLAIM_SECRET`, and (loopback only)
 * `LIBRARIAN_ALLOW_NO_AUTH=true`. Mode 0600 on create AND an unconditional
 * `chmodSync(0o600)` so a pre-existing looser file is tightened (same discipline
 * as env.ts `writeEnvFile`). The directory is created if missing.
 *
 * Format is `KEY=VALUE` lines (docker's `--env-file` syntax — NOT shell, so no
 * quoting/`export`). The minted secrets are 64-hex with no special chars, so a
 * raw value is safe; we reject a value with a newline (it would corrupt the file
 * / smuggle a second var) rather than emit a malformed file.
 */
function writeDeployEnvFileAt(file: string, input: DeployEnvInput): string {
  const secretKey = input.secretKey?.trim() ?? "";
  const bootstrapClaimSecret = input.bootstrapClaimSecret ?? "";
  for (const [name, value] of [
    ["LIBRARIAN_AGENT_TOKEN", input.agentToken],
    ["LIBRARIAN_SECRET_KEY", secretKey],
    ["LIBRARIAN_BOOTSTRAP_CLAIM_SECRET", bootstrapClaimSecret],
  ] as const) {
    if (/[\r\n]/.test(value)) {
      throw new UpError(`Refusing to write ${name} containing a newline to the deploy env-file.`);
    }
  }
  validateBootstrapClaimSecret(bootstrapClaimSecret);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [`LIBRARIAN_AGENT_TOKEN=${input.agentToken}`];
  // Omit the key line entirely when absent (update's read-back-failed path) — the
  // server then resolves it from /data/secret.key, preserving encrypted secrets.
  if (secretKey) {
    lines.push(`LIBRARIAN_SECRET_KEY=${secretKey}`);
  }
  if (bootstrapClaimSecret) {
    lines.push(`LIBRARIAN_BOOTSTRAP_CLAIM_SECRET=${bootstrapClaimSecret}`);
  }
  if (input.host === LOCALHOST) {
    lines.push("LIBRARIAN_ALLOW_NO_AUTH=true");
  }
  fs.writeFileSync(file, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  // writeFileSync only applies `mode` on create; chmod unconditionally so a
  // pre-existing looser file is tightened (env.ts discipline).
  fs.chmodSync(file, 0o600);
  return file;
}

export function writeDeployEnvFile(deployDir: string, input: DeployEnvInput): string {
  return writeDeployEnvFileAt(deployEnvFilePath(deployDir), input);
}

export function writeStagedDeployEnvFile(deployDir: string, input: DeployEnvInput): string {
  return writeDeployEnvFileAt(stagedDeployEnvFilePath(deployDir, stagedEnvIdMinter()), input);
}

/**
 * Parse an existing deploy env-file into a `KEY=VALUE` record, or `{}` when absent.
 * `up` uses this to REUSE the master key and optional bootstrap-claim secret
 * across re-runs — re-minting the master key would orphan encrypted settings,
 * while dropping the claim secret would silently disarm pending provisioning.
 * `update` also consults this protected file if the old container is unreadable.
 */
export function readDeployEnvFile(deployDir: string): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(deployEnvFilePath(deployDir), "utf8");
  } catch {
    return {}; // absent/unreadable → first deploy (or a wiped deploy dir)
  }
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return out;
}

function validateBootstrapClaimSecret(secret: string): void {
  if (secret.length > 0 && secret.length < 32) {
    throw new UpError("LIBRARIAN_BOOTSTRAP_CLAIM_SECRET must be at least 32 characters when set.");
  }
}

// --- the up flow ---------------------------------------------------------

export interface UpResult {
  /** Human-readable report for stdout (carries the master key ONCE). */
  output: string;
}

/**
 * Run `server up`. Throws `UpError` (teaching message) on any failure; on a
 * failed health-wait it rolls the container back first so no half-up state is
 * left behind. Works for any resolved bind host (loopback / tailnet / all
 * interfaces); the bind choice drives the auth model (§6).
 */
export async function runUp(options: UpOptions, deps: UpDeps): Promise<UpResult> {
  // Progress to stderr (the stdout result carries the master key) so a long `up`
  // shows where it is + what remains, instead of a blank line.
  const log = deps.log ?? ((line: string): void => void process.stderr.write(`${line}\n`));

  // 1) Select before preflight: stable releases need Docker only; arbitrary refs
  // keep the source path's Docker + Git contract.
  const target = selectDeploymentTarget(options.ref);
  const preflightOptions = deps.platform ? { platform: deps.platform } : {};
  if (target.imageSource === "registry") await dockerPreflight(preflightOptions);
  else await sourcePreflight(preflightOptions);

  // 2) Resolve the bind host (default loopback; Tailscale offer; `0.0.0.0`
  //    ask-first). May throw `UpError` if the user declines a `0.0.0.0` bind —
  //    BEFORE any clone/build/run, so a declined exposure leaves nothing behind.
  const host = await resolveBindHost(options, deps);

  // Resolve the published dashboard port (default 3042; teaching error on a bad
  // value or an MCP-port collision) — BEFORE any clone/build/run, so a typo'd
  // port fails fast and leaves nothing behind.
  const dashboardPort = resolveDashboardPort(options.dashboardPort);

  const dataVolume = options.dataVolume ?? DEFAULT_DATA_VOLUME;
  const deployDir = options.dir ?? path.join(librarianDir(deps.home), "server");
  const suppliedBootstrapClaimSecret = (deps.env ?? process.env).LIBRARIAN_BOOTSTRAP_CLAIM_SECRET;
  // Validate before cloning/building so a weak operator credential fails fast
  // and never produces a container that immediately exits at boot.
  validateBootstrapClaimSecret(suppliedBootstrapClaimSecret ?? "");

  // Optional host data directory (bind-mount) instead of the named volume.
  // Mutually exclusive with --data-volume; resolved to an absolute path (docker
  // treats a RELATIVE `-v` source as a volume NAME, not a path) and created if
  // missing. The container then runs as the directory's owner, so the vault stays
  // owned by — and writable by — the operator (a bind-mount shadows the image's
  // build-time chown, so the host ownership is what wins).
  if (options.dataDir && options.dataVolume) {
    throw new UpError(
      "Pass either --data-dir (a host directory) or --data-volume (a Docker volume), not both.",
    );
  }
  // Resolve without creating yet: a registry pull/metadata failure must leave no
  // new host material. Source behavior still creates it before clone/build.
  const dataDir = options.dataDir ? path.resolve(options.dataDir) : undefined;
  if (target.imageSource === "source" && dataDir) fs.mkdirSync(dataDir, { recursive: true });

  // 3) Resolve the ref, then prepare either the immutable registry image or the
  // source checkout/build. Stable failures never fall back to source.
  if (target.imageSource === "registry") {
    log(
      target.ref
        ? `[1/5] Selecting exact published release ${target.ref}…`
        : "[1/5] Resolving the latest published release…",
    );
  } else {
    log(`[1/5] Selecting source ref ${target.ref}…`);
  }
  const tag =
    target.imageSource === "registry"
      ? await resolveRegistryRef(target.ref)
      : await resolveRef(target.ref);

  // The shared deployment lock lives inside deployDir. An initial source clone
  // must therefore happen before acquiring it; otherwise the lockfile itself
  // makes the clone target non-empty. Existing managed clones are prepared
  // under the lock below, alongside the rest of the deployment transaction.
  const sourceNeedsInitialPreparation =
    target.imageSource === "source" && !(await pathExists(path.join(deployDir, ".git")));
  if (sourceNeedsInitialPreparation) {
    log(`[2/5] Preparing the source checkout at ${deployDir} (cloning the repository)…`);
    await prepareDeployDir(deployDir, tag);
  }

  // `server up` and every update path share one host-level critical section.
  // From the first container inspect through env/state finalization, no loser
  // may observe or mutate the winner's deployment files or candidate.
  const deploymentLockPath = updateLockPath({ home: deps.home, dir: options.dir });
  const deploymentLock = acquireUpdateLock(deploymentLockPath);
  if (!deploymentLock) {
    throw new UpError(
      `Another server deployment is already in progress (lock: ${deploymentLockPath}). ` +
        "Wait for it to finish, then re-run `librarian server up`.",
    );
  }
  let lockReleased = false;
  const releaseDeploymentLock = (): void => {
    if (lockReleased) return;
    lockReleased = true;
    deploymentLock.release();
  };
  let completedDeployment:
    | {
        agentToken: string;
        masterKey: string;
        mintedKey: boolean;
        deploymentIdentity: string;
      }
    | undefined;

  try {
    const existingDeployEnv = readDeployEnvFile(deployDir);
    const bootstrapClaimSecret =
      suppliedBootstrapClaimSecret === undefined
        ? existingDeployEnv.LIBRARIAN_BOOTSTRAP_CLAIM_SECRET
        : suppliedBootstrapClaimSecret || undefined;
    validateBootstrapClaimSecret(bootstrapClaimSecret ?? "");
    const existingContainer = await inspectContainerPresence();
    if (existingContainer.exists) {
      if (target.imageSource !== "registry") throw existingContainerError([]);
      const existingState = readDeployState(deployDir);
      const drift = registryDeploymentDrift(
        deployDir,
        tag,
        existingState,
        existingContainer.container,
        {
          host,
          dataVolume,
          dataDir,
          dashboardPort,
          bootstrapClaimSecret,
        },
      );
      if (drift.length > 0) throw existingContainerError(drift);
      if (existingState?.imageSource !== "registry") {
        throw existingContainerError(["persisted deployment state"]);
      }
      log("✓ The requested release is already running and healthy.");
      releaseDeploymentLock();
      return alreadyRunningOutput(
        `published ${tag} (${shortImageDigest(existingState.imageDigest)})`,
        host,
        dashboardPort,
        await enableBootOutput(options, deps),
      );
    }

    let registryImage: PreparedRegistryImage | undefined;
    if (target.imageSource === "registry") {
      log(`[2/5] Pulling and validating ${tag} from the release registry…`);
      registryImage = await prepareRegistryImage(tag, (chunk) => {
        if (deps.log) {
          for (const line of chunk.split("\n")) if (line.length > 0) log(line);
        } else {
          process.stderr.write(chunk);
        }
      });
    } else if (!sourceNeedsInitialPreparation) {
      log(`[2/5] Preparing the source checkout at ${deployDir} (cloning the repository)…`);
      await prepareDeployDir(deployDir, tag);
    }

    if (target.imageSource === "registry" && dataDir) fs.mkdirSync(dataDir, { recursive: true });
    const runAsUser = dataDir ? dirOwner(dataDir) : undefined;

    // 4) Source targets build locally; registry targets are already verified and
    // run only by immutable digest. No credential material is staged until this
    // preparation has succeeded.
    let runImageRef: string;
    if (registryImage) {
      log(`[3/5] Release image verified at ${registryImage.imageDigest}.`);
      runImageRef = registryImage.imageDigest;
    } else {
      log(
        `[3/5] Building source image ${CONTAINER_NAME}:${tag} — the slow step: pulling the base ` +
          `image, installing dependencies, and downloading the embeddings model. Expect several ` +
          `minutes on a first run; live build output follows.`,
      );
      await build(deployDir, tag);
      runImageRef = `${CONTAINER_NAME}:${tag}`;
    }

    // 5) Mint the secrets the CLI owns (the loop-closer). Both are CSPRNG and
    //    NEVER logged: the agent token, and — ADR 0008 P4 — the master key. The
    //    MASTER KEY must NOT be re-minted on a re-run — that orphans every secret
    //    encrypted under the previous key. A candidate env-file is kept separate
    //    from the live one until the new container reports healthy.
    const agentToken = minter();
    const existingKey = existingDeployEnv.LIBRARIAN_SECRET_KEY?.trim() || undefined;
    const masterKey = existingKey ?? mintSecretKey();
    const mintedKey = existingKey === undefined;
    const envFile = writeStagedDeployEnvFile(deployDir, {
      agentToken,
      secretKey: masterKey,
      bootstrapClaimSecret,
      host,
    });
    const nextDeployState: Parameters<typeof writeDeployState>[1] = registryImage
      ? {
          containerName: CONTAINER_NAME,
          host,
          dataVolume,
          dataDir,
          dashboardPort,
          ref: tag,
          imageTag: registryImage.imageRef,
          imageSource: "registry",
          imageRef: registryImage.imageRef,
          imageDigest: registryImage.imageDigest,
        }
      : {
          containerName: CONTAINER_NAME,
          host,
          dataVolume,
          dataDir,
          dashboardPort,
          ref: tag,
          imageTag: `${CONTAINER_NAME}:${tag}`,
          imageSource: "source",
          imageRef: `${CONTAINER_NAME}:${tag}`,
        };

    log("[4/5] Starting the container…");
    const createArgs = buildCreateArgs({
      host,
      dataVolume,
      dashboardPort,
      dataDir,
      runAsUser,
      imageRef: runImageRef,
      envFile,
    });
    let candidateId: string | null = null;
    let healthRollbackComplete = false;
    try {
      const createResult = await run("docker", createArgs, { cwd: deployDir });
      failIfNonZero("docker", createArgs, createResult);
      const returnedId = createResult.stdout.trim();
      if (!/^[0-9a-f]{64}$/.test(returnedId)) {
        throw new UpError(
          "Docker created the candidate container but did not return its full immutable ID. " +
            `Refusing unsafe cleanup by mutable name; inspect ${CONTAINER_NAME} manually before retrying.`,
        );
      }
      candidateId = returnedId;
      const startArgs = ["start", candidateId];
      const startResult = await run("docker", startArgs, { cwd: deployDir });
      failIfNonZero("docker", startArgs, startResult);

      // 6+7) Wait for health. ANY failure in this post-`docker start` phase — a
      //      timeout/unhealthy report or an exception from `docker inspect`/`sleep`
      //      — MUST force-remove the container so no half-up state is left behind
      //      (spec §11). `waitForHealthy` already rolls back on its own
      //      timeout/unhealthy path; this guard catches the throwing cases it
      //      can't. Every cleanup targets the immutable candidate ID.
      //
      //      ADR 0008 P4: the master key is no longer READ BACK from the container
      //      (`docker exec cat /data/secret.key`) — the CLI minted it and supplied
      //      it via env, so the server never writes that file. We surface the
      //      key we minted.
      log("[5/5] Waiting for the server to become healthy…");
      await waitForHealthy({ ...options, containerIdentity: candidateId });
      log("✓ The server is healthy.");

      // Promote the non-secret deploy state and the secret-bearing env-file as
      // one recoverable operation. A failed promotion restores both exact prior
      // files (or their absence) before the candidate is removed.
      finalizeDeploymentFiles(deployDir, envFile, nextDeployState);
      candidateId = null;
    } catch (error) {
      if (error instanceof HealthRollbackCompleteError) {
        healthRollbackComplete = true;
        candidateId = null;
      }
      if (candidateId && !healthRollbackComplete) {
        try {
          await removeAttemptContainer(candidateId);
          candidateId = null;
        } catch (cleanupError) {
          removeStagedEnv(envFile);
          throw cleanupError;
        }
        if (error instanceof CleanupError) {
          removeStagedEnv(envFile);
          throw new UpError(
            "The candidate container could not start or become healthy. The first cleanup " +
              "attempt failed, but a retry " +
              "removed the candidate container; the data volume is untouched. Fix the startup " +
              "cause, then re-run `librarian server up`.",
          );
        }
      }
      removeStagedEnv(envFile);
      throw error;
    }

    completedDeployment = {
      agentToken,
      masterKey,
      mintedKey,
      deploymentIdentity: registryImage
        ? `published ${tag} (${shortImageDigest(registryImage.imageDigest)})`
        : `source ${tag}`,
    };
  } finally {
    releaseDeploymentLock();
  }

  // A successful locked body always assigns this before releasing the lock;
  // every failure throws through the finally above.
  const { agentToken, masterKey, mintedKey, deploymentIdentity } = completedDeployment!;

  // 8) Boot persistence (opt-in, spec §5.8). With `--enable-boot`, install +
  //    enable the systemd unit AFTER a healthy up (so the named container the
  //    unit references actually exists). On macOS this prints the deferred
  //    notice and continues — the `up` still succeeds. The unit references the
  //    EXISTING container by name and carries NO secret (boot.ts).
  const lines = await enableBootOutput(options, deps);

  // 9) Close the loop: surface secrets/URLs + offer the local env write.
  await closeTheLoop(lines, {
    host,
    dashboardPort,
    agentToken,
    masterKey,
    mintedKey,
    deploymentIdentity,
    options,
    deps,
  });

  return { output: lines.join("\n") };
}

// --- bind-host resolution (spec §5.3, §6) -------------------------------

/**
 * Resolve the host the container publishes on:
 *   - `--host <addr>` wins (explicit). `0.0.0.0` is still ask-first.
 *   - no `--host`, interactive, not `--yes`, and `tailscale ip -4` yields a
 *     tailnet IP → OFFER it (default: keep loopback).
 *   - otherwise → `127.0.0.1` (we never silently expose beyond localhost).
 *
 * Binding to `0.0.0.0` requires explicit confirmation (`--yes` auto-accepts);
 * declining aborts with a teaching error BEFORE any clone/build/run.
 */
async function resolveBindHost(options: UpOptions, deps: UpDeps): Promise<string> {
  // An empty/whitespace `--host` (e.g. `--host ""`) is treated as "not provided"
  // rather than slipping through as `""` — which would publish `-p :3000:3000`
  // (ALL interfaces) with no ask-first (I1). Fall through to the default path.
  if (options.host !== undefined && options.host.trim().length > 0) {
    const host = normalizeHost(options.host.trim());
    if (host === ALL_INTERFACES) {
      await confirmAllInterfaces(options, deps);
    } else if (isIpv6Literal(host)) {
      // `::1` already normalized to loopback above; any OTHER IPv6 literal is
      // beyond this slice's scope (the `-p` arg would need bracketing and the
      // exposure path would need IPv6 reasoning). Teach rather than emit a
      // malformed `-p ::ffff:…:3000:3000`.
      throw new UpError(
        `IPv6 bind addresses other than loopback (::1) are not supported yet (got '${host}'). ` +
          "Use an IPv4 address (e.g. a tailnet IP) or '0.0.0.0' to bind all interfaces.",
      );
    }
    return host;
  }

  // No explicit host: best-effort offer the Tailscale IP (interactive only).
  const interactive = deps.interactive ?? true;
  if (interactive && options.yes !== true) {
    const tailnetIp = await detectTailscaleIp();
    if (tailnetIp) {
      const answer = await deps.prompter.promptText(
        `Detected a Tailscale address (${tailnetIp}). Bind the server to it so your ` +
          `tailnet can reach it (instead of localhost only)? [y/N]`,
        { default: "n" },
      );
      if (isYes(answer)) return tailnetIp;
    }
  }

  return LOCALHOST;
}

/**
 * Normalize loopback spellings to the canonical `127.0.0.1` (I3). The server
 * treats `localhost` / `::1` / `127.0.0.1` identically (loopback no-auth bypass),
 * so the CLI must too — otherwise `--host localhost` would omit `ALLOW_NO_AUTH`
 * and needlessly require an agent token for a loopback-only server. Any other
 * value is returned unchanged (the caller decides whether it's allowed).
 */
function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower === "::1" || lower === LOCALHOST) return LOCALHOST;
  return host;
}

/** True for a genuine IPv6 literal (after loopback normalization). */
function isIpv6Literal(host: string): boolean {
  return isIP(host) === 6;
}

/**
 * Confirm an all-interfaces (`0.0.0.0`) bind. `--yes` auto-accepts; otherwise
 * prompt (default no). Declining throws `UpError` — exposing every interface is
 * never something we do without an explicit yes.
 */
async function confirmAllInterfaces(options: UpOptions, deps: UpDeps): Promise<void> {
  if (options.yes === true) return;

  const answer = await deps.prompter.promptText(
    `Binding to 0.0.0.0 exposes the server on ALL network interfaces — anyone who ` +
      `can reach this machine can reach it. Continue? [y/N]`,
    { default: "n" },
  );
  if (!isYes(answer)) {
    throw new UpError(
      "Aborted: binding to 0.0.0.0 (all interfaces) was declined. " +
        "Re-run without --host for a localhost-only server, or with --host <tailnet-ip> " +
        "for a specific reachable address.",
    );
  }
}

/**
 * Best-effort probe for this machine's Tailscale IPv4 address, routed through
 * the injectable `docker.ts` runner (so tests stub it; no real tailscale).
 * Returns `null` when `tailscale` is absent or yields no usable IPv4 — the
 * caller then stays on loopback. Never throws: a probe failure is silent.
 */
async function detectTailscaleIp(): Promise<string | null> {
  if ((await which("tailscale")) === null) return null;
  try {
    const result = await run("tailscale", ["ip", "-4"]);
    if (result.code !== 0) return null;
    // Use `node:net` `isIP` so invalid octets (e.g. `999.1.2.3`) are rejected —
    // a loose `\d{1,3}` regex would accept them (S1).
    const ip = result.stdout
      .split("\n")
      .map((l) => l.trim())
      .find((l) => isIP(l) === 4);
    return ip ?? null;
  } catch {
    return null;
  }
}

// --- step helpers --------------------------------------------------------

/** Resolve the ref to deploy: an explicit `--ref` wins; else the latest tag. */
async function resolveRef(ref: string | undefined): Promise<string> {
  if (ref && ref.trim().length > 0) return ref.trim();
  const latest = await fetchLatestVersion();
  if (!latest) {
    throw new UpError(
      "Could not resolve the latest release tag from GitHub. " +
        "Check your network, or pin a ref with `--ref <tag|main>`.",
    );
  }
  // `fetchLatestVersion` strips the leading `v`; the tag we check out keeps it.
  return `v${latest}`;
}

/** Resolve an omitted stable ref and reject any non-release response fail-closed. */
async function resolveRegistryRef(ref: string | undefined): Promise<string> {
  if (ref !== undefined) return ref;
  const latest = await fetchLatestVersion();
  const candidate = latest ? `v${latest}` : "";
  if (!candidate || !isReleasedVersionRef(candidate)) {
    throw new UpError(
      "Could not resolve a valid latest stable release tag from GitHub. Check your network and " +
        "GitHub availability, or pin an exact stable tag with `--ref vX.Y.Z`. Stable installs " +
        "never fall back to a source build.",
    );
  }
  return candidate;
}

interface DesiredDeploymentConfig {
  host: string;
  dataVolume: string;
  dataDir?: string | undefined;
  dashboardPort: number;
  bootstrapClaimSecret?: string | undefined;
}

interface LiveContainer {
  State?: { Health?: { Status?: unknown } };
  Config?: { Image?: unknown; User?: unknown; Env?: unknown };
  HostConfig?: {
    RestartPolicy?: { Name?: unknown };
    PortBindings?: unknown;
  };
  Mounts?: unknown;
}

type ContainerPresence = { exists: false } | { exists: true; container: LiveContainer };

function verifiedNotFound(result: RunResult, identity = CONTAINER_NAME): boolean {
  const detail = `${result.stdout}\n${result.stderr}`;
  const escapedIdentity = identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`no such (?:object|container):?\\s*${escapedIdentity}(?:\\s|$)`, "i").test(detail) ||
    new RegExp(`no container .*${escapedIdentity}.* found`, "i").test(detail)
  );
}

/** Inspect the fixed container name without treating daemon/permission failures as absence. */
async function inspectContainerPresence(): Promise<ContainerPresence> {
  const result = await run("docker", [
    "container",
    "inspect",
    "--format",
    "{{json .}}",
    CONTAINER_NAME,
  ]);
  if (result.code !== 0) {
    if (verifiedNotFound(result)) return { exists: false };
    const detail = redactSecrets(result.stderr.trim() || result.stdout.trim());
    throw new UpError(
      `Could not inspect the existing ${CONTAINER_NAME} container` +
        (detail ? `: ${detail}` : ".") +
        " Fix Docker access, then re-run `librarian server up`.",
    );
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return { exists: true, container: parsed as LiveContainer };
  } catch {
    throw new UpError(
      `Docker returned malformed metadata for the existing ${CONTAINER_NAME} container. ` +
        "Refusing to replace it; inspect or remove it manually, then re-run `librarian server up`.",
    );
  }
}

function envRecord(value: unknown): Record<string, string> | null {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return null;
  const record: Record<string, string> = {};
  for (const entry of value) {
    const equals = entry.indexOf("=");
    if (equals > 0) record[entry.slice(0, equals)] = entry.slice(equals + 1);
  }
  return record;
}

function exactPortBinding(bindings: unknown, key: string, host: string, port: number): boolean {
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) return false;
  const value = (bindings as Record<string, unknown>)[key];
  return (
    Array.isArray(value) &&
    value.length === 1 &&
    value[0] !== null &&
    typeof value[0] === "object" &&
    !Array.isArray(value[0]) &&
    (value[0] as Record<string, unknown>).HostIp === host &&
    (value[0] as Record<string, unknown>).HostPort === String(port)
  );
}

/** Exact live + persisted identity check performed before any registry access. */
function registryDeploymentDrift(
  deployDir: string,
  ref: string,
  state: DeployState | null,
  container: LiveContainer,
  desired: DesiredDeploymentConfig,
): string[] {
  const drift: string[] = [];
  if (
    !state ||
    state.imageSource !== "registry" ||
    state.ref !== ref ||
    state.imageRef !== `${CANONICAL_IMAGE_NAME}:${ref}` ||
    state.imageTag !== `${CANONICAL_IMAGE_NAME}:${ref}` ||
    !state.imageDigest ||
    state.host !== desired.host ||
    state.dataVolume !== desired.dataVolume ||
    state.dataDir !== desired.dataDir ||
    state.dashboardPort !== desired.dashboardPort
  ) {
    drift.push("persisted deployment state");
  }

  const digest = state?.imageSource === "registry" ? state.imageDigest : undefined;
  if (container.State?.Health?.Status !== "healthy") drift.push("health status");
  if (!digest || container.Config?.Image !== digest) drift.push("image digest");

  const mounts = Array.isArray(container.Mounts)
    ? container.Mounts.filter(
        (mount) =>
          mount !== null &&
          typeof mount === "object" &&
          !Array.isArray(mount) &&
          (mount as Record<string, unknown>).Destination === "/data",
      )
    : [];
  const mount = mounts.length === 1 ? (mounts[0] as Record<string, unknown>) : undefined;
  if (
    !mount ||
    (desired.dataDir
      ? mount.Type !== "bind" || mount.Source !== desired.dataDir
      : mount.Type !== "volume" || mount.Name !== desired.dataVolume)
  ) {
    drift.push("/data mount source or type");
  }

  const bindings = container.HostConfig?.PortBindings;
  if (
    !bindings ||
    typeof bindings !== "object" ||
    Array.isArray(bindings) ||
    Object.keys(bindings).sort().join(",") !== `3000/tcp,${MCP_PUBLISHED_PORT}/tcp` ||
    !exactPortBinding(bindings, "3000/tcp", desired.host, desired.dashboardPort) ||
    !exactPortBinding(bindings, `${MCP_PUBLISHED_PORT}/tcp`, desired.host, MCP_PUBLISHED_PORT)
  ) {
    drift.push("published host or ports");
  }
  if (container.HostConfig?.RestartPolicy?.Name !== "unless-stopped") {
    drift.push("restart policy");
  }

  let expectedUser = "node";
  if (desired.dataDir) {
    try {
      expectedUser = dirOwner(desired.dataDir);
    } catch {
      drift.push("bind-mounted data directory");
    }
  }
  if (container.Config?.User !== expectedUser) drift.push("container user");

  const persistedEnv = readDeployEnvFile(deployDir);
  const liveEnv = envRecord(container.Config?.Env);
  const requiredRuntime: Record<string, string> = {
    LIBRARIAN_DATA_DIR: "/data",
    LIBRARIAN_HOST: ALL_INTERFACES,
    LIBRARIAN_PORT: String(MCP_PUBLISHED_PORT),
    PORT: "3000",
  };
  let envMatches = liveEnv !== null;
  for (const [name, value] of Object.entries(requiredRuntime)) {
    if (liveEnv?.[name] !== value) envMatches = false;
  }
  for (const name of [
    "LIBRARIAN_AGENT_TOKEN",
    "LIBRARIAN_SECRET_KEY",
    "LIBRARIAN_BOOTSTRAP_CLAIM_SECRET",
  ]) {
    const expected = persistedEnv[name];
    if ((liveEnv?.[name] || undefined) !== (expected || undefined)) envMatches = false;
  }
  if (!persistedEnv.LIBRARIAN_AGENT_TOKEN || !persistedEnv.LIBRARIAN_SECRET_KEY) {
    envMatches = false;
  }
  if (
    (persistedEnv.LIBRARIAN_BOOTSTRAP_CLAIM_SECRET || undefined) !==
    (desired.bootstrapClaimSecret || undefined)
  ) {
    envMatches = false;
  }
  const expectedNoAuth = desired.host === LOCALHOST ? "true" : undefined;
  if ((liveEnv?.LIBRARIAN_ALLOW_NO_AUTH || undefined) !== expectedNoAuth) envMatches = false;
  if (!envMatches) drift.push("authentication or runtime environment");

  return drift;
}

async function enableBootOutput(options: UpOptions, deps: UpDeps): Promise<string[]> {
  if (!options.enableBoot) return [];
  const bootResult = await enableBoot(deps.platform ? { platform: deps.platform } : {});
  return [bootResult.output, ""];
}

function existingContainerError(drift: string[]): UpError {
  const detail = drift.length > 0 ? ` (${drift.join(", ")})` : "";
  return new UpError(
    `The existing ${CONTAINER_NAME} container differs from the ` +
      `requested healthy deployment${detail}. Refusing to pull, rewrite credentials, or replace ` +
      "it. Run `librarian server down` if you intend to replace it, then retry.",
  );
}

function alreadyRunningOutput(
  deploymentIdentity: string,
  host: string,
  dashboardPort: number,
  bootLines: string[],
): UpResult {
  const lines = [...bootLines];
  lines.push(
    `The Librarian server is already running and healthy from ${deploymentIdentity}.`,
    "",
    `  MCP URL:     http://${host}:${MCP_PUBLISHED_PORT}/mcp`,
    `  Dashboard:   http://${host}:${dashboardPort}`,
  );
  return { output: lines.join("\n") };
}

export function removeStagedEnv(stagedEnvFile: string): void {
  try {
    fs.rmSync(stagedEnvFile, { force: true });
  } catch {
    // The primary deployment/cleanup error is more useful than a temp-file error.
  }
}

interface FileSnapshot {
  contents: Buffer | null;
  mode?: number | undefined;
}

function snapshotFile(file: string): FileSnapshot {
  try {
    const stat = fs.statSync(file);
    return { contents: fs.readFileSync(file), mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { contents: null };
    throw error;
  }
}

function restoreFile(file: string, snapshot: FileSnapshot): void {
  if (snapshot.contents === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.writeFileSync(file, snapshot.contents, { mode: snapshot.mode });
  if (snapshot.mode !== undefined) fs.chmodSync(file, snapshot.mode);
}

/** Promote env + state as one guarded unit, restoring exact prior bytes on failure. */
export function finalizeDeploymentFiles(
  deployDir: string,
  stagedEnvFile: string,
  state: Parameters<typeof writeDeployState>[1],
): void {
  const liveEnvFile = deployEnvFilePath(deployDir);
  const liveStateFile = deployStatePath(deployDir);
  const priorEnv = snapshotFile(liveEnvFile);
  const priorState = snapshotFile(liveStateFile);
  const stagedStateDir = fs.mkdtempSync(path.join(deployDir, ".deploy-state-next-"));
  const stagedStateFile = deployStatePath(stagedStateDir);
  try {
    writeDeployState(stagedStateDir, state);
    finalizationRenamer(stagedEnvFile, liveEnvFile);
    finalizationRenamer(stagedStateFile, liveStateFile);
  } catch (error) {
    try {
      finalizationRestorer(liveEnvFile, priorEnv);
      finalizationRestorer(liveStateFile, priorState);
    } catch (rollbackError) {
      const detail = redactSecrets(
        rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      );
      throw new DeploymentFinalizationError(
        `Deployment persistence failed and prior files could not be restored${detail ? `: ${detail}` : "."} ` +
          "The candidate container will be removed; restore deploy.env and deploy-state.json from backup before retrying.",
        false,
      );
    }
    const detail = redactSecrets(error instanceof Error ? error.message : String(error));
    throw new DeploymentFinalizationError(
      `Could not finalize deployment persistence${detail ? `: ${detail}` : "."} ` +
        "Prior deploy.env and deploy-state.json content was restored.",
      true,
    );
  } finally {
    try {
      fs.rmSync(stagedStateDir, { recursive: true, force: true });
    } catch {
      // Non-secret staging residue must not override persistence/rollback truth.
    }
  }
}

/**
 * Ready the deploy dir at `tag`:
 *   - absent → `git clone <repo> <dir>` then checkout the ref;
 *   - already OUR managed clone → `git fetch` + checkout the ref;
 *   - exists but isn't our clone (different remote / dirty) → STOP and ask.
 * Never clobbers a dir we didn't create.
 */
async function prepareDeployDir(dir: string, tag: string): Promise<void> {
  const gitDir = path.join(dir, ".git");
  if (!(await pathExists(gitDir))) {
    if (await pathExists(dir)) {
      // A non-empty dir that isn't a git repo → not ours; don't clobber.
      if (!(await isEmptyDir(dir))) {
        throw new UpError(
          `Deploy dir ${dir} exists but is not a Librarian clone (no .git). ` +
            "Refusing to overwrite a directory I didn't create — " +
            "remove it or choose another path with `--dir <path>`.",
        );
      }
    }
    await git(["clone", REPO_URL, dir]);
    await checkoutRef(dir, tag);
    return;
  }

  // It's a git repo — confirm it's OUR clone before touching it.
  const originResult = await run("git", ["-C", dir, "remote", "get-url", "origin"]);
  const origin = originResult.stdout.trim();
  if (!sameRepo(origin, REPO_URL)) {
    throw new UpError(
      `Deploy dir ${dir} is a git repo with a different remote (${origin || "none"}). ` +
        "Refusing to touch a clone I didn't create — choose another path with `--dir <path>`.",
    );
  }
  await git(["-C", dir, "fetch", "--tags", "origin"]);
  await checkoutRef(dir, tag);
}

/** True iff `origin` points at the same repo as `REPO_URL` (scheme/.git tolerant). */
function sameRepo(origin: string, repo: string): boolean {
  const norm = (u: string): string =>
    u
      .trim()
      .replace(/\.git$/, "")
      .replace(/\/$/, "")
      .replace(/^git@github\.com:/, "https://github.com/")
      .toLowerCase();
  return norm(origin) === norm(repo);
}

/**
 * Build the all-in-one image from the deploy dir, STREAMING docker's output live.
 * This is the slow step (base-image pull, deps install, embeddings-model download);
 * the capturing `run` used elsewhere left the user staring at a blank line for
 * minutes. `--progress=plain` keeps the streamed output line-oriented in non-TTY
 * logs. The build context carries NO secret (secrets ride `--env-file` at run-time,
 * not build-time), so forwarding the raw output is safe.
 */
async function build(deployDir: string, tag: string): Promise<void> {
  const args = [
    "build",
    "--progress=plain",
    "-f",
    "docker/all-in-one.Dockerfile",
    "-t",
    `${CONTAINER_NAME}:${tag}`,
    ".",
  ];
  const forward = (chunk: string): void => void process.stderr.write(chunk);
  const code = await stream(
    "docker",
    args,
    { onStdout: forward, onStderr: forward },
    {
      cwd: deployDir,
    },
  );
  if (code !== 0) {
    throw new UpError(
      `\`docker build\` failed (exit ${code ?? "signal"}). ` +
        "Fix the error shown above, then re-run `librarian server up`.",
    );
  }
}

class CleanupError extends UpError {}

class HealthRollbackCompleteError extends UpError {}

/** Remove only the container created by this attempt, and verify the outcome. */
async function removeAttemptContainer(candidateId: string): Promise<void> {
  const result = await run("docker", ["rm", "-f", candidateId]);
  if (result.code === 0 || verifiedNotFound(result, candidateId)) return;
  const detail = redactSecrets(result.stderr.trim() || result.stdout.trim());
  throw new CleanupError(
    `Could not remove failed candidate container ${candidateId}` +
      (detail ? `: ${detail}` : ".") +
      ` The data volume was not removed. Run \`docker rm -f ${candidateId}\` manually, ` +
      "then re-run `librarian server up`.",
  );
}

/**
 * Health-wait tuning shared by `up` and `update` (the bounded poll + log-tail).
 * A subset of `UpOptions` so `update` can reuse {@link waitForHealthy} without
 * importing the whole `UpOptions` shape.
 */
export interface HealthWaitOptions {
  /** Health-wait bound: how many polls before declaring failure (small in tests). */
  healthAttempts?: number | undefined;
  /** Milliseconds between health polls (0 in tests). */
  healthIntervalMs?: number | undefined;
  /** Lines of `docker logs` to surface on a failed health-wait. */
  logTailLines?: number | undefined;
  /** Immutable container ID for owned-candidate cleanup; update omits this for legacy name use. */
  containerIdentity?: string | undefined;
}

/**
 * Poll `docker inspect … Health.Status` until `healthy`, bounded. On timeout or
 * an unhealthy report: surface `docker logs --tail` (REDACTED), roll the
 * container back (`docker rm -f`), and throw — leaving NO half-up container.
 *
 * Exported so `update` recreates with the IDENTICAL health-wait + rollback
 * pattern (a failed recreate force-removes the new container and never advances
 * deploy-state). The thrown `UpError`'s message is already secret-redacted.
 */
export async function waitForHealthy(options: HealthWaitOptions): Promise<void> {
  const attempts = options.healthAttempts ?? 60;
  const intervalMs = options.healthIntervalMs ?? 2000;
  const tail = options.logTailLines ?? 50;
  const identity = options.containerIdentity ?? CONTAINER_NAME;

  // Track whether ANY poll yielded a non-empty status. Snap docker's confinement
  // does not emit stdout to a non-TTY pipe, so every `docker inspect` comes back
  // exit-0-but-EMPTY — health can never be read, the loop times out, and `docker
  // logs` is empty too. We detect that distinct failure and teach, rather than
  // emit the misleading "did not become healthy … (no log output captured)".
  let sawAnyStatus = false;
  let allInspectsOk = true;
  for (let i = 0; i < attempts; i += 1) {
    const result = await run("docker", [
      "inspect",
      "--format",
      "{{.State.Health.Status}}",
      identity,
    ]);
    if (result.code !== 0) allInspectsOk = false; // a failing inspect is NOT the snap signature
    const state = result.stdout.trim();
    if (state.length > 0) sawAnyStatus = true;
    if (state === "healthy") return;
    if (state === "unhealthy") break; // no point waiting out the bound
    if (i < attempts - 1) await sleepImpl(intervalMs);
  }

  // Failed: surface the recent logs for triage, but REDACT first. Post-ADR-0008-P3
  // the server no longer logs an admin token, but the redactor still scrubs the
  // legacy generation line and any `libadmin_`/bearer token in the captured output
  // (defense-in-depth, e.g. an older image) — none of that may reach an error
  // message (spec §5.6 wants logs surfaced, just not secrets). Then roll back so
  // no half-up container survives.
  const logs = await run("docker", ["logs", "--tail", String(tail), identity]);
  await removeAttemptContainer(identity);

  // Conservative snap-docker detection: every `docker inspect` SUCCEEDED (exit 0)
  // yet returned empty output — never a single "starting"/"healthy"/"unhealthy".
  // That exit-0-but-empty shape is snap's pipe confinement; a FAILING inspect
  // (exit ≠ 0) is a different problem and falls through to the normal error below.
  // The container may well be running fine — we just can't see it through snap.
  if (!sawAnyStatus && allInspectsOk) {
    throw new HealthRollbackCompleteError(
      `Could not read the container's health — every \`docker inspect\` returned empty ` +
        `output. That is the signature of snap docker, whose confinement does not emit ` +
        `stdout to a non-TTY pipe, so \`librarian server\` cannot read health or logs (the ` +
        `container itself may be running fine). \`librarian server\` is not supported on snap ` +
        `docker — use native Docker (docker-ce); see the "Use native Docker, not the snap ` +
        `package" note in the self-host guide. The container was rolled back (the data ` +
        `volume is untouched).`,
    );
  }

  const detail = redactSecrets(logs.stdout.trim() || logs.stderr.trim());
  throw new HealthRollbackCompleteError(
    `The server did not become healthy in time and was rolled back ` +
      `(container removed; the data volume is untouched). Recent logs:\n` +
      (detail ? detail : "(no log output captured)") +
      `\n\nFix the cause above, then re-run \`librarian server up\`.`,
  );
}

/**
 * Close the loop: surface the master key ONCE (with the SAVE warning), print the
 * MCP + dashboard URLs and the minted agent token, and OFFER to write this
 * machine's `~/.librarian/env` when it's absent/incomplete (`--yes` auto-accepts).
 *
 * ADR 0008 P4: the master key surfaced here is the one the CLI MINTED (and
 * delivered via the deploy env-file) — it is no longer read back from
 * `/data/secret.key` (the server never writes that file when the key is env-
 * supplied). It is never written to any host file (only the 0600 deploy env-file).
 *
 * ADR 0008 P3: no admin token is surfaced — the admin tRPC API is off the network
 * (internal listener only), so there is no admin token to mint or paste anywhere.
 */
async function closeTheLoop(
  lines: string[],
  ctx: {
    host: string;
    /** The published dashboard port — drives the printed dashboard URL. */
    dashboardPort: number;
    agentToken: string;
    masterKey: string;
    /** True when this run freshly MINTED the master key (vs reused an existing one). */
    mintedKey: boolean;
    /** Selected image strategy + human-readable immutable identity. */
    deploymentIdentity: string;
    options: UpOptions;
    deps: UpDeps;
  },
): Promise<void> {
  const {
    host,
    dashboardPort,
    agentToken,
    masterKey,
    mintedKey,
    deploymentIdentity,
    options,
    deps,
  } = ctx;
  const mcpUrl = `http://${host}:${MCP_PUBLISHED_PORT}/mcp`;
  const dashboardUrl = `http://${host}:${dashboardPort}`;

  lines.push(
    `The Librarian server is up and healthy from ${deploymentIdentity}.`,
    "",
    `  MCP URL:     ${mcpUrl}`,
    `  Dashboard:   ${dashboardUrl}`,
    `  Agent token: ${agentToken}`,
    "",
  );

  // `0.0.0.0` is a bind directive, not a connectable address — point clients at
  // the machine's real reachable IP rather than over-engineering auto-detection.
  if (host === ALL_INTERFACES) {
    // S2: a `--yes` run auto-accepts the all-interfaces bind with no prompt, so
    // print a one-line trace of that exposure — otherwise it's invisible in CI
    // logs (the only record of "we bound every interface, unattended").
    if (options.yes === true) {
      lines.push("Note: binding 0.0.0.0 (all interfaces) — auto-accepted via --yes.", "");
    }
    lines.push(
      "Note: 0.0.0.0 binds every interface but is NOT a connectable address — " +
        "clients should use this machine's reachable LAN/tailnet IP in the URLs above.",
      "",
    );
  }

  lines.push("Paste the MCP URL + agent token into `librarian install` on your clients.", "");
  if (mintedKey) {
    // The ONE-TIME master-key surfacing (the freshly CLI-minted key — ADR 0008 P4).
    // Never written to any host file other than the 0600 deploy env-file.
    lines.push(`Master key (${SAVE_KEY_WARNING}):`, `  ${masterKey}`, "");
  } else {
    // A re-run reusing the existing key: do NOT re-display it (it's unchanged, and
    // re-printing a previously-saved secret adds exposure without value).
    lines.push(
      "Reusing the existing master key from the deploy env-file (unchanged — not re-displayed).",
      "",
    );
  }

  await offerLocalEnv(lines, { mcpUrl, agentToken, options, deps });
}

/**
 * Offer to write this machine's own `~/.librarian/env` (so single-box dev gets
 * server + client in one shot). OFFER, never force: prompt (default no), or
 * auto-accept with `--yes`. Reuses env.ts so the token lands chmod-600 and is
 * never logged. Only offers when the env is absent/incomplete.
 */
async function offerLocalEnv(
  lines: string[],
  ctx: {
    mcpUrl: string;
    agentToken: string;
    options: UpOptions;
    deps: UpDeps;
  },
): Promise<void> {
  const { mcpUrl, agentToken, options, deps } = ctx;
  const existing = readEnvFile(deps.home);
  const complete = Boolean(existing?.mcpUrl && existing?.token);
  if (complete) {
    lines.push("This machine's `~/.librarian/env` is already configured — left as is.");
    return;
  }

  let accepted = options.yes === true;
  if (!accepted) {
    const answer = await deps.prompter.promptText(
      "Write this machine's own ~/.librarian/env so local agents use this server? [y/N]",
      { default: "n" },
    );
    accepted = isYes(answer);
  }

  if (accepted) {
    writeEnvFile({ mcpUrl, token: agentToken }, deps.home);
    lines.push("Wrote ~/.librarian/env (chmod 600) — local agents now point at this server.");
  } else {
    lines.push(
      "Left ~/.librarian/env untouched. Configure a client later with:",
      `  librarian config --mcp-url ${mcpUrl} --token <the agent token above>`,
    );
  }
}

function isYes(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === "y" || a === "yes";
}

// --- thin runner wrappers (teaching errors on a non-zero exit) ----------

/** Run a `git …` command from anywhere; a non-zero exit is a teaching error. */
async function git(args: string[]): Promise<void> {
  const result = await run("git", args);
  failIfNonZero("git", args, result);
}

/**
 * Check out `ref` in `dir` without letting a `--…`-shaped ref inject a git
 * option (S-1). `git checkout` does NOT honor `--end-of-options` — it reads the
 * marker itself as a pathspec (`pathspec '--end-of-options' did not match`,
 * verified on git 2.43), so guarding the ref on the checkout fails outright.
 * `git rev-parse` DOES honor `--end-of-options`, so we resolve the ref to a
 * commit SHA there (the injection guard that actually works), then check out
 * that SHA — a hex object id can never be parsed as an option.
 */
export async function checkoutRef(dir: string, ref: string): Promise<void> {
  const resolved = await run("git", [
    "-C",
    dir,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  failIfNonZero("git", ["-C", dir, "rev-parse", ref], resolved);
  await git(["-C", dir, "checkout", resolved.stdout.trim()]);
}

function failIfNonZero(cmd: string, args: string[], result: RunResult): void {
  if (result.code === 0) return;
  // Redact in case a failed docker/git step echoed a secret-shaped value. Post
  // ADR 0008 P4 the secrets ride in the 0600 deploy env-file (via `--env-file`),
  // NOT inline on argv — so an argv-echoing `build`/`run` failure no longer
  // carries them. We still redact defensively (e.g. a daemon that prints the
  // expanded env, or an older code path) so no 64-hex secret reaches the message.
  const detail = redactSecrets(result.stderr.trim() || result.stdout.trim());
  throw new UpError(
    `\`${cmd} ${args[0]}\` failed (exit ${result.code ?? "signal"})` +
      (detail ? `:\n${detail}` : ".") +
      "\n\nResolve the error above, then re-run `librarian server up`.",
  );
}

// --- tiny fs probes (kept here so the flow stays self-contained) ---------

async function pathExists(p: string): Promise<boolean> {
  const fs = await import("node:fs/promises");
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isEmptyDir(p: string): Promise<boolean> {
  const fs = await import("node:fs/promises");
  try {
    const entries = await fs.readdir(p);
    return entries.length === 0;
  } catch {
    return false;
  }
}
