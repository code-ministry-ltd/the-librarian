// S2 — `librarian server up` (localhost happy path).
//
// Every test drives the public `runCli(["server", "up", …])` entry against a
// fresh temp home, the injected `docker.ts` FakeRunner (so the EXACT git/docker
// argv is asserted), a stubbed latest-release fetcher, a deterministic agent
// token, a no-op health-poll sleep, and a scripted prompter. No real daemon,
// network, or git is ever touched.

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readEnvFile } from "../src/env.js";
import { resetRunner } from "../src/exec.js";
import { runCli } from "../src/runtime.js";
import { deployStatePath, readDeployState, writeDeployState } from "../src/server/deploy-state.js";
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
  buildRunArgs,
  deployEnvFilePath,
  stagedDeployEnvFilePath,
  resetSecretKeyMinter,
  resetFinalizationRenamer,
  resetSleep,
  resetStagedEnvIdMinter,
  resetTokenMinter,
  runUp,
  setSecretKeyMinter,
  setFinalizationRenamer,
  setSleep,
  setStagedEnvIdMinter,
  setTokenMinter,
  waitForHealthy,
  writeDeployEnvFile,
} from "../src/server/up.js";
import { resetLatestFetcher, setLatestFetcher } from "../src/status.js";
import { FakeRunner, withTempHome } from "./helpers.js";
import { FakePrompter } from "./prompter.js";

const AGENT_TOKEN = "agent-token-deterministic-for-tests";
// ADR 0008 P4: the master key is CLI-MINTED (no longer read back from the
// container). This is the deterministic value the minter seam returns in tests.
const MASTER_KEY = "master-key-minted-by-the-cli-deterministic";
const BOOTSTRAP_CLAIM_SECRET = "managed-bootstrap-claim-secret-".repeat(2);
const LATEST = "1.4.2"; // fetchLatestVersion returns the v-stripped version
const LATEST_TAG = "v1.4.2";
const REGISTRY_HASH = "ab".repeat(32);
const REGISTRY_DIGEST = `${CANONICAL_IMAGE_NAME}@sha256:${REGISTRY_HASH}`;
const REGISTRY_IMAGE_REF = `${CANONICAL_IMAGE_NAME}:${LATEST_TAG}`;
const REGISTRY_REVISION = "12".repeat(20);
const CANDIDATE_CONTAINER_ID = "cafebabedeadbeef".repeat(4);
const UNRELATED_CONTAINER_ID = "decafbad01234567".repeat(4);
const STAGED_ENV_INVOCATION_ID = "deterministic-invocation";

function registryInspectJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Os: "linux",
    Architecture: "amd64",
    Config: {
      Labels: {
        "org.opencontainers.image.source": "https://github.com/code-ministry-ltd/the-librarian",
        "org.opencontainers.image.version": LATEST,
        "org.opencontainers.image.revision": REGISTRY_REVISION,
      },
    },
    RepoTags: [REGISTRY_IMAGE_REF],
    RepoDigests: [REGISTRY_DIGEST],
    ...overrides,
  });
}

// The image build STREAMS its output live (so a multi-minute build isn't a blank
// line) — it goes through the streamer seam, not the capture runner. Record the
// streamed build invocation + stub success so no test ever spawns a real build.
let buildStream: { cmd: string; args: string[]; opts?: { cwd?: string } }[];
beforeEach(() => {
  buildStream = [];
  setStagedEnvIdMinter(() => STAGED_ENV_INVOCATION_ID);
  setReleaseProvenanceResolver(async () => ({
    revision: REGISTRY_REVISION,
    imageDigest: REGISTRY_DIGEST,
  }));
  setStreamer({
    stream: async (cmd, args, _handlers, opts) => {
      buildStream.push({ cmd, args: [...args], opts });
      return 0;
    },
  });
});

/** The streamed `docker build` argv (after `docker`), or undefined if none. */
function streamedBuildArgs(): string[] | undefined {
  return buildStream.find((c) => c.cmd === "docker" && c.args[0] === "build")?.args;
}

function streamedPullArgs(): string[] | undefined {
  return buildStream.find((c) => c.cmd === "docker" && c.args[0] === "pull")?.args;
}

afterEach(() => {
  resetRunner();
  resetDockerRunner();
  resetStreamer();
  resetLatestFetcher();
  resetSleep();
  resetStagedEnvIdMinter();
  resetTokenMinter();
  resetSecretKeyMinter();
  resetReleaseProvenanceResolver();
  resetFinalizationRenamer();
});

/** A FakeRunner wired for a fully-successful localhost `up`. */
function healthyRunner(): FakeRunner {
  // ADR 0008 P4: secrets are CLI-minted into a 0600 deploy env-file and delivered
  // via `docker run --env-file`; the master key is NOT read back from the
  // container, so there is no `docker exec cat /data/secret.key` to script.
  return withCandidateLifecycle(
    new FakeRunner()
      .withWhich("docker")
      .withWhich("git")
      .onRun("docker", ["info"], { code: 0 })
      .onRun("docker", ["info", "--format", "{{json .}}"], {
        stdout: JSON.stringify({ OSType: "linux", Architecture: "amd64" }),
        code: 0,
      })
      .onRun("docker", ["container", "inspect", "--format", "{{json .}}", "the-librarian"], {
        stderr: "No such container: the-librarian",
        code: 1,
      })
      .onRun("docker", ["image", "inspect", "--format", "{{json .}}", REGISTRY_IMAGE_REF], {
        stdout: `${registryInspectJson()}\n`,
        code: 0,
      })
      .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", "the-librarian"], {
        stdout: "healthy\n",
        code: 0,
      })
      .onRun(
        "docker",
        ["inspect", "--format", "{{.State.Health.Status}}", CANDIDATE_CONTAINER_ID],
        { stdout: "healthy\n", code: 0 },
      ),
  );
}

/** A fully-successful registry deployment runner; Git is intentionally absent. */
function healthyRegistryRunner(): FakeRunner {
  return withCandidateLifecycle(
    new FakeRunner()
      .withWhich("docker")
      .onRun("docker", ["info"], { code: 0 })
      .onRun("docker", ["info", "--format", "{{json .}}"], {
        stdout: JSON.stringify({ OSType: "linux", Architecture: "x86_64" }),
        code: 0,
      })
      .onRun("docker", ["container", "inspect", "--format", "{{json .}}", "the-librarian"], {
        stderr: "No such container: the-librarian",
        code: 1,
      })
      .onRun("docker", ["image", "inspect", "--format", "{{json .}}", REGISTRY_IMAGE_REF], {
        stdout: `${registryInspectJson()}\n`,
        code: 0,
      })
      .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", "the-librarian"], {
        stdout: "healthy\n",
        code: 0,
      })
      .onRun(
        "docker",
        ["inspect", "--format", "{{.State.Health.Status}}", CANDIDATE_CONTAINER_ID],
        { stdout: "healthy\n", code: 0 },
      ),
  );
}

function withCandidateLifecycle(runner: FakeRunner): FakeRunner {
  const realRun = runner.run.bind(runner);
  runner.run = async (cmd, args, options) => {
    if (cmd === "docker" && args[0] === "create") {
      runner.calls.push({ cmd, args: [...args], opts: options });
      return { stdout: `${CANDIDATE_CONTAINER_ID}\n`, stderr: "", code: 0 };
    }
    if (cmd === "docker" && args[0] === "start" && args[1] === CANDIDATE_CONTAINER_ID) {
      runner.calls.push({ cmd, args: [...args], opts: options });
      return { stdout: `${CANDIDATE_CONTAINER_ID}\n`, stderr: "", code: 0 };
    }
    return realRun(cmd, args, options);
  };
  return runner;
}

/** Install the deterministic seams shared by the happy-path tests. */
function stubSeams(): void {
  setLatestFetcher(async () => LATEST);
  setTokenMinter(() => AGENT_TOKEN);
  setSecretKeyMinter(() => MASTER_KEY);
  setSleep(async () => undefined);
}

/** The deploy env-file path under a temp home's default deploy dir. */
function deployEnvOf(home: string): string {
  return deployEnvFilePath(path.join(home, ".librarian", "server"));
}

function stagedDeployEnvOf(home: string): string {
  return stagedDeployEnvFilePath(path.join(home, ".librarian", "server"), STAGED_ENV_INVOCATION_ID);
}

/** The argv (after `docker`) any `run -d …` call recorded by the runner. */
function dockerRunArgs(runner: FakeRunner): string[] | undefined {
  return runner.calls.find((c) => c.cmd === "docker" && c.args[0] === "create")?.args;
}

function liveRegistryContainer() {
  return {
    State: { Health: { Status: "healthy" } },
    Config: {
      Image: REGISTRY_DIGEST,
      User: "node",
      Env: [
        "LIBRARIAN_AGENT_TOKEN=existing-agent-token",
        "LIBRARIAN_SECRET_KEY=existing-master-key-long-enough-for-safe-reuse",
        "LIBRARIAN_ALLOW_NO_AUTH=true",
        "LIBRARIAN_DATA_DIR=/data",
        "LIBRARIAN_HOST=0.0.0.0",
        "LIBRARIAN_PORT=3838",
        "PORT=3000",
      ],
    },
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
      PortBindings: {
        "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "3042" }],
        "3838/tcp": [{ HostIp: "127.0.0.1", HostPort: "3838" }],
      },
    },
    Mounts: [{ Destination: "/data", Type: "volume", Name: "librarian_data" }],
  };
}

function seedRegistryDeployment(home: string): string {
  const deployDir = path.join(home, ".librarian", "server");
  writeDeployEnvFile(deployDir, {
    agentToken: "existing-agent-token",
    secretKey: "existing-master-key-long-enough-for-safe-reuse",
    host: "127.0.0.1",
  });
  writeDeployState(deployDir, {
    containerName: "the-librarian",
    host: "127.0.0.1",
    dataVolume: "librarian_data",
    dashboardPort: 3042,
    ref: LATEST_TAG,
    imageTag: REGISTRY_IMAGE_REF,
    imageSource: "registry",
    imageRef: REGISTRY_IMAGE_REF,
    imageDigest: REGISTRY_DIGEST,
  });
  return deployDir;
}

