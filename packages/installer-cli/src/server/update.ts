// `librarian server update` — prepare an immutable replacement while the current
// service keeps serving, then replace it as a recoverable transition.

import fs from "node:fs";
import path from "node:path";
import type { FlagValue } from "../parse-args.js";
import { librarianDir } from "../paths.js";
import {
  dnsAllowsNoOp,
  dnsConfigFromServers,
  dnsFlagsSpecified,
  dnsServersForReplacement,
  nameserverTuple,
  parseDnsFlag,
  parseLiveDns,
  resolveDnsConfig,
} from "./dns.js";
import { fetchLatestVersion } from "../status.js";
import { type DeployState, readDeployState } from "./deploy-state.js";
import {
  prepareRegistryImage,
  selectDeploymentTarget,
  shortImageDigest,
  type DeploymentTarget,
  type PreparedRegistryImage,
} from "./deployment-image.js";
import { run, stream, type RunResult } from "./docker.js";
import { dockerPreflight, sourcePreflight } from "./preflight.js";
import { redactSecrets } from "./redact.js";
import { isCanonicalSourceRemote, redactGitDiagnostics } from "./source-repository.js";
import {
  buildCreateArgs,
  CONTAINER_NAME,
  DeploymentFinalizationError,
  finalizeDeploymentFiles,
  LEGACY_DASHBOARD_PORT,
  mintAgentToken,
  readDeployEnvFile,
  REPO_URL,
  writeStagedDeployEnvFile,
} from "./up.js";
import { acquireUpdateLock, UpdateInProgressError, updateLockPath } from "./update-lock.js";

export interface UpdateOptions {
  ref?: string | undefined;
  yes?: boolean | undefined;
  dir?: string | undefined;
  home?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  healthAttempts?: number | undefined;
  healthIntervalMs?: number | undefined;
  logTailLines?: number | undefined;
  /** Raw `--dns` / `--no-dns`. Parsed by {@link parseDnsFlag}. */
  dns?: FlagValue | undefined;
  /** Raw `--dns-fallback` / `--no-dns-fallback`. */
  dnsFallback?: FlagValue | undefined;
}

export class UpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateError";
  }
}

export interface UpdateResult {
  output: string;
  /** True only when a replacement completed; false for an exact healthy no-op. */
  changed: boolean;
}

interface LiveContainer {
  Id?: unknown;
  Image?: unknown;
  State?: { Status?: unknown; Health?: { Status?: unknown } };
  Config?: { Image?: unknown; User?: unknown; Env?: unknown };
  HostConfig?: {
    RestartPolicy?: { Name?: unknown };
    PortBindings?: unknown;
    Dns?: unknown;
  };
  Mounts?: unknown;
}

interface PreservedConfig {
  immutableContainerId: string;
  immutableImageId: string;
  configuredImage: string;
  host: string;
  dashboardPort: number;
  dataVolume: string;
  dataDir?: string | undefined;
  runAsUser?: string | undefined;
  restartPolicy: string;
  env: Map<string, string>;
  healthy: boolean;
  /** Live `HostConfig.Dns` (empty = Docker default). Used for recovery and adopt-on-recreate. */
  dnsServers: string[];
}

interface PreparedTarget {
  ref: string;
  imageSource: "registry" | "source";
  runImageRef: string;
  imageRef: string;
  imageDigest?: string | undefined;
  cwd: string;
}

interface SourceResolution {
  checkout: string;
  commit: string;
  imageTag: string;
}

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const CONTAINER_ID = /^[0-9a-f]{64}$/;
type Redactor = (text: string) => string;

export type UpdateSecretArtifactRemover = (file: string) => void;
const realUpdateSecretArtifactRemover: UpdateSecretArtifactRemover = (file) =>
  fs.rmSync(file, { force: true });
let updateSecretArtifactRemover = realUpdateSecretArtifactRemover;

export function setUpdateSecretArtifactRemover(next: UpdateSecretArtifactRemover): void {
  updateSecretArtifactRemover = next;
}

export function resetUpdateSecretArtifactRemover(): void {
  updateSecretArtifactRemover = realUpdateSecretArtifactRemover;
}

class RecoveryAttemptError extends Error {
  constructor(
    message: string,
    readonly ownedContainerId: string,
  ) {
    super(message);
    this.name = "RecoveryAttemptError";
  }
}

export async function runUpdate(options: UpdateOptions = {}): Promise<UpdateResult> {
  const target = selectDeploymentTarget(options.ref);
  const preflight = options.platform ? { platform: options.platform } : {};
  if (target.imageSource === "registry") await dockerPreflight(preflight);
  else await sourcePreflight(preflight);

  const deployDir = options.dir ?? path.join(librarianDir(options.home), "server");
  const lockPath = updateLockPath({ home: options.home, dir: options.dir });
  const lock = acquireUpdateLock(lockPath);
  if (!lock) throw new UpdateInProgressError(lockPath);
  try {
    // State is read only after winning the same lifecycle lock used by `up`, so
    // it cannot go stale behind a concurrent file/container finalization.
    const state = readDeployState(deployDir);
    if (!state) {
      throw new UpdateError(
        `No deploy-state found at ${deployDir} — this host has not run \`librarian server up\` ` +
          "(or the deploy dir is wrong). Run `librarian server up` first, or pass `--dir <path>`.",
      );
    }
    return await performUpdate(options, deployDir, state, target);
  } finally {
    lock.release();
  }
}

