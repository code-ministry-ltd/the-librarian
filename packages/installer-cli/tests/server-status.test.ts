// S4 — `librarian server status`: running? healthy? deployed-vs-latest badge.
//
// `status` reports, from stubbed `docker inspect` + a stubbed
// `fetchLatestVersion` (no real daemon/network):
//   - container running? (docker inspect state)
//   - health (`{{.State.Health.Status}}`)
//   - the DEPLOYED version (the ref from deploy-state, else `git describe`)
//   - the LATEST release (`fetchLatestVersion`)
//   - an `up-to-date | update-available` badge via `isBehind(deployed, latest)`
// Offline / unknown latest renders `unknown`/`?` and NEVER crashes (mirrors
// status.ts's offline tolerance). A container that doesn't exist → "not running".

import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetRunner } from "../src/exec.js";
import { runCli } from "../src/runtime.js";
import { writeDeployState } from "../src/server/deploy-state.js";
import {
  resetRunner as resetDockerRunner,
  setRunner as setDockerRunner,
} from "../src/server/docker.js";
import { resetLatestFetcher, setLatestFetcher } from "../src/status.js";
import { FakeRunner, withTempHome } from "./helpers.js";

afterEach(() => {
  resetRunner();
  resetDockerRunner();
  resetLatestFetcher();
});

const DEPLOYED = "v1.4.2";

/** Seed a deploy-state recording the deployed ref `v1.4.2`. */
function seedDeployState(home: string): void {
  writeDeployState(path.join(home, ".librarian", "server"), {
    containerName: "the-librarian",
    host: "127.0.0.1",
    dataVolume: "librarian_data",
    ref: DEPLOYED,
    imageTag: `the-librarian:${DEPLOYED}`,
  });
}

/** docker present, daemon up, container running + healthy. */
function runningHealthy(): FakeRunner {
  return new FakeRunner()
    .withWhich("docker")
    .withWhich("git")
    .onRun("docker", ["info"], { code: 0 })
    .onRun("docker", ["inspect", "--format", "{{.State.Status}}", "the-librarian"], {
      stdout: "running\n",
      code: 0,
    })
    .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", "the-librarian"], {
      stdout: "healthy\n",
      code: 0,
    });
}

describe("server status — running + healthy, deployed vs latest badge", () => {
  it("a NEWER latest → update-available", async () => {
    await withTempHome(async (home) => {
      seedDeployState(home);
      setDockerRunner(runningHealthy());
      setLatestFetcher(async () => "1.5.0"); // newer than deployed 1.4.2

      const r = await runCli(["server", "status"], { home });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/running/i);
      expect(r.stdout).toMatch(/healthy/i);
      expect(r.stdout).toContain(DEPLOYED); // deployed version
      expect(r.stdout).toContain("1.5.0"); // latest
      expect(r.stdout).toMatch(/update-available/i);
      expect(r.stdout).not.toMatch(/up-to-date/i);
    });
  });

  it("an EQUAL latest → up-to-date", async () => {
    await withTempHome(async (home) => {
      seedDeployState(home);
      setDockerRunner(runningHealthy());
      setLatestFetcher(async () => "1.4.2"); // equal to deployed

      const r = await runCli(["server", "status"], { home });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/up-to-date/i);
      expect(r.stdout).not.toMatch(/update-available/i);
    });
  });
});

describe("server status — offline tolerance (never crashes)", () => {
  it("fetchLatestVersion returns null → latest unknown, badge ?, no crash", async () => {
    await withTempHome(async (home) => {
      seedDeployState(home);
      setDockerRunner(runningHealthy());
      setLatestFetcher(async () => null); // offline

      const r = await runCli(["server", "status"], { home });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/unknown/i);
      // The badge degrades to `?` rather than lying about an update.
      expect(r.stdout).toContain("?");
      expect(r.stdout).not.toMatch(/update-available/i);
      expect(r.stdout).not.toMatch(/up-to-date/i);
    });
  });
});