describe("server up — source localhost happy path (exact argv)", () => {
  it("clones at an arbitrary source ref, builds, then runs the localhost container", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up", "--ref", "main"], { home, prompter });
      expect(r.exitCode).toBe(0);

      const deployDir = path.join(home, ".librarian", "server");

      // git clone <repo> <dir>, then resolve the ref to a SHA — guarded on
      // `rev-parse` (which DOES honor `--end-of-options`; `git checkout` does
      // NOT) — and check out that SHA (S-1). The checkout itself running is
      // proven by the docker build/run below (it follows the checkout in code).
      expect(
        runner.ran("git", [
          "clone",
          "https://github.com/code-ministry-ltd/the-librarian",
          deployDir,
        ]),
      ).toBe(true);
      expect(
        runner.ran("git", [
          "-C",
          deployDir,
          "rev-parse",
          "--verify",
          "--end-of-options",
          "main^{commit}",
        ]),
      ).toBe(true);

      // docker build with the VERIFIED command — STREAMED live (`--progress=plain`).
      expect(streamedBuildArgs()).toEqual([
        "build",
        "--progress=plain",
        "-f",
        "docker/all-in-one.Dockerfile",
        "-t",
        "the-librarian:main",
        ".",
      ]);

      // docker run — the EXACT localhost argv. ADR 0008 P4: secrets ride in the
      // 0600 deploy env-file via `--env-file <path>`, NOT inline `-e`. No --init.
      expect(dockerRunArgs(runner)).toEqual([
        "create",
        "--name",
        "the-librarian",
        "--restart",
        "unless-stopped",
        "-p",
        "127.0.0.1:3042:3000",
        "-p",
        "127.0.0.1:3838:3838",
        "-v",
        "librarian_data:/data",
        "--env-file",
        stagedDeployEnvOf(home),
        "the-librarian:main",
      ]);

      // The secrets must NOT appear on argv (off-argv invariant — ADR 0008 P4).
      const runArgs = dockerRunArgs(runner) ?? [];
      expect(runArgs.some((a) => a.includes(AGENT_TOKEN))).toBe(false);
      expect(runArgs.some((a) => a.includes(MASTER_KEY))).toBe(false);
      expect(runArgs.some((a) => a.includes("LIBRARIAN_ALLOW_NO_AUTH"))).toBe(false);
    });
  });

  it("runs build + run from the deploy dir (cwd carries the Dockerfile context)", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      await runCli(["server", "up", "--ref", "main"], { home, prompter });

      const deployDir = path.join(home, ".librarian", "server");
      const build = buildStream.find((c) => c.args[0] === "build");
      const dRun = runner.calls.find((c) => c.cmd === "docker" && c.args[0] === "create");
      expect(build?.opts?.cwd).toBe(deployDir);
      expect(dRun?.opts?.cwd).toBe(deployDir);
    });
  });
});

describe("server up — flags reflected in argv", () => {
  it("--data-volume, --dir and --ref are honoured", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const customDir = path.join(home, "custom-deploy");
      const r = await runCli(
        ["server", "up", "--data-volume", "my_vol", "--dir", customDir, "--ref", "main"],
        { home, prompter },
      );
      expect(r.exitCode).toBe(0);

      // Clone + checkout at the pinned ref, into the custom dir.
      expect(
        runner.ran("git", [
          "clone",
          "https://github.com/code-ministry-ltd/the-librarian",
          customDir,
        ]),
      ).toBe(true);
      expect(
        runner.ran("git", [
          "-C",
          customDir,
          "rev-parse",
          "--verify",
          "--end-of-options",
          "main^{commit}",
        ]),
      ).toBe(true);

      // The image tag follows the ref; the volume is the override. (Build streams.)
      expect(streamedBuildArgs()).toEqual([
        "build",
        "--progress=plain",
        "-f",
        "docker/all-in-one.Dockerfile",
        "-t",
        "the-librarian:main",
        ".",
      ]);
      const runArgs = dockerRunArgs(runner);
      expect(runArgs).toContain("my_vol:/data");
      expect(runArgs?.[runArgs.length - 1]).toBe("the-librarian:main");
    });
  });

  it("--data-dir bind-mounts a host directory and runs the container as its owner", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const dataDir = path.join(home, "my-vault");
      const r = await runCli(["server", "up", "--data-dir", dataDir], { home, prompter });
      expect(r.exitCode).toBe(0);

      const runArgs = dockerRunArgs(runner) ?? [];
      // Bind-mount the ABSOLUTE host path at /data — not the named volume.
      expect(runArgs).toContain(`${dataDir}:/data`);
      expect(runArgs).not.toContain("librarian_data:/data");
      // Run as the directory's owner so the vault stays host-owned + writable.
      const owner = `${process.getuid?.()}:${process.getgid?.()}`;
      const u = runArgs.indexOf("--user");
      expect(u).toBeGreaterThan(-1);
      expect(runArgs[u + 1]).toBe(owner);
      // --user is an option (precedes the image, the final arg).
      expect(u).toBeLessThan(runArgs.length - 1);
      // The directory was created, and deploy-state records it so `update` reuses it.
      expect(fs.existsSync(dataDir)).toBe(true);
      expect(readDeployState(path.join(home, ".librarian", "server"))?.dataDir).toBe(dataDir);
    });
  });

  it("--data-dir and --data-volume together is a teaching error (no docker run)", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(
        ["server", "up", "--data-dir", path.join(home, "v"), "--data-volume", "my_vol"],
        { home, prompter },
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/either --data-dir.*--data-volume|not both/i);
      // It aborts before recreating anything.
      expect(runner.calls.some((c) => c.cmd === "docker" && c.args[0] === "run")).toBe(false);
    });
  });
});

describe("server up — health-wait failure rolls back (no half-up)", () => {
  it("an unhealthy container is removed, logs surfaced, and the command errors", async () => {
    await withTempHome(async (home) => {
      const runner = new FakeRunner()
        .withWhich("docker")
        .withWhich("git")
        .onRun("docker", ["info"], { code: 0 })
        .onRun("docker", ["info", "--format", "{{json .}}"], {
          stdout: JSON.stringify({ OSType: "linux", Architecture: "amd64" }),
          code: 0,
        })
        .onRun("docker", ["container", "inspect", "--format", "{{json .}}", "the-librarian"], {
          stderr: "No such container: the-librarian",
          code: 1,
        })
        .onRun("docker", ["image", "inspect", "--format", "{{json .}}", REGISTRY_IMAGE_REF], {
          stdout: registryInspectJson(),
          code: 0,
        })
        .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", "the-librarian"], {
          stdout: "unhealthy\n",
          code: 0,
        })
        .onRun(
          "docker",
          ["inspect", "--format", "{{.State.Health.Status}}", CANDIDATE_CONTAINER_ID],
          { stdout: "unhealthy\n", code: 0 },
        )
        .onRun("docker", ["logs", "--tail", "50", "the-librarian"], {
          stdout: "boom: the server crashed on boot\n",
          code: 0,
        })
        .onRun("docker", ["logs", "--tail", "50", CANDIDATE_CONTAINER_ID], {
          stdout: "boom: the server crashed on boot\n",
          code: 0,
        });
      setDockerRunner(withCandidateLifecycle(runner));
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      // The container reports `unhealthy`, so the poll terminates fast (no need
      // to wait out the bound) and the flow rolls back.
      const r = await runCli(["server", "up", "--ref", "main"], { home, prompter });

      expect(r.exitCode).toBe(1);
      // Rolled back — the container was force-removed.
      expect(runner.ran("docker", ["rm", "-f", CANDIDATE_CONTAINER_ID])).toBe(true);
      // Logs were surfaced to the operator.
      expect(runner.calls.some((c) => c.cmd === "docker" && c.args[0] === "logs")).toBe(true);
      expect(r.stderr).toMatch(/did not become healthy/i);
      expect(r.stderr).toMatch(/rolled back/i);
      // No master-key read happened (we failed before the exec).
      expect(runner.ran("docker", ["exec", "the-librarian", "cat", "/data/secret.key"])).toBe(
        false,
      );
    });
  });
});

describe("server up — a failed docker step REDACTS secret-bearing output (S-2)", () => {
  it("removes staged credentials when the source image build fails", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      setStreamer({ stream: async () => 1 });

      const result = await runCli(["server", "up", "--ref", "main"], {
        home,
        prompter: new FakePrompter({}),
      });

      expect(result.exitCode).toBe(1);
      expect(fs.existsSync(stagedDeployEnvOf(home))).toBe(false);
      expect(fs.existsSync(deployEnvOf(home))).toBe(false);
    });
  });

  it("a docker run failure is surfaced redacted; the secrets never reach argv or the error", async () => {
    await withTempHome(async (home) => {
      // The real minters yield 64-hex values; mirror that shape here (assembled
      // from sub-threshold parts) so redactSecrets's 64-hex rule can catch any
      // value that DID somehow reach the captured stream (e.g. an expanded env).
      const hexAgentToken = "fedcba9876543210".repeat(4);
      const hexMasterKey = "0123456789abcdef".repeat(4);
      setLatestFetcher(async () => LATEST);
      setTokenMinter(() => hexAgentToken);
      setSecretKeyMinter(() => hexMasterKey);
      setSleep(async () => undefined);

      // Everything up to `docker run` succeeds (clone/checkout/build); only the
      // `docker run -d …` step fails. ADR 0008 P4: the secrets ride in the 0600
      // deploy env-file (via `--env-file`), so they are NOT on argv. We simulate
      // a daemon that echoes the EXPANDED env anyway (worst case) and assert the
      // redactor still scrubs the 64-hex values.
      const runner = new FakeRunner()
        .withWhich("docker")
        .withWhich("git")
        .withFallback({ code: 0 })
        .onRun("docker", ["info"], { code: 0 })
        .onRun("docker", ["container", "inspect", "--format", "{{json .}}", "the-librarian"], {
          stderr: "No such container: the-librarian",
          code: 1,
        });
      // Script the failing `docker run` by matching its full argv.
      const runArgs = buildCreateArgs({
        host: "127.0.0.1",
        dataVolume: "librarian_data",
        dashboardPort: 3042,
        imageRef: "the-librarian:main",
        envFile: stagedDeployEnvOf(home),
      });
      runner.onRun("docker", runArgs, {
        stderr:
          "docker: Error response from daemon: invalid reference; env was " +
          `LIBRARIAN_AGENT_TOKEN=${hexAgentToken} LIBRARIAN_SECRET_KEY=${hexMasterKey}\n`,
        code: 1,
      });
      setDockerRunner(runner);
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up", "--ref", "main"], { home, prompter });
      expect(r.exitCode).toBe(1);
      // It failed at the `docker create` step (not earlier).
      expect(r.stderr).toMatch(/docker create/);
      // The secrets are NOT on the docker run argv (off-argv invariant).
      expect(runArgs.some((a) => a.includes(hexAgentToken))).toBe(false);
      expect(runArgs.some((a) => a.includes(hexMasterKey))).toBe(false);
      // Neither secret may appear in the surfaced error...
      expect(r.stderr).not.toContain(hexAgentToken);
      expect(r.stderr).not.toContain(hexMasterKey);
      // ...but the non-secret remainder of the error IS surfaced.
      expect(r.stderr).toMatch(/Error response from daemon/);
      // ...and neither leaked into any file other than the 0600 deploy env-file.
      expect(filesContaining(home, hexAgentToken)).toEqual([]);
      expect(filesContaining(home, hexMasterKey)).toEqual([]);
    });
  });
});

