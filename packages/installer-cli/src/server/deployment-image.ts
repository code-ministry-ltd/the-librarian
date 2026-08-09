import { run, stream, type RunResult } from "./docker.js";
import { redactSecrets } from "./redact.js";

/** The immutable release image published by the repository release workflow. */
export const CANONICAL_IMAGE_NAME = "ghcr.io/code-ministry-ltd/the-librarian";

/** Canonical source label stamped by the release workflow. */
export const CANONICAL_SOURCE_REPOSITORY = "https://github.com/code-ministry-ltd/the-librarian";

const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const REQUIRED_PLATFORM = "linux/amd64";
const GITHUB_API = "https://api.github.com/repos/code-ministry-ltd/the-librarian";

/** A pulled release image whose provenance and immutable identity were verified. */
export interface PreparedRegistryImage {
  imageSource: "registry";
  ref: string;
  /** Human-readable canonical version tag retained in deploy state. */
  imageRef: string;
  /** Immutable canonical repository digest passed to `docker run`. */
  imageDigest: string;
  /** Source commit stamped by the release workflow. */
  revision: string;
}

/** A fail-closed, human-facing registry preparation failure. */
export class DeploymentImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentImageError";
  }
}

export interface ReleaseProvenance {
  revision: string;
  imageDigest: string;
}

export interface PublicHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type PublicGithubFetch = (
  url: string,
  init: { redirect: "error" | "follow"; headers?: Record<string, string> },
) => Promise<PublicHttpResponse>;

const realPublicGithubFetch: PublicGithubFetch = (url, init) => fetch(url, init);
let publicGithubFetch = realPublicGithubFetch;

export function setPublicGithubFetch(next: PublicGithubFetch): void {
  publicGithubFetch = next;
}

export function resetPublicGithubFetch(): void {
  publicGithubFetch = realPublicGithubFetch;
}

export type ReleaseProvenanceResolver = (ref: string) => Promise<ReleaseProvenance>;

const defaultReleaseProvenanceResolver: ReleaseProvenanceResolver = async (ref) => {
  const reference = await fetchGithubJson(`${GITHUB_API}/git/ref/tags/${encodeURIComponent(ref)}`);
  let object = gitObject(reference);
  for (let depth = 0; object.type === "tag" && depth < 5; depth += 1) {
    object = gitObject(await fetchGithubJson(`${GITHUB_API}/git/tags/${object.sha}`));
  }
  if (object.type !== "commit" || !REVISION_PATTERN.test(object.sha)) {
    throw new Error(`GitHub tag ${ref} did not peel to a full commit SHA.`);
  }
  const release = await fetchGithubJson(`${GITHUB_API}/releases/tags/${encodeURIComponent(ref)}`);
  const assets = objectRecord(release).assets;
  const receiptUrl = Array.isArray(assets)
    ? assets.map(objectRecord).find((asset) => asset.name === "docker-image-digest.txt")
        ?.browser_download_url
    : undefined;
  const expectedReceiptUrl = `${CANONICAL_SOURCE_REPOSITORY}/releases/download/${ref}/docker-image-digest.txt`;
  if (receiptUrl !== expectedReceiptUrl) {
    throw new Error(`GitHub release ${ref} has no docker-image-digest.txt receipt.`);
  }
  const receipt = (await fetchGithubText(receiptUrl)).trim();
  const prefix = `${CANONICAL_IMAGE_NAME}@`;
  if (!receipt.startsWith(prefix) || !IMAGE_DIGEST_PATTERN.test(receipt.slice(prefix.length))) {
    throw new Error(`GitHub release ${ref} has an invalid Docker digest receipt.`);
  }
  return { revision: object.sha, imageDigest: receipt };
};

let releaseProvenanceResolver = defaultReleaseProvenanceResolver;

export function setReleaseProvenanceResolver(next: ReleaseProvenanceResolver): void {
  releaseProvenanceResolver = next;
}

export function resetReleaseProvenanceResolver(): void {
  releaseProvenanceResolver = defaultReleaseProvenanceResolver;
}

/** A stable released deployment, resolved to a concrete release in the pull flow. */
export interface RegistryDeploymentTarget {
  imageSource: "registry";
  /** Absent when the caller omitted `--ref`; the latest release is resolved later. */
  ref?: string | undefined;
}

/** A branch, tag, commit, or malformed release-like ref that must build from source. */
export interface SourceDeploymentTarget {
  imageSource: "source";
  ref: string;
}

export type DeploymentTarget = RegistryDeploymentTarget | SourceDeploymentTarget;

/** Exact release refs only: `vMAJOR.MINOR.PATCH`, with strict numeric components. */
export function isReleasedVersionRef(ref: string): boolean {
  return /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(ref);
}

/**
 * Select the deployment strategy without doing network or Docker work.
 * Omitted/blank refs stay unresolved for the later latest-release lookup.
 */
