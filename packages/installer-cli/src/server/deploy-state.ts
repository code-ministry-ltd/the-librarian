// The NON-SECRET deploy-state file for the `server` command group.
//
// `up` runs the container with a chosen bind host, data volume, and ref, but
// none of that was persisted anywhere — so `update` couldn't recreate the
// container with the same config and `status` couldn't report the deployed ref
// reliably (it would have to guess via `git describe`). This file records that
// config in the deploy dir (default `~/.librarian/server/deploy-state.json`).
//
// SECURITY (AGENTS.md / spec §11): this file is NON-SECRET by construction. It
// carries ONLY non-secret fields — a bind host, a volume name (and an optional
// host data dir), a ref, image identity/provenance, and the container name. It
// NEVER carries a bearer token, master key, or admin token. `writeDeployState`
// whitelists exactly those fields, so a
// caller that accidentally passes extra keys (a smuggled secret) cannot leak
// them into the file. The master key / admin token are surfaced to stdout once
// by `up` and persisted nowhere host-side — that contract is unchanged.

import fs from "node:fs";
import path from "node:path";
import { CANONICAL_IMAGE_NAME, isReleasedVersionRef } from "./deployment-image.js";

/**
 * The deploy-state recorded after a successful `up` (and rewritten by `update`).
 * Every field is NON-SECRET — see the module header. Do NOT add a token/key.
 */
interface DeployStateBase {
  /** The container name every `server` command operates on. */
  containerName: string;
  /** The resolved bind host the container publishes on (`127.0.0.1`, a tailnet IP, `0.0.0.0`). */
  host: string;
  /** The named data volume mounted at `/data` (sacred across `down`/`update`). */
  dataVolume: string;
  /**
   * A host directory bind-mounted at `/data` instead of the named volume, when the
   * operator chose one via `--data-dir`. Optional — absent on named-volume deploys
   * and on states written before this field existed. When set, `update` reuses it
   * and runs the container as its owner.
   */
  dataDir?: string | undefined;
  /** The deployed ref — a `vX.Y.Z` tag or `main` (what was checked out + built). */
  ref: string;
  /** Legacy-compatible image identity: local tag for source, registry tag for registry. */
  imageTag: string;
  /**
   * The host port the dashboard is published on (`-p <host>:<dashboardPort>:3000`).
   * Optional — absent on states written before this field existed. When absent,
   * `update` treats it as the historical `3000` and backfills it, so an existing
   * server never silently changes ports under the operator; a fresh `up` defaults
   * to `3042`. Like `dataDir`, it is back-compatible (old states still validate).
   */
  dashboardPort?: number | undefined;
}

/** State written before explicit image provenance existed; interpreted as source. */
export interface LegacyDeployState extends DeployStateBase {
  imageSource?: undefined;
  imageRef?: undefined;
  imageDigest?: undefined;
}

/** A locally built source image; its explicit ref is the existing local image tag. */
export interface SourceDeployState extends DeployStateBase {
  imageSource: "source";
  imageRef: string;
  imageDigest?: undefined;
}

/** A released registry image, retaining both its readable tag and immutable digest. */
export interface RegistryDeployState extends DeployStateBase {
  imageSource: "registry";
  imageRef: string;
  imageDigest: string;
}

export type DeployState = LegacyDeployState | SourceDeployState | RegistryDeployState;

interface DeployStateCandidate extends DeployStateBase {
  imageSource?: "registry" | "source" | undefined;
  imageRef?: string | undefined;
  imageDigest?: string | undefined;
}

/** Required legacy keys; optional fields are individually picked and validated below. */
const REQUIRED_STATE_KEYS = ["containerName", "host", "dataVolume", "ref", "imageTag"] as const;
const PERSISTED_STATE_KEYS = new Set<string>([
  ...REQUIRED_STATE_KEYS,
  "dataDir",
  "dashboardPort",
  "imageSource",
  "imageRef",
  "imageDigest",
]);

const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const VERSION_IMAGE_PREFIX = `${CANONICAL_IMAGE_NAME}:`;
const DIGEST_IMAGE_PREFIX = `${CANONICAL_IMAGE_NAME}@`;

function isCanonicalVersionImageRef(imageRef: string): boolean {
  return (
    imageRef.startsWith(VERSION_IMAGE_PREFIX) &&
    isReleasedVersionRef(imageRef.slice(VERSION_IMAGE_PREFIX.length))
  );
}

function isCanonicalDigestImageRef(imageRef: string): boolean {
  return (
    imageRef.startsWith(DIGEST_IMAGE_PREFIX) &&
    IMAGE_DIGEST_PATTERN.test(imageRef.slice(DIGEST_IMAGE_PREFIX.length))
  );
}

