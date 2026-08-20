import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetRunner } from "../src/exec.js";
import { runCli } from "../src/runtime.js";
import { readDeployState, writeDeployState } from "../src/server/deploy-state.js";
import {
  CANONICAL_IMAGE_NAME,
  resetReleaseProvenanceResolver,
  setReleaseProvenanceResolver,
} from "../src/server/deployment-image.js";
import {
  resetRunner as resetDockerRunner,
  resetStreamer,
  setRunner as setDockerRunner,
  setStreamer,
} from "../src/server/docker.js";
import {
  buildCreateArgs,
  deployEnvFilePath,
  resetFinalizationRenamer,
  resetFinalizationRestorer,
  resetSecretKeyMinter,
  resetStagedEnvIdMinter,
  resetTokenMinter,
  setSecretKeyMinter,
  setFinalizationRenamer,
  setFinalizationRestorer,
  setStagedEnvIdMinter,
  setTokenMinter,
  stagedDeployEnvFilePath,
  writeDeployEnvFile,
} from "../src/server/up.js";
import {
  resetUpdateSecretArtifactRemover,
  setUpdateSecretArtifactRemover,
} from "../src/server/update.js";
import { resetLatestFetcher, setLatestFetcher } from "../src/status.js";
import { FakeRunner, withTempHome } from "./helpers.js";

const OLD_REF = "v1.20.1";
const NEW_VERSION = "1.21.0";
const NEW_REF = `v${NEW_VERSION}`;
const OLD_HASH = "10".repeat(32);
const NEW_HASH = "20".repeat(32);
const OLD_DIGEST = `${CANONICAL_IMAGE_NAME}@sha256:${OLD_HASH}`;
const NEW_DIGEST = `${CANONICAL_IMAGE_NAME}@sha256:${NEW_HASH}`;
const OLD_IMAGE_ID = `sha256:${"30".repeat(32)}`;
const REVISION = "40".repeat(20);
const CANDIDATE_ID = "50".repeat(32);
const RECOVERY_ID = "60".repeat(32);
const SOURCE_COMMIT = "80".repeat(20);
const SOURCE_TAG = `the-librarian:source-${SOURCE_COMMIT}`;
const SOURCE_IMAGE_ID = `sha256:${"81".repeat(32)}`;
const OLD_SOURCE_COMMIT = "82".repeat(20);
const OLD_SOURCE_TAG = `the-librarian:source-${OLD_SOURCE_COMMIT}`;
const OLD_SOURCE_IMAGE_ID = `sha256:${"83".repeat(32)}`;
const INVOCATION = "update-test";
const AGENT_TOKEN = "agent-token-already-running";
const FRESH_TOKEN = "fresh-agent-token-for-update";
const MASTER_KEY = "master-key-already-running";
const BOOTSTRAP = "bootstrap-claim-secret-".repeat(2);

interface LiveOptions {
  imageId?: string;
  configuredImage?: string;
  healthy?: boolean;
  host?: string;
  dashboardPort?: number;
  dataVolume?: string;
  dataDir?: string;
  user?: string;
  restartPolicy?: string;
  env?: string[];
  dns?: string[];
}

interface StreamCall {
  args: string[];
  cwd?: string;
}

let streamCalls: StreamCall[];
let streamExit: number | null;

beforeEach(() => {
  streamCalls = [];
  streamExit = 0;
  setStreamer({
    stream: async (_cmd, args, _handlers, opts) => {
      streamCalls.push({ args: [...args], cwd: opts?.cwd });
      return streamExit;
    },
  });
  setLatestFetcher(async () => NEW_VERSION);
  setReleaseProvenanceResolver(async () => ({ revision: REVISION, imageDigest: NEW_DIGEST }));
  setStagedEnvIdMinter(() => INVOCATION);
  setTokenMinter(() => FRESH_TOKEN);
  setSecretKeyMinter(() => "must-not-be-minted-by-update");
});

afterEach(() => {
  resetRunner();
  resetDockerRunner();
  resetStreamer();
  resetLatestFetcher();
  resetReleaseProvenanceResolver();
  resetStagedEnvIdMinter();
  resetTokenMinter();
  resetSecretKeyMinter();
  resetFinalizationRenamer();
  resetFinalizationRestorer();
  resetUpdateSecretArtifactRemover();
});

function deployDir(home: string): string {
  return path.join(home, ".librarian", "server");
}

function envFile(home: string): string {
  return deployEnvFilePath(deployDir(home));
}

function stagedEnv(home: string): string {
  return stagedDeployEnvFilePath(deployDir(home), INVOCATION);
}

function seedSource(home: string, ref = OLD_REF): void {
  const dir = deployDir(home);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  writeDeployState(dir, {
    containerName: "the-librarian",
    host: "127.0.0.1",
    dataVolume: "librarian_data",
    dashboardPort: 3000,
    ref,
    imageTag: `the-librarian:${ref}`,
    imageSource: "source",
    imageRef: `the-librarian:${ref}`,
  });
  writeDeployEnvFile(dir, {
    agentToken: AGENT_TOKEN,
    secretKey: MASTER_KEY,
    bootstrapClaimSecret: BOOTSTRAP,
    host: "127.0.0.1",
  });
}

function seedRegistry(home: string, ref = OLD_REF, digest = OLD_DIGEST): void {
  const dir = deployDir(home);
  fs.mkdirSync(dir, { recursive: true });
  writeDeployState(dir, {
    containerName: "the-librarian",
    host: "127.0.0.1",
    dataVolume: "librarian_data",
    dashboardPort: 3042,
    ref,
    imageTag: `${CANONICAL_IMAGE_NAME}:${ref}`,
    imageSource: "registry",
    imageRef: `${CANONICAL_IMAGE_NAME}:${ref}`,
    imageDigest: digest,
  });
  writeDeployEnvFile(dir, {
    agentToken: AGENT_TOKEN,
    secretKey: MASTER_KEY,
    bootstrapClaimSecret: BOOTSTRAP,
    host: "127.0.0.1",
  });
}

function seedResolvedSource(home: string, ref: string, imageTag: string): void {
  const dir = deployDir(home);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  writeDeployState(dir, {
    containerName: "the-librarian",
    host: "127.0.0.1",
    dataVolume: "librarian_data",
    dashboardPort: 3000,
    ref,
    imageTag,
    imageSource: "source",
    imageRef: imageTag,
  });
  writeDeployEnvFile(dir, {
    agentToken: AGENT_TOKEN,
    secretKey: MASTER_KEY,
    bootstrapClaimSecret: BOOTSTRAP,
    host: "127.0.0.1",
  });
}