export function selectDeploymentTarget(ref: string | undefined): DeploymentTarget {
  if (ref === undefined || ref.trim().length === 0) return { imageSource: "registry" };
  if (isReleasedVersionRef(ref)) {
    return { imageSource: "registry", ref };
  }
  return { imageSource: "source", ref };
}

interface DockerImageInspect {
  Os?: unknown;
  Architecture?: unknown;
  Config?: { Labels?: Record<string, unknown> | null } | null;
  RepoTags?: unknown;
  RepoDigests?: unknown;
}

interface DockerDaemonInfo {
  OSType?: unknown;
  Architecture?: unknown;
}

function imageFailure(message: string): DeploymentImageError {
  return new DeploymentImageError(
    `${message} The release image was not used and source fallback is disabled for stable ` +
      "releases. Resolve the registry/image problem, then re-run `librarian server up`.",
  );
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function gitObject(value: unknown): { type: string; sha: string } {
  const object = objectRecord(objectRecord(value).object);
  const type = typeof object.type === "string" ? object.type : "";
  const sha = typeof object.sha === "string" ? object.sha : "";
  if ((type !== "tag" && type !== "commit") || !REVISION_PATTERN.test(sha)) {
    throw new Error("GitHub returned malformed tag provenance.");
  }
  return { type, sha };
}

async function fetchGithubJson(url: string): Promise<unknown> {
  const response = await publicGithubFetch(url, {
    redirect: "error",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}.`);
  return response.json();
}

async function fetchGithubText(url: string): Promise<string> {
  const response = await publicGithubFetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`GitHub receipt download returned HTTP ${response.status}.`);
  return response.text();
}

function normalizedPlatform(os: unknown, architecture: unknown): string {
  const normalizedOs = typeof os === "string" ? os.trim().toLowerCase() : "";
  const rawArch = typeof architecture === "string" ? architecture.trim().toLowerCase() : "";
  const normalizedArch = ["amd64", "x86_64", "x86-64"].includes(rawArch)
    ? "amd64"
    : ["arm64", "aarch64"].includes(rawArch)
      ? "arm64"
      : rawArch;
  return normalizedOs && normalizedArch ? `${normalizedOs}/${normalizedArch}` : "";
}

async function inspectDockerDaemon(): Promise<DockerDaemonInfo> {
  let result: RunResult;
  try {
    result = await run("docker", ["info", "--format", "{{json .}}"]);
  } catch (error) {
    const detail = redactSecrets(error instanceof Error ? error.message : String(error));
    throw imageFailure(`Could not inspect the active Docker server platform: ${detail}`);
  }
  if (result.code !== 0) {
    const detail = redactSecrets(result.stderr.trim() || result.stdout.trim());
    throw imageFailure(
      `Could not inspect the active Docker server platform${detail ? `: ${detail}` : "."}`,
    );
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout.trim());
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as DockerDaemonInfo;
  } catch {
    throw imageFailure("Docker returned malformed server platform metadata.");
  }
}

function redactingStream(onProgress: (chunk: string) => void): {
  write: (chunk: string) => void;
  flush: () => void;
} {
  let buffered = "";
  const emitCompleteRecords = (): void => {
    const boundary = Math.max(buffered.lastIndexOf("\n"), buffered.lastIndexOf("\r"));
    if (boundary < 0) return;
    const complete = buffered.slice(0, boundary + 1);
    buffered = buffered.slice(boundary + 1);
    onProgress(redactSecrets(complete));
  };
  return {
    write(chunk) {
      buffered += chunk;
      emitCompleteRecords();
    },
    flush() {
      if (!buffered) return;
      onProgress(redactSecrets(buffered));
      buffered = "";
    },
  };
}

/**
 * Pull and validate a stable release image, returning the digest-pinned run target.
 * This is shared preparation for `up` now and the B3 update flow later.
 */
export async function prepareRegistryImage(
  ref: string,
  onProgress: (chunk: string) => void,
): Promise<PreparedRegistryImage> {
  if (!isReleasedVersionRef(ref)) {
    throw imageFailure(`Expected an exact release ref like v1.20.1, got '${ref}'.`);
  }
  const daemon = await inspectDockerDaemon();
  const daemonPlatform = normalizedPlatform(daemon.OSType, daemon.Architecture);
  if (daemonPlatform !== REQUIRED_PLATFORM) {
    throw imageFailure(
      `The active Docker server reports '${daemonPlatform || "unknown"}', but the supported platform is ${REQUIRED_PLATFORM}. ` +
        "Switch Docker context to a Linux amd64 server or install on a supported host.",
    );
  }
  const imageRef = `${CANONICAL_IMAGE_NAME}:${ref}`;
  const stdout = redactingStream(onProgress);
  const stderr = redactingStream(onProgress);
  let pullCode: number | null;
  try {
    pullCode = await stream("docker", ["pull", imageRef], {
      onStdout: stdout.write,
      onStderr: stderr.write,
    });
  } catch (error) {
    stdout.flush();
    stderr.flush();
    const detail = redactSecrets(error instanceof Error ? error.message : String(error));
    throw imageFailure(
      `\`docker pull ${imageRef}\` could not start${detail ? `: ${detail}` : "."}`,
    );
  }
  stdout.flush();
  stderr.flush();
  if (pullCode !== 0) {
    throw imageFailure(
      `\`docker pull ${imageRef}\` failed (exit ${pullCode ?? "signal"}). Check registry access, ` +
        "authentication, network connectivity, and whether this release supports your architecture.",
    );
  }

  let inspected: RunResult;
  try {
    inspected = await run("docker", ["image", "inspect", "--format", "{{json .}}", imageRef]);
  } catch (error) {
    const detail = redactSecrets(error instanceof Error ? error.message : String(error));
    throw imageFailure(
      `Docker metadata inspection failed for ${imageRef}${detail ? `: ${detail}` : "."}`,
    );
  }
  if (inspected.code !== 0) {
    const detail = redactSecrets(inspected.stderr.trim() || inspected.stdout.trim());
    throw imageFailure(
      `Docker pulled ${imageRef}, but its local metadata could not be inspected` +
        (detail ? `: ${detail}` : "."),
    );
  }

  let record: DockerImageInspect;
  try {
    const parsed: unknown = JSON.parse(inspected.stdout.trim());
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    record = parsed as DockerImageInspect;
  } catch {
    throw imageFailure(`Docker returned malformed image metadata for ${imageRef}.`);
  }
  const validated = validateRegistryImage(ref, imageRef, record, daemonPlatform);
  let authoritative: ReleaseProvenance;
  try {
    authoritative = await releaseProvenanceResolver(ref);
  } catch (error) {
    const detail = redactSecrets(error instanceof Error ? error.message : String(error));
    throw imageFailure(
      `Could not verify ${ref} against authoritative GitHub release provenance${detail ? `: ${detail}` : "."}`,
    );
  }
  if (validated.revision !== authoritative.revision) {
    throw imageFailure(
      `Image revision ${validated.revision} does not match GitHub tag ${ref} commit ${authoritative.revision}.`,
    );
  }
  if (validated.imageDigest !== authoritative.imageDigest) {
    throw imageFailure(
      `Image digest ${validated.imageDigest} does not match the GitHub release receipt ${authoritative.imageDigest}.`,
    );
  }
  return validated;
}