async function performUpdate(
  options: UpdateOptions,
  deployDir: string,
  state: DeployState,
  target: DeploymentTarget,
): Promise<UpdateResult> {
  const targetRef = await resolveTargetRef(target);
  // A moving source ref must be fetched and resolved before idempotency. The
  // checkout may move while the current service continues serving; no image is
  // built and no credential/container state is touched yet.
  const sourceResolution =
    target.imageSource === "source" ? await resolveSourceTarget(deployDir, targetRef) : undefined;
  const current = await inspectCurrentContainer(state);
  const dnsOption = parseDnsFlag(options.dns, "--dns");
  const dnsFallbackOption = parseDnsFlag(options.dnsFallback, "--dns-fallback");
  const flagsSpecified = dnsFlagsSpecified(dnsOption, dnsFallbackOption);
  const resolvedDns = resolveDnsConfig({
    dns: dnsOption,
    dnsFallback: dnsFallbackOption,
    stored: { dns: state.dns, dnsFallback: state.dnsFallback },
  });
  const replacementDns = dnsServersForReplacement({
    flagsSpecified,
    resolved: resolvedDns,
    live: current.dnsServers,
  });
  const storedDns = nameserverTuple({ dns: state.dns, dnsFallback: state.dnsFallback });

  // Registry no-op is before a pull. Source no-op compares the fetched commit's
  // deterministic tag and its current immutable image ID, so `main` advancing
  // cannot be mistaken for an already-current deployment.
  const exactTarget = sourceResolution
    ? await isExactHealthySourceTarget(state, targetRef, current, deployDir, sourceResolution)
    : isExactHealthyRegistryTarget(state, targetRef, current, deployDir);
  if (
    exactTarget &&
    dnsAllowsNoOp({
      flagsSpecified,
      stored: storedDns,
      live: current.dnsServers,
      desired: replacementDns,
    })
  ) {
    const identity =
      target.imageSource === "registry" && state.imageSource === "registry"
        ? `published ${targetRef} (${shortImageDigest(state.imageDigest)})`
        : `source ${targetRef}`;
    return {
      output: `Already up to date (${identity}) — the exact deployment is healthy.\nNothing to do.`,
      changed: false,
    };
  }

  const prepared = await prepareTarget(target.imageSource, targetRef, deployDir, sourceResolution);

  // Finish all local, fallible preparation before interrupting the old service.
  const persisted = readDeployEnvFile(deployDir);
  const agentToken =
    current.env.get("LIBRARIAN_AGENT_TOKEN") ?? persisted.LIBRARIAN_AGENT_TOKEN ?? mintAgentToken();
  const secretKey =
    current.env.get("LIBRARIAN_SECRET_KEY") ?? persisted.LIBRARIAN_SECRET_KEY ?? undefined;
  const bootstrapClaimSecret =
    current.env.get("LIBRARIAN_BOOTSTRAP_CLAIM_SECRET") ??
    persisted.LIBRARIAN_BOOTSTRAP_CLAIM_SECRET ??
    undefined;
  const tokenIsFresh =
    !current.env.has("LIBRARIAN_AGENT_TOKEN") && !persisted.LIBRARIAN_AGENT_TOKEN;
  const stagedEnv = writeStagedDeployEnvFile(deployDir, {
    agentToken,
    secretKey,
    bootstrapClaimSecret,
    host: current.host,
  });
  const priorRecoveryEnv = `${stagedEnv}.previous`;
  try {
    writePriorRecoveryEnv(priorRecoveryEnv, current.env);
  } catch (error) {
    const warning = cleanupSecretArtifact(stagedEnv);
    throw new UpdateError(`${errorDetail(error)}${warning ? ` ${warning}` : ""}`);
  }
  const redact = valueAwareRedactor([
    agentToken,
    secretKey,
    bootstrapClaimSecret,
    current.env.get("LIBRARIAN_AGENT_TOKEN"),
    current.env.get("LIBRARIAN_SECRET_KEY"),
    current.env.get("LIBRARIAN_BOOTSTRAP_CLAIM_SECRET"),
  ]);

  const nextState: Parameters<typeof finalizeDeploymentFiles>[2] =
    prepared.imageSource === "registry"
      ? {
          containerName: state.containerName,
          host: current.host,
          dataVolume: current.dataVolume,
          dataDir: current.dataDir,
          dashboardPort: current.dashboardPort,
          ref: prepared.ref,
          imageTag: prepared.imageRef,
          imageSource: "registry",
          imageRef: prepared.imageRef,
          imageDigest: prepared.imageDigest!,
          ...dnsConfigFromServers(replacementDns),
        }
      : {
          containerName: state.containerName,
          host: current.host,
          dataVolume: current.dataVolume,
          dataDir: current.dataDir,
          dashboardPort: current.dashboardPort,
          ref: prepared.ref,
          imageTag: prepared.imageRef,
          imageSource: "source",
          imageRef: prepared.imageRef,
          ...dnsConfigFromServers(replacementDns),
        };

  let oldRemoved = false;
  let candidateId: string | null = null;
  let migrationStarted = false;
  let successCleanupWarning: string | null = null;
  try {
    await stopCurrent(current.immutableContainerId, redact);
    await removeCurrent(current.immutableContainerId, redact);
    oldRemoved = true;

    candidateId = await createContainer(
      prepared.runImageRef,
      { ...current, dnsServers: replacementDns },
      stagedEnv,
      prepared.cwd,
      redact,
    );
    await startContainer(candidateId, prepared.cwd, redact);
    await waitForHealth(candidateId, options, redact);

    migrationStarted = true;
    await execMigration(candidateId, redact);

    finalizeDeploymentFiles(deployDir, stagedEnv, nextState);
    candidateId = null;
    successCleanupWarning = cleanupSecretArtifact(priorRecoveryEnv);
  } catch (primary) {
    const primaryMessage = errorDetail(primary, redact);
    const priorFilesRestored =
      !(primary instanceof DeploymentFinalizationError) || primary.priorFilesRestored;
    if (candidateId) {
      const ownedCandidateId = candidateId;
      try {
        await removeOwnedContainer(ownedCandidateId, redact);
        candidateId = null;
      } catch (cleanupError) {
        throw recoveryFailure(
          primaryMessage,
          errorDetail(cleanupError, redact),
          current,
          priorRecoveryEnv,
          migrationStarted,
          true,
          priorFilesRestored,
          ownedCandidateId,
        );
      }
    }

    try {
      if (oldRemoved) {
        await recreatePrevious(current, priorRecoveryEnv, deployDir, options, redact);
      } else {
        await restartPrevious(current.immutableContainerId, options, redact);
      }
    } catch (recoveryError) {
      // Keep the protected staged env-file: the printed recovery command uses it.
      throw recoveryFailure(
        primaryMessage,
        errorDetail(recoveryError, redact),
        current,
        priorRecoveryEnv,
        migrationStarted,
        oldRemoved,
        priorFilesRestored,
        recoveryError instanceof RecoveryAttemptError ? recoveryError.ownedContainerId : undefined,
      );
    }
    const cleanupWarnings = [cleanupSecretArtifact(stagedEnv)];
    if (priorFilesRestored) cleanupWarnings.push(cleanupSecretArtifact(priorRecoveryEnv));
    throw recoveredFailure(
      primaryMessage,
      migrationStarted,
      priorFilesRestored,
      priorRecoveryEnv,
      cleanupWarnings.filter((warning): warning is string => warning !== null),
    );
  }

  return {
    output: [renderSuccess(prepared, tokenIsFresh ? agentToken : null), successCleanupWarning]
      .filter(Boolean)
      .join("\n"),
    changed: true,
  };
}