describe("server up — master key surfaced once, persisted only in the 0600 deploy env-file", () => {
  it("prints the key exactly once with the SAVE warning; it lands ONLY in the deploy env-file", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      // Accept the env-write offer — even then, the MASTER KEY must not land in
      // the CLIENT env (~/.librarian/env); only the agent token may. The master
      // key's ONLY host home is the 0600 deploy env-file (ADR 0008 P4).
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "y" } });

      const r = await runCli(["server", "up", "--ref", "main"], { home, prompter });
      expect(r.exitCode).toBe(0);

      // Surfaced exactly once, beside the SAVE warning — the CLI-minted key.
      expect(r.stdout).toContain(MASTER_KEY);
      expect(r.stdout.split(MASTER_KEY).length - 1).toBe(1);
      expect(r.stdout).toMatch(/SAVE THIS KEY — excluded from backups/);

      // The master key appears in EXACTLY ONE file: the 0600 deploy env-file —
      // never in the client env, deploy-state, or anywhere else.
      expect(filesContaining(home, MASTER_KEY)).toEqual([deployEnvOf(home)]);
    });
  });
});

describe("server up — the 0600 deploy env-file (ADR 0008 P4)", () => {
  it("writes the deploy env-file (mode 0600) with the agent token, master key, and loopback ALLOW_NO_AUTH; argv references it via --env-file; no read-back", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up", "--ref", "main"], { home, prompter });
      expect(r.exitCode).toBe(0);

      const envFile = deployEnvOf(home);

      // The file exists and is 0600 (owner read/write only).
      const mode = fs.statSync(envFile).mode & 0o777;
      expect(mode).toBe(0o600);

      // It carries all three deploy env entries (loopback → ALLOW_NO_AUTH).
      const body = fs.readFileSync(envFile, "utf8");
      expect(body).toContain(`LIBRARIAN_AGENT_TOKEN=${AGENT_TOKEN}`);
      expect(body).toContain(`LIBRARIAN_SECRET_KEY=${MASTER_KEY}`);
      expect(body).toContain("LIBRARIAN_ALLOW_NO_AUTH=true");

      // The docker run argv references it via `--env-file <path>` — and carries
      // NO inline `-e` for these secrets / the no-auth flag.
      const runArgs = dockerRunArgs(runner) ?? [];
      const envFlagIdx = runArgs.indexOf("--env-file");
      expect(envFlagIdx).toBeGreaterThanOrEqual(0);
      expect(runArgs[envFlagIdx + 1]).toBe(stagedDeployEnvOf(home));
      expect(runArgs).not.toContain("-e");
      expect(runArgs.some((a) => a.includes(AGENT_TOKEN))).toBe(false);
      expect(runArgs.some((a) => a.includes(MASTER_KEY))).toBe(false);

      // The master key is the CLI-minted value, surfaced once — NOT read back
      // from the container (no `docker exec cat /data/secret.key`).
      expect(r.stdout).toContain(MASTER_KEY);
      expect(runner.ran("docker", ["exec", "the-librarian", "cat", "/data/secret.key"])).toBe(
        false,
      );
    });
  });

  it("beyond-localhost OMITS ALLOW_NO_AUTH from the env-file (still 0600, still has both secrets)", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up", "--host", "100.101.102.103"], { home, prompter });
      expect(r.exitCode).toBe(0);

      const envFile = deployEnvOf(home);
      expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
      const body = fs.readFileSync(envFile, "utf8");
      expect(body).toContain(`LIBRARIAN_AGENT_TOKEN=${AGENT_TOKEN}`);
      expect(body).toContain(`LIBRARIAN_SECRET_KEY=${MASTER_KEY}`);
      // Beyond localhost: no loopback no-auth bypass.
      expect(body).not.toContain("LIBRARIAN_ALLOW_NO_AUTH");
    });
  });

  it("persists an env-supplied bootstrap claim secret without putting it on argv or stdout", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up"], {
        home,
        prompter,
        env: { LIBRARIAN_BOOTSTRAP_CLAIM_SECRET: BOOTSTRAP_CLAIM_SECRET },
      });

      expect(r.exitCode).toBe(0);
      expect(fs.readFileSync(deployEnvOf(home), "utf8")).toContain(
        `LIBRARIAN_BOOTSTRAP_CLAIM_SECRET=${BOOTSTRAP_CLAIM_SECRET}`,
      );
      expect(dockerRunArgs(runner)?.some((arg) => arg.includes(BOOTSTRAP_CLAIM_SECRET))).toBe(
        false,
      );
      expect(r.stdout).not.toContain(BOOTSTRAP_CLAIM_SECRET);
      expect(r.stderr).not.toContain(BOOTSTRAP_CLAIM_SECRET);
      expect(filesContaining(home, BOOTSTRAP_CLAIM_SECRET)).toEqual([deployEnvOf(home)]);
    });
  });

  it("refuses a weak env-supplied bootstrap claim secret before building or starting", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up"], {
        home,
        prompter,
        env: { LIBRARIAN_BOOTSTRAP_CLAIM_SECRET: "too-short" },
      });

      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("LIBRARIAN_BOOTSTRAP_CLAIM_SECRET must be at least 32 characters");
      expect(streamedBuildArgs()).toBeUndefined();
      expect(dockerRunArgs(runner)).toBeUndefined();
    });
  });
});

describe("server up — foreign deploy dir stops and asks (never clobbers)", () => {
  it("a git repo with a different remote halts before any clobbering git op", async () => {
    await withTempHome(async (home) => {
      const deployDir = path.join(home, ".librarian", "server");
      fs.mkdirSync(path.join(deployDir, ".git"), { recursive: true });

      const runner = healthyRunner().onRun(
        "git",
        ["-C", deployDir, "remote", "get-url", "origin"],
        { stdout: "https://github.com/someone-else/other-repo.git\n", code: 0 },
      );
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up", "--ref", "main"], { home, prompter });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/different remote/i);

      // It must NOT have clobbered: no clone, no fetch, no checkout.
      expect(runner.calls.some((c) => c.cmd === "git" && c.args[0] === "clone")).toBe(false);
      expect(runner.calls.some((c) => c.cmd === "git" && c.args.includes("checkout"))).toBe(false);
      expect(runner.calls.some((c) => c.cmd === "git" && c.args.includes("fetch"))).toBe(false);
      // And it never reached docker build/run (the build streams; none recorded).
      expect(buildStream.length).toBe(0);
      expect(runner.calls.some((c) => c.cmd === "docker" && c.args[0] === "run")).toBe(false);
    });
  });

  it("our managed clone fetches + checks out the ref (does not re-clone)", async () => {
    await withTempHome(async (home) => {
      const deployDir = path.join(home, ".librarian", "server");
      fs.mkdirSync(path.join(deployDir, ".git"), { recursive: true });

      const runner = healthyRunner().onRun(
        "git",
        ["-C", deployDir, "remote", "get-url", "origin"],
        { stdout: "git@github.com:code-ministry-ltd/the-librarian.git\n", code: 0 },
      );
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up", "--ref", "main"], { home, prompter });
      expect(r.exitCode).toBe(0);

      // No clone (already ours); fetch tags + resolve the ref on `rev-parse`
      // (the guard `git checkout` can't honor, S-1) before checking out the SHA.
      expect(runner.calls.some((c) => c.cmd === "git" && c.args[0] === "clone")).toBe(false);
      expect(runner.ran("git", ["-C", deployDir, "fetch", "--tags", "origin"])).toBe(true);
      expect(
        runner.ran("git", [
          "-C",
          deployDir,
          "rev-parse",
          "--verify",
          "--end-of-options",
          "main^{commit}",
        ]),
      ).toBe(true);
    });
  });
});

describe("server up — loop-closer (MCP URL + token + env offer)", () => {
  it("prints the MCP/dashboard URLs + agent token; writes env only when accepted", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "y" } });

      const r = await runCli(["server", "up"], { home, prompter });
      expect(r.exitCode).toBe(0);

      expect(r.stdout).toContain("http://127.0.0.1:3838/mcp");
      expect(r.stdout).toContain("http://127.0.0.1:3042");
      expect(r.stdout).toContain(AGENT_TOKEN);

      // Accepted → env written with the URL + agent token (the agent token MAY
      // be persisted; the master key may not).
      const env = readEnvFile(home);
      expect(env?.mcpUrl).toBe("http://127.0.0.1:3838/mcp");
      expect(env?.token).toBe(AGENT_TOKEN);
    });
  });

  it("declined offer leaves ~/.librarian/env unwritten", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up"], { home, prompter });
      expect(r.exitCode).toBe(0);
      expect(readEnvFile(home)).toBeNull();
    });
  });

  it("--yes auto-accepts the env write without prompting", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      // A prompter that THROWS if asked — proves --yes never prompts.
      const prompter = new FakePrompter({});

      const r = await runCli(["server", "up", "--yes"], { home, prompter });
      expect(r.exitCode).toBe(0);
      expect(readEnvFile(home)?.token).toBe(AGENT_TOKEN);
      expect(prompter.textCalls.length).toBe(0);
    });
  });
});

describe("server up — writes the NON-SECRET deploy-state (S4/S5 prerequisite)", () => {
  it("writes deploy-state.json with host/dataVolume/ref/imageTag/containerName and NO secret", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up"], { home, prompter });
      expect(r.exitCode).toBe(0);

      const deployDir = path.join(home, ".librarian", "server");
      const state = readDeployState(deployDir);
      expect(state).toEqual({
        containerName: "the-librarian",
        host: "127.0.0.1",
        dataVolume: "librarian_data",
        dashboardPort: 3042,
        ref: LATEST_TAG,
        imageTag: REGISTRY_IMAGE_REF,
        imageSource: "registry",
        imageRef: REGISTRY_IMAGE_REF,
        imageDigest: REGISTRY_DIGEST,
      });

      // The state file carries NO secret: not the agent token, not the master key.
      const raw = fs.readFileSync(deployStatePath(deployDir), "utf8");
      expect(raw).not.toContain(AGENT_TOKEN);
      expect(raw).not.toContain(MASTER_KEY);
      expect(raw).not.toMatch(/token|secret|key/i);
    });
  });

  it("records the override host/volume/ref the operator chose", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const customDir = path.join(home, "custom-deploy");
      const r = await runCli(
        ["server", "up", "--data-volume", "my_vol", "--dir", customDir, "--ref", "main"],
        { home, prompter },
      );
      expect(r.exitCode).toBe(0);

      expect(readDeployState(customDir)).toEqual({
        containerName: "the-librarian",
        host: "127.0.0.1",
        dataVolume: "my_vol",
        dashboardPort: 3042,
        ref: "main",
        imageTag: "the-librarian:main",
        imageSource: "source",
        imageRef: "the-librarian:main",
      });
    });
  });

  it("--dashboard-port: records the chosen port + publishes + prints it; a bad value teaches", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up", "--dashboard-port", "3500"], { home, prompter });
      expect(r.exitCode).toBe(0);

      // Published on the chosen host port (container side stays 3000) + printed.
      expect(dockerRunArgs(runner)).toContain("127.0.0.1:3500:3000");
      expect(r.stdout).toContain("http://127.0.0.1:3500");

      // Persisted so `update`/autoupdate reuse it.
      const deployDir = path.join(home, ".librarian", "server");
      expect(readDeployState(deployDir)?.dashboardPort).toBe(3500);
    });
  });

  it("--dashboard-port: a non-numeric / out-of-range / MCP-colliding value is a teaching error (no docker run)", async () => {
    for (const [value, pattern] of [
      ["abc", /whole number/i],
      ["70000", /1 to 65535/i],
      ["3838", /collides with the MCP endpoint/i],
    ] as const) {
      await withTempHome(async (home) => {
        const runner = healthyRunner();
        setDockerRunner(runner);
        stubSeams();
        const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

        const r = await runCli(["server", "up", "--dashboard-port", value], { home, prompter });
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toMatch(pattern);
        // Failed fast — before any image build or container start.
        expect(runner.calls.some((c) => c.cmd === "docker" && c.args[0] === "run")).toBe(false);
        expect(runner.calls.some((c) => c.cmd === "docker" && c.args[0] === "build")).toBe(false);
      });
    }
  });
});

