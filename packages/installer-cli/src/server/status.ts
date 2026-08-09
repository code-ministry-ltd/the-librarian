// `librarian server status` — running? healthy? deployed-vs-latest.
//
// Reports, all from the injectable `docker.ts` runner + the injectable
// latest-release fetcher (so tests never touch a real daemon/network):
//   - container running? (`docker inspect --format {{.State.Status}}`)
//   - health (`docker inspect --format {{.State.Health.Status}}`)
//   - the DEPLOYED provenance — published tag + short digest, source ref, or a
//     legacy ref from old state / `git describe`
//   - the LATEST release (`fetchLatestVersion` — the same fetch `librarian
//     status` uses for the harnesses)
//   - an `up-to-date | update-available` badge via `isBehind(deployed, latest)`
//
// OFFLINE TOLERANCE (mirrors src/status.ts): an unreachable GitHub resolves
// latest to `unknown` and the badge to `?`; an unknown deployed version does the
// same. The command never crashes because the network was down or the deploy dir
// wasn't a git repo — it renders `unknown`/`?` and exits 0.

import path from "node:path";
import { librarianDir } from "../paths.js";
import { isBehind } from "../semver.js";
import { fetchLatestVersion } from "../status.js";
import { readDeployState } from "./deploy-state.js";
import { shortImageDigest } from "./deployment-image.js";
import { run, which } from "./docker.js";
import { dockerPreflight } from "./preflight.js";
import { CONTAINER_NAME } from "./up.js";

export interface ServerStatusOptions {
  /** Override home (tests). */
  home?: string | undefined;
  /** Deploy dir override. Default: `~/.librarian/server`. */
  dir?: string | undefined;
  /** Platform for preflight's daemon hint. Default `process.platform`. */
  platform?: NodeJS.Platform | undefined;
}

export interface ServerStatusResult {
  /** The rendered status report for stdout. */
  output: string;
}

/** The deploy dir `status` reads its recorded provenance / git fallback from. */
function resolveDeployDir(options: ServerStatusOptions): string {
  return options.dir ?? path.join(librarianDir(options.home), "server");
}

/**
 * Read the container's `State.Status` (running / exited / …). Returns `null`
 * when `docker inspect` fails — the container doesn't exist → "not running".
 */
async function inspectField(format: string): Promise<string | null> {
  const result = await run("docker", ["inspect", "--format", format, CONTAINER_NAME]);
  if (result.code !== 0) return null;
  return result.stdout.trim();
}

/**
 * Resolve deployed provenance from state without Git. Old state and a no-state
 * `git describe` fallback remain explicitly labelled legacy because neither
 * records an immutable published digest nor explicit source strategy.
 */
interface DeployedIdentity {
  /** Raw version/ref used for the update badge. */
  ref: string;
  /** Human-readable provenance rendered to the operator. */
  label: string;
  /** Whether comparing this identity with the latest stable release is meaningful. */
  releaseComparable: boolean;
}

async function resolveDeployed(deployDir: string): Promise<DeployedIdentity | null> {
  const state = readDeployState(deployDir);
  if (state?.imageSource === "registry") {
    return {
      ref: state.ref,
      label: `published ${state.ref} (${shortImageDigest(state.imageDigest)})`,
      releaseComparable: true,
    };
  }
  if (state?.imageSource === "source") {
    return { ref: state.ref, label: `source ${state.ref}`, releaseComparable: false };
  }
  if (state?.ref) {
    return { ref: state.ref, label: `legacy ${state.ref}`, releaseComparable: false };
  }

  if ((await which("git")) === null) return null;
  const described = await run("git", ["-C", deployDir, "describe", "--tags"]);
  if (described.code === 0) {
    const tag = described.stdout.trim();
    if (tag) return { ref: tag, label: `legacy ${tag}`, releaseComparable: false };
  }
  return null;
}

/**
 * Run `server status`. Preflights docker, probes the container's running/health
 * state, resolves the deployed + latest versions, and renders the report. Never
 * throws on an offline latest-fetch or an absent deploy dir — those degrade to
 * `unknown`/`?`.
 */
export async function serverStatus(options: ServerStatusOptions = {}): Promise<ServerStatusResult> {
  await dockerPreflight(options.platform ? { platform: options.platform } : {});
  const deployDir = resolveDeployDir(options);

  // Probe the container. A null status means `docker inspect` failed → absent.
  const statusField = await inspectField("{{.State.Status}}");
  const running = statusField === "running";
  // Health is only meaningful when the container exists; an empty health string
  // (no healthcheck, or container absent) renders "unknown".
  const health = statusField === null ? null : await inspectField("{{.State.Health.Status}}");

  const [deployed, latest] = await Promise.all([resolveDeployed(deployDir), fetchLatestVersion()]);

  return { output: render({ statusField, running, health, deployed, latest }) };
}

interface RenderInput {
  statusField: string | null;
  running: boolean;
  health: string | null;
  deployed: DeployedIdentity | null;
  latest: string | null;
}

/**
 * The `up-to-date | update-available | ?` badge. `?` whenever either version is
 * unknown — an offline run never lies about an available update (mirrors the
 * harness `status` table's `update?` column).
 */
function badge(deployed: DeployedIdentity | null, latest: string | null): string {
  if (!deployed?.releaseComparable || !latest) return "?";
  return isBehind(deployed.ref, latest) ? "update-available" : "up-to-date";
}

function render(input: RenderInput): string {
  const { statusField, running, health, deployed, latest } = input;
  const runningLabel = statusField === null ? "not running" : running ? "running" : statusField;
  const healthLabel = health && health.length > 0 ? health : "unknown";

  const lines = [
    `The Librarian server (${CONTAINER_NAME}):`,
    "",
    `  Running:    ${runningLabel}`,
    `  Health:     ${runningLabel === "not running" ? "—" : healthLabel}`,
    `  Deployed:   ${deployed?.label ?? "unknown"}`,
    `  Latest:     ${latest ?? "unknown"}`,
    `  Update:     ${badge(deployed, latest)}`,
  ];

  if (latest === null) {
    lines.push("", "latest release unknown (could not reach GitHub) — Update shows ?");
  }
  return lines.join("\n");
}