function liveJson(options: LiveOptions = {}): string {
  const host = options.host ?? "127.0.0.1";
  const dashboardPort = options.dashboardPort ?? 3000;
  const dataDir = options.dataDir;
  return JSON.stringify({
    Id: "70".repeat(32),
    Image: options.imageId ?? OLD_IMAGE_ID,
    State: {
      Status: "running",
      Health: { Status: options.healthy === false ? "unhealthy" : "healthy" },
    },
    Config: {
      Image: options.configuredImage ?? `the-librarian:${OLD_REF}`,
      User: options.user ?? (dataDir ? "1001:1002" : "node"),
      Env: options.env ?? [
        `LIBRARIAN_AGENT_TOKEN=${AGENT_TOKEN}`,
        `LIBRARIAN_SECRET_KEY=${MASTER_KEY}`,
        `LIBRARIAN_BOOTSTRAP_CLAIM_SECRET=${BOOTSTRAP}`,
        "LIBRARIAN_ALLOW_NO_AUTH=true",
        "LIBRARIAN_DATA_DIR=/data",
        "LIBRARIAN_HOST=0.0.0.0",
        "LIBRARIAN_PORT=3838",
        "PORT=3000",
      ],
    },
    HostConfig: {
      RestartPolicy: { Name: options.restartPolicy ?? "unless-stopped" },
      PortBindings: {
        "3000/tcp": [{ HostIp: host, HostPort: String(dashboardPort) }],
        "3838/tcp": [{ HostIp: host, HostPort: "3838" }],
      },
      ...(options.dns && options.dns.length > 0 ? { Dns: options.dns } : {}),
    },
    Mounts: dataDir
      ? [{ Type: "bind", Source: dataDir, Destination: "/data" }]
      : [
          {
            Type: "volume",
            Name: options.dataVolume ?? "librarian_data",
            Destination: "/data",
          },
        ],
  });
}

function registryInspect(): string {
  return JSON.stringify({
    Os: "linux",
    Architecture: "amd64",
    Config: {
      Labels: {
        "org.opencontainers.image.source": "https://github.com/code-ministry-ltd/the-librarian",
        "org.opencontainers.image.version": NEW_VERSION,
        "org.opencontainers.image.revision": REVISION,
      },
    },
    RepoTags: [`${CANONICAL_IMAGE_NAME}:${NEW_REF}`],
    RepoDigests: [NEW_DIGEST],
  });
}

function baseRunner(live = liveJson()): FakeRunner {
  return new FakeRunner()
    .withWhich("docker")
    .withWhich("git")
    .onRun("docker", ["info"], { code: 0 })
    .onRun("docker", ["info", "--format", "{{json .}}"], {
      stdout: JSON.stringify({ OSType: "linux", Architecture: "amd64" }),
    })
    .onRun("docker", ["container", "inspect", "--format", "{{json .}}", "the-librarian"], {
      stdout: live,
    })
    .onRun(
      "docker",
      ["image", "inspect", "--format", "{{json .}}", `${CANONICAL_IMAGE_NAME}:${NEW_REF}`],
      {
        stdout: registryInspect(),
      },
    );
}

function replacementArgs(home: string, imageRef: string, options: LiveOptions = {}): string[] {
  const args = buildCreateArgs({
    host: options.host ?? "127.0.0.1",
    dataVolume: options.dataVolume ?? "librarian_data",
    dashboardPort: options.dashboardPort ?? 3000,
    dataDir: options.dataDir,
    runAsUser: options.user ?? (options.dataDir ? "1001:1002" : "node"),
    restartPolicy: options.restartPolicy ?? "unless-stopped",
    imageRef,
    envFile: stagedEnv(home),
    dnsServers: options.dns,
  });
  args.splice(1, 0, "--cidfile", `${stagedEnv(home)}.cid`);
  return args;
}

function recoveryArgs(home: string, options: LiveOptions = {}): string[] {
  const args = replacementArgs(home, OLD_IMAGE_ID, options);
  args[args.indexOf("--env-file") + 1] = `${stagedEnv(home)}.previous`;
  args[args.indexOf("--cidfile") + 1] = `${stagedEnv(home)}.previous.cid`;
  return args;
}

const cidfileEnabled = new WeakSet<FakeRunner>();

function enableCidfileWrites(runner: FakeRunner): void {
  if (cidfileEnabled.has(runner)) return;
  cidfileEnabled.add(runner);
  const original = runner.run.bind(runner);
  runner.run = async (cmd, args, opts) => {
    const result = await original(cmd, args, opts);
    const cidfileIndex = args.indexOf("--cidfile");
    if (cmd !== "docker" || args[0] !== "create" || cidfileIndex < 0 || result.code !== 0) {
      return result;
    }
    const id = result.stdout.trim();
    if (/^[0-9a-f]{64}$/.test(id)) fs.writeFileSync(args[cidfileIndex + 1]!, `${id}\n`);
    // Docker stdout is intentionally not an identity contract for the update.
    return { ...result, stdout: "create acknowledged without an ID\n" };
  };
}

function scriptSuccessfulReplacement(
  runner: FakeRunner,
  home: string,
  imageRef: string,
  options: LiveOptions = {},
): FakeRunner {
  enableCidfileWrites(runner);
  const args = replacementArgs(home, imageRef, options);
  return runner
    .onRun("docker", args, { stdout: `${CANDIDATE_ID}\n` })
    .onRun("docker", ["start", CANDIDATE_ID], { code: 0 })
    .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", CANDIDATE_ID], {
      stdout: "healthy\n",
    });
}

function scriptSource(runner: FakeRunner, checkout: string, ref: string): FakeRunner {
  return runner
    .onRun("git", ["-C", checkout, "remote", "get-url", "origin"], {
      stdout: "https://github.com/code-ministry-ltd/the-librarian\n",
    })
    .onRun("git", ["-C", checkout, "fetch", "--tags", "origin"], { code: 0 })
    .onRun(
      "git",
      [
        "-C",
        checkout,
        "rev-parse",
        "--verify",
        "--end-of-options",
        `refs/remotes/origin/${ref}^{commit}`,
      ],
      { stdout: `${SOURCE_COMMIT}\n` },
    )
    .onRun("git", ["-C", checkout, "checkout", SOURCE_COMMIT], { code: 0 })
    .onRun("docker", ["image", "inspect", "--format", "{{.Id}}", SOURCE_TAG], {
      stdout: `${SOURCE_IMAGE_ID}\n`,
    });
}

function callIndex(runner: FakeRunner, verb: string): number {
  return runner.calls.findIndex((call) => call.cmd === "docker" && call.args[0] === verb);
}

function destructiveVolumeCommand(runner: FakeRunner): boolean {
  return runner.calls.some(
    (call) =>
      call.cmd === "docker" &&
      ((call.args[0] === "rm" && call.args.includes("-v")) ||
        (call.args[0] === "volume" && call.args.includes("rm"))),
  );
}

