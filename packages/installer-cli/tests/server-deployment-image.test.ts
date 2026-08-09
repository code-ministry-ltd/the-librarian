import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CANONICAL_IMAGE_NAME,
  isReleasedVersionRef,
  prepareRegistryImage,
  resetPublicGithubFetch,
  resetReleaseProvenanceResolver,
  selectDeploymentTarget,
  setPublicGithubFetch,
  setReleaseProvenanceResolver,
} from "../src/server/deployment-image.js";
import { resetRunner, resetStreamer, setRunner, setStreamer } from "../src/server/docker.js";
import { FakeRunner } from "./helpers.js";

const VERSION = "v1.20.1";
const IMAGE_REF = `${CANONICAL_IMAGE_NAME}:${VERSION}`;
const HASH = "ab".repeat(32);
const IMAGE_DIGEST = `${CANONICAL_IMAGE_NAME}@sha256:${HASH}`;
const REVISION = "12".repeat(20);

function inspectRecord(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Os: "linux",
    Architecture: "amd64",
    Config: {
      Labels: {
        "org.opencontainers.image.source": "https://github.com/code-ministry-ltd/the-librarian",
        "org.opencontainers.image.version": "1.20.1",
        "org.opencontainers.image.revision": REVISION,
      },
    },
    RepoTags: [IMAGE_REF],
    RepoDigests: [IMAGE_DIGEST],
    ...overrides,
  });
}

let streamed: { cmd: string; args: string[]; output: string[] }[];

beforeEach(() => {
  streamed = [];
  setReleaseProvenanceResolver(async () => ({
    revision: REVISION,
    imageDigest: IMAGE_DIGEST,
  }));
  setStreamer({
    stream: async (cmd, args, handlers) => {
      const output: string[] = [];
      streamed.push({ cmd, args: [...args], output });
      for (const chunk of ["pulling layer\n", "download complete\n"]) {
        handlers.onStdout?.(chunk);
        output.push(chunk);
      }
      return 0;
    },
  });
});

afterEach(() => {
  resetRunner();
  resetStreamer();
  resetPublicGithubFetch();
  resetReleaseProvenanceResolver();
});

function registryRunner(inspect = inspectRecord()): FakeRunner {
  return new FakeRunner()
    .onRun("docker", ["info", "--format", "{{json .}}"], {
      stdout: JSON.stringify({ OSType: "linux", Architecture: "x86_64" }),
      code: 0,
    })
    .onRun("docker", ["image", "inspect", "--format", "{{json .}}", IMAGE_REF], {
      stdout: `${inspect}\n`,
      code: 0,
    });
}

describe("server deployment image — canonical registry identity", () => {
  it("uses the one published GHCR image name", () => {
    expect(CANONICAL_IMAGE_NAME).toBe("ghcr.io/code-ministry-ltd/the-librarian");
  });
});

describe("server deployment image — strict released-version recognition", () => {
  it.each([
    ["v0.0.0", true],
    ["v1.20.1", true],
    ["v10.200.3000", true],
    ["1.20.1", false],
    ["v1.20", false],
    ["v1.20.1-beta.1", false],
    ["v1.20.1+build", false],
    ["v01.20.1", false],
    ["v1.020.1", false],
    ["v1.20.01", false],
    [" v1.20.1", false],
    ["v1.20.1 ", false],
  ])("classifies %j as released=%s", (ref, released) => {
    expect(isReleasedVersionRef(ref)).toBe(released);
  });
});

describe("server deployment image — target selection", () => {
  it.each([
    [undefined, { imageSource: "registry" }],
    ["", { imageSource: "registry" }],
    ["   ", { imageSource: "registry" }],
    ["v1.20.1", { imageSource: "registry", ref: "v1.20.1" }],
    ["main", { imageSource: "source", ref: "main" }],
    ["feature/pull-images", { imageSource: "source", ref: "feature/pull-images" }],
    ["release-candidate", { imageSource: "source", ref: "release-candidate" }],
    ["8f1f0f3", { imageSource: "source", ref: "8f1f0f3" }],
    ["v1.20", { imageSource: "source", ref: "v1.20" }],
    ["v1.20.1-beta.1", { imageSource: "source", ref: "v1.20.1-beta.1" }],
    [" v1.20.1 ", { imageSource: "source", ref: " v1.20.1 " }],
    [" main ", { imageSource: "source", ref: " main " }],
  ])("selects %j as %j", (ref, target) => {
    expect(selectDeploymentTarget(ref)).toEqual(target);
  });
});