function validateRegistryImage(
  ref: string,
  imageRef: string,
  record: DockerImageInspect,
  daemonPlatform: string,
): PreparedRegistryImage {
  const labels = record.Config?.Labels ?? {};
  const version = labels["org.opencontainers.image.version"];
  const source = labels["org.opencontainers.image.source"];
  const revision = labels["org.opencontainers.image.revision"];
  const expectedVersion = ref.slice(1);
  if (!Array.isArray(record.RepoTags) || !record.RepoTags.includes(imageRef)) {
    throw imageFailure(`The pulled image does not carry the requested tag ${imageRef}.`);
  }
  if (version !== expectedVersion) {
    throw imageFailure(
      `Image version metadata mismatch: expected '${expectedVersion}' for ${ref}, got '${redactSecrets(String(version))}'.`,
    );
  }
  if (source !== CANONICAL_SOURCE_REPOSITORY) {
    throw imageFailure(
      `Image source metadata mismatch: expected ${CANONICAL_SOURCE_REPOSITORY}, got '${redactSecrets(String(source))}'.`,
    );
  }
  if (typeof revision !== "string" || !REVISION_PATTERN.test(revision)) {
    throw imageFailure(
      `Image revision metadata is missing or invalid; expected a full 40-character Git commit for traceability.`,
    );
  }
  const imagePlatform = normalizedPlatform(record.Os, record.Architecture);
  if (imagePlatform !== REQUIRED_PLATFORM || imagePlatform !== daemonPlatform) {
    throw imageFailure(
      `The pulled image platform/architecture metadata is '${imagePlatform || "unknown"}', but the supported platform is ${REQUIRED_PLATFORM} and must match the active Docker server.`,
    );
  }
  const digestPrefix = `${CANONICAL_IMAGE_NAME}@`;
  const imageDigest = Array.isArray(record.RepoDigests)
    ? record.RepoDigests.find(
        (value): value is string =>
          typeof value === "string" &&
          value.startsWith(digestPrefix) &&
          IMAGE_DIGEST_PATTERN.test(value.slice(digestPrefix.length)),
      )
    : undefined;
  if (!imageDigest) {
    throw imageFailure(
      `Docker metadata for ${imageRef} has no full canonical repository digest (${CANONICAL_IMAGE_NAME}@sha256:<64 lowercase hex characters>).`,
    );
  }
  return { imageSource: "registry", ref, imageRef, imageDigest, revision };
}