describe("server update — strategy and preparation", () => {
  it("moves a source deployment to an exact published digest on a Docker-only host", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      const runner = scriptSuccessfulReplacement(baseRunner(), home, NEW_DIGEST);
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", NEW_REF], { home });

      expect(result.exitCode).toBe(0);
      expect(runner.calls.some((call) => call.cmd === "git")).toBe(false);
      expect(streamCalls[0]?.args).toEqual(["pull", `${CANONICAL_IMAGE_NAME}:${NEW_REF}`]);
      expect(callIndex(runner, "image")).toBeLessThan(callIndex(runner, "stop"));
      expect(runner.ran("docker", ["stop", "70".repeat(32)])).toBe(true);
      expect(runner.ran("docker", ["rm", "70".repeat(32)])).toBe(true);
      expect(readDeployState(deployDir(home))).toMatchObject({
        imageSource: "registry",
        ref: NEW_REF,
        imageRef: `${CANONICAL_IMAGE_NAME}:${NEW_REF}`,
        imageDigest: NEW_DIGEST,
      });
    });
  });

  it("updates a published deployment to a newer published digest", async () => {
    await withTempHome(async (home) => {
      seedRegistry(home);
      const live = liveJson({ configuredImage: OLD_DIGEST, dashboardPort: 3042 });
      const runner = scriptSuccessfulReplacement(baseRunner(live), home, NEW_DIGEST, {
        dashboardPort: 3042,
      });
      setDockerRunner(runner);

      const result = await runCli(["server", "update"], { home });
      expect(result.exitCode).toBe(0);
      expect(readDeployState(deployDir(home))?.imageDigest).toBe(NEW_DIGEST);
    });
  });

  it("creates a managed checkout when a published deployment switches to main", async () => {
    await withTempHome(async (home) => {
      seedRegistry(home);
      const checkout = path.join(deployDir(home), "source");
      const live = liveJson({ configuredImage: OLD_DIGEST, dashboardPort: 3042 });
      let runner = baseRunner(live).onRun(
        "git",
        ["clone", "https://github.com/code-ministry-ltd/the-librarian", checkout],
        { code: 0 },
      );
      runner = scriptSource(runner, checkout, "main");
      runner = scriptSuccessfulReplacement(runner, home, SOURCE_IMAGE_ID, {
        dashboardPort: 3042,
      });
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", "main"], { home });
      expect(result.exitCode).toBe(0);
      expect(streamCalls[0]).toMatchObject({
        args: expect.arrayContaining(["build"]),
        cwd: checkout,
      });
      expect(readDeployState(deployDir(home))).toMatchObject({
        imageSource: "source",
        ref: "main",
        imageRef: SOURCE_TAG,
      });
    });
  });

  it("keeps an existing source checkout for source updates", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      const checkout = deployDir(home);
      let runner = scriptSource(baseRunner(), checkout, "main");
      runner = scriptSuccessfulReplacement(runner, home, SOURCE_IMAGE_ID);
      setDockerRunner(runner);

      expect((await runCli(["server", "update", "--ref", "main"], { home })).exitCode).toBe(0);
      expect(streamCalls[0]?.cwd).toBe(checkout);
    });
  });

  it("fetches main before no-op so an advanced remote commit is deployed", async () => {
    await withTempHome(async (home) => {
      seedResolvedSource(home, "main", OLD_SOURCE_TAG);
      const checkout = deployDir(home);
      const live = liveJson({
        imageId: OLD_SOURCE_IMAGE_ID,
        configuredImage: OLD_SOURCE_IMAGE_ID,
      });
      let runner = scriptSource(baseRunner(live), checkout, "main");
      runner = scriptSuccessfulReplacement(runner, home, SOURCE_IMAGE_ID);
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", "main"], { home });
      expect(result.exitCode).toBe(0);
      expect(streamCalls[0]?.args).toContain(SOURCE_TAG);
      expect(readDeployState(checkout)).toMatchObject({ ref: "main", imageRef: SOURCE_TAG });
    });
  });

  it("an unchanged resolved source commit and immutable image is a clean no-op", async () => {
    await withTempHome(async (home) => {
      seedResolvedSource(home, "main", SOURCE_TAG);
      const checkout = deployDir(home);
      const live = liveJson({ imageId: SOURCE_IMAGE_ID, configuredImage: SOURCE_IMAGE_ID });
      const runner = scriptSource(baseRunner(live), checkout, "main");
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", "main"], { home });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/already up to date/i);
      expect(result.stdout).toMatch(/source main/i);
      expect(streamCalls).toEqual([]);
      expect(callIndex(runner, "stop")).toBe(-1);
    });
  });

  it("builds a slash branch with a commit-derived tag and runs the inspected image ID", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      const checkout = deployDir(home);
      let runner = scriptSource(baseRunner(), checkout, "feature/pull-images");
      runner = scriptSuccessfulReplacement(runner, home, SOURCE_IMAGE_ID);
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", "feature/pull-images"], { home });
      expect(result.exitCode).toBe(0);
      expect(streamCalls[0]?.args).toContain(SOURCE_TAG);
      expect(streamCalls[0]?.args.join(" ")).not.toContain("the-librarian:feature/pull-images");
      const create = runner.calls.find((call) => call.args[0] === "create")?.args;
      expect(create?.at(-1)).toBe(SOURCE_IMAGE_ID);
      expect(create).not.toContain(SOURCE_TAG);
    });
  });

  it("accepts literal git ref punctuation without treating it as revision syntax", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      const ref = "release+candidate";
      let runner = scriptSource(baseRunner(), deployDir(home), ref);
      runner = scriptSuccessfulReplacement(runner, home, SOURCE_IMAGE_ID);
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", ref], { home });

      expect(result.exitCode).toBe(0);
      expect(streamCalls[0]?.args).toContain(SOURCE_TAG);
    });
  });

  it("runs the inspected source image ID rather than the mutable build tag", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      let runner = scriptSource(baseRunner(), deployDir(home), "main");
      runner = scriptSuccessfulReplacement(runner, home, SOURCE_IMAGE_ID);
      setDockerRunner(runner);

      expect((await runCli(["server", "update", "--ref", "main"], { home })).exitCode).toBe(0);
      const create = runner.calls.find((call) => call.args[0] === "create")?.args;
      expect(create?.at(-1)).toBe(SOURCE_IMAGE_ID);
      expect(create).not.toContain(SOURCE_TAG);
    });
  });

  it("a failed pull leaves the serving container, deploy files, and state untouched", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      const beforeEnv = fs.readFileSync(envFile(home));
      const beforeState = fs.readFileSync(path.join(deployDir(home), "deploy-state.json"));
      streamExit = 1;
      const runner = baseRunner();
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", NEW_REF], { home });
      expect(result.exitCode).toBe(1);
      expect(callIndex(runner, "stop")).toBe(-1);
      expect(fs.readFileSync(envFile(home))).toEqual(beforeEnv);
      expect(fs.readFileSync(path.join(deployDir(home), "deploy-state.json"))).toEqual(beforeState);
    });
  });

  it("a provenance mismatch leaves the old service serving without source fallback", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      setReleaseProvenanceResolver(async () => ({
        revision: REVISION,
        imageDigest: `${CANONICAL_IMAGE_NAME}@sha256:${"99".repeat(32)}`,
      }));
      const runner = baseRunner();
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", NEW_REF], { home });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/receipt|digest/i);
      expect(callIndex(runner, "stop")).toBe(-1);
      expect(runner.calls.some((call) => call.cmd === "git")).toBe(false);
    });
  });

  it("a failed source build leaves the old service serving", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      streamExit = 7;
      const runner = scriptSource(baseRunner(), deployDir(home), "main");
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", "main"], { home });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("still serving");
      expect(callIndex(runner, "stop")).toBe(-1);
    });
  });

  it.each([
    ["tracked", " M packages/core/src/index.ts\n"],
    ["untracked", "?? local-notes.txt\n"],
  ])(
    "refuses a source update with %s checkout changes before build or stop",
    async (_kind, status) => {
      await withTempHome(async (home) => {
        seedSource(home);
        const checkout = deployDir(home);
        const beforeEnv = fs.readFileSync(envFile(home));
        const stateFile = path.join(checkout, "deploy-state.json");
        const beforeState = fs.readFileSync(stateFile);
        const runner = scriptSource(baseRunner(), checkout, "main").onRun(
          "git",
          ["-C", checkout, "status", "--porcelain", "--untracked-files=all"],
          { stdout: status },
        );
        setDockerRunner(runner);

        const result = await runCli(["server", "update", "--ref", "main"], { home });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/local tracked or untracked changes/i);
        expect(streamCalls).toEqual([]);
        expect(callIndex(runner, "stop")).toBe(-1);
        expect(fs.readFileSync(envFile(home))).toEqual(beforeEnv);
        expect(fs.readFileSync(stateFile)).toEqual(beforeState);
      });
    },
  );

  it("ignores only the untracked CLI-owned files in a legacy root checkout", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      const checkout = deployDir(home);
      let runner = scriptSource(baseRunner(), checkout, "main").onRun(
        "git",
        ["-C", checkout, "status", "--porcelain", "--untracked-files=all"],
        {
          stdout: "?? deploy.env\n?? deploy-state.json\n?? .autoupdate.lock\n",
        },
      );
      runner = scriptSuccessfulReplacement(runner, home, SOURCE_IMAGE_ID);
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", "main"], { home });

      expect(result.exitCode).toBe(0);
      expect(streamCalls[0]?.cwd).toBe(checkout);
      expect(runner.ran("docker", ["stop", "70".repeat(32)])).toBe(true);
    });
  });

  it("does not echo a credential-bearing unexpected git remote", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      const username = ["runtime", "user"].join("-");
      const password = ["runtime", "credential"].join("-");
      const remote = `https://${username}:${password}@github.com/other-owner/other-repository.git?access=${password}`;
      const runner = baseRunner().onRun(
        "git",
        ["-C", deployDir(home), "remote", "get-url", "origin"],
        { stdout: `${remote}\n` },
      );
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", "main"], { home });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/unexpected origin/i);
      expect(result.stderr).not.toContain(username);
      expect(result.stderr).not.toContain(password);
      expect(result.stderr).not.toContain(remote);
    });
  });

  it("accepts the canonical git remote when HTTPS credentials are configured", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      const username = ["runtime", "user"].join("-");
      const password = ["runtime", "credential"].join("-");
      const remote = `https://${username}:${password}@github.com/code-ministry-ltd/the-librarian.git`;
      const checkout = deployDir(home);
      let runner = scriptSource(baseRunner(), checkout, "main").onRun(
        "git",
        ["-C", checkout, "remote", "get-url", "origin"],
        { stdout: `${remote}\n` },
      );
      runner = scriptSuccessfulReplacement(runner, home, SOURCE_IMAGE_ID);
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", "main"], { home });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain(username);
      expect(result.stdout).not.toContain(password);
    });
  });

  it("sanitizes credential-bearing git diagnostics", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      const credential = ["runtime", "fetch", "credential"].join("-");
      const leaked = `https://worker:${credential}@github.com/code-ministry-ltd/the-librarian.git?token=${credential}`;
      const checkout = deployDir(home);
      const runner = scriptSource(baseRunner(), checkout, "main").onRun(
        "git",
        ["-C", checkout, "fetch", "--tags", "origin"],
        { code: 1, stderr: `fatal: could not read from ${leaked}` },
      );
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", "main"], { home });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("[redacted-remote]");
      expect(result.stderr).not.toContain(credential);
      expect(result.stderr).not.toContain(leaked);
      expect(callIndex(runner, "stop")).toBe(-1);
    });
  });

  it("rejects git revision expressions before checkout, build, or stop", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      const runner = scriptSource(baseRunner(), deployDir(home), "main~1");
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", "main~1"], { home });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/literal branch name.*revision expressions/is);
      expect(streamCalls).toEqual([]);
      expect(callIndex(runner, "stop")).toBe(-1);
      expect(
        runner.calls.some((call) => call.cmd === "git" && call.args.includes("checkout")),
      ).toBe(false);
    });
  });
});

