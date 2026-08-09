// S4 — `librarian server down`: stop the container, DATA SACRED.
//
// `down` maps to `docker stop the-librarian` and NOTHING else. The
// load-bearing assertions (success criterion 6 — data is sacred): the argv is
// EXACTLY `docker stop the-librarian`, and NO `rm` / `-v` / `volume` / `rm -f`
// ever appears. A later `up`/`update` brings the same data back. When the
// container isn't running, `down` prints a friendly message and does not crash.

import { afterEach, describe, expect, it } from "vitest";
import { resetRunner } from "../src/exec.js";
import { runCli } from "../src/runtime.js";
import {
  resetRunner as resetDockerRunner,
  setRunner as setDockerRunner,
} from "../src/server/docker.js";
import { FakeRunner, withTempHome } from "./helpers.js";

afterEach(() => {
  resetRunner();
  resetDockerRunner();
});

/** A runner with docker present + daemon reachable (preflight passes). */
function dockerReady(): FakeRunner {
  return new FakeRunner().withWhich("docker").onRun("docker", ["info"], { code: 0 });
}

/** True iff the runner ever issued a destructive docker op (rm / volume / -v). */
function ranDestructive(runner: FakeRunner): boolean {
  return runner.calls.some(
    (c) =>
      c.cmd === "docker" &&
      (c.args.includes("rm") ||
        c.args.includes("-v") ||
        c.args.includes("volume") ||
        c.args.includes("-f")),
  );
}

describe("server down — stops the container, never removes data (SC 6)", () => {
  it("argv is EXACTLY `docker stop the-librarian` — no rm/-v/volume/rm -f", async () => {
    await withTempHome(async (home) => {
      const runner = dockerReady().onRun("docker", ["stop", "the-librarian"], {
        stdout: "the-librarian\n",
        code: 0,
      });
      setDockerRunner(runner);

      const r = await runCli(["server", "down"], { home });
      expect(r.exitCode).toBe(0);

      // The stop call happened, with EXACTLY this argv.
      expect(runner.ran("docker", ["stop", "the-librarian"])).toBe(true);
      // The ONLY docker command (besides the preflight `info`) is `stop`.
      const dockerVerbs = runner.calls.filter((c) => c.cmd === "docker").map((c) => c.args[0]);
      expect(dockerVerbs).toEqual(["info", "stop"]);
      // NOTHING destructive ran.
      expect(ranDestructive(runner)).toBe(false);
    });
  });

  it("reports the container was stopped", async () => {
    await withTempHome(async (home) => {
      const runner = dockerReady().onRun("docker", ["stop", "the-librarian"], {
        stdout: "the-librarian\n",
        code: 0,
      });
      setDockerRunner(runner);

      const r = await runCli(["server", "down"], { home });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/stopped/i);
      // Data-sacred reassurance: the data volume is preserved.
      expect(r.stdout).toMatch(/data|volume|preserved|kept/i);
    });
  });
});

describe("server down — not running is friendly, not a crash", () => {
  it("a missing container prints a clear message and exits 0 (idempotent-ish)", async () => {
    await withTempHome(async (home) => {
      // `docker stop` on an absent container exits non-zero with "No such container".
      const runner = dockerReady().onRun("docker", ["stop", "the-librarian"], {
        stderr: "Error response from daemon: No such container: the-librarian\n",
        code: 1,
      });
      setDockerRunner(runner);

      const r = await runCli(["server", "down"], { home });
      // Not a crash — a friendly outcome.
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/not running|no.*container|already|nothing to stop/i);
      // Still no destructive op, even on the not-running path.
      expect(ranDestructive(runner)).toBe(false);
      // No stack trace leaked.
      expect(r.stderr).not.toMatch(/at \w+.*\(/);
    });
  });
});

describe("server down — preflight teaches when docker is missing", () => {
  it("docker absent → teaching error, never a destructive op", async () => {
    await withTempHome(async (home) => {
      const runner = new FakeRunner(); // nothing on PATH
      setDockerRunner(runner);

      const r = await runCli(["server", "down"], { home });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/docker/i);
      expect(r.stderr).toMatch(/install/i);
      expect(ranDestructive(runner)).toBe(false);
    });
  });
});
