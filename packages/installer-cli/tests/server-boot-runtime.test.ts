// S6 — boot persistence wired into the CLI runtime.
//
// Drives the public `runCli(["server", "enable-boot"|"disable-boot", …])` and
// `runCli(["server", "up", "--enable-boot"])` entries against the injected
// `docker.ts` FakeRunner, so the EXACT systemctl/sudo argv is asserted and no
// real systemd/sudo/docker is touched. Platform is injectable so the macOS
// deferral is testable from a Linux host.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetRunner } from "../src/exec.js";
import { runCli } from "../src/runtime.js";
import { writeDeployState } from "../src/server/deploy-state.js";
import {
  resetRunner as resetDockerRunner,
  resetStreamer,
  setRunner as setDockerRunner,
  setStreamer,
} from "../src/server/docker.js";
import {
  resetSleep,
  resetTokenMinter,
  setSleep,
  setTokenMinter,
  writeDeployEnvFile,
} from "../src/server/up.js";
import { resetLatestFetcher, setLatestFetcher } from "../src/status.js";
import { FakeRunner, withTempHome } from "./helpers.js";
import { FakePrompter } from "./prompter.js";

const UNIT_PATH = "/etc/systemd/system/the-librarian.service";
const UNIT_NAME = "the-librarian.service";
const AGENT_TOKEN = "agent-token-deterministic-for-tests";
const MASTER_KEY = "master-key-read-back-from-the-container-once";
const LATEST = "1.4.2";
const IMAGE_NAME = "ghcr.io/code-ministry-ltd/the-librarian";
const IMAGE_REF = `${IMAGE_NAME}:v${LATEST}`;
const IMAGE_DIGEST = `${IMAGE_NAME}@sha256:${"ab".repeat(32)}`;
const CANDIDATE_CONTAINER_ID = "cafebabedeadbeef".repeat(4);

// `up`'s image build now STREAMS (live output) via the streamer seam — stub it to
// succeed so these boot tests never spawn a real `docker build`.
beforeEach(() => {
  setStreamer({ stream: async () => 0 });
});

afterEach(() => {
  resetRunner();
  resetDockerRunner();
  resetStreamer();
  resetLatestFetcher();
  resetSleep();
  resetTokenMinter();
});

/** A runner with docker/systemctl/sudo present, every call succeeding. */
function bootReady(): FakeRunner {
  return new FakeRunner()
    .withWhich("docker")
    .withWhich("git")
    .withWhich("systemctl")
    .withWhich("sudo")
    .onRun("docker", ["info"], { code: 0 })
    .onRun("docker", ["container", "inspect", "--format", "{{json .}}", "the-librarian"], {
      stderr: "No such container: the-librarian",
      code: 1,
    })
    .withFallback({ code: 0 });
}

/** A fully-successful localhost `up` runner, plus systemctl/sudo for boot. */
function upPlusBootReady(): FakeRunner {
  const runner = bootReady()
    .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", "the-librarian"], {
      stdout: "healthy\n",
      code: 0,
    })
    .onRun("docker", ["exec", "the-librarian", "cat", "/data/secret.key"], {
      stdout: `${MASTER_KEY}\n`,
      code: 0,
    });
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
    if (
      cmd === "docker" &&
      args.join(" ") === `inspect --format {{.State.Health.Status}} ${CANDIDATE_CONTAINER_ID}`
    ) {
      runner.calls.push({ cmd, args: [...args], opts: options });
      return { stdout: "healthy\n", stderr: "", code: 0 };
    }
    return realRun(cmd, args, options);
  };
  return runner;
}

function stubUpSeams(): void {
  setLatestFetcher(async () => LATEST);
  setTokenMinter(() => AGENT_TOKEN);
  setSleep(async () => undefined);
}

describe("server enable-boot (linux) — standalone", () => {
  it("installs the unit and enables --now, exit 0", async () => {
    await withTempHome(async (home) => {
      const runner = bootReady();
      setDockerRunner(runner);

      const r = await runCli(["server", "enable-boot"], { home, platform: "linux" });
      expect(r.exitCode).toBe(0);

      expect(
        runner.calls.some(
          (c) => c.cmd === "sudo" && c.args[0] === "cp" && c.args.includes(UNIT_PATH),
        ),
      ).toBe(true);
      expect(
        runner.calls.some(
          (c) =>
            c.cmd === "sudo" &&
            c.args[0] === "systemctl" &&
            c.args.includes("enable") &&
            c.args.includes("--now") &&
            c.args.includes(UNIT_NAME),
        ),
      ).toBe(true);
      expect(r.stdout).toMatch(/boot/i);
    });
  });
});

describe("server disable-boot (linux) — standalone", () => {
  it("disables --now, removes the unit, daemon-reload, exit 0", async () => {
    await withTempHome(async (home) => {
      const runner = bootReady();
      setDockerRunner(runner);

      const r = await runCli(["server", "disable-boot"], { home, platform: "linux" });
      expect(r.exitCode).toBe(0);

      expect(
        runner.calls.some(
          (c) => c.cmd === "sudo" && c.args[0] === "systemctl" && c.args.includes("disable"),
        ),
      ).toBe(true);
      expect(
        runner.calls.some(
          (c) => c.cmd === "sudo" && c.args[0] === "rm" && c.args.includes(UNIT_PATH),
        ),
      ).toBe(true);
    });
  });
});