describe("server update — exact no-op and preserved configuration", () => {
  it("an exact healthy published deployment is a no-op before registry access", async () => {
    await withTempHome(async (home) => {
      seedRegistry(home);
      const runner = baseRunner(liveJson({ configuredImage: OLD_DIGEST, dashboardPort: 3042 }));
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", OLD_REF], { home });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/already up to date/i);
      expect(result.stdout).toMatch(/published v1\.20\.1 \(101010101010\)/i);
      expect(streamCalls).toEqual([]);
      expect(callIndex(runner, "stop")).toBe(-1);
    });
  });

  it("a strategy change at the same ref is not treated as a no-op", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      setLatestFetcher(async () => OLD_REF.slice(1));
      setReleaseProvenanceResolver(async () => ({ revision: REVISION, imageDigest: NEW_DIGEST }));
      const runner = scriptSuccessfulReplacement(
        baseRunner().onRun(
          "docker",
          ["image", "inspect", "--format", "{{json .}}", `${CANONICAL_IMAGE_NAME}:${OLD_REF}`],
          {
            stdout: registryInspect()
              .replaceAll(NEW_REF, OLD_REF)
              .replace(`"${NEW_VERSION}"`, `"${OLD_REF.slice(1)}"`),
          },
        ),
        home,
        NEW_DIGEST,
      );
      setDockerRunner(runner);

      const result = await runCli(["server", "update"], { home });
      expect(result.exitCode).toBe(0);
      expect(streamCalls[0]?.args[0]).toBe("pull");
      expect(callIndex(runner, "stop")).toBeGreaterThan(0);
    });
  });

  it.each([
    [
      "runtime environment",
      {
        env: [
          `LIBRARIAN_AGENT_TOKEN=${AGENT_TOKEN}`,
          `LIBRARIAN_SECRET_KEY=${MASTER_KEY}`,
          `LIBRARIAN_BOOTSTRAP_CLAIM_SECRET=${BOOTSTRAP}`,
          "LIBRARIAN_ALLOW_NO_AUTH=true",
          "LIBRARIAN_DATA_DIR=/data",
          "LIBRARIAN_HOST=0.0.0.0",
          "LIBRARIAN_PORT=3838",
        ],
      },
    ],
    ["/data mount", { dataVolume: "drifted_volume" }],
  ] as const)("rejects %s drift instead of returning the pre-pull no-op", async (_label, drift) => {
    await withTempHome(async (home) => {
      seedRegistry(home);
      const liveOptions: LiveOptions = {
        configuredImage: OLD_DIGEST,
        dashboardPort: 3042,
        ...drift,
      };
      const oldInspect = registryInspect()
        .replaceAll(NEW_REF, OLD_REF)
        .replace(`"${NEW_VERSION}"`, `"${OLD_REF.slice(1)}"`);
      let runner = baseRunner(liveJson(liveOptions)).onRun(
        "docker",
        ["image", "inspect", "--format", "{{json .}}", `${CANONICAL_IMAGE_NAME}:${OLD_REF}`],
        { stdout: oldInspect },
      );
      runner = scriptSuccessfulReplacement(runner, home, NEW_DIGEST, liveOptions);
      setDockerRunner(runner);
      setReleaseProvenanceResolver(async () => ({ revision: REVISION, imageDigest: NEW_DIGEST }));

      const result = await runCli(["server", "update", "--ref", OLD_REF], { home });
      expect(result.stdout).not.toMatch(/already up to date/i);
      expect(streamCalls[0]?.args[0]).toBe("pull");
    });
  });

  it("preserves bind mount ownership, custom ports, secrets, claim, and restart policy", async () => {
    await withTempHome(async (home) => {
      const dataDir = path.join(home, "vault");
      fs.mkdirSync(dataDir);
      const dir = deployDir(home);
      fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
      writeDeployState(dir, {
        containerName: "the-librarian",
        host: "100.64.0.8",
        dataVolume: "unused",
        dataDir,
        dashboardPort: 3500,
        ref: OLD_REF,
        imageTag: `the-librarian:${OLD_REF}`,
        imageSource: "source",
        imageRef: `the-librarian:${OLD_REF}`,
      });
      writeDeployEnvFile(dir, {
        agentToken: AGENT_TOKEN,
        secretKey: MASTER_KEY,
        bootstrapClaimSecret: BOOTSTRAP,
        host: "100.64.0.8",
      });
      const liveOptions = {
        host: "100.64.0.8",
        dashboardPort: 3500,
        dataDir,
        user: "1001:1002",
      };
      const runner = scriptSuccessfulReplacement(
        baseRunner(liveJson(liveOptions)),
        home,
        NEW_DIGEST,
        liveOptions,
      );
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", NEW_REF], { home });
      expect(result.exitCode).toBe(0);
      const create = runner.calls.find((call) => call.args[0] === "create")?.args ?? [];
      expect(create).toContain("100.64.0.8:3500:3000");
      expect(create).toContain(`${dataDir}:/data`);
      expect(create).toContain("1001:1002");
      expect(create.some((arg) => arg.includes(AGENT_TOKEN) || arg.includes(MASTER_KEY))).toBe(
        false,
      );
      expect(fs.readFileSync(envFile(home), "utf8")).toContain(
        `LIBRARIAN_BOOTSTRAP_CLAIM_SECRET=${BOOTSTRAP}`,
      );
    });
  });

  it("a preserved custom user and restart policy no-op on an immediate same-target update", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      const custom: LiveOptions = { user: "1002:1003", restartPolicy: "always" };
      let runner = scriptSuccessfulReplacement(
        baseRunner(liveJson(custom)),
        home,
        NEW_DIGEST,
        custom,
      );
      setDockerRunner(runner);
      expect((await runCli(["server", "update", "--ref", NEW_REF], { home })).exitCode).toBe(0);

      streamCalls = [];
      runner = baseRunner(liveJson({ ...custom, configuredImage: NEW_DIGEST }));
      setDockerRunner(runner);
      const second = await runCli(["server", "update", "--ref", NEW_REF], { home });
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toMatch(/already up to date/i);
      expect(streamCalls).toEqual([]);
      expect(callIndex(runner, "stop")).toBe(-1);
    });
  });
});