describe("server up — beyond-localhost binding (S3)", () => {
  const TAILNET = "100.101.102.103";

  /** A FakeRunner wired for a fully-successful beyond-localhost `up`. */
  function beyondRunner(): FakeRunner {
    // ADR 0008 P3: `server up` no longer reads back /data/admin.token (the server
    // no longer mints one), so the healthy runner already covers the beyond path.
    return healthyRunner();
  }

  it("--host <tailnet-ip>: omits ALLOW_NO_AUTH, binds the tailnet IP, surfaces no admin token, MCP URL uses the host", async () => {
    await withTempHome(async (home) => {
      const runner = beyondRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up", "--host", TAILNET], { home, prompter });
      expect(r.exitCode).toBe(0);

      // docker run argv: OMITS ALLOW_NO_AUTH, publishes on the tailnet IP.
      const runArgs = dockerRunArgs(runner);
      expect(runArgs).not.toContain("LIBRARIAN_ALLOW_NO_AUTH=true");
      expect(runArgs).toContain(`${TAILNET}:3042:3000`);
      expect(runArgs).toContain(`${TAILNET}:3838:3838`);

      // ADR 0008 P3: no admin token is read back or surfaced — there isn't one.
      expect(runner.ran("docker", ["exec", "the-librarian", "cat", "/data/admin.token"])).toBe(
        false,
      );
      expect(r.stdout).not.toMatch(/admin token/i);

      // The MCP URL uses the chosen host.
      expect(r.stdout).toContain(`http://${TAILNET}:3838/mcp`);
      expect(r.stdout).toContain(`http://${TAILNET}:3042`);
    });
  });

  it("argv DIFF (SC 3/4): loopback carries ALLOW_NO_AUTH in the env-file; beyond omits it; NEITHER reads back secret.key (ADR 0008 P3/P4)", async () => {
    await withTempHome(async (home) => {
      // --- localhost run ---
      const local = healthyRunner();
      setDockerRunner(local);
      stubSeams();
      const lr = await runCli(["server", "up"], {
        home,
        prompter: new FakePrompter({ answers: { "~/.librarian/env": "n" } }),
      });
      expect(lr.exitCode).toBe(0);

      // ALLOW_NO_AUTH is in the env-file (loopback), NOT on argv (ADR 0008 P4).
      const localRun = dockerRunArgs(local) ?? [];
      expect(localRun).not.toContain("LIBRARIAN_ALLOW_NO_AUTH=true");
      expect(fs.readFileSync(deployEnvOf(home), "utf8")).toContain("LIBRARIAN_ALLOW_NO_AUTH=true");
      // Never reads back secret.key (CLI minted it) and never an admin.token.
      expect(local.ran("docker", ["exec", "the-librarian", "cat", "/data/secret.key"])).toBe(false);
      expect(local.ran("docker", ["exec", "the-librarian", "cat", "/data/admin.token"])).toBe(
        false,
      );
      resetDockerRunner();
    });

    await withTempHome(async (home) => {
      // --- beyond-localhost run ---
      const beyond = beyondRunner();
      setDockerRunner(beyond);
      stubSeams();
      const br = await runCli(["server", "up", "--host", TAILNET], {
        home,
        prompter: new FakePrompter({ answers: { "~/.librarian/env": "n" } }),
      });
      expect(br.exitCode).toBe(0);

      const beyondRun = dockerRunArgs(beyond) ?? [];
      expect(beyondRun).not.toContain("LIBRARIAN_ALLOW_NO_AUTH=true");
      expect(fs.readFileSync(deployEnvOf(home), "utf8")).not.toContain("LIBRARIAN_ALLOW_NO_AUTH");
      // Beyond localhost also never reads back secret.key nor an admin.token.
      expect(beyond.ran("docker", ["exec", "the-librarian", "cat", "/data/secret.key"])).toBe(
        false,
      );
      expect(beyond.ran("docker", ["exec", "the-librarian", "cat", "/data/admin.token"])).toBe(
        false,
      );
    });
  });

  it("the master key appears in stdout once and ONLY in the 0600 deploy env-file (no admin token at all)", async () => {
    await withTempHome(async (home) => {
      const runner = beyondRunner();
      setDockerRunner(runner);
      stubSeams();
      // Accept the env-write offer — even then, the master key must not land in
      // the CLIENT env; its only host home is the 0600 deploy env-file.
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "y" } });

      const r = await runCli(["server", "up", "--host", TAILNET, "--yes"], { home, prompter });
      expect(r.exitCode).toBe(0);

      expect(r.stdout.split(MASTER_KEY).length - 1).toBe(1);
      expect(r.stdout).not.toMatch(/admin token/i);

      expect(filesContaining(home, MASTER_KEY)).toEqual([deployEnvOf(home)]);
    });
  });

  it("--host 0.0.0.0 WITHOUT --yes prompts; declining aborts before docker run", async () => {
    await withTempHome(async (home) => {
      const runner = beyondRunner();
      setDockerRunner(runner);
      stubSeams();
      // The confirm prompt is keyed on "0.0.0.0"; answer "n" to decline.
      const prompter = new FakePrompter({ answers: { "0.0.0.0": "n" } });

      const r = await runCli(["server", "up", "--host", "0.0.0.0"], { home, prompter });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/all interfaces|0\.0\.0\.0|aborted|declin/i);

      // Aborted before any docker run (and before git work).
      expect(runner.calls.some((c) => c.cmd === "docker" && c.args[0] === "run")).toBe(false);
      // The confirm was actually asked.
      expect(prompter.textCalls.some((c) => c.question.includes("0.0.0.0"))).toBe(true);
    });
  });

  it("--host 0.0.0.0 with --yes proceeds (no confirm prompt) and prints the unreachable-address note", async () => {
    await withTempHome(async (home) => {
      const runner = beyondRunner();
      setDockerRunner(runner);
      stubSeams();
      // A prompter that THROWS if the 0.0.0.0 confirm is asked — proves --yes skips it.
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up", "--host", "0.0.0.0", "--yes"], { home, prompter });
      expect(r.exitCode).toBe(0);

      const runArgs = dockerRunArgs(runner);
      expect(runArgs).toContain("0.0.0.0:3838:3838");
      expect(runArgs).not.toContain("LIBRARIAN_ALLOW_NO_AUTH=true");
      // 0.0.0.0 is a bind, not a connectable address — a one-line note tells the user.
      expect(r.stdout).toMatch(/reachable|LAN|tailnet|not a connectable/i);
      // S2: the auto-accepted exposure must be VISIBLE in the output (e.g. CI logs),
      // not silent — a one-line note naming 0.0.0.0 and the --yes auto-accept.
      expect(r.stdout).toMatch(/binding 0\.0\.0\.0.*auto-accepted.*--yes/i);
      // No 0.0.0.0 confirm prompt happened under --yes.
      expect(prompter.textCalls.some((c) => c.question.includes("0.0.0.0"))).toBe(false);
    });
  });
});

describe("server up — failed health-wait redacts secrets from surfaced logs (C1)", () => {
  const TAILNET = "100.101.102.103";
  // Assembled from sub-threshold parts so no realistic secret literal is committed
  // (GitGuardian scans every commit). The value is deliberately fake + low-entropy:
  // redaction works on the `libadmin_` prefix / the boot-log line, not the body.
  const FAKE_ADMIN_LOG_LINE =
    "Generated a new admin token (LIBRARIAN_ADMIN_TOKEN): " + "libadmin_" + "FAKETOKENVALUE";
  const FAKE_ADMIN_TOKEN = "libadmin_" + "FAKETOKENVALUE";

  it("a beyond-localhost up that goes unhealthy never surfaces the boot-logged admin token, and rolls back", async () => {
    await withTempHome(async (home) => {
      const runner = new FakeRunner()
        .withWhich("docker")
        .withWhich("git")
        .onRun("docker", ["info"], { code: 0 })
        .onRun("docker", ["info", "--format", "{{json .}}"], {
          stdout: JSON.stringify({ OSType: "linux", Architecture: "amd64" }),
          code: 0,
        })
        .onRun("docker", ["container", "inspect", "--format", "{{json .}}", "the-librarian"], {
          stderr: "No such container: the-librarian",
          code: 1,
        })
        .onRun("docker", ["image", "inspect", "--format", "{{json .}}", REGISTRY_IMAGE_REF], {
          stdout: registryInspectJson(),
          code: 0,
        })
        .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", "the-librarian"], {
          stdout: "unhealthy\n",
          code: 0,
        })
        .onRun(
          "docker",
          ["inspect", "--format", "{{.State.Health.Status}}", CANDIDATE_CONTAINER_ID],
          { stdout: "unhealthy\n", code: 0 },
        )
        // The boot logs CONTAIN the one-time admin-token generation line.
        .onRun("docker", ["logs", "--tail", "50", "the-librarian"], {
          stdout: `boot: starting up\n${FAKE_ADMIN_LOG_LINE}\nboot: health probe failed\n`,
          code: 0,
        })
        .onRun("docker", ["logs", "--tail", "50", CANDIDATE_CONTAINER_ID], {
          stdout: `boot: starting up\n${FAKE_ADMIN_LOG_LINE}\nboot: health probe failed\n`,
          code: 0,
        });
      setDockerRunner(withCandidateLifecycle(runner));
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up", "--host", TAILNET], { home, prompter });
      expect(r.exitCode).toBe(1);

      // The surfaced error must NOT carry the bearer token nor the generation line.
      expect(r.stderr).not.toContain(FAKE_ADMIN_TOKEN);
      expect(r.stderr).not.toMatch(/Generated a new admin token/i);
      // ...but the (redacted) tail is still surfaced for debugging.
      expect(r.stderr).toMatch(/boot: starting up/);
      expect(r.stderr).toMatch(/boot: health probe failed/);
      expect(r.stderr).toMatch(/did not become healthy/i);

      // Rolled back — no half-up container.
      expect(runner.ran("docker", ["rm", "-f", CANDIDATE_CONTAINER_ID])).toBe(true);
    });
  });
});

