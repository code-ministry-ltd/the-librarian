import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { isMissingImageError } from "../../../scripts/classify-image-inspect-failure.mjs";

const workflow = fs.readFileSync(
  new URL("../../../.github/workflows/release.yml", import.meta.url),
  "utf8",
);

function job(name: string, nextName?: string): string {
  const end = nextName ? `(?=^  ${nextName}:)` : "(?![\\s\\S])";
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)${end}`, "m"));
  if (!match) throw new Error(`release workflow job not found: ${name}`);
  return match[0];
}

describe("release workflow — published all-in-one image", () => {
  it("keeps the workflow main-only and grants package write only to Docker publication", () => {
    expect(workflow).toMatch(/on:\n\s+push:\n\s+branches: \[main\]/);
    expect(workflow).not.toMatch(/^\s+pull_request:/m);
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(job("publish-docker", "github-release")).toMatch(
      /permissions:\n\s+contents: read\n\s+packages: write/,
    );
    expect(job("prepare-release", "publish-docker")).not.toContain("packages: write");
    expect(job("github-release", "publish-npm")).not.toContain("packages: write");
  });

  it("distinguishes a rerun of the release commit from a later no-bump commit", () => {
    const prepare = job("prepare-release", "publish-docker");
    expect(prepare).toContain('git rev-list -n 1 "$TAG"');
    expect(prepare).toContain('"$TAG_COMMIT" = "$GITHUB_SHA"');
    expect(prepare).toContain("candidate=true");
    expect(prepare).toContain("candidate=false");
  });

  it("builds the exact release tag with traceable OCI metadata", () => {
    const publish = job("publish-docker", "github-release");
    expect(publish).toContain("needs: prepare-release");
    expect(publish).toContain('ref: "v${{ needs.prepare-release.outputs.version }}"');
    expect(publish).toContain("ghcr.io/code-ministry-ltd/the-librarian");
    expect(publish).toContain("docker/all-in-one.Dockerfile");
    expect(publish).toContain("platforms: linux/amd64");
    expect(publish).toContain("org.opencontainers.image.source");
    expect(publish).toContain("org.opencontainers.image.revision");
    expect(publish).toContain("org.opencontainers.image.version");
  });

  it("never rebuilds an existing version tag and verifies it after a registry round trip", () => {
    const publish = job("publish-docker", "github-release");
    expect(publish).toContain("docker buildx imagetools inspect");
    expect(publish).toContain("for attempt in 1 2 3");
    expect(publish).toContain("classify-image-inspect-failure.mjs");
    expect(publish).toContain("Registry lookup was indeterminate");
    expect(publish).toContain("if: steps.image.outputs.exists == 'false'");
    expect(publish).toContain('docker pull "$VERSION_REF"');
    expect(publish).toContain("node scripts/smoke-docker-image.mjs");
  });

  it("fails closed when a registry infrastructure error happens to contain not found", () => {
    const versionRef = "ghcr.io/code-ministry-ltd/the-librarian:v1.20.1";

    expect(isMissingImageError("manifest unknown", versionRef)).toBe(true);
    expect(isMissingImageError("no such manifest: v1.20.1", versionRef)).toBe(true);
    expect(isMissingImageError(`ERROR: ${versionRef}: not found`, versionRef)).toBe(true);

    expect(isMissingImageError("token endpoint returned 404 Not Found", versionRef)).toBe(false);
    expect(isMissingImageError("network route not found", versionRef)).toBe(false);
    expect(isMissingImageError(`ERROR: ${versionRef}: not found\nrequest failed`, versionRef)).toBe(
      false,
    );
  });

  it("records the verified digest before promoting latest by digest", () => {
    const publish = job("publish-docker", "github-release");
    const digestIndex = publish.indexOf("id: digest");
    const latestIndex = publish.indexOf("docker buildx imagetools create");
    expect(digestIndex).toBeGreaterThan(-1);
    expect(latestIndex).toBeGreaterThan(digestIndex);
    expect(publish).toContain("docker-image-digest.txt");
    expect(publish).toContain('"$LATEST_DIGEST" != "$DIGEST"');
    expect(publish).toContain("git fetch --depth=1 origin main");
    expect(publish).toContain('if [ "$CURRENT_VERSION" != "$VERSION" ]');
    expect(publish).toContain("Skipping latest promotion");
  });

  it("creates the GitHub release only after Docker succeeds, then publishes npm", () => {
    expect(job("github-release", "publish-npm")).toContain(
      "needs: [prepare-release, publish-docker]",
    );
    expect(job("publish-npm")).toContain("needs: [prepare-release, github-release]");
  });
});