describe("server update — opt-in operator DNS", () => {
  it("recreates a healthy latest deploy when --dns is new (does not no-op)", async () => {
    await withTempHome(async (home) => {
      seedRegistry(home, NEW_REF, NEW_DIGEST);
      const live = liveJson({ configuredImage: NEW_DIGEST, dashboardPort: 3042 });
      const dns = ["100.100.100.100"];
      const runner = scriptSuccessfulReplacement(baseRunner(live), home, NEW_DIGEST, {
        dashboardPort: 3042,
        dns,
      });
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--dns", "100.100.100.100"], { home });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toMatch(/already up to date/i);
      expect(callIndex(runner, "stop")).toBeGreaterThan(0);
      expect(readDeployState(deployDir(home))).toMatchObject({ dns: "100.100.100.100" });
    });
  });

  it("reuses stored DNS on a later update with no DNS flags", async () => {
    await withTempHome(async (home) => {
      seedRegistry(home);
      const dir = deployDir(home);
      writeDeployState(dir, { ...readDeployState(dir)!, dns: "100.100.100.100" });
      const live = liveJson({
        configuredImage: OLD_DIGEST,
        dashboardPort: 3042,
        dns: ["100.100.100.100"],
      });
      const runner = scriptSuccessfulReplacement(baseRunner(live), home, NEW_DIGEST, {
        dashboardPort: 3042,
        dns: ["100.100.100.100"],
      });
      setDockerRunner(runner);

      const result = await runCli(["server", "update"], { home });
      expect(result.exitCode).toBe(0);
      expect(readDeployState(dir)).toMatchObject({
        imageDigest: NEW_DIGEST,
        dns: "100.100.100.100",
      });
    });
  });

  it("a same-version update without DNS flags leaves a live hand-patch in place", async () => {
    await withTempHome(async (home) => {
      seedRegistry(home, NEW_REF, NEW_DIGEST);
      const runner = baseRunner(
        liveJson({
          configuredImage: NEW_DIGEST,
          dashboardPort: 3042,
          dns: ["100.100.100.100"],
        }),
      );
      setDockerRunner(runner);

      const result = await runCli(["server", "update"], { home });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/already up to date/i);
      expect(callIndex(runner, "stop")).toBe(-1);
      expect(readDeployState(deployDir(home))?.dns).toBeUndefined();
    });
  });

  it("a version bump with no flags adopts live HostConfig.Dns into deploy-state", async () => {
    await withTempHome(async (home) => {
      seedRegistry(home);
      const dns = ["100.100.100.100"];
      const live = liveJson({ configuredImage: OLD_DIGEST, dashboardPort: 3042, dns });
      const runner = scriptSuccessfulReplacement(baseRunner(live), home, NEW_DIGEST, {
        dashboardPort: 3042,
        dns,
      });
      setDockerRunner(runner);

      const result = await runCli(["server", "update"], { home });
      expect(result.exitCode).toBe(0);
      expect(readDeployState(deployDir(home))).toMatchObject({ dns: "100.100.100.100" });
    });
  });

  it("--no-dns on an already-current deploy recreates without --dns", async () => {
    await withTempHome(async (home) => {
      seedRegistry(home, NEW_REF, NEW_DIGEST);
      const dir = deployDir(home);
      writeDeployState(dir, { ...readDeployState(dir)!, dns: "100.100.100.100" });
      const live = liveJson({
        configuredImage: NEW_DIGEST,
        dashboardPort: 3042,
        dns: ["100.100.100.100"],
      });
      const runner = scriptSuccessfulReplacement(baseRunner(live), home, NEW_DIGEST, {
        dashboardPort: 3042,
      });
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--no-dns"], { home });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toMatch(/already up to date/i);
      expect(readDeployState(dir)?.dns).toBeUndefined();
    });
  });
});

