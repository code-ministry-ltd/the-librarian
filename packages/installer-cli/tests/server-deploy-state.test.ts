// `server/deploy-state.ts` — the NON-SECRET deploy-state file that lets
// `update` recreate the container with the same config and `status` report the
// deployed ref reliably. It lives in the deploy dir (default
// `~/.librarian/server/deploy-state.json`) and carries NO token/key — ever.
//
// These tests assert the round-trip, the path-injection (works under a fake
// home), and — load-bearing for "data is sacred" / "no leaks" — that no secret
// shape can be written to it.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deployStatePath,
  readDeployState,
  writeDeployState,
  type DeployState,
} from "../src/server/deploy-state.js";
import { withTempHome } from "./helpers.js";

const SAMPLE: DeployState = {
  containerName: "the-librarian",
  host: "127.0.0.1",
  dataVolume: "librarian_data",
  ref: "v1.4.2",
  imageTag: "the-librarian:v1.4.2",
};

const RAW_DIGEST = `sha256:${"0123456789abcdef".repeat(4)}`;
const VERSION_IMAGE_REF = "ghcr.io/code-ministry-ltd/the-librarian:v1.4.2";
const DIGEST_IMAGE_REF = `ghcr.io/code-ministry-ltd/the-librarian@${RAW_DIGEST}`;

function expectReadAndWriteReject(dir: string, state: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(deployStatePath(dir), JSON.stringify(state), "utf8");
  expect(readDeployState(dir)).toBeNull();
  expect(() => writeDeployState(dir, state as unknown as DeployState)).toThrow(/invalid deploy/i);
}

