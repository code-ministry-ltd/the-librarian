// Preflight for the `server` command group.
//
// Every `server` subcommand that directly drives a container (up / update /
// down / status / logs / admin) first confirms the host actually has the tools
// it needs: `docker` installed AND its daemon reachable. Source deployments
// additionally require `git`; registry-backed and Docker-only commands do not.
// A missing or unreachable tool is a TEACHING error (what to install, or "is
// the daemon running?") — never a stack trace, never a bare "error".
//
// The check goes through the `docker.ts` seam, so tests stub it and a real
// daemon is never contacted. `platform` is injectable so the macOS-specific
// "Docker Desktop" hint is testable on any host.

import { run, which } from "./docker.js";

/**
 * A preflight failure carrying an actionable, teaching message. The CLI
 * runtime renders `error.message` as one clean stderr line (no stack trace),
 * so this message IS what the user reads.
 */
export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightError";
  }
}

export interface PreflightOptions {
  /**
   * The host platform, defaulting to `process.platform`. Injectable so the
   * macOS "Docker Desktop" daemon hint is testable from any host.
   */
  platform?: NodeJS.Platform;
}

const DOCKER_INSTALL =
  "Docker is required but was not found on your PATH. " +
  "Install Docker Engine (Linux) or Docker Desktop (macOS) — " +
  "see https://docs.docker.com/get-docker/ — then re-run this command.";

const GIT_INSTALL =
  "git is required but was not found on your PATH. " +
  "Install git (e.g. `apt install git`, `brew install git`, or " +
  "https://git-scm.com/downloads), then re-run this command.";

function dockerDaemonHint(platform: NodeJS.Platform): string {
  const start =
    platform === "darwin"
      ? "Is Docker Desktop running? Start Docker Desktop and wait for it to report ready, then re-run this command."
      : "Is the Docker daemon running? Start it (e.g. `sudo systemctl start docker`) and confirm `docker info` succeeds, then re-run this command.";
  return `Docker is installed but its daemon is unreachable. ${start}`;
}

/**
 * Confirm `docker` is installed with a reachable daemon, or throw a teaching
 * `PreflightError`. Resolves to nothing on success.
 *
 * Order matters: report a missing binary before probing the daemon, so a host
 * without Docker is told to install it (not told the daemon is down).
 */
export async function dockerPreflight(options: PreflightOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;

  if ((await which("docker")) === null) {
    throw new PreflightError(DOCKER_INSTALL);
  }

  // Daemon probe: `docker info` exits non-zero (and prints to stderr) when the
  // engine isn't reachable. We only care about the exit code here.
  const info = await run("docker", ["info"]);
  if (info.code !== 0) {
    throw new PreflightError(dockerDaemonHint(platform));
  }
}

/** Confirm Docker plus Git for a lifecycle path that operates on source. */
export async function sourcePreflight(options: PreflightOptions = {}): Promise<void> {
  await dockerPreflight(options);
  if ((await which("git")) === null) {
    throw new PreflightError(GIT_INSTALL);
  }
}