describe("server update — recoverable replacement", () => {
  it("uses the cidfile identity when docker create stdout is malformed", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      const runner = scriptSuccessfulReplacement(baseRunner(), home, NEW_DIGEST);
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", NEW_REF], { home });

      expect(result.exitCode).toBe(0);
      expect(runner.ran("docker", ["start", CANDIDATE_ID])).toBe(true);
      expect(runner.calls.find((call) => call.args[0] === "create")?.args).toContain("--cidfile");
      expect(
        runner.calls.some((call) => call.args.includes("the-librarian") && call.args[0] === "rm"),
      ).toBe(false);
    });
  });

  it("a missing create cidfile gives inspect-only manual guidance without mutable-name cleanup", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      const runner = baseRunner().onRun("docker", replacementArgs(home, NEW_DIGEST), {
        stdout: `${CANDIDATE_ID}\n`,
      });
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", NEW_REF], { home });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("docker container inspect");
      expect(result.stderr).not.toContain("docker create");
      expect(result.stderr).not.toContain("docker rm -f the-librarian");
      expect(result.stderr).not.toContain("docker start the-librarian");
    });
  });

  it("a stop-boundary failure restarts and verifies the original named container", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      const runner = baseRunner()
        .onRun("docker", ["stop", "70".repeat(32)], { code: 1, stderr: "stop failed" })
        .onRun("docker", ["start", "70".repeat(32)], { code: 0 })
        .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", "70".repeat(32)], {
          stdout: "healthy\n",
        });
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", NEW_REF], { home });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/restored and verified healthy/i);
      expect(runner.ran("docker", ["start", "70".repeat(32)])).toBe(true);
      expect(readDeployState(deployDir(home))?.ref).toBe(OLD_REF);
    });
  });

  it("a remove-boundary failure restarts the original immutable container ID", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      const runner = baseRunner()
        .onRun("docker", ["rm", "70".repeat(32)], { code: 1, stderr: "rm failed" })
        .onRun("docker", ["container", "inspect", "70".repeat(32)], { stdout: "still here" })
        .onRun("docker", ["start", "70".repeat(32)], { code: 0 })
        .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", "70".repeat(32)], {
          stdout: "healthy\n",
        });
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", NEW_REF], { home });
      expect(result.exitCode).toBe(1);
      expect(runner.ran("docker", ["start", "70".repeat(32)])).toBe(true);
      expect(callIndex(runner, "create")).toBe(-1);
    });
  });

  it("classifies a failed rm whose immutable ID is already absent as removed", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      let runner = baseRunner()
        .onRun("docker", ["rm", "70".repeat(32)], { code: 1, stderr: "daemon timeout" })
        .onRun("docker", ["container", "inspect", "70".repeat(32)], {
          code: 1,
          stderr: `No such container: ${"70".repeat(32)}`,
        });
      runner = scriptSuccessfulReplacement(runner, home, NEW_DIGEST);
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", NEW_REF], { home });
      expect(result.exitCode).toBe(0);
      expect(runner.ran("docker", replacementArgs(home, NEW_DIGEST))).toBe(true);
    });
  });

  it("an unhealthy replacement is removed by ID and the previous image is recreated and verified", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      let runner = baseRunner();
      runner = scriptSuccessfulReplacement(runner, home, NEW_DIGEST)
        .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", CANDIDATE_ID], {
          stdout: "unhealthy\n",
        })
        .onRun("docker", ["logs", "--tail", "50", CANDIDATE_ID], {
          stdout: `health failed ${AGENT_TOKEN} ${BOOTSTRAP}`,
        });
      const oldArgs = recoveryArgs(home);
      runner
        .onRun("docker", ["rm", "-f", CANDIDATE_ID], { code: 0 })
        .onRun("docker", oldArgs, { stdout: `${RECOVERY_ID}\n` })
        .onRun("docker", ["start", RECOVERY_ID], { code: 0 })
        .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", RECOVERY_ID], {
          stdout: "healthy\n",
        });
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", NEW_REF], { home });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/restored and verified healthy/i);
      expect(result.stderr).not.toContain(AGENT_TOKEN);
      expect(result.stderr).not.toContain(BOOTSTRAP);
      expect(runner.ran("docker", ["rm", "-f", CANDIDATE_ID])).toBe(true);
      expect(runner.ran("docker", oldArgs)).toBe(true);
      expect(readDeployState(deployDir(home))?.ref).toBe(OLD_REF);
    });
  });

  it("a migration failure restores the executable and states that data was not rolled back", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      let runner = scriptSuccessfulReplacement(baseRunner(), home, NEW_DIGEST).onRun(
        "docker",
        ["exec", CANDIDATE_ID, "the-librarian", "migrate-data-dir"],
        { code: 1, stderr: `migration failed ${AGENT_TOKEN} ${BOOTSTRAP}` },
      );
      const oldArgs = recoveryArgs(home);
      runner = runner
        .onRun("docker", ["rm", "-f", CANDIDATE_ID], { code: 0 })
        .onRun("docker", oldArgs, { stdout: `${RECOVERY_ID}\n` })
        .onRun("docker", ["start", RECOVERY_ID], { code: 0 })
        .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", RECOVERY_ID], {
          stdout: "healthy\n",
        });
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", NEW_REF], { home });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/persistent data changes.*NOT rolled back/i);
      expect(result.stderr).not.toContain(AGENT_TOKEN);
      expect(result.stderr).not.toContain(BOOTSTRAP);
      expect(readDeployState(deployDir(home))?.ref).toBe(OLD_REF);
    });
  });

  it("a second-file promotion failure restores old files and recovers with an extant env-file", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      const oldEnv = fs.readFileSync(envFile(home));
      const oldState = fs.readFileSync(path.join(deployDir(home), "deploy-state.json"));
      let promotions = 0;
      setFinalizationRenamer((source, destination) => {
        promotions += 1;
        if (promotions === 2) throw new Error("state promotion failed");
        fs.renameSync(source, destination);
      });
      let runner = scriptSuccessfulReplacement(baseRunner(), home, NEW_DIGEST);
      const oldArgs = recoveryArgs(home);
      runner = runner
        .onRun("docker", ["rm", "-f", CANDIDATE_ID], { code: 0 })
        .onRun("docker", oldArgs, { stdout: `${RECOVERY_ID}\n` })
        .onRun("docker", ["start", RECOVERY_ID], { code: 0 })
        .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", RECOVERY_ID], {
          stdout: "healthy\n",
        });
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", NEW_REF], { home });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/restored and verified healthy/i);
      expect(runner.ran("docker", oldArgs)).toBe(true);
      expect(fs.readFileSync(envFile(home))).toEqual(oldEnv);
      expect(fs.readFileSync(path.join(deployDir(home), "deploy-state.json"))).toEqual(oldState);
    });
  });

  it("preserves the prior recovery env and teaches file repair when persistence restoration fails", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      let promotions = 0;
      setFinalizationRenamer((source, destination) => {
        promotions += 1;
        if (promotions === 2) throw new Error("state promotion failed");
        fs.renameSync(source, destination);
      });
      setFinalizationRestorer(() => {
        throw new Error("prior bytes could not be restored");
      });
      let runner = scriptSuccessfulReplacement(baseRunner(), home, NEW_DIGEST);
      const oldArgs = recoveryArgs(home);
      runner = runner
        .onRun("docker", ["rm", "-f", CANDIDATE_ID], { code: 0 })
        .onRun("docker", oldArgs, { stdout: `${RECOVERY_ID}\n` })
        .onRun("docker", ["start", RECOVERY_ID], { code: 0 })
        .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", RECOVERY_ID], {
          stdout: "healthy\n",
        });
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", NEW_REF], { home });
      const priorEnv = `${stagedEnv(home)}.previous`;
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/restoration FAILED|may be inconsistent/i);
      expect(result.stderr).not.toContain("Deploy state was not advanced");
      expect(result.stderr).toContain(priorEnv);
      expect(fs.statSync(priorEnv).mode & 0o777).toBe(0o600);
    });
  });

  it("reports protected credential residue when successful-update cleanup fails", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      const runner = scriptSuccessfulReplacement(baseRunner(), home, NEW_DIGEST);
      setDockerRunner(runner);
      setUpdateSecretArtifactRemover(() => {
        throw new Error("cleanup denied");
      });

      const result = await runCli(["server", "update", "--ref", NEW_REF], { home });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/credential residue remains/i);
      expect(result.stdout).toContain(`${stagedEnv(home)}.previous`);
      expect(result.stdout).not.toContain(AGENT_TOKEN);
    });
  });

  it("appends a residue warning when recovered-failure cleanup cannot remove secret artifacts", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      let runner = scriptSuccessfulReplacement(baseRunner(), home, NEW_DIGEST).onRun(
        "docker",
        ["inspect", "--format", "{{.State.Health.Status}}", CANDIDATE_ID],
        { stdout: "unhealthy\n" },
      );
      const oldArgs = recoveryArgs(home);
      runner = runner
        .onRun("docker", ["rm", "-f", CANDIDATE_ID], { code: 0 })
        .onRun("docker", oldArgs, { stdout: `${RECOVERY_ID}\n` })
        .onRun("docker", ["start", RECOVERY_ID], { code: 0 })
        .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", RECOVERY_ID], {
          stdout: "healthy\n",
        });
      setDockerRunner(runner);
      setUpdateSecretArtifactRemover(() => {
        throw new Error("cleanup denied");
      });

      const result = await runCli(["server", "update", "--ref", NEW_REF], { home });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/credential residue remains/i);
      expect(result.stderr).not.toContain(AGENT_TOKEN);
    });
  });

  it("a recovery failure reports both failures and inspect-only guidance when ownership is unknown", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      const leakedSecret = "de".repeat(32);
      let runner = scriptSuccessfulReplacement(baseRunner(), home, NEW_DIGEST).onRun(
        "docker",
        ["inspect", "--format", "{{.State.Health.Status}}", CANDIDATE_ID],
        { stdout: "unhealthy\n" },
      );
      const oldArgs = recoveryArgs(home);
      runner = runner
        .onRun("docker", ["logs", "--tail", "50", CANDIDATE_ID], {
          stdout: `candidate failed ${leakedSecret}`,
        })
        .onRun("docker", ["rm", "-f", CANDIDATE_ID], { code: 0 })
        .onRun("docker", oldArgs, { code: 1, stderr: `recovery failed ${leakedSecret}` });
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", NEW_REF], { home });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/Update failed:.*Recovery also failed:/s);
      expect(result.stderr).toContain("The server was NOT rolled back");
      expect(result.stderr).toContain("docker container inspect");
      expect(result.stderr).not.toMatch(/\ndocker create/);
      expect(result.stderr).toMatch(/do not remove, recreate, or start/i);
      expect(result.stderr).not.toContain(leakedSecret);
      expect(result.stderr).not.toContain("docker rm -f the-librarian");
      expect(fs.existsSync(stagedEnv(home))).toBe(true);
    });
  });

  it("a pre-removal restart failure prints only exact old-ID restart recovery commands", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      const oldId = "70".repeat(32);
      const runner = baseRunner()
        .onRun("docker", ["stop", oldId], { code: 1, stderr: "stop failed" })
        .onRun("docker", ["start", oldId], { code: 1, stderr: "restart failed" });
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", NEW_REF], { home });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`docker container inspect ${oldId}`);
      expect(result.stderr).toContain(`docker start ${oldId}`);
      expect(result.stderr).not.toContain("docker create");
      expect(result.stderr).not.toContain("docker rm -f the-librarian");
    });
  });

  it("a finalization plus recovery failure prints an env-file path that still exists", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      let promotions = 0;
      setFinalizationRenamer((source, destination) => {
        promotions += 1;
        if (promotions === 2) throw new Error("state promotion failed");
        fs.renameSync(source, destination);
      });
      let runner = scriptSuccessfulReplacement(baseRunner(), home, NEW_DIGEST);
      const oldArgs = recoveryArgs(home);
      runner = runner
        .onRun("docker", ["rm", "-f", CANDIDATE_ID], { code: 0 })
        .onRun("docker", oldArgs, { code: 1, stderr: "recovery create failed" });
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", NEW_REF], { home });
      const printedEnv = `${stagedEnv(home)}.previous`;
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(printedEnv);
      expect(fs.existsSync(printedEnv!)).toBe(true);
    });
  });

  it("restores a non-loopback legacy deployment with no token without adopting the fresh candidate token", async () => {
    await withTempHome(async (home) => {
      const dir = deployDir(home);
      fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
      writeDeployState(dir, {
        containerName: "the-librarian",
        host: "100.64.0.9",
        dataVolume: "librarian_data",
        dashboardPort: 3000,
        ref: OLD_REF,
        imageTag: `the-librarian:${OLD_REF}`,
      });
      fs.writeFileSync(envFile(home), `LIBRARIAN_SECRET_KEY=${MASTER_KEY}\n`, { mode: 0o600 });
      const live = liveJson({
        host: "100.64.0.9",
        env: [
          `LIBRARIAN_SECRET_KEY=${MASTER_KEY}`,
          "LIBRARIAN_DATA_DIR=/data",
          "LIBRARIAN_HOST=0.0.0.0",
          "LIBRARIAN_PORT=3838",
          "PORT=3000",
        ],
      });
      let runner = scriptSuccessfulReplacement(baseRunner(live), home, NEW_DIGEST, {
        host: "100.64.0.9",
      }).onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", CANDIDATE_ID], {
        stdout: "unhealthy\n",
      });
      const oldArgs = recoveryArgs(home, { host: "100.64.0.9" });
      runner = runner
        .onRun("docker", ["rm", "-f", CANDIDATE_ID], { code: 0 })
        .onRun("docker", oldArgs, { stdout: `${RECOVERY_ID}\n` })
        .onRun("docker", ["start", RECOVERY_ID], { code: 0 })
        .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", RECOVERY_ID], {
          stdout: "healthy\n",
        });
      let recoveryEnvBody = "";
      const originalRun = runner.run.bind(runner);
      runner.run = async (cmd, args, opts) => {
        if (cmd === "docker" && args[0] === "create" && args.at(-1) === OLD_IMAGE_ID) {
          const envPath = args[args.indexOf("--env-file") + 1];
          recoveryEnvBody = fs.readFileSync(envPath!, "utf8");
        }
        return originalRun(cmd, args, opts);
      };
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", NEW_REF], { home });
      expect(result.exitCode).toBe(1);
      expect(recoveryEnvBody).not.toContain("LIBRARIAN_AGENT_TOKEN");
      expect(recoveryEnvBody).not.toContain(FRESH_TOKEN);
    });
  });

  it("a failed recovery start names only the owned recovery ID in cleanup guidance", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      let runner = scriptSuccessfulReplacement(baseRunner(), home, NEW_DIGEST).onRun(
        "docker",
        ["inspect", "--format", "{{.State.Health.Status}}", CANDIDATE_ID],
        { stdout: "unhealthy\n" },
      );
      const oldArgs = recoveryArgs(home);
      runner = runner
        .onRun("docker", ["rm", "-f", CANDIDATE_ID], { code: 0 })
        .onRun("docker", oldArgs, { stdout: `${RECOVERY_ID}\n` })
        .onRun("docker", ["start", RECOVERY_ID], { code: 1, stderr: "start failed" });
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", NEW_REF], { home });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`docker rm -f ${RECOVERY_ID}`);
      expect(result.stderr).not.toContain("docker rm -f the-librarian");
    });
  });

  it("never issues destructive volume commands or leaks preserved secrets", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      const runner = scriptSuccessfulReplacement(baseRunner(), home, NEW_DIGEST);
      setDockerRunner(runner);

      const result = await runCli(["server", "update", "--ref", NEW_REF], { home });
      const argv = runner.calls.flatMap((call) => call.args).join("\n");
      expect(result.exitCode).toBe(0);
      expect(destructiveVolumeCommand(runner)).toBe(false);
      expect(argv).not.toContain(AGENT_TOKEN);
      expect(argv).not.toContain(MASTER_KEY);
      expect(result.stdout + result.stderr).not.toContain(MASTER_KEY);
      expect(JSON.stringify(readDeployState(deployDir(home)))).not.toContain(AGENT_TOKEN);
    });
  });
});