describe("deploy-state — round-trip under a fake home", () => {
  it("writeDeployState then readDeployState returns the same state", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      writeDeployState(dir, SAMPLE);
      expect(readDeployState(dir)).toEqual(SAMPLE);
    });
  });

  it("round-trips the optional host data dir when present", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      const withDir: DeployState = { ...SAMPLE, dataDir: "/srv/librarian" };
      writeDeployState(dir, withDir);
      expect(readDeployState(dir)).toEqual(withDir);
      const parsed = JSON.parse(fs.readFileSync(deployStatePath(dir), "utf8")) as Record<
        string,
        unknown
      >;
      expect(parsed.dataDir).toBe("/srv/librarian");
    });
  });

  it("a named-volume state omits dataDir and an older (dataDir-less) file still parses", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      writeDeployState(dir, SAMPLE); // no dataDir
      const parsed = JSON.parse(fs.readFileSync(deployStatePath(dir), "utf8")) as Record<
        string,
        unknown
      >;
      expect("dataDir" in parsed).toBe(false);
      // A state written before dataDir existed must still read back cleanly.
      expect(readDeployState(dir)).toEqual(SAMPLE);
    });
  });

  it("round-trips the optional dashboard port when present", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      const withPort: DeployState = { ...SAMPLE, dashboardPort: 3500 };
      writeDeployState(dir, withPort);
      expect(readDeployState(dir)).toEqual(withPort);
      const parsed = JSON.parse(fs.readFileSync(deployStatePath(dir), "utf8")) as Record<
        string,
        unknown
      >;
      expect(parsed.dashboardPort).toBe(3500);
    });
  });

  it("round-trips optional DNS nameservers when present and omits them otherwise", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      const withDns: DeployState = {
        ...SAMPLE,
        dns: "100.100.100.100",
        dnsFallback: "8.8.8.8",
      };
      writeDeployState(dir, withDns);
      expect(readDeployState(dir)).toEqual(withDns);
      writeDeployState(dir, SAMPLE);
      const parsed = JSON.parse(fs.readFileSync(deployStatePath(dir), "utf8")) as Record<
        string,
        unknown
      >;
      expect("dns" in parsed).toBe(false);
      expect("dnsFallback" in parsed).toBe(false);
      expect(readDeployState(dir)?.dns).toBeUndefined();
    });
  });

  it("round-trips a digest-pinned registry deployment", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      const registryState: DeployState = {
        ...SAMPLE,
        imageTag: VERSION_IMAGE_REF,
        imageSource: "registry",
        imageRef: VERSION_IMAGE_REF,
        imageDigest: DIGEST_IMAGE_REF,
      };
      writeDeployState(dir, registryState);
      expect(readDeployState(dir)).toEqual(registryState);
    });
  });

  it("round-trips an explicitly recorded source deployment", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      const sourceState: DeployState = {
        ...SAMPLE,
        imageSource: "source",
        imageRef: "the-librarian:v1.4.2",
      };
      writeDeployState(dir, sourceState);
      expect(readDeployState(dir)).toEqual(sourceState);
    });
  });

  it("an old state with no image provenance still parses as a legacy source deployment", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(deployStatePath(dir), JSON.stringify(SAMPLE), "utf8");
      const state = readDeployState(dir);
      expect(state).toEqual(SAMPLE);
      expect(state?.imageSource ?? "source").toBe("source");
    });
  });

  it.each([
    DIGEST_IMAGE_REF,
    "docker.io/code-ministry-ltd/the-librarian:v1.4.2",
    "ghcr.io/code-ministry-ltd/the-librarian:1.4.2",
    "ghcr.io/code-ministry-ltd/the-librarian:v01.4.2",
    "ghcr.io/code-ministry-ltd/the-librarian:v1.4.2-beta.1",
  ])("rejects a registry state with non-canonical version imageRef %j", async (imageRef) => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      expectReadAndWriteReject(dir, {
        ...SAMPLE,
        imageTag: VERSION_IMAGE_REF,
        imageSource: "registry",
        imageRef,
        imageDigest: DIGEST_IMAGE_REF,
      });
    });
  });

  it.each([
    RAW_DIGEST,
    `docker.io/code-ministry-ltd/the-librarian@${RAW_DIGEST}`,
    `ghcr.io/code-ministry-ltd/the-librarian@SHA256:${"0123456789abcdef".repeat(4)}`,
    `ghcr.io/code-ministry-ltd/the-librarian@sha256:${"ABCDEF0123456789".repeat(4)}`,
    "ghcr.io/code-ministry-ltd/the-librarian@sha256:abcd",
  ])("rejects a registry state with non-canonical imageDigest %j", async (imageDigest) => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      expectReadAndWriteReject(dir, {
        ...SAMPLE,
        imageTag: VERSION_IMAGE_REF,
        imageSource: "registry",
        imageRef: VERSION_IMAGE_REF,
        imageDigest,
      });
    });
  });

  it.each([{ imageRef: VERSION_IMAGE_REF }, { imageDigest: DIGEST_IMAGE_REF }])(
    "rejects a registry state missing one required image identity field",
    async (identity) => {
      await withTempHome(async (home) => {
        const dir = path.join(home, ".librarian", "server");
        expectReadAndWriteReject(dir, {
          ...SAMPLE,
          imageTag: VERSION_IMAGE_REF,
          imageSource: "registry",
          ...identity,
        });
      });
    },
  );

  it.each([
    {
      label: "source discriminator without imageRef",
      state: { ...SAMPLE, imageSource: "source" },
    },
    {
      label: "imageRef without a discriminator",
      state: { ...SAMPLE, imageRef: SAMPLE.imageTag },
    },
    {
      label: "imageDigest without a discriminator",
      state: { ...SAMPLE, imageDigest: DIGEST_IMAGE_REF },
    },
    {
      label: "source deployment carrying a registry digest",
      state: {
        ...SAMPLE,
        imageSource: "source",
        imageRef: SAMPLE.imageTag,
        imageDigest: DIGEST_IMAGE_REF,
      },
    },
    {
      label: "source imageRef differing from the local imageTag",
      state: { ...SAMPLE, imageSource: "source", imageRef: "the-librarian:main" },
    },
    {
      label: "registry imageTag differing from its configured imageRef",
      state: {
        ...SAMPLE,
        imageSource: "registry",
        imageRef: VERSION_IMAGE_REF,
        imageDigest: DIGEST_IMAGE_REF,
      },
    },
    {
      label: "registry imageRef version differing from ref",
      state: {
        ...SAMPLE,
        imageTag: "ghcr.io/code-ministry-ltd/the-librarian:v1.5.0",
        imageSource: "registry",
        imageRef: "ghcr.io/code-ministry-ltd/the-librarian:v1.5.0",
        imageDigest: DIGEST_IMAGE_REF,
      },
    },
    {
      label: "unsupported imageSource discriminator",
      state: {
        ...SAMPLE,
        imageTag: VERSION_IMAGE_REF,
        imageSource: "cache",
        imageRef: VERSION_IMAGE_REF,
        imageDigest: DIGEST_IMAGE_REF,
      },
    },
  ])("rejects incoherent provenance: $label", async ({ state }) => {
    await withTempHome(async (home) => {
      expectReadAndWriteReject(path.join(home, ".librarian", "server"), state);
    });
  });

  it("a state written before dashboardPort existed omits it and reads back with no port", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      writeDeployState(dir, SAMPLE); // no dashboardPort
      const parsed = JSON.parse(fs.readFileSync(deployStatePath(dir), "utf8")) as Record<
        string,
        unknown
      >;
      expect("dashboardPort" in parsed).toBe(false);
      expect(readDeployState(dir)?.dashboardPort).toBeUndefined();
    });
  });

  it("ignores a non-integer dashboardPort in the file (falls back to undefined, never throws)", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        deployStatePath(dir),
        JSON.stringify({ ...SAMPLE, dashboardPort: "3500" }),
        "utf8",
      );
      // A string port is garbage — ignored, but the rest of the state still parses.
      const state = readDeployState(dir);
      expect(state?.dashboardPort).toBeUndefined();
      expect(state?.host).toBe("127.0.0.1");
    });
  });

  it("writes to <dir>/deploy-state.json and creates the dir if absent", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      expect(fs.existsSync(dir)).toBe(false);
      writeDeployState(dir, SAMPLE);
      expect(fs.existsSync(deployStatePath(dir))).toBe(true);
      expect(deployStatePath(dir)).toBe(path.join(dir, "deploy-state.json"));
    });
  });

  it("readDeployState returns null when the file is absent", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      expect(readDeployState(dir)).toBeNull();
    });
  });

  it("readDeployState returns null on malformed JSON (never throws)", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(deployStatePath(dir), "{ not json", "utf8");
      expect(readDeployState(dir)).toBeNull();
    });
  });

  it("readDeployState returns null when required fields are missing", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(deployStatePath(dir), JSON.stringify({ host: "127.0.0.1" }), "utf8");
      expect(readDeployState(dir)).toBeNull();
    });
  });
});