describe("server up — any post-run failure rolls back (I2, no half-up)", () => {
  it("an exception thrown mid-health-loop (docker inspect rejects) still force-removes the container", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      // Make `docker inspect` (the health probe) REJECT instead of returning.
      const realRun = runner.run.bind(runner);
      runner.run = async (cmd, args, opts) => {
        if (cmd === "docker" && args[0] === "inspect" && args[2] === "{{.State.Health.Status}}") {
          // still record the call so we can reason about ordering
          runner.calls.push({ cmd, args: [...args], opts });
          throw new Error("docker inspect exploded mid-health-loop");
        }
        return realRun(cmd, args, opts);
      };
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up"], { home, prompter });
      expect(r.exitCode).toBe(1);

      // Even though the failure was an exception (not the timeout/unhealthy return
      // path), the container must be force-removed — no half-up state survives.
      expect(runner.ran("docker", ["rm", "-f", CANDIDATE_CONTAINER_ID])).toBe(true);
    });
  });
});

describe("server up — empty/whitespace --host does not silently bind all interfaces (I1)", () => {
  it("--host '' defaults to loopback (no all-interfaces bind, no confirm prompt)", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      // A prompter that THROWS if any 0.0.0.0 confirm is asked — there must be none.
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up", "--host", ""], { home, prompter });
      expect(r.exitCode).toBe(0);

      const runArgs = dockerRunArgs(runner);
      // Defaulted to loopback — NOT `:3042:3000` (a missing/all-interfaces host).
      expect(runArgs).toContain("127.0.0.1:3042:3000");
      expect(runArgs).toContain("127.0.0.1:3838:3838");
      expect(runArgs?.some((a) => a === ":3042:3000")).toBe(false);
      // Loopback no-auth bypass lives in the env-file (ADR 0008 P4), not on argv.
      expect(fs.readFileSync(deployEnvOf(home), "utf8")).toContain("LIBRARIAN_ALLOW_NO_AUTH=true");
      // No all-interfaces confirm was ever shown.
      expect(prompter.textCalls.some((c) => c.question.includes("0.0.0.0"))).toBe(false);
    });
  });

  it("--host '   ' (whitespace) also defaults to loopback", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up", "--host", "   "], { home, prompter });
      expect(r.exitCode).toBe(0);

      const runArgs = dockerRunArgs(runner);
      expect(runArgs).toContain("127.0.0.1:3042:3000");
      expect(fs.readFileSync(deployEnvOf(home), "utf8")).toContain("LIBRARIAN_ALLOW_NO_AUTH=true");
    });
  });
});

describe("server up — loopback spellings normalize to 127.0.0.1 (I3)", () => {
  for (const spelling of ["localhost", "::1"]) {
    it(`--host ${spelling} behaves identically to 127.0.0.1 (ALLOW_NO_AUTH in env-file, no read-back)`, async () => {
      await withTempHome(async (home) => {
        const runner = healthyRunner();
        setDockerRunner(runner);
        stubSeams();
        const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

        const r = await runCli(["server", "up", "--host", spelling], { home, prompter });
        expect(r.exitCode).toBe(0);

        const runArgs = dockerRunArgs(runner);
        // Normalized to loopback: publishes on 127.0.0.1 (a well-formed `-p` arg
        // — no malformed `::1:3042:3000`). ALLOW_NO_AUTH lives in the env-file.
        expect(runArgs).toContain("127.0.0.1:3042:3000");
        expect(runArgs).toContain("127.0.0.1:3838:3838");
        expect(fs.readFileSync(deployEnvOf(home), "utf8")).toContain(
          "LIBRARIAN_ALLOW_NO_AUTH=true",
        );

        // Never reads back the master key (CLI minted it); never an admin.token.
        expect(runner.ran("docker", ["exec", "the-librarian", "cat", "/data/secret.key"])).toBe(
          false,
        );
        expect(runner.ran("docker", ["exec", "the-librarian", "cat", "/data/admin.token"])).toBe(
          false,
        );
      });
    });
  }
});

describe("server up — Tailscale best-effort offer (S3)", () => {
  const TAILNET = "100.64.0.7";

  /** A healthy runner that ALSO reads back the admin token (beyond-localhost). */
  function tsRunner(): FakeRunner {
    return healthyRunner()
      .withWhich("tailscale")
      .onRun("tailscale", ["ip", "-4"], { stdout: `${TAILNET}\n`, code: 0 })
      .onRun("docker", ["exec", "the-librarian", "cat", "/data/admin.token"], {
        stdout: "admin-token-from-tailscale-offer\n",
        code: 0,
      });
  }

  it("interactive + no --host + tailscale IP present → offers it; accepting binds the tailnet IP", async () => {
    await withTempHome(async (home) => {
      const runner = tsRunner();
      setDockerRunner(runner);
      stubSeams();
      // Accept the tailscale offer (keyed on "tailscale"); decline the env write.
      const prompter = new FakePrompter({
        answers: { tailscale: "y", "~/.librarian/env": "n" },
      });

      const r = await runCli(["server", "up"], { home, prompter, interactive: true });
      expect(r.exitCode).toBe(0);

      // Offered (a prompt mentioning tailscale was shown)...
      expect(prompter.textCalls.some((c) => c.question.toLowerCase().includes("tailscale"))).toBe(
        true,
      );
      // ...and accepted → bound to the tailnet IP (ALLOW_NO_AUTH omitted).
      const runArgs = dockerRunArgs(runner);
      expect(runArgs).toContain(`${TAILNET}:3838:3838`);
      expect(runArgs).not.toContain("LIBRARIAN_ALLOW_NO_AUTH=true");
    });
  });

  it("interactive + tailscale IP present but DECLINED → stays on 127.0.0.1", async () => {
    await withTempHome(async (home) => {
      const runner = tsRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({
        answers: { tailscale: "n", "~/.librarian/env": "n" },
      });

      const r = await runCli(["server", "up"], { home, prompter, interactive: true });
      expect(r.exitCode).toBe(0);

      const runArgs = dockerRunArgs(runner);
      expect(runArgs).toContain("127.0.0.1:3838:3838");
      expect(fs.readFileSync(deployEnvOf(home), "utf8")).toContain("LIBRARIAN_ALLOW_NO_AUTH=true");
    });
  });

  it("--yes never offers tailscale (stays 127.0.0.1, no silent exposure)", async () => {
    await withTempHome(async (home) => {
      const runner = tsRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({});

      const r = await runCli(["server", "up", "--yes"], { home, prompter, interactive: true });
      expect(r.exitCode).toBe(0);

      const runArgs = dockerRunArgs(runner);
      expect(runArgs).toContain("127.0.0.1:3838:3838");
      expect(fs.readFileSync(deployEnvOf(home), "utf8")).toContain("LIBRARIAN_ALLOW_NO_AUTH=true");
      expect(prompter.textCalls.some((c) => c.question.toLowerCase().includes("tailscale"))).toBe(
        false,
      );
    });
  });

  it("non-interactive never offers tailscale (stays 127.0.0.1)", async () => {
    await withTempHome(async (home) => {
      const runner = tsRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up"], { home, prompter, interactive: false });
      expect(r.exitCode).toBe(0);

      const runArgs = dockerRunArgs(runner);
      expect(runArgs).toContain("127.0.0.1:3838:3838");
      expect(fs.readFileSync(deployEnvOf(home), "utf8")).toContain("LIBRARIAN_ALLOW_NO_AUTH=true");
      expect(prompter.textCalls.some((c) => c.question.toLowerCase().includes("tailscale"))).toBe(
        false,
      );
    });
  });

  it("tailscale absent (which → null) → no offer, no error (silent skip)", async () => {
    await withTempHome(async (home) => {
      // healthyRunner does NOT mark tailscale present → which() returns null.
      const runner = healthyRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up"], { home, prompter, interactive: true });
      expect(r.exitCode).toBe(0);

      // No tailscale probe call recorded beyond which(); no tailscale prompt.
      expect(runner.calls.some((c) => c.cmd === "tailscale" && c.args[0] === "ip")).toBe(false);
      expect(prompter.textCalls.some((c) => c.question.toLowerCase().includes("tailscale"))).toBe(
        false,
      );
      // Stayed on localhost.
      expect(dockerRunArgs(runner)).toContain("127.0.0.1:3838:3838");
    });
  });
});

describe("buildRunArgs — the S3/P4 seam (secrets via --env-file, off argv)", () => {
  it("references the env-file via --env-file, carries no inline -e, omits --init", () => {
    const args = buildRunArgs({
      host: "127.0.0.1",
      dataVolume: "librarian_data",
      dashboardPort: 3042,
      imageRef: "the-librarian:v1.0.0",
      envFile: "/tmp/deploy.env",
    });
    // Secrets + the no-auth flag are NOT on argv (they live in the env-file).
    expect(args).not.toContain("-e");
    expect(args).not.toContain("LIBRARIAN_ALLOW_NO_AUTH=true");
    const i = args.indexOf("--env-file");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("/tmp/deploy.env");
    expect(args).not.toContain("--init");
    expect(args[args.length - 1]).toBe("the-librarian:v1.0.0");
  });

  it("publishes on the chosen host (argv is host-driven; secrets are env-file-driven)", () => {
    const args = buildRunArgs({
      host: "100.1.2.3",
      dataVolume: "librarian_data",
      dashboardPort: 3042,
      imageRef: "the-librarian:v1.0.0",
      envFile: "/tmp/deploy.env",
    });
    expect(args).toContain("100.1.2.3:3042:3000");
    expect(args).toContain("100.1.2.3:3838:3838");
    expect(args).toContain("--env-file");
    expect(args[args.length - 1]).toBe("the-librarian:v1.0.0");
  });

  it("publishes the dashboard on the chosen port; the container side stays 3000", () => {
    const args = buildRunArgs({
      host: "127.0.0.1",
      dataVolume: "librarian_data",
      dashboardPort: 3500,
      imageRef: "the-librarian:v1.0.0",
      envFile: "/tmp/deploy.env",
    });
    // Only the published (host) side moves; the container always listens on 3000.
    expect(args).toContain("127.0.0.1:3500:3000");
    // The MCP publish is unaffected.
    expect(args).toContain("127.0.0.1:3838:3838");
  });
});

describe("writeDeployEnvFile — the 0600 deploy env-file (ADR 0008 P4)", () => {
  it("writes 0600 with both secrets + loopback ALLOW_NO_AUTH; rewrites tighten a loose file", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".librarian", "server");
      const file = writeDeployEnvFile(dir, {
        agentToken: AGENT_TOKEN,
        secretKey: MASTER_KEY,
        host: "127.0.0.1",
      });
      expect(file).toBe(deployEnvFilePath(dir));
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const body = fs.readFileSync(file, "utf8");
      expect(body).toContain(`LIBRARIAN_AGENT_TOKEN=${AGENT_TOKEN}`);
      expect(body).toContain(`LIBRARIAN_SECRET_KEY=${MASTER_KEY}`);
      expect(body).toContain("LIBRARIAN_ALLOW_NO_AUTH=true");

      // A pre-existing loose file is tightened on rewrite (unconditional chmod).
      fs.chmodSync(file, 0o644);
      writeDeployEnvFile(dir, { agentToken: AGENT_TOKEN, secretKey: MASTER_KEY, host: "0.0.0.0" });
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      // Beyond-localhost rewrite drops ALLOW_NO_AUTH.
      expect(fs.readFileSync(file, "utf8")).not.toContain("LIBRARIAN_ALLOW_NO_AUTH");
    });
  });
});