describe("server update — lifecycle guardrails", () => {
  it("acquires the lifecycle lock before attempting to read deploy state", async () => {
    await withTempHome(async (home) => {
      const dir = deployDir(home);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, ".autoupdate.lock"), `${process.pid} ${Date.now()}\n`);
      setDockerRunner(new FakeRunner().withWhich("docker").onRun("docker", ["info"], { code: 0 }));

      const result = await runCli(["server", "update", "--ref", NEW_REF], { home });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/another update is already in progress/i);
      expect(result.stderr).not.toMatch(/no deploy-state/i);
    });
  });
  it("uses Docker-only preflight for a release and Git preflight for source", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      const registryRunner = baseRunner();
      setDockerRunner(registryRunner);
      const registry = await runCli(["server", "update", "--ref", NEW_REF], { home });
      expect(registry.stderr).not.toMatch(/git is required/i);

      const sourceRunner = new FakeRunner().withWhich("docker").onRun("docker", ["info"], {
        code: 0,
      });
      setDockerRunner(sourceRunner);
      const source = await runCli(["server", "update", "--ref", "main"], { home });
      expect(source.exitCode).toBe(1);
      expect(source.stderr).toMatch(/git is required/i);
    });
  });

  it("releases the shared lock after success and failure", async () => {
    await withTempHome(async (home) => {
      seedSource(home);
      let runner = scriptSuccessfulReplacement(baseRunner(), home, NEW_DIGEST);
      setDockerRunner(runner);
      expect((await runCli(["server", "update", "--ref", NEW_REF], { home })).exitCode).toBe(0);
      expect(fs.existsSync(path.join(deployDir(home), ".autoupdate.lock"))).toBe(false);

      streamExit = 1;
      runner = baseRunner(liveJson({ configuredImage: NEW_DIGEST, dashboardPort: 3000 }));
      setDockerRunner(runner);
      expect((await runCli(["server", "update", "--ref", "v1.22.0"], { home })).exitCode).toBe(1);
      expect(fs.existsSync(path.join(deployDir(home), ".autoupdate.lock"))).toBe(false);
    });
  });
});