async function resolveTargetRef(target: DeploymentTarget): Promise<string> {
  if (target.imageSource === "source") return target.ref;
  if (target.ref) return target.ref;
  const latest = await fetchLatestVersion();
  if (!latest) {
    throw new UpdateError(
      "Could not resolve the latest stable release from GitHub. Check the network, or pin " +
        "`--ref vX.Y.Z`. Stable updates never fall back to a source build.",
    );
  }
  return `v${latest}`;
}

async function prepareTarget(
  imageSource: "registry" | "source",
  ref: string,
  deployDir: string,
  sourceResolution?: SourceResolution | undefined,
): Promise<PreparedTarget> {
  if (imageSource === "registry") {
    let image: PreparedRegistryImage;
    try {
      image = await prepareRegistryImage(ref, (chunk) => void process.stderr.write(chunk));
    } catch (error) {
      throw new UpdateError(
        errorDetail(error).replaceAll("librarian server up", "librarian server update"),
      );
    }
    return {
      ref,
      imageSource,
      runImageRef: image.imageDigest,
      imageRef: image.imageRef,
      imageDigest: image.imageDigest,
      cwd: deployDir,
    };
  }

  if (!sourceResolution) throw new UpdateError("Internal error: source target was not resolved.");
  await buildSourceImage(sourceResolution.checkout, sourceResolution.imageTag);
  const immutableImageId = await inspectSourceImageId(sourceResolution.imageTag, true);
  return {
    ref,
    imageSource,
    runImageRef: immutableImageId!,
    imageRef: sourceResolution.imageTag,
    cwd: sourceResolution.checkout,
  };
}

