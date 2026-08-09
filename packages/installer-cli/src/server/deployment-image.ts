/** The immutable release image published by the repository release workflow. */
export const CANONICAL_IMAGE_NAME = "ghcr.io/code-ministry-ltd/the-librarian";

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