describe("deploy-state — carries NO secret (the file is non-secret)", () => {
  it("the serialized legacy state contains exactly the five non-secret fields", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      writeDeployState(dir, SAMPLE);
      const parsed = JSON.parse(fs.readFileSync(deployStatePath(dir), "utf8")) as Record<
        string,
        unknown
      >;
      expect(Object.keys(parsed).sort()).toEqual(
        ["containerName", "dataVolume", "host", "imageTag", "ref"].sort(),
      );
    });
  });

  it("persists only the eight whitelisted non-secret fields for registry state", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      writeDeployState(dir, {
        ...SAMPLE,
        imageTag: VERSION_IMAGE_REF,
        imageSource: "registry",
        imageRef: VERSION_IMAGE_REF,
        imageDigest: DIGEST_IMAGE_REF,
      });
      const parsed = JSON.parse(fs.readFileSync(deployStatePath(dir), "utf8")) as Record<
        string,
        unknown
      >;
      expect(Object.keys(parsed).sort()).toEqual(
        [
          "containerName",
          "dataVolume",
          "host",
          "imageDigest",
          "imageRef",
          "imageSource",
          "imageTag",
          "ref",
        ].sort(),
      );
    });
  });

  it.each([
    {
      variant: "legacy",
      extraKey: "token",
      state: SAMPLE,
    },
    {
      variant: "source",
      extraKey: "secretKey",
      state: { ...SAMPLE, imageSource: "source", imageRef: SAMPLE.imageTag },
    },
    {
      variant: "registry",
      extraKey: "futureField",
      state: {
        ...SAMPLE,
        imageTag: VERSION_IMAGE_REF,
        imageSource: "registry",
        imageRef: VERSION_IMAGE_REF,
        imageDigest: DIGEST_IMAGE_REF,
      },
    },
  ])("rejects an unexpected own key on $variant state during read and write", async (input) => {
    await withTempHome(async (home) => {
      // Assemble a secret-shaped value at runtime (GitGuardian scans commits).
      const extraValue = "tok_" + "0123456789abcdef".repeat(4);
      expectReadAndWriteReject(path.join(home, ".librarian", "server"), {
        ...input.state,
        [input.extraKey]: extraValue,
      });
    });
  });
});