async function inspectCurrentContainer(state: DeployState): Promise<PreservedConfig> {
  const args = ["container", "inspect", "--format", "{{json .}}", CONTAINER_NAME];
  const result = await run("docker", args);
  if (result.code !== 0) {
    throw new UpdateError(
      `Could not inspect the current ${CONTAINER_NAME} container before update` +
        detailSuffix(result) +
        " The existing deployment and state were left untouched; run `librarian server up` if it is absent.",
    );
  }
  let live: LiveContainer;
  try {
    const parsed: unknown = JSON.parse(result.stdout.trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    live = parsed as LiveContainer;
  } catch {
    throw new UpdateError(
      "Docker returned malformed metadata for the current container. Refusing to interrupt it.",
    );
  }

  const immutableImageId = typeof live.Image === "string" ? live.Image : "";
  const immutableContainerId = typeof live.Id === "string" ? live.Id : "";
  const configuredImage = typeof live.Config?.Image === "string" ? live.Config.Image : "";
  if (
    !CONTAINER_ID.test(immutableContainerId) ||
    !IMAGE_ID.test(immutableImageId) ||
    !configuredImage
  ) {
    throw new UpdateError(
      "Docker did not report the current container's full immutable image ID. Refusing an update that could not restore the previous executable.",
    );
  }
  const ports = preservedPorts(live.HostConfig?.PortBindings);
  const mount = preservedMount(live.Mounts, state.dataVolume);
  const restartPolicy = live.HostConfig?.RestartPolicy?.Name;
  if (typeof restartPolicy !== "string" || !restartPolicy) {
    throw new UpdateError(
      "Docker did not report the current restart policy. Refusing an update that could drift container configuration.",
    );
  }
  return {
    immutableContainerId,
    immutableImageId,
    configuredImage,
    host: ports.host,
    dashboardPort: ports.dashboardPort,
    dataVolume: mount.dataVolume,
    dataDir: mount.dataDir,
    runAsUser:
      typeof live.Config?.User === "string" && live.Config.User ? live.Config.User : undefined,
    restartPolicy,
    env: envMap(live.Config?.Env),
    healthy: live.State?.Status === "running" && live.State?.Health?.Status === "healthy",
    dnsServers: parseLiveDns(live.HostConfig?.Dns),
  };
}

function preservedPorts(value: unknown): { host: string; dashboardPort: number } {
  const record = objectRecord(value);
  const dashboard = oneBinding(record["3000/tcp"], "dashboard");
  const mcp = oneBinding(record["3838/tcp"], "MCP");
  if (dashboard.host !== mcp.host || mcp.port !== 3838) {
    throw new UpdateError(
      "The current dashboard/MCP port bindings are not a supported Librarian configuration. Refusing to replace it or change its exposure.",
    );
  }
  return { host: dashboard.host, dashboardPort: dashboard.port };
}

function oneBinding(value: unknown, label: string): { host: string; port: number } {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new UpdateError(`Docker did not report exactly one ${label} host-port binding.`);
  }
  const binding = objectRecord(value[0]);
  const host = typeof binding.HostIp === "string" ? binding.HostIp : "";
  const rawPort = typeof binding.HostPort === "string" ? binding.HostPort : "";
  const port = Number(rawPort);
  if (!host || !/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UpdateError(`Docker returned an invalid ${label} host-port binding.`);
  }
  return { host, port };
}

function preservedMount(
  value: unknown,
  fallbackVolume: string,
): { dataVolume: string; dataDir?: string | undefined } {
  const mounts = Array.isArray(value)
    ? value.filter((entry) => objectRecord(entry).Destination === "/data")
    : [];
  if (mounts.length !== 1) {
    throw new UpdateError("Docker did not report exactly one /data mount. Refusing to risk data.");
  }
  const mount = objectRecord(mounts[0]);
  if (mount.Type === "bind" && typeof mount.Source === "string" && mount.Source) {
    return { dataVolume: fallbackVolume, dataDir: mount.Source };
  }
  if (mount.Type === "volume" && typeof mount.Name === "string" && mount.Name) {
    return { dataVolume: mount.Name };
  }
  throw new UpdateError(
    "The current /data mount is neither a named volume nor an absolute bind mount. Refusing to replace it.",
  );
}

function hasExactHealthyConfiguration(
  state: DeployState,
  requestedSource: "registry" | "source",
  ref: string,
  current: PreservedConfig,
  deployDir: string,
): boolean {
  const stateSource = state.imageSource ?? "source";
  if (!current.healthy || stateSource !== requestedSource || state.ref !== ref) return false;
  if (state.host !== current.host) return false;
  if ((state.dashboardPort ?? LEGACY_DASHBOARD_PORT) !== current.dashboardPort) return false;
  if ((state.dataDir ?? undefined) !== current.dataDir) return false;
  if (!current.dataDir && state.dataVolume !== current.dataVolume) return false;
  // Update preserves the live container's validated user and restart policy,
  // including operator customisations. Those fields are not in deploy state,
  // so requiring the `up` defaults here would replace the same target forever.
  const persisted = readDeployEnvFile(deployDir);
  const requiredRuntime: Record<string, string> = {
    LIBRARIAN_DATA_DIR: "/data",
    LIBRARIAN_HOST: "0.0.0.0",
    LIBRARIAN_PORT: "3838",
    PORT: "3000",
  };
  for (const [name, value] of Object.entries(requiredRuntime)) {
    if (current.env.get(name) !== value) return false;
  }
  for (const name of [
    "LIBRARIAN_AGENT_TOKEN",
    "LIBRARIAN_SECRET_KEY",
    "LIBRARIAN_BOOTSTRAP_CLAIM_SECRET",
    "LIBRARIAN_ALLOW_NO_AUTH",
  ]) {
    if ((current.env.get(name) || undefined) !== (persisted[name] || undefined)) return false;
  }
  return Boolean(persisted.LIBRARIAN_AGENT_TOKEN);
}