// --- helpers -------------------------------------------------------------

/** Recursively collect files under `dir` whose contents contain `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        let content = "";
        try {
          content = fs.readFileSync(full, "utf8");
        } catch {
          continue;
        }
        if (content.includes(needle)) hits.push(full);
      }
    }
  };
  walk(dir);
  return hits;
}

describe("server up — master key reuse (P2)", () => {
  it("REUSES an existing deploy.env master key on re-run (no re-mint, no re-surface)", async () => {
    await withTempHome(async (home) => {
      const deployDir = path.join(home, ".librarian", "server");
      const EXISTING_KEY = "existing-master-key-from-a-prior-up-do-not-rotate";
      // Seed a prior deploy's env-file (key + token), then mark the dir as OUR clone
      // so prepareDeployDir takes the fetch+checkout path (not a fresh clone).
      writeDeployEnvFile(deployDir, {
        agentToken: "prior-agent-token",
        secretKey: EXISTING_KEY,
        host: "127.0.0.1",
      });
      fs.mkdirSync(path.join(deployDir, ".git"), { recursive: true });

      const runner = healthyRunner().onRun(
        "git",
        ["-C", deployDir, "remote", "get-url", "origin"],
        { stdout: "git@github.com:code-ministry-ltd/the-librarian.git\n", code: 0 },
      );
      setDockerRunner(runner);
      stubSeams(); // MASTER_KEY is what the minter WOULD return — it must NOT be used
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up"], { home, prompter });
      expect(r.exitCode).toBe(0);

      // The rewritten env-file keeps the EXISTING key — the minter was not consulted.
      const body = fs.readFileSync(deployEnvFilePath(deployDir), "utf8");
      expect(body).toContain(`LIBRARIAN_SECRET_KEY=${EXISTING_KEY}`);
      expect(body).not.toContain(MASTER_KEY);
      // A reused key is never re-surfaced; the output says so instead.
      expect(r.stdout).not.toContain(MASTER_KEY);
      expect(r.stdout).toContain("Reusing the existing master key");
    });
  });

  it("preserves a prior bootstrap claim secret when the current shell does not set one", async () => {
    await withTempHome(async (home) => {
      const deployDir = path.join(home, ".librarian", "server");
      writeDeployEnvFile(deployDir, {
        agentToken: "prior-agent-token",
        secretKey: MASTER_KEY,
        bootstrapClaimSecret: BOOTSTRAP_CLAIM_SECRET,
        host: "127.0.0.1",
      });
      fs.mkdirSync(path.join(deployDir, ".git"), { recursive: true });

      const runner = healthyRunner().onRun(
        "git",
        ["-C", deployDir, "remote", "get-url", "origin"],
        { stdout: "git@github.com:code-ministry-ltd/the-librarian.git\n", code: 0 },
      );
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up"], { home, prompter, env: {} });

      expect(r.exitCode).toBe(0);
      expect(fs.readFileSync(deployEnvOf(home), "utf8")).toContain(
        `LIBRARIAN_BOOTSTRAP_CLAIM_SECRET=${BOOTSTRAP_CLAIM_SECRET}`,
      );
    });
  });
});

describe("server up — snap-docker health-read detection (P5)", () => {
  it("raises a snap-docker teaching error when every `docker inspect` is empty", async () => {
    // Snap docker's hallmark: exit-0 but EMPTY stdout on a non-TTY pipe, so the
    // health read never yields a status and `docker logs` is empty too.
    const runner = new FakeRunner()
      .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", "the-librarian"], {
        stdout: "",
        code: 0,
      })
      .onRun("docker", ["logs", "--tail", "50", "the-librarian"], { stdout: "", code: 0 })
      .onRun("docker", ["rm", "-f", "the-librarian"], { code: 0 });
    setDockerRunner(runner);
    setSleep(async () => undefined);

    await expect(waitForHealthy({ healthAttempts: 2, healthIntervalMs: 0 })).rejects.toThrow(
      /snap docker/i,
    );
  });

  it("still gives the normal timeout error when a status IS readable (not snap)", async () => {
    // A readable "starting" that never reaches healthy → the ordinary timeout path,
    // NOT the snap-docker message.
    const runner = new FakeRunner()
      .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", "the-librarian"], {
        stdout: "starting\n",
        code: 0,
      })
      .onRun("docker", ["logs", "--tail", "50", "the-librarian"], { stdout: "boot log\n", code: 0 })
      .onRun("docker", ["rm", "-f", "the-librarian"], { code: 0 });
    setDockerRunner(runner);
    setSleep(async () => undefined);

    await expect(waitForHealthy({ healthAttempts: 2, healthIntervalMs: 0 })).rejects.toThrow(
      /did not become healthy/i,
    );
  });

  it("treats a verified already-absent container as successful health cleanup", async () => {
    const runner = new FakeRunner()
      .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", "the-librarian"], {
        stdout: "unhealthy\n",
        code: 0,
      })
      .onRun("docker", ["logs", "--tail", "50", "the-librarian"], {
        stdout: "boot failed\n",
        code: 0,
      })
      .onRun("docker", ["rm", "-f", "the-librarian"], {
        stderr: "Error: No such container: the-librarian",
        code: 1,
      });
    setDockerRunner(runner);

    await expect(waitForHealthy({ healthAttempts: 1 })).rejects.toThrow(
      /did not become healthy.*rolled back/i,
    );
    expect(runner.calls.filter((call) => call.args[0] === "rm")).toHaveLength(1);
  });

  it("a FAILING inspect (exit≠0, empty) is NOT snap — falls through to the normal error", async () => {
    // Empty output but a non-zero exit is a different failure (container gone /
    // daemon hiccup), not snap's exit-0-empty signature.
    const runner = new FakeRunner()
      .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", "the-librarian"], {
        stdout: "",
        code: 1,
      })
      .onRun("docker", ["logs", "--tail", "50", "the-librarian"], { stdout: "boom\n", code: 0 })
      .onRun("docker", ["rm", "-f", "the-librarian"], { code: 0 });
    setDockerRunner(runner);
    setSleep(async () => undefined);

    await expect(waitForHealthy({ healthAttempts: 2, healthIntervalMs: 0 })).rejects.toThrow(
      /did not become healthy/i,
    );
  });
});

describe("server up — stable registry deployments (B2)", () => {
  it("pulls the latest release without Git/build and runs its exact canonical digest", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRegistryRunner();
      setDockerRunner(runner);
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const result = await runCli(["server", "up"], { home, prompter });

      expect(result.exitCode).toBe(0);
      expect(streamedPullArgs()).toEqual(["pull", REGISTRY_IMAGE_REF]);
      expect(streamedBuildArgs()).toBeUndefined();
      expect(runner.calls.some((call) => call.cmd === "git")).toBe(false);
      expect(dockerRunArgs(runner)?.at(-1)).toBe(REGISTRY_DIGEST);
      expect(dockerRunArgs(runner)).toContain(stagedDeployEnvOf(home));
      expect(fs.existsSync(stagedDeployEnvOf(home))).toBe(false);
      expect(fs.existsSync(deployEnvOf(home))).toBe(true);
      expect(readDeployState(path.join(home, ".librarian", "server"))).toEqual({
        containerName: "the-librarian",
        host: "127.0.0.1",
        dataVolume: "librarian_data",
        dashboardPort: 3042,
        ref: LATEST_TAG,
        imageTag: REGISTRY_IMAGE_REF,
        imageSource: "registry",
        imageRef: REGISTRY_IMAGE_REF,
        imageDigest: REGISTRY_DIGEST,
      });
    });
  });

  it("uses an exact release ref directly without consulting latest", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRegistryRunner();
      setDockerRunner(runner);
      let latestCalls = 0;
      setLatestFetcher(async () => {
        latestCalls += 1;
        return LATEST;
      });
      setTokenMinter(() => AGENT_TOKEN);
      setSecretKeyMinter(() => MASTER_KEY);
      setSleep(async () => undefined);

      const result = await runCli(["server", "up", "--ref", LATEST_TAG], {
        home,
        prompter: new FakePrompter({ answers: { "~/.librarian/env": "n" } }),
      });

      expect(result.exitCode).toBe(0);
      expect(latestCalls).toBe(0);
      expect(streamedPullArgs()).toEqual(["pull", REGISTRY_IMAGE_REF]);
      expect(dockerRunArgs(runner)?.at(-1)).toBe(REGISTRY_DIGEST);
    });
  });

  it("preserves named-volume and bind-directory storage argv with a digest run target", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRegistryRunner();
      setDockerRunner(runner);
      stubSeams();
      const dataDir = path.join(home, "vault-data");

      const result = await runCli(["server", "up", "--data-dir", dataDir], {
        home,
        prompter: new FakePrompter({ answers: { "~/.librarian/env": "n" } }),
      });

      expect(result.exitCode).toBe(0);
      expect(dockerRunArgs(runner)).toContain(`${dataDir}:/data`);
      expect(dockerRunArgs(runner)?.at(-1)).toBe(REGISTRY_DIGEST);
      expect(readDeployState(path.join(home, ".librarian", "server"))?.dataDir).toBe(dataDir);
    });
  });

  it("a failed pull leaves no container, deploy state, or newly minted credential material", async () => {
    await withTempHome(async (home) => {
      const runner = new FakeRunner()
        .withWhich("docker")
        .onRun("docker", ["info"], { code: 0 })
        .onRun("docker", ["info", "--format", "{{json .}}"], {
          stdout: JSON.stringify({ OSType: "linux", Architecture: "amd64" }),
          code: 0,
        })
        .onRun("docker", ["container", "inspect", "--format", "{{json .}}", "the-librarian"], {
          stderr: "No such container: the-librarian",
          code: 1,
        });
      setDockerRunner(runner);
      setLatestFetcher(async () => LATEST);
      let minted = 0;
      setTokenMinter(() => {
        minted += 1;
        return AGENT_TOKEN;
      });
      setSecretKeyMinter(() => {
        minted += 1;
        return MASTER_KEY;
      });
      setStreamer({ stream: async () => 1 });

      const result = await runCli(["server", "up"], {
        home,
        prompter: new FakePrompter({ answers: { "~/.librarian/env": "n" } }),
      });
      const deployDir = path.join(home, ".librarian", "server");

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/docker pull.*failed/i);
      expect(minted).toBe(0);
      expect(fs.existsSync(deployEnvFilePath(deployDir))).toBe(false);
      expect(fs.existsSync(deployStatePath(deployDir))).toBe(false);
      expect(readEnvFile(home)).toBeNull();
      expect(runner.calls.some((call) => call.args[0] === "run")).toBe(false);
      expect(runner.calls.some((call) => call.cmd === "git")).toBe(false);
    });
  });

  it("rejects a malformed latest-release response without pulling or falling back", async () => {
    await withTempHome(async (home) => {
      const runner = new FakeRunner().withWhich("docker").onRun("docker", ["info"], { code: 0 });
      setDockerRunner(runner);
      setLatestFetcher(async () => "1.4.2-beta.1");
      setTokenMinter(() => {
        throw new Error("must not mint for an invalid latest release");
      });

      const result = await runCli(["server", "up"], {
        home,
        prompter: new FakePrompter({ answers: { "~/.librarian/env": "n" } }),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/valid latest stable release tag/i);
      expect(streamedPullArgs()).toBeUndefined();
      expect(streamedBuildArgs()).toBeUndefined();
      expect(runner.calls.some((call) => call.cmd === "git")).toBe(false);
      expect(fs.existsSync(path.join(home, ".librarian", "server"))).toBe(false);
    });
  });

  it("metadata or digest mismatch fails closed without source fallback or credentials", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRegistryRunner().onRun(
        "docker",
        ["image", "inspect", "--format", "{{json .}}", REGISTRY_IMAGE_REF],
        { stdout: registryInspectJson({ RepoDigests: [] }), code: 0 },
      );
      setDockerRunner(runner);
      stubSeams();

      const result = await runCli(["server", "up"], {
        home,
        prompter: new FakePrompter({ answers: { "~/.librarian/env": "n" } }),
      });
      const deployDir = path.join(home, ".librarian", "server");

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/canonical repository digest/i);
      expect(runner.calls.some((call) => call.cmd === "git")).toBe(false);
      expect(streamedBuildArgs()).toBeUndefined();
      expect(fs.existsSync(deployEnvFilePath(deployDir))).toBe(false);
      expect(fs.existsSync(deployStatePath(deployDir))).toBe(false);
    });
  });

  it("a concurrent up refuses before touching the winner's staged credentials or deployment files", async () => {
    await withTempHome(async (home) => {
      const deployDir = path.join(home, ".librarian", "server");
      const runner = healthyRegistryRunner();
      const realRun = runner.run.bind(runner);
      let createCalls = 0;
      let releaseWinnerCreate!: () => void;
      const winnerCreateHeld = new Promise<void>((resolve) => {
        releaseWinnerCreate = resolve;
      });
      let markWinnerAtCreate!: () => void;
      const winnerAtCreate = new Promise<void>((resolve) => {
        markWinnerAtCreate = resolve;
      });
      runner.run = async (cmd, args, options) => {
        if (cmd === "docker" && args[0] === "create") {
          runner.calls.push({ cmd, args: [...args], opts: options });
          createCalls += 1;
          if (createCalls === 1) {
            markWinnerAtCreate();
            await winnerCreateHeld;
            return { stdout: `${CANDIDATE_CONTAINER_ID}\n`, stderr: "", code: 0 };
          }
          return {
            stdout: "",
            stderr: "Conflict. The container name is already in use.",
            code: 1,
          };
        }
        return realRun(cmd, args, options);
      };
      setDockerRunner(runner);
      setLatestFetcher(async () => LATEST);
      const mintedTokens = ["winner-agent-token", "loser-agent-token"];
      const stagedInvocationIds = ["winner-invocation", "loser-invocation"];
      setTokenMinter(() => mintedTokens.shift() ?? "unexpected-third-token");
      setStagedEnvIdMinter(() => stagedInvocationIds.shift() ?? "unexpected-third-invocation");
      setSecretKeyMinter(() => MASTER_KEY);
      setSleep(async () => undefined);
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const winnerPromise = runCli(["server", "up"], { home, prompter });
      await winnerAtCreate;
      const winnerCreate = runner.calls.find(
        (call) => call.cmd === "docker" && call.args[0] === "create",
      );
      const envFlag = winnerCreate?.args.indexOf("--env-file") ?? -1;
      const winnerStagedEnv = winnerCreate?.args[envFlag + 1];
      expect(winnerStagedEnv).toBeTruthy();
      const winnerStagedBytes = fs.readFileSync(winnerStagedEnv!);

      const loser = await runCli(["server", "up"], { home, prompter });
      const stageFilesWhileWinnerHeld = fs
        .readdirSync(deployDir)
        .filter((name) => name.startsWith("deploy.env.next"));
      const winnerStageStillExists = fs.existsSync(winnerStagedEnv!);
      const winnerStageAfterLoser = winnerStageStillExists
        ? fs.readFileSync(winnerStagedEnv!)
        : Buffer.alloc(0);
      const liveEnvExistsWhileWinnerHeld = fs.existsSync(deployEnvFilePath(deployDir));
      const liveStateExistsWhileWinnerHeld = fs.existsSync(deployStatePath(deployDir));

      releaseWinnerCreate();
      const winner = await winnerPromise;

      expect(loser.exitCode).toBe(1);
      expect(loser.stderr).toMatch(/another.*(?:deployment|update).*in progress/i);
      expect(createCalls).toBe(1);
      expect(path.basename(winnerStagedEnv!)).toBe("deploy.env.next-winner-invocation");
      expect(stagedInvocationIds).toEqual(["loser-invocation"]);
      expect(stageFilesWhileWinnerHeld).toEqual([path.basename(winnerStagedEnv!)]);
      expect(winnerStageStillExists).toBe(true);
      expect(winnerStageAfterLoser).toEqual(winnerStagedBytes);
      expect(liveEnvExistsWhileWinnerHeld).toBe(false);
      expect(liveStateExistsWhileWinnerHeld).toBe(false);
      expect(winner.exitCode).toBe(0);
      expect(fs.readFileSync(deployEnvFilePath(deployDir), "utf8")).toContain(
        "LIBRARIAN_AGENT_TOKEN=winner-agent-token",
      );
      expect(fs.readdirSync(deployDir).some((name) => name.startsWith("deploy.env.next"))).toBe(
        false,
      );
      expect(fs.existsSync(path.join(deployDir, ".autoupdate.lock"))).toBe(false);
    });
  });

  it("cleans up the immutable candidate after docker start fails and removes staged credentials", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRegistryRunner();
      const realRun = runner.run.bind(runner);
      runner.run = async (cmd, args, options) => {
        if (cmd === "docker" && args[0] === "start") {
          runner.calls.push({ cmd, args: [...args], opts: options });
          return { stdout: "", stderr: "daemon failed during start", code: 1 };
        }
        return realRun(cmd, args, options);
      };
      setDockerRunner(runner);
      stubSeams();

      const result = await runCli(["server", "up"], {
        home,
        prompter: new FakePrompter({ answers: { "~/.librarian/env": "n" } }),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/docker start.*failed/i);
      expect(runner.ran("docker", ["rm", "-f", CANDIDATE_CONTAINER_ID])).toBe(true);
      expect(fs.existsSync(stagedDeployEnvOf(home))).toBe(false);
      expect(fs.existsSync(deployEnvOf(home))).toBe(false);
      expect(fs.existsSync(deployStatePath(path.join(home, ".librarian", "server")))).toBe(false);
    });
  });

  it("never removes a same-name unrelated container that appears after candidate creation fails", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRegistryRunner();
      const realRun = runner.run.bind(runner);
      let nameInspects = 0;
      runner.run = async (cmd, args, options) => {
        if (cmd === "docker" && args[0] === "container" && args.at(-1) === "the-librarian") {
          runner.calls.push({ cmd, args: [...args], opts: options });
          nameInspects += 1;
          return nameInspects === 1
            ? { stdout: "", stderr: "No such container: the-librarian", code: 1 }
            : {
                stdout: JSON.stringify({ Id: UNRELATED_CONTAINER_ID }),
                stderr: "",
                code: 0,
              };
        }
        if (cmd === "docker" && (args[0] === "create" || args[0] === "run")) {
          runner.calls.push({ cmd, args: [...args], opts: options });
          return { stdout: "", stderr: "candidate creation failed", code: 1 };
        }
        return realRun(cmd, args, options);
      };
      setDockerRunner(runner);
      stubSeams();

      const result = await runCli(["server", "up"], {
        home,
        prompter: new FakePrompter({}),
      });

      expect(result.exitCode).toBe(1);
      expect(runner.calls.filter((call) => call.args[0] === "rm")).toEqual([]);
      expect(fs.existsSync(stagedDeployEnvOf(home))).toBe(false);
    });
  });

  it("health rollback targets only the immutable candidate ID after its name is reused", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRegistryRunner();
      const realRun = runner.run.bind(runner);
      runner.run = async (cmd, args, options) => {
        if (cmd === "docker" && args[0] === "create") {
          runner.calls.push({ cmd, args: [...args], opts: options });
          return { stdout: `${CANDIDATE_CONTAINER_ID}\n`, stderr: "", code: 0 };
        }
        if (cmd === "docker" && args[0] === "start") {
          runner.calls.push({ cmd, args: [...args], opts: options });
          return { stdout: `${CANDIDATE_CONTAINER_ID}\n`, stderr: "", code: 0 };
        }
        if (cmd === "docker" && args[0] === "run") {
          runner.calls.push({ cmd, args: [...args], opts: options });
          return { stdout: "legacy run succeeded", stderr: "", code: 0 };
        }
        if (cmd === "docker" && args[0] === "inspect") {
          runner.calls.push({ cmd, args: [...args], opts: options });
          return { stdout: "unhealthy\n", stderr: "", code: 0 };
        }
        if (cmd === "docker" && args[0] === "logs") {
          runner.calls.push({ cmd, args: [...args], opts: options });
          return { stdout: "candidate failed\n", stderr: "", code: 0 };
        }
        if (cmd === "docker" && args[0] === "rm") {
          runner.calls.push({ cmd, args: [...args], opts: options });
          return args.at(-1) === CANDIDATE_CONTAINER_ID
            ? {
                stdout: "",
                stderr: `No such container: ${CANDIDATE_CONTAINER_ID}`,
                code: 1,
              }
            : { stdout: UNRELATED_CONTAINER_ID, stderr: "", code: 0 };
        }
        return realRun(cmd, args, options);
      };
      setDockerRunner(runner);
      stubSeams();

      const result = await runCli(["server", "up"], {
        home,
        prompter: new FakePrompter({}),
      });

      expect(result.exitCode).toBe(1);
      const removals = runner.calls.filter((call) => call.args[0] === "rm");
      expect(removals).toHaveLength(1);
      expect(removals[0]?.args.at(-1)).toBe(CANDIDATE_CONTAINER_ID);
      expect(removals.some((call) => call.args.at(-1) === "the-librarian")).toBe(false);
      expect(removals.some((call) => call.args.at(-1) === UNRELATED_CONTAINER_ID)).toBe(false);
      const healthAndLogs = runner.calls.filter(
        (call) => call.args[0] === "inspect" || call.args[0] === "logs",
      );
      expect(healthAndLogs).not.toHaveLength(0);
      expect(healthAndLogs.every((call) => call.args.at(-1) === CANDIDATE_CONTAINER_ID)).toBe(true);
    });
  });

  it("reports cleanup failure truthfully when both health rollback attempts fail", async () => {
    await withTempHome(async (home) => {
      const leaked = "fedcba9876543210".repeat(4);
      const runner = healthyRegistryRunner()
        .onRun(
          "docker",
          ["inspect", "--format", "{{.State.Health.Status}}", CANDIDATE_CONTAINER_ID],
          { stdout: "unhealthy\n", code: 0 },
        )
        .onRun("docker", ["logs", "--tail", "50", CANDIDATE_CONTAINER_ID], {
          stdout: "server failed\n",
          code: 0,
        })
        .onRun("docker", ["rm", "-f", CANDIDATE_CONTAINER_ID], {
          stderr: `permission denied ${leaked}`,
          code: 1,
        });
      setDockerRunner(runner);
      stubSeams();

      const result = await runCli(["server", "up"], {
        home,
        prompter: new FakePrompter({ answers: { "~/.librarian/env": "n" } }),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/could not remove|cleanup failed/i);
      expect(result.stderr).toContain(`docker rm -f ${CANDIDATE_CONTAINER_ID}`);
      expect(result.stderr).not.toContain(leaked);
      expect(result.stderr).not.toMatch(/container removed|was rolled back/i);
      expect(runner.calls.filter((call) => call.args[0] === "rm")).toHaveLength(2);
      expect(fs.existsSync(stagedDeployEnvOf(home))).toBe(false);
      expect(fs.existsSync(deployEnvOf(home))).toBe(false);
    });
  });

  it("restores prior env/state bytes and removes the exact candidate when state promotion fails", async () => {
    await withTempHome(async (home) => {
      const deployDir = seedRegistryDeployment(home);
      const priorEnv = fs.readFileSync(deployEnvFilePath(deployDir));
      const priorState = fs.readFileSync(deployStatePath(deployDir));
      const runner = healthyRegistryRunner();
      setDockerRunner(runner);
      stubSeams();
      let promotions = 0;
      setFinalizationRenamer((source, destination) => {
        promotions += 1;
        if (promotions === 2) throw new Error("injected state promotion failure");
        fs.renameSync(source, destination);
      });

      const result = await runCli(["server", "up"], {
        home,
        prompter: new FakePrompter({}),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/persist|finaliz|promotion/i);
      expect(runner.ran("docker", ["rm", "-f", CANDIDATE_CONTAINER_ID])).toBe(true);
      expect(fs.readFileSync(deployEnvFilePath(deployDir))).toEqual(priorEnv);
      expect(fs.readFileSync(deployStatePath(deployDir))).toEqual(priorState);
      expect(fs.existsSync(stagedDeployEnvOf(home))).toBe(false);
      expect(fs.readdirSync(deployDir).some((name) => name.startsWith(".deploy-state-next-"))).toBe(
        false,
      );
    });
  });

  it("restores file absence and removes the exact candidate when fresh state promotion fails", async () => {
    await withTempHome(async (home) => {
      const deployDir = path.join(home, ".librarian", "server");
      const runner = healthyRegistryRunner();
      setDockerRunner(runner);
      stubSeams();
      let promotions = 0;
      setFinalizationRenamer((source, destination) => {
        promotions += 1;
        if (promotions === 2) throw new Error("injected fresh state promotion failure");
        fs.renameSync(source, destination);
      });

      const result = await runCli(["server", "up"], {
        home,
        prompter: new FakePrompter({}),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/persist|finaliz|promotion/i);
      expect(runner.ran("docker", ["rm", "-f", CANDIDATE_CONTAINER_ID])).toBe(true);
      expect(fs.existsSync(deployEnvFilePath(deployDir))).toBe(false);
      expect(fs.existsSync(deployStatePath(deployDir))).toBe(false);
      expect(fs.existsSync(stagedDeployEnvOf(home))).toBe(false);
      expect(fs.readdirSync(deployDir).some((name) => name.startsWith(".deploy-state-next-"))).toBe(
        false,
      );
    });
  });

  it("a healthy deployment already running the same registry digest is a clean no-op", async () => {
    await withTempHome(async (home) => {
      const deployDir = seedRegistryDeployment(home);
      const beforeEnv = fs.readFileSync(deployEnvFilePath(deployDir), "utf8");
      const beforeState = fs.readFileSync(deployStatePath(deployDir), "utf8");
      const runner = healthyRegistryRunner().onRun(
        "docker",
        ["container", "inspect", "--format", "{{json .}}", "the-librarian"],
        { stdout: JSON.stringify(liveRegistryContainer()), code: 0 },
      );
      setDockerRunner(runner);
      let pulls = 0;
      setStreamer({
        stream: async () => {
          pulls += 1;
          throw new Error("registry unavailable");
        },
      });
      setLatestFetcher(async () => LATEST);
      setTokenMinter(() => {
        throw new Error("must not mint on a no-op");
      });
      setSecretKeyMinter(() => {
        throw new Error("must not mint on a no-op");
      });

      const result = await runCli(["server", "up"], {
        home,
        prompter: new FakePrompter({}),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/already running.*healthy/i);
      expect(pulls).toBe(0);
      expect(dockerRunArgs(runner)).toBeUndefined();
      expect(runner.ran("docker", ["rm", "-f", "the-librarian"])).toBe(false);
      expect(fs.readFileSync(deployEnvFilePath(deployDir), "utf8")).toBe(beforeEnv);
      expect(fs.readFileSync(deployStatePath(deployDir), "utf8")).toBe(beforeState);
      expect(readEnvFile(home)).toBeNull();
    });
  });

  it("does not mistake an unrelated Docker not-found error for an absent container", async () => {
    await withTempHome(async (home) => {
      const runner = healthyRegistryRunner().onRun(
        "docker",
        ["container", "inspect", "--format", "{{json .}}", "the-librarian"],
        { stderr: "Docker context 'remote' not found", code: 1 },
      );
      setDockerRunner(runner);
      stubSeams();

      const result = await runCli(["server", "up"], {
        home,
        prompter: new FakePrompter({}),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/could not inspect.*container/i);
      expect(streamedPullArgs()).toBeUndefined();
      expect(dockerRunArgs(runner)).toBeUndefined();
    });
  });

  it.each([
    ["a different value", "replacement-bootstrap-claim-secret-".repeat(2)],
    ["explicit removal", ""],
  ])(
    "refuses a registry no-op when the invocation requests %s for the bootstrap claim secret",
    async (_description, requestedSecret) => {
      await withTempHome(async (home) => {
        const existingSecret = "existing-bootstrap-claim-secret-".repeat(2);
        const deployDir = seedRegistryDeployment(home);
        writeDeployEnvFile(deployDir, {
          agentToken: "existing-agent-token",
          secretKey: "existing-master-key-long-enough-for-safe-reuse",
          bootstrapClaimSecret: existingSecret,
          host: "127.0.0.1",
        });
        const live = liveRegistryContainer();
        live.Config.Env.push(`LIBRARIAN_BOOTSTRAP_CLAIM_SECRET=${existingSecret}`);
        const beforeEnv = fs.readFileSync(deployEnvFilePath(deployDir));
        const beforeState = fs.readFileSync(deployStatePath(deployDir));
        const runner = healthyRegistryRunner().onRun(
          "docker",
          ["container", "inspect", "--format", "{{json .}}", "the-librarian"],
          { stdout: JSON.stringify(live), code: 0 },
        );
        setDockerRunner(runner);
        stubSeams();

        const result = await runCli(["server", "up"], {
          home,
          env: { LIBRARIAN_BOOTSTRAP_CLAIM_SECRET: requestedSecret },
          prompter: new FakePrompter({}),
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/existing.*container.*differs/i);
        expect(streamedPullArgs()).toBeUndefined();
        expect(runner.calls.some((call) => call.args[0] === "rm")).toBe(false);
        expect(fs.readFileSync(deployEnvFilePath(deployDir))).toEqual(beforeEnv);
        expect(fs.readFileSync(deployStatePath(deployDir))).toEqual(beforeState);
      });
    },
  );

  it.each([
    [
      "image digest",
      (live: ReturnType<typeof liveRegistryContainer>) => (live.Config.Image += "x"),
    ],
    [
      "mount source",
      (live: ReturnType<typeof liveRegistryContainer>) => (live.Mounts[0]!.Name = "other"),
    ],
    [
      "mount type",
      (live: ReturnType<typeof liveRegistryContainer>) => (live.Mounts[0]!.Type = "bind"),
    ],
    [
      "published host",
      (live: ReturnType<typeof liveRegistryContainer>) =>
        (live.HostConfig.PortBindings["3000/tcp"][0]!.HostIp = "0.0.0.0"),
    ],
    [
      "published port",
      (live: ReturnType<typeof liveRegistryContainer>) =>
        (live.HostConfig.PortBindings["3000/tcp"][0]!.HostPort = "3001"),
    ],
    [
      "restart policy",
      (live: ReturnType<typeof liveRegistryContainer>) =>
        (live.HostConfig.RestartPolicy.Name = "always"),
    ],
    [
      "container user",
      (live: ReturnType<typeof liveRegistryContainer>) => (live.Config.User = "root"),
    ],
    [
      "auth environment",
      (live: ReturnType<typeof liveRegistryContainer>) =>
        live.Config.Env.splice(live.Config.Env.indexOf("LIBRARIAN_ALLOW_NO_AUTH=true"), 1),
    ],
  ])("refuses a live same-name container with drifted %s before mutation", async (_name, drift) => {
    await withTempHome(async (home) => {
      const deployDir = seedRegistryDeployment(home);
      const beforeEnv = fs.readFileSync(deployEnvFilePath(deployDir), "utf8");
      const beforeState = fs.readFileSync(deployStatePath(deployDir), "utf8");
      const live = liveRegistryContainer();
      drift(live);
      const runner = healthyRegistryRunner().onRun(
        "docker",
        ["container", "inspect", "--format", "{{json .}}", "the-librarian"],
        { stdout: JSON.stringify(live), code: 0 },
      );
      setDockerRunner(runner);
      stubSeams();

      const result = await runCli(["server", "up"], {
        home,
        prompter: new FakePrompter({}),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/existing.*container.*differs|refusing to replace/i);
      expect(streamedPullArgs()).toBeUndefined();
      expect(dockerRunArgs(runner)).toBeUndefined();
      expect(runner.ran("docker", ["rm", "-f", "the-librarian"])).toBe(false);
      expect(fs.readFileSync(deployEnvFilePath(deployDir), "utf8")).toBe(beforeEnv);
      expect(fs.readFileSync(deployStatePath(deployDir), "utf8")).toBe(beforeState);
    });
  });
});

describe("server up — progress feedback", () => {
  it("emits numbered phase messages through the injected log", async () => {
    await withTempHome(async (home) => {
      setDockerRunner(healthyRunner());
      stubSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });
      const lines: string[] = [];

      const result = await runUp(
        {},
        { home, prompter, interactive: false, log: (line) => lines.push(line) },
      );
      // Sanity: the run actually completed (so the phases below really ran).
      expect(result.output).toContain("up and healthy");

      const joined = lines.join("\n");
      expect(joined).toContain("[1/5]");
      expect(joined).toContain("[2/5]");
      expect(joined).toMatch(/\[3\/5\].*[Vv]erified/);
      expect(joined).toContain("[4/5]");
      expect(joined).toContain("[5/5]");
      expect(joined).toMatch(/pulling and validating/i);
      expect(joined).toContain("✓ The server is healthy.");
    });
  });
});