describe("server status — container absent → not running", () => {
  it("`docker inspect` non-zero (no such container) → not running, no crash", async () => {
    await withTempHome(async (home) => {
      seedDeployState(home);
      const runner = new FakeRunner()
        .withWhich("docker")
        .withWhich("git")
        .onRun("docker", ["info"], { code: 0 })
        .onRun("docker", ["inspect", "--format", "{{.State.Status}}", "the-librarian"], {
          stderr: "Error: No such object: the-librarian\n",
          code: 1,
        });
      setDockerRunner(runner);
      setLatestFetcher(async () => "1.5.0");

      const r = await runCli(["server", "status"], { home });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/not running/i);
      // Still reports the deployed version it knows from deploy-state.
      expect(r.stdout).toContain(DEPLOYED);
    });
  });
});

describe("server status — deployed version from deploy-state, else git describe", () => {
  it("reads the deployed ref from deploy-state.json", async () => {
    await withTempHome(async (home) => {
      seedDeployState(home);
      setDockerRunner(runningHealthy());
      setLatestFetcher(async () => "1.4.2");

      const r = await runCli(["server", "status"], { home });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(DEPLOYED);
    });
  });

  it("falls back to `git -C <dir> describe --tags` when no deploy-state exists", async () => {
    await withTempHome(async (home) => {
      // No deploy-state seeded — status must fall back to git describe.
      const deployDir = path.join(home, ".librarian", "server");
      const runner = runningHealthy().onRun("git", ["-C", deployDir, "describe", "--tags"], {
        stdout: "v1.3.9\n",
        code: 0,
      });
      setDockerRunner(runner);
      setLatestFetcher(async () => "1.5.0");

      const r = await runCli(["server", "status"], { home });
      expect(r.exitCode).toBe(0);
      // The git-describe value is surfaced as the deployed version.
      expect(r.stdout).toContain("v1.3.9");
      expect(runner.ran("git", ["-C", deployDir, "describe", "--tags"])).toBe(true);
    });
  });

  it("deployed unknown (no deploy-state AND git describe fails) → unknown, badge ?", async () => {
    await withTempHome(async (home) => {
      const deployDir = path.join(home, ".librarian", "server");
      const runner = runningHealthy().onRun("git", ["-C", deployDir, "describe", "--tags"], {
        stderr: "fatal: not a git repository\n",
        code: 128,
      });
      setDockerRunner(runner);
      setLatestFetcher(async () => "1.5.0");

      const r = await runCli(["server", "status"], { home });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/unknown/i);
      expect(r.stdout).toContain("?");
      expect(r.stdout).not.toMatch(/update-available/i);
    });
  });

  it("deployed unknown without git → unknown without failing or running git", async () => {
    await withTempHome(async (home) => {
      const runner = new FakeRunner()
        .withWhich("docker")
        .onRun("docker", ["info"], { code: 0 })
        .onRun("docker", ["inspect", "--format", "{{.State.Status}}", "the-librarian"], {
          stdout: "running\n",
          code: 0,
        })
        .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", "the-librarian"], {
          stdout: "healthy\n",
          code: 0,
        });
      setDockerRunner(runner);
      setLatestFetcher(async () => "1.5.0");

      const r = await runCli(["server", "status"], { home });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/Deployed:\s+unknown/);
      expect(r.stdout).toContain("?");
      expect(runner.calls.some((call) => call.cmd === "git")).toBe(false);
    });
  });
});

describe("server status — preflight teaches when docker is missing", () => {
  it("docker absent → teaching error", async () => {
    await withTempHome(async (home) => {
      setDockerRunner(new FakeRunner());
      setLatestFetcher(async () => "1.5.0");
      const r = await runCli(["server", "status"], { home });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/docker/i);
      expect(r.stderr).toMatch(/install/i);
    });
  });
});