function isExactHealthyRegistryTarget(
  state: DeployState,
  ref: string,
  current: PreservedConfig,
  deployDir: string,
): boolean {
  return (
    hasExactHealthyConfiguration(state, "registry", ref, current, deployDir) &&
    state.imageSource === "registry" &&
    Boolean(state.imageDigest) &&
    current.configuredImage === state.imageDigest
  );
}

async function isExactHealthySourceTarget(
  state: DeployState,
  ref: string,
  current: PreservedConfig,
  deployDir: string,
  source: SourceResolution,
): Promise<boolean> {
  if (!hasExactHealthyConfiguration(state, "source", ref, current, deployDir)) return false;
  if (state.imageSource !== "source" || state.imageRef !== source.imageTag) return false;
  const taggedImageId = await inspectSourceImageId(source.imageTag, false);
  return (
    taggedImageId !== null &&
    taggedImageId === current.immutableImageId &&
    current.configuredImage === current.immutableImageId
  );
}

async function resolveSourceTarget(deployDir: string, ref: string): Promise<SourceResolution> {
  assertLiteralSourceRef(ref);
  const rootGit = path.join(deployDir, ".git");
  const checkout = fs.existsSync(rootGit) ? deployDir : path.join(deployDir, "source");
  if (!fs.existsSync(path.join(checkout, ".git"))) {
    if (fs.existsSync(checkout) && fs.readdirSync(checkout).length > 0) {
      throw new UpdateError(
        `Managed source checkout ${checkout} is non-empty but is not a git clone. Refusing to overwrite it.`,
      );
    }
    await checked("git", ["clone", REPO_URL, checkout], redactGitDiagnostics);
  } else {
    const remote = await run("git", ["-C", checkout, "remote", "get-url", "origin"]);
    checkedResult("git", ["remote", "get-url", "origin"], remote, redactGitDiagnostics);
    if (!isCanonicalSourceRemote(remote.stdout)) {
      throw new UpdateError(
        `Managed source checkout ${checkout} has an unexpected origin; refusing to modify it. ` +
          "Set origin to the canonical repository or use a different deploy directory.",
      );
    }
  }
  const statusArgs = ["-C", checkout, "status", "--porcelain", "--untracked-files=all"];
  const status = await run("git", statusArgs);
  checkedResult("git", statusArgs, status, redactGitDiagnostics);
  if (hasUserCheckoutChanges(status.stdout)) {
    throw new UpdateError(
      `Managed source checkout ${checkout} has local tracked or untracked changes. ` +
        "The current container is still serving; commit, stash, or move those files before retrying.",
    );
  }
  await checked("git", ["-C", checkout, "fetch", "--tags", "origin"], redactGitDiagnostics);
  const commit = await resolveSourceCommit(checkout, ref);
  await checked("git", ["-C", checkout, "checkout", commit], redactGitDiagnostics);
  return {
    checkout,
    commit,
    imageTag: `${CONTAINER_NAME}:source-${commit}`,
  };
}

async function resolveSourceCommit(checkout: string, ref: string): Promise<string> {
  const candidates = [`refs/remotes/origin/${ref}^{commit}`, `refs/tags/${ref}^{commit}`];
  if (/^[0-9a-f]{40}$/i.test(ref)) candidates.push(`${ref}^{commit}`);
  let last: RunResult | undefined;
  for (const candidate of candidates) {
    const result = await run("git", [
      "-C",
      checkout,
      "rev-parse",
      "--verify",
      "--end-of-options",
      candidate,
    ]);
    last = result;
    const commit = result.stdout.trim();
    if (result.code === 0 && /^[0-9a-f]{40}$/.test(commit)) return commit;
  }
  throw new UpdateError(
    `Could not resolve source ref '${ref}' to a full commit after fetching origin` +
      (last ? detailSuffix(last, redactGitDiagnostics) : ".") +
      " Check the branch, tag, or commit and retry.",
  );
}

function assertLiteralSourceRef(ref: string): void {
  const components = ref.split("/");
  const forbiddenCharacter = [...ref].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return (
      codePoint <= 0x20 ||
      codePoint === 0x7f ||
      ["~", "^", ":", "?", "*", "[", "\\"].includes(character)
    );
  });
  const invalidShape =
    !ref ||
    ref === "@" ||
    ref.startsWith("-") ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.includes("@{") ||
    components.some((component) => component.startsWith(".") || component.endsWith(".lock"));
  if (forbiddenCharacter || invalidShape) {
    throw new UpdateError(
      "Source --ref must be a literal branch name, tag name, or full 40-character commit SHA; " +
        "Git revision expressions such as '~', '^', and '@{' are not accepted.",
    );
  }
}