describe("server enable-boot / disable-boot (macOS) — deferred notice, no systemctl", () => {
  it("enable-boot on darwin prints the Linux-only notice and exits 0", async () => {
    await withTempHome(async (home) => {
      const runner = bootReady();
      setDockerRunner(runner);

      const r = await runCli(["server", "enable-boot"], { home, platform: "darwin" });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/linux-only|linux only|launchd|deferred/i);
      expect(runner.calls.some((c) => c.cmd === "sudo")).toBe(false);
    });
  });

  it("disable-boot on darwin prints the notice and exits 0", async () => {
    await withTempHome(async (home) => {
      const runner = bootReady();
      setDockerRunner(runner);

      const r = await runCli(["server", "disable-boot"], { home, platform: "darwin" });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/linux-only|linux only|launchd|deferred/i);
      expect(runner.calls.some((c) => c.cmd === "sudo")).toBe(false);
    });
  });
});

describe("server up --enable-boot (linux) — boot enable runs AFTER a healthy up", () => {
  it("the systemctl enable argv appears after the docker run argv", async () => {
    await withTempHome(async (home) => {
      const runner = upPlusBootReady();
      setDockerRunner(runner);
      stubUpSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up", "--ref", "main", "--enable-boot"], {
        home,
        prompter,
        platform: "linux",
      });
      expect(r.exitCode).toBe(0);

      const idxRun = runner.calls.findIndex((c) => c.cmd === "docker" && c.args[0] === "start");
      const idxEnable = runner.calls.findIndex(
        (c) => c.cmd === "sudo" && c.args[0] === "systemctl" && c.args.includes("enable"),
      );
      expect(idxRun).toBeGreaterThanOrEqual(0);
      expect(idxEnable).toBeGreaterThan(idxRun);

      // The healthy `up` still closed the loop (URL + token surfaced).
      expect(r.stdout).toContain("http://127.0.0.1:3838/mcp");
      expect(r.stdout).toContain(AGENT_TOKEN);
      // The deferred-note from the old wiring is GONE.
      expect(r.stdout).not.toMatch(/recognised but boot persistence arrives in a later slice/i);
    });
  });

  it("does NOT enable boot on a plain `up` (opt-in only)", async () => {
    await withTempHome(async (home) => {
      const runner = upPlusBootReady();
      setDockerRunner(runner);
      stubUpSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up", "--ref", "main"], {
        home,
        prompter,
        platform: "linux",
      });
      expect(r.exitCode).toBe(0);
      expect(runner.calls.some((c) => c.cmd === "sudo")).toBe(false);
    });
  });

  it("enables boot for an exact healthy registry no-op without pulling", async () => {
    await withTempHome(async (home) => {
      const deployDir = `${home}/.librarian/server`;
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
        ref: `v${LATEST}`,
        imageTag: IMAGE_REF,
        imageSource: "registry",
        imageRef: IMAGE_REF,
        imageDigest: IMAGE_DIGEST,
      });
      const live = {
        State: { Health: { Status: "healthy" } },
        Config: {
          Image: IMAGE_DIGEST,
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
      const runner = upPlusBootReady().onRun(
        "docker",
        ["container", "inspect", "--format", "{{json .}}", "the-librarian"],
        { stdout: JSON.stringify(live), code: 0 },
      );
      setDockerRunner(runner);
      stubUpSeams();
      let pulls = 0;
      setStreamer({
        stream: async () => {
          pulls += 1;
          throw new Error("registry unavailable");
        },
      });

      const result = await runCli(["server", "up", "--enable-boot"], {
        home,
        prompter: new FakePrompter({}),
        platform: "linux",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/already running.*healthy/i);
      expect(pulls).toBe(0);
      expect(runner.calls.some((call) => call.cmd === "sudo" && call.args.includes("enable"))).toBe(
        true,
      );
    });
  });
});

describe("server up --enable-boot (macOS) — notice, up still succeeds", () => {
  it("prints the Linux-only boot notice and the up succeeds (no systemctl)", async () => {
    await withTempHome(async (home) => {
      const runner = upPlusBootReady();
      setDockerRunner(runner);
      stubUpSeams();
      const prompter = new FakePrompter({ answers: { "~/.librarian/env": "n" } });

      const r = await runCli(["server", "up", "--ref", "main", "--enable-boot"], {
        home,
        prompter,
        platform: "darwin",
      });
      expect(r.exitCode).toBe(0);

      // The up succeeded (loop closed) AND the boot notice is shown.
      expect(r.stdout).toContain("http://127.0.0.1:3838/mcp");
      expect(r.stdout).toMatch(/linux-only|linux only|launchd|deferred/i);
      // Nothing touched systemd.
      expect(runner.calls.some((c) => c.cmd === "sudo")).toBe(false);
    });
  });
});