function validImageMetadata(state: DeployStateCandidate): state is DeployState {
  if (state.imageSource === undefined) {
    return state.imageRef === undefined && state.imageDigest === undefined;
  }
  if (state.imageSource === "source") {
    return state.imageRef === state.imageTag && state.imageDigest === undefined;
  }
  if (state.imageSource !== "registry") return false;
  const expectedVersionRef = `${CANONICAL_IMAGE_NAME}:${state.ref}`;
  return (
    isReleasedVersionRef(state.ref) &&
    state.imageRef === expectedVersionRef &&
    isCanonicalVersionImageRef(state.imageRef) &&
    state.imageTag === expectedVersionRef &&
    state.imageDigest !== undefined &&
    isCanonicalDigestImageRef(state.imageDigest)
  );
}

function hasOnlyPersistedStateKeys(state: object): boolean {
  return Reflect.ownKeys(state).every(
    (key) => typeof key === "string" && PERSISTED_STATE_KEYS.has(key),
  );
}

/** `<dir>/deploy-state.json` — the deploy-state file path within a deploy dir. */
export function deployStatePath(dir: string): string {
  return path.join(dir, "deploy-state.json");
}

/**
 * Write the deploy-state to `<dir>/deploy-state.json`, creating `dir` if absent.
 *
 * Inputs with undeclared own keys are rejected, then declared fields are picked
 * explicitly. The file is non-secret, so it gets ordinary permissions.
 */
export function writeDeployState(dir: string, state: DeployState): void {
  if (!hasOnlyPersistedStateKeys(state)) {
    throw new TypeError(
      "Invalid deploy state fields: only whitelisted non-secret deployment metadata is allowed; unexpected own keys are rejected.",
    );
  }
  if (!validImageMetadata(state)) {
    throw new TypeError(
      "Invalid deploy image metadata: expected legacy fields only; source with imageRef matching imageTag and no digest; or registry with a matching canonical version tag and full lowercase sha256 digest reference.",
    );
  }
  fs.mkdirSync(dir, { recursive: true });
  // Pick ONLY the whitelisted keys — never spread `state`, which could carry
  // extra (secret-shaped) properties a caller smuggled in.
  const safe: Record<string, string | number> = {
    containerName: state.containerName,
    host: state.host,
    dataVolume: state.dataVolume,
    ref: state.ref,
    imageTag: state.imageTag,
  };
  // Only persist the optional host data dir when one was chosen — a named-volume
  // deploy keeps the original field set (and old states stay byte-compatible).
  if (state.dataDir) safe.dataDir = state.dataDir;
  // Persist the published dashboard port when set, so `update` reuses it (a state
  // written before this field stays byte-compatible until the next write).
  if (state.dashboardPort !== undefined) safe.dashboardPort = state.dashboardPort;
  if (state.imageSource !== undefined) safe.imageSource = state.imageSource;
  if (state.imageRef !== undefined) safe.imageRef = state.imageRef;
  if (state.imageDigest !== undefined) safe.imageDigest = state.imageDigest;
  fs.writeFileSync(deployStatePath(dir), `${JSON.stringify(safe, null, 2)}\n`, "utf8");
}

/**
 * Read the deploy-state back, or `null` if the file is absent, unparseable, or
 * missing any required field. Never throws — a missing/corrupt state file means
 * the caller falls back (e.g. `status` uses `git describe`), never crashes.
 */
export function readDeployState(dir: string): DeployState | null {
  let raw: string;
  try {
    raw = fs.readFileSync(deployStatePath(dir), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (!hasOnlyPersistedStateKeys(obj)) return null;
  for (const key of REQUIRED_STATE_KEYS) {
    if (typeof obj[key] !== "string") return null;
  }
  const result: DeployStateCandidate = {
    containerName: obj.containerName as string,
    host: obj.host as string,
    dataVolume: obj.dataVolume as string,
    ref: obj.ref as string,
    imageTag: obj.imageTag as string,
  };
  if (
    obj.imageSource !== undefined &&
    obj.imageSource !== "registry" &&
    obj.imageSource !== "source"
  ) {
    return null;
  }
  if (obj.imageRef !== undefined && typeof obj.imageRef !== "string") return null;
  if (obj.imageDigest !== undefined && typeof obj.imageDigest !== "string") return null;
  if (obj.imageSource !== undefined) result.imageSource = obj.imageSource;
  if (typeof obj.imageRef === "string") result.imageRef = obj.imageRef;
  if (typeof obj.imageDigest === "string") result.imageDigest = obj.imageDigest;
  // Optional, back-compatible: present only on `--data-dir` deploys written after
  // this field existed; left undefined otherwise (old states still validate).
  if (typeof obj.dataDir === "string") result.dataDir = obj.dataDir;
  // Optional, back-compatible: a finite integer port written after this field
  // existed. A garbage value (non-number / non-finite) is ignored — left
  // undefined so `update` falls back to the historical default rather than
  // recreating on a corrupt port.
  if (typeof obj.dashboardPort === "number" && Number.isInteger(obj.dashboardPort)) {
    result.dashboardPort = obj.dashboardPort;
  }
  return validImageMetadata(result) ? result : null;
}