function hasUserCheckoutChanges(porcelain: string): boolean {
  // In legacy deployments the managed clone itself is the deploy directory.
  // These exact untracked files are owned by the CLI and necessarily coexist
  // with source. The lock exists during this check. Do not ignore staged env,
  // cidfile, state-staging, or wildcard-shaped residue: those need inspection.
  const cliOwnedUntracked = new Set([
    "?? deploy.env",
    "?? deploy-state.json",
    "?? .autoupdate.lock",
  ]);
  return porcelain
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .some((line) => line !== "" && !cliOwnedUntracked.has(line));
}

async function buildSourceImage(checkout: string, imageTag: string): Promise<void> {
  const args = [
    "build",
    "--progress=plain",
    "-f",
    "docker/all-in-one.Dockerfile",
    "-t",
    imageTag,
    ".",
  ];
  let code: number | null;
  try {
    code = await stream(
      "docker",
      args,
      {
        onStdout: (chunk) => void process.stderr.write(chunk),
        onStderr: (chunk) => void process.stderr.write(chunk),
      },
      { cwd: checkout },
    );
  } catch (error) {
    throw new UpdateError(`\`docker build\` could not start: ${errorDetail(error)}`);
  }
  if (code !== 0) {
    throw new UpdateError(
      `\`docker build\` failed (exit ${code ?? "signal"}). The current container is still serving; fix the build and retry.`,
    );
  }
}

async function inspectSourceImageId(imageTag: string, required: boolean): Promise<string | null> {
  const args = ["image", "inspect", "--format", "{{.Id}}", imageTag];
  const result = await run("docker", args);
  if (result.code !== 0) {
    if (!required) return null;
    checkedResult("docker", args, result);
  }
  const imageId = result.stdout.trim();
  if (!IMAGE_ID.test(imageId)) {
    if (!required) return null;
    throw new UpdateError(
      `Docker did not report a full immutable image ID after building ${imageTag}. The current container is still serving.`,
    );
  }
  return imageId;
}

async function stopCurrent(identity: string, redact: Redactor): Promise<void> {
  const args = ["stop", identity];
  const result = await run("docker", args);
  if (result.code === 0 || /is not running/i.test(result.stderr)) return;
  checkedResult("docker", args, result, redact);
}

async function removeCurrent(identity: string, redact: Redactor): Promise<void> {
  const args = ["rm", identity];
  const result = await run("docker", args);
  if (result.code === 0 || verifiedNotFound(result, identity)) return;
  // A failed `docker rm` does not prove whether the daemon removed the target.
  // Resolve the exact immutable ID before choosing restart-vs-recreate recovery.
  const classified = await run("docker", ["container", "inspect", identity]);
  if (classified.code !== 0 && verifiedNotFound(classified, identity)) return;
  if (classified.code !== 0) {
    throw new UpdateError(
      `\`docker rm\` failed and Docker could not determine whether container ${identity} still exists` +
        detailSuffix(classified, redact) +
        " Refusing to act on the mutable container name.",
    );
  }
  checkedResult("docker", args, result, redact);
}

async function createContainer(
  imageRef: string,
  config: PreservedConfig,
  envFile: string,
  cwd: string,
  redact: Redactor,
): Promise<string> {
  const cidFile = `${envFile}.cid`;
  const args = buildCreateArgs({
    host: config.host,
    dataVolume: config.dataVolume,
    dashboardPort: config.dashboardPort,
    dataDir: config.dataDir,
    runAsUser: config.runAsUser,
    restartPolicy: config.restartPolicy,
    imageRef,
    envFile,
    dnsServers: config.dnsServers,
  });
  args.splice(1, 0, "--cidfile", cidFile);
  fs.rmSync(cidFile, { force: true });
  try {
    const created = await run("docker", args, { cwd });
    checkedResult("docker", args, created, redact);
    let id = "";
    try {
      id = fs.readFileSync(cidFile, "utf8").trim();
    } catch {
      // A successful `docker create` without its cidfile leaves ownership
      // ambiguous. Recovery must inspect, never remove/create by mutable name.
    }
    if (!CONTAINER_ID.test(id)) {
      throw new UpdateError(
        `Docker created a container but did not write a full immutable ID to ${cidFile}. ` +
          `Refusing cleanup by mutable name; inspect ${CONTAINER_NAME} manually.`,
      );
    }
    return id;
  } finally {
    try {
      fs.rmSync(cidFile, { force: true });
    } catch {
      // The cidfile contains only a container ID. Cleanup failure must not lose
      // an identity we successfully captured and turn safe cleanup ambiguous.
    }
  }
}