describe("server deployment image — registry preparation", () => {
  it("streams the exact release pull and returns the validated canonical digest", async () => {
    const runner = registryRunner();
    setRunner(runner);
    const progress: string[] = [];

    await expect(prepareRegistryImage(VERSION, (chunk) => progress.push(chunk))).resolves.toEqual({
      imageSource: "registry",
      ref: VERSION,
      imageRef: IMAGE_REF,
      imageDigest: IMAGE_DIGEST,
      revision: REVISION,
    });
    expect(streamed).toEqual([
      {
        cmd: "docker",
        args: ["pull", IMAGE_REF],
        output: ["pulling layer\n", "download complete\n"],
      },
    ]);
    expect(progress.join("")).toBe("pulling layer\ndownload complete\n");
  });

  it.each([
    ["missing readable tag", { RepoTags: [] }, /does not carry the requested tag/i],
    [
      "version mismatch",
      {
        Config: {
          Labels: {
            "org.opencontainers.image.source": "https://github.com/code-ministry-ltd/the-librarian",
            "org.opencontainers.image.version": "1.20.0",
            "org.opencontainers.image.revision": REVISION,
          },
        },
      },
      /version metadata.*1\.20\.1.*1\.20\.0/i,
    ],
    [
      "source mismatch",
      {
        Config: {
          Labels: {
            "org.opencontainers.image.source": "https://github.com/example/other",
            "org.opencontainers.image.version": "1.20.1",
            "org.opencontainers.image.revision": REVISION,
          },
        },
      },
      /source metadata/i,
    ],
    [
      "revision missing",
      {
        Config: {
          Labels: {
            "org.opencontainers.image.source": "https://github.com/code-ministry-ltd/the-librarian",
            "org.opencontainers.image.version": "1.20.1",
          },
        },
      },
      /revision metadata/i,
    ],
    ["architecture missing", { Architecture: "" }, /architecture metadata/i],
    ["digest missing", { RepoDigests: [] }, /canonical repository digest/i],
    [
      "wrong repository digest",
      { RepoDigests: [`ghcr.io/example/other@sha256:${HASH}`] },
      /canonical repository digest/i,
    ],
    [
      "short digest",
      { RepoDigests: [`${CANONICAL_IMAGE_NAME}@sha256:abcd`] },
      /canonical repository digest/i,
    ],
  ])("rejects %s without returning an image", async (_name, overrides, message) => {
    const runner = registryRunner(inspectRecord(overrides as Record<string, unknown>));
    setRunner(runner);

    await expect(prepareRegistryImage(VERSION, () => undefined)).rejects.toThrow(message);
  });

  it("fails closed with a redacted teaching error when the pull fails", async () => {
    const leaked = "0123456789abcdef".repeat(4);
    setRunner(registryRunner());
    setStreamer({
      stream: async (_cmd, _args, handlers) => {
        handlers.onStderr?.(`registry denied token ${leaked}\n`);
        return 1;
      },
    });
    const progress: string[] = [];

    await expect(prepareRegistryImage(VERSION, (chunk) => progress.push(chunk))).rejects.toThrow(
      /docker pull.*failed.*registry access.*network/i,
    );
    expect(progress.join("")).not.toContain(leaked);
    expect(progress.join("")).toContain("[redacted]");
  });

  it("redacts a rejected metadata inspection and teaches the operator how to recover", async () => {
    const leaked = "fedcba9876543210".repeat(4);
    const runner = registryRunner();
    const realRun = runner.run.bind(runner);
    runner.run = async (cmd, args, options) => {
      if (cmd === "docker" && args[0] === "image") {
        throw new Error(`daemon rejected credential ${leaked}`);
      }
      return realRun(cmd, args, options);
    };
    setRunner(runner);

    await expect(prepareRegistryImage(VERSION, () => undefined)).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/metadata inspection failed/i);
        expect((error as Error).message).not.toContain(leaked);
        expect((error as Error).message).toContain("[redacted]");
        return true;
      },
    );
  });

  it("redacts secret-shaped invalid metadata values", async () => {
    const leaked = "0123456789abcdef".repeat(4);
    const runner = registryRunner(
      inspectRecord({
        Config: {
          Labels: {
            "org.opencontainers.image.source": leaked,
            "org.opencontainers.image.version": "1.20.1",
            "org.opencontainers.image.revision": REVISION,
          },
        },
      }),
    );
    setRunner(runner);

    await expect(prepareRegistryImage(VERSION, () => undefined)).rejects.toSatisfy(
      (error: unknown) => {
        expect((error as Error).message).not.toContain(leaked);
        expect((error as Error).message).toContain("[redacted]");
        return true;
      },
    );
  });

  it.each([
    ["arm64 daemon", { OSType: "linux", Architecture: "arm64" }],
    ["unknown daemon architecture", { OSType: "linux", Architecture: "mips64" }],
    ["blank daemon platform", { OSType: "   ", Architecture: "   " }],
    ["non-linux daemon", { OSType: "windows", Architecture: "amd64" }],
  ])("rejects %s before pulling or creating credentials", async (_name, daemon) => {
    const runner = registryRunner().onRun("docker", ["info", "--format", "{{json .}}"], {
      stdout: JSON.stringify(daemon),
      code: 0,
    });
    setRunner(runner);

    await expect(prepareRegistryImage(VERSION, () => undefined)).rejects.toThrow(
      /supported platform.*linux\/amd64/i,
    );
    expect(streamed).toEqual([]);
  });

  it.each([
    ["wrong image architecture", { Architecture: "arm64" }],
    ["unknown image architecture", { Architecture: "unknown" }],
    ["blank image platform", { Os: " ", Architecture: " " }],
    ["daemon/image mismatch", { Os: "windows", Architecture: "amd64" }],
  ])("rejects %s after pull validation", async (_name, imagePlatform) => {
    setRunner(registryRunner(inspectRecord(imagePlatform)));

    await expect(prepareRegistryImage(VERSION, () => undefined)).rejects.toThrow(
      /image platform.*linux\/amd64/i,
    );
  });

  it("rejects a plausible but unauthoritative 40-hex OCI revision", async () => {
    setRunner(registryRunner());
    setReleaseProvenanceResolver(async () => ({
      revision: "34".repeat(20),
      imageDigest: IMAGE_DIGEST,
    }));

    await expect(prepareRegistryImage(VERSION, () => undefined)).rejects.toThrow(
      /revision.*does not match.*GitHub/i,
    );
  });

  it("rejects a canonical digest that disagrees with the release receipt", async () => {
    setRunner(registryRunner());
    setReleaseProvenanceResolver(async () => ({
      revision: REVISION,
      imageDigest: `${CANONICAL_IMAGE_NAME}@sha256:${"cd".repeat(32)}`,
    }));

    await expect(prepareRegistryImage(VERSION, () => undefined)).rejects.toThrow(
      /digest.*does not match.*release receipt/i,
    );
  });

  it("peels the public GitHub tag and verifies the exact release digest receipt", async () => {
    const tagObject = "34".repeat(20);
    const urls: string[] = [];
    resetReleaseProvenanceResolver();
    setPublicGithubFetch(async (url) => {
      urls.push(url);
      const json = async (): Promise<unknown> => {
        if (url.includes("/git/ref/tags/")) {
          return { object: { type: "tag", sha: tagObject } };
        }
        if (url.includes(`/git/tags/${tagObject}`)) {
          return { object: { type: "commit", sha: REVISION } };
        }
        return {
          assets: [
            {
              name: "docker-image-digest.txt",
              browser_download_url:
                "https://github.com/code-ministry-ltd/the-librarian/releases/download/v1.20.1/docker-image-digest.txt",
            },
          ],
        };
      };
      return { ok: true, status: 200, json, text: async () => `${IMAGE_DIGEST}\n` };
    });
    const runner = registryRunner();
    setRunner(runner);

    await expect(prepareRegistryImage(VERSION, () => undefined)).resolves.toMatchObject({
      revision: REVISION,
      imageDigest: IMAGE_DIGEST,
    });
    expect(urls).toEqual([
      expect.stringContaining("/git/ref/tags/v1.20.1"),
      expect.stringContaining(`/git/tags/${tagObject}`),
      expect.stringContaining("/releases/tags/v1.20.1"),
      expect.stringContaining("/releases/download/v1.20.1/docker-image-digest.txt"),
    ]);
    expect(runner.calls.some((call) => call.cmd === "git")).toBe(false);
  });

  it("rejects a digest receipt URL outside the canonical repository release", async () => {
    setPublicGithubFetch(async (url) => {
      if (url.includes("/git/ref/tags/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ object: { type: "commit", sha: REVISION } }),
          text: async () => "",
        };
      }
      if (url.includes("/releases/tags/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            assets: [
              {
                name: "docker-image-digest.txt",
                browser_download_url:
                  "https://github.com/another-owner/another-repo/releases/download/v1.20.1/docker-image-digest.txt",
              },
            ],
          }),
          text: async () => "",
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    resetReleaseProvenanceResolver();
    setRunner(registryRunner());

    await expect(prepareRegistryImage(VERSION, () => undefined)).rejects.toThrow(
      /no docker-image-digest\.txt receipt/i,
    );
  });

  it("buffers stdout and stderr independently so split secrets are redacted", async () => {
    const hex = "0123456789abcdef".repeat(4);
    const admin = "libadmin_" + "split-secret-value";
    setRunner(registryRunner());
    setStreamer({
      stream: async (_cmd, _args, handlers) => {
        handlers.onStdout?.(`token ${hex.slice(0, 19)}`);
        handlers.onStderr?.("Generated a new admin ");
        handlers.onStdout?.(`${hex.slice(19)}\n`);
        handlers.onStderr?.(`token: ${admin.slice(0, 11)}`);
        handlers.onStderr?.(`${admin.slice(11)}\n`);
        return 0;
      },
    });
    const progress: string[] = [];

    await prepareRegistryImage(VERSION, (chunk) => progress.push(chunk));

    const output = progress.join("");
    expect(output).not.toContain(hex);
    expect(output).not.toContain(admin);
    expect(output).not.toMatch(/Generated a new admin token/i);
    expect(output).toContain("[redacted]");
  });

  it("rejects invalid release refs before issuing docker commands", async () => {
    const runner = new FakeRunner();
    setRunner(runner);

    await expect(prepareRegistryImage("main", () => undefined)).rejects.toThrow(
      /exact release ref/i,
    );
    expect(runner.calls).toEqual([]);
    expect(streamed).toEqual([]);
  });
});