async function startContainer(id: string, cwd: string, redact: Redactor): Promise<void> {
  const started = await run("docker", ["start", id], { cwd });
  checkedResult("docker", ["start", id], started, redact);
}

async function waitForHealth(
  identity: string,
  options: UpdateOptions,
  redact: Redactor,
): Promise<void> {
  const attempts = options.healthAttempts ?? 60;
  const interval = options.healthIntervalMs ?? 2000;
  let last = "unknown";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await run("docker", [
      "inspect",
      "--format",
      "{{.State.Health.Status}}",
      identity,
    ]);
    if (result.code === 0 && result.stdout.trim()) last = result.stdout.trim();
    if (last === "healthy") return;
    if (last === "unhealthy") break;
    if (attempt < attempts - 1 && interval > 0) {
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
  const logs = await run("docker", [
    "logs",
    "--tail",
    String(options.logTailLines ?? 50),
    identity,
  ]);
  const detail = redact(logs.stdout.trim() || logs.stderr.trim());
  throw new UpdateError(
    `Container ${identity} did not become healthy (last status: ${last})` +
      (detail ? `:\n${detail}` : "."),
  );
}

async function execMigration(identity: string, redact: Redactor): Promise<void> {
  const args = ["exec", identity, CONTAINER_NAME, "migrate-data-dir"];
  const result = await run("docker", args);
  checkedResult("docker", args, result, redact);
}

async function restartPrevious(
  identity: string,
  options: UpdateOptions,
  redact: Redactor,
): Promise<void> {
  const result = await run("docker", ["start", identity]);
  if (result.code !== 0 && !/already running/i.test(`${result.stdout}\n${result.stderr}`)) {
    checkedResult("docker", ["start", identity], result, redact);
  }
  await waitForHealth(identity, options, redact);
}

async function recreatePrevious(
  previous: PreservedConfig,
  envFile: string,
  deployDir: string,
  options: UpdateOptions,
  redact: Redactor,
): Promise<void> {
  const id = await createContainer(previous.immutableImageId, previous, envFile, deployDir, redact);
  try {
    await startContainer(id, deployDir, redact);
    await waitForHealth(id, options, redact);
  } catch (error) {
    throw new RecoveryAttemptError(errorDetail(error, redact), id);
  }
}

async function removeOwnedContainer(identity: string, redact: Redactor): Promise<void> {
  const result = await run("docker", ["rm", "-f", identity]);
  if (result.code === 0 || verifiedNotFound(result, identity)) return;
  checkedResult("docker", ["rm", "-f", identity], result, redact);
}

function recoveredFailure(
  primary: string,
  migrationStarted: boolean,
  priorFilesRestored: boolean,
  recoveryEnv: string,
  cleanupWarnings: string[],
): UpdateError {
  const dataNote = migrationStarted
    ? " The previous executable was restored and verified healthy, but persistent data changes made after migration began were NOT rolled back."
    : " The previous executable and container configuration were restored and verified healthy; persistent data was not deleted or rolled back.";
  const persistenceNote = priorFilesRestored
    ? " Deploy state was not advanced."
    : ` Prior deploy.env/deploy-state restoration FAILED, so their on-disk contents may be inconsistent. ` +
      `The exact prior runtime credentials remain protected at ${recoveryEnv} (mode 0600). Repair deploy.env and deploy-state.json from backup or the running container before retrying; do not delete that recovery file until repair is complete.`;
  return new UpdateError(
    `Update failed: ${primary}.${dataNote}${persistenceNote}` +
      (cleanupWarnings.length > 0 ? ` ${cleanupWarnings.join(" ")}` : ""),
  );
}

function recoveryFailure(
  primary: string,
  recovery: string,
  previous: PreservedConfig,
  envFile: string,
  migrationStarted: boolean,
  oldRemoved: boolean,
  priorFilesRestored: boolean,
  ownedContainerId?: string | undefined,
): UpdateError {
  const create = buildCreateArgs({
    host: previous.host,
    dataVolume: previous.dataVolume,
    dashboardPort: previous.dashboardPort,
    dataDir: previous.dataDir,
    runAsUser: previous.runAsUser,
    restartPolicy: previous.restartPolicy,
    imageRef: previous.immutableImageId,
    envFile,
    dnsServers: previous.dnsServers,
  });
  const manualCidFile = `${envFile}.manual-recovery.cid`;
  create.splice(1, 0, "--cidfile", manualCidFile);
  const commands = oldRemoved
    ? ownedContainerId
      ? [
          `docker rm -f ${ownedContainerId}`,
          `docker ${create.map(shellWord).join(" ")}`,
          `docker start "$(cat ${shellWord(manualCidFile)})"`,
          `docker inspect --format '{{.State.Health.Status}}' "$(cat ${shellWord(manualCidFile)})"`,
        ]
      : [
          `docker container inspect --format '{{.Id}} {{.Image}} {{.State.Status}}' ${CONTAINER_NAME}`,
          `Do not remove, recreate, or start ${CONTAINER_NAME} by name until you have verified its immutable ID and ownership.`,
        ]
    : [
        `docker container inspect ${previous.immutableContainerId}`,
        `docker start ${previous.immutableContainerId}`,
        `docker inspect --format '{{.State.Health.Status}}' ${previous.immutableContainerId}`,
      ];
  return new UpdateError(
    `Update failed: ${primary}. Recovery also failed: ${recovery}. ` +
      (migrationStarted
        ? "Persistent data changes made after migration began were NOT rolled back. "
        : "Persistent data, secrets, and deploy state were left in place. ") +
      (priorFilesRestored
        ? ""
        : `Prior deploy.env/deploy-state restoration also FAILED; their contents may be inconsistent. Keep ${envFile} (mode 0600) and repair both files from backup or inspected runtime configuration. `) +
      `Protected prior runtime credentials remain at ${envFile} (mode 0600); keep that file until recovery is complete. ` +
      `The server was NOT rolled back. Recover the previous ${oldRemoved ? "image" : "container"} manually:\n${commands.join("\n")}`,
  );
}

function renderSuccess(prepared: PreparedTarget, freshToken: string | null): string {
  const identity =
    prepared.imageSource === "registry"
      ? `published ${prepared.ref} (${shortImageDigest(prepared.imageDigest!)})`
      : `source ${prepared.ref}`;
  const lines = [
    `Updated The Librarian server to ${identity} — the container is healthy.`,
    "The existing storage, ports, credentials, and restart policy were preserved; pending data-dir migrations were applied.",
  ];
  if (freshToken) {
    lines.push(
      "",
      "NOTE: no previous agent token was recoverable, so a fresh token was minted. Existing clients must update their token:",
      `  Agent token: ${freshToken}`,
    );
  }
  return lines.join("\n");
}

async function checked(
  cmd: string,
  args: string[],
  redact: Redactor = redactSecrets,
): Promise<void> {
  checkedResult(cmd, args, await run(cmd, args), redact);
}

function checkedResult(
  cmd: string,
  args: string[],
  result: RunResult,
  redact: Redactor = redactSecrets,
): void {
  if (result.code === 0) return;
  throw new UpdateError(
    `\`${cmd} ${args[0]}\` failed (exit ${result.code ?? "signal"})` +
      detailSuffix(result, redact) +
      " Resolve the error, then re-run `librarian server update`.",
  );
}

function detailSuffix(result: RunResult, redact: Redactor = redactSecrets): string {
  const detail = redact(result.stderr.trim() || result.stdout.trim());
  return detail ? `: ${detail}` : ".";
}

function errorDetail(error: unknown, redact: Redactor = redactSecrets): string {
  return redact(error instanceof Error ? error.message : String(error));
}

function envMap(value: unknown): Map<string, string> {
  const result = new Map<string, string>();
  if (!Array.isArray(value)) return result;
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const equals = entry.indexOf("=");
    if (equals > 0) result.set(entry.slice(0, equals), entry.slice(equals + 1));
  }
  return result;
}

/** A protected env-file that reproduces the previous container's auth exactly. */
function writePriorRecoveryEnv(file: string, previousEnv: Map<string, string>): void {
  const names = [
    "LIBRARIAN_AGENT_TOKEN",
    "LIBRARIAN_SECRET_KEY",
    "LIBRARIAN_BOOTSTRAP_CLAIM_SECRET",
    "LIBRARIAN_ALLOW_NO_AUTH",
  ];
  const lines: string[] = [];
  for (const name of names) {
    if (!previousEnv.has(name)) continue;
    const value = previousEnv.get(name)!;
    if (/[\r\n]/.test(value)) {
      throw new UpdateError(`Refusing to stage prior ${name} because it contains a newline.`);
    }
    lines.push(`${name}=${value}`);
  }
  fs.writeFileSync(file, lines.length > 0 ? `${lines.join("\n")}\n` : "", {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(file, 0o600);
}

/** Shape-redact first, then scrub the exact runtime credentials we already know. */
function valueAwareRedactor(values: Array<string | undefined>): Redactor {
  const secrets = [...new Set(values.filter((value): value is string => Boolean(value)))].sort(
    (left, right) => right.length - left.length,
  );
  return (text): string => {
    let redacted = redactSecrets(text);
    for (const secret of secrets) redacted = redacted.split(secret).join("[redacted]");
    return redacted;
  };
}

/** Remove a protected update-only credential file, or return a truthful warning. */
function cleanupSecretArtifact(file: string): string | null {
  try {
    updateSecretArtifactRemover(file);
    return null;
  } catch {
    return (
      `WARNING: protected credential residue remains at ${file} (mode 0600). ` +
      `Remove it manually with \`rm -- ${shellWord(file)}\` after recovery is complete.`
    );
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function verifiedNotFound(result: RunResult, identity: string): boolean {
  const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`no such (?:object|container):?\\s*${escaped}(?:\\s|$)`, "i").test(
    `${result.stdout}\n${result.stderr}`,
  );
}

function shellWord(value: string): string {
  return /^[a-zA-Z0-9_./:@=-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
