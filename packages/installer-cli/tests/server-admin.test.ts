// S7a — `librarian server admin <verb> [args…]`: dispatch a curated subset of
// the folded-in `@librarian/cli` (`the-librarian`) into the running container.
//
// The load-bearing assertions (spec §7):
//   - The argv is EXACTLY `docker exec the-librarian the-librarian <verb> [args…]`
//     with the remaining args passed through VERBATIM, in order.
//   - Only `backup | restore | auth | rebuild` are exposed; anything else
//     (`seed`, `migrate-data-dir`, `export`, `handoffs`, or a typo) is a teaching
//     error that names the allowed verbs and runs NO `docker exec`.
//   - Preflight runs first; a container that isn't running is a teaching error
//     ("the server isn't running — `librarian server up` first") with NO exec.

import { afterEach, describe, expect, it } from "vitest";
import { resetRunner } from "../src/exec.js";
import { runCli } from "../src/runtime.js";
import {
  resetInteractiveRunner,
  resetRunner as resetDockerRunner,
  setInteractiveRunner,
  setRunner as setDockerRunner,
} from "../src/server/docker.js";
import { FakeRunner, withTempHome } from "./helpers.js";

afterEach(() => {
  resetRunner();
  resetDockerRunner();
  resetInteractiveRunner();
});

/** A runner with docker present, daemon reachable, and the container running. */
function adminReady(): FakeRunner {
  return new FakeRunner()
    .withWhich("docker")
    .onRun("docker", ["info"], { code: 0 })
    .onRun("docker", ["inspect", "--format", "{{.State.Status}}", "the-librarian"], {
      stdout: "running\n",
      code: 0,
    });
}

/** The `docker exec` calls the runner recorded, in order (verb + passthrough). */
function execCalls(runner: FakeRunner): string[][] {
  return runner.calls.filter((c) => c.cmd === "docker" && c.args[0] === "exec").map((c) => c.args);
}

describe("server admin — dispatches the curated verbs into the container", () => {
  it("`backup` → docker exec the-librarian the-librarian backup", async () => {
    await withTempHome(async (home) => {
      const runner = adminReady();
      setDockerRunner(runner);

      const r = await runCli(["server", "admin", "backup"], { home, interactive: false });
      expect(r.exitCode).toBe(0);

      expect(execCalls(runner)).toEqual([["exec", "the-librarian", "the-librarian", "backup"]]);
    });
  });

  it("`auth reset-password --user x` passes the sub-verb + args through VERBATIM, in order", async () => {
    await withTempHome(async (home) => {
      const runner = adminReady();
      setDockerRunner(runner);

      const r = await runCli(["server", "admin", "auth", "reset-password", "--user", "x"], {
        home,
        interactive: false,
      });
      expect(r.exitCode).toBe(0);

      expect(execCalls(runner)).toEqual([
        ["exec", "the-librarian", "the-librarian", "auth", "reset-password", "--user", "x"],
      ]);
    });
  });

  it("`rebuild` → docker exec the-librarian the-librarian rebuild", async () => {
    await withTempHome(async (home) => {
      const runner = adminReady();
      setDockerRunner(runner);

      const r = await runCli(["server", "admin", "rebuild"], { home, interactive: false });
      expect(r.exitCode).toBe(0);

      expect(execCalls(runner)).toEqual([["exec", "the-librarian", "the-librarian", "rebuild"]]);
    });
  });

  it("`restore --secret-key …` passes the flag + value through VERBATIM", async () => {
    await withTempHome(async (home) => {
      const runner = adminReady();
      setDockerRunner(runner);

      const r = await runCli(["server", "admin", "restore", "--secret-key", "abc123"], {
        home,
        interactive: false,
      });
      expect(r.exitCode).toBe(0);

      expect(execCalls(runner)).toEqual([
        ["exec", "the-librarian", "the-librarian", "restore", "--secret-key", "abc123"],
      ]);
    });
  });

  it("an interactive run uses an inherited-stdio `-it` exec (NOT the capture runner)", async () => {
    await withTempHome(async (home) => {
      const runner = adminReady();
      setDockerRunner(runner);
      // The interactive path must go through the inherited-stdio seam — pairing
      // `-t` with the capture runner (stdin ignored) is the "input device is not a
      // TTY" bug. Capture the inherited-exec argv here.
      const interactiveCalls: string[][] = [];
      setInteractiveRunner({
        runInteractive: async (_cmd, args) => {
          interactiveCalls.push([...args]);
          return 0;
        },
      });

      const r = await runCli(["server", "admin", "restore"], { home, interactive: true });
      expect(r.exitCode).toBe(0);

      // `-it` rides the inherited-stdio seam…
      expect(interactiveCalls).toEqual([
        ["exec", "-it", "the-librarian", "the-librarian", "restore"],
      ]);
      // …and the capture runner (which ignores stdin) issued NO exec.
      expect(execCalls(runner)).toEqual([]);
    });
  });

  it("`--secret-key` makes the verb non-interactive even on a TTY (no -it; SC-3)", async () => {
    await withTempHome(async (home) => {
      const runner = adminReady();
      setDockerRunner(runner);
      let interactiveUsed = false;
      setInteractiveRunner({
        runInteractive: async () => {
          interactiveUsed = true;
          return 0;
        },
      });

      // interactive:true, but the secret is already supplied → no prompt needed.
      const r = await runCli(["server", "admin", "restore", "--secret-key", "abc"], {
        home,
        interactive: true,
      });
      expect(r.exitCode).toBe(0);

      // Runs through the capture runner with NO -it; the inherited seam is untouched.
      expect(interactiveUsed).toBe(false);
      expect(execCalls(runner)).toEqual([
        ["exec", "the-librarian", "the-librarian", "restore", "--secret-key", "abc"],
      ]);
    });
  });
});

describe("server admin — only the curated verbs are exposed (spec §7)", () => {
  it("`seed` is NOT folded in → teaching error, NO docker exec", async () => {
    await withTempHome(async (home) => {
      const runner = adminReady();
      setDockerRunner(runner);

      const r = await runCli(["server", "admin", "seed"], { home, interactive: false });
      expect(r.exitCode).toBe(1);
      // Names the allowed verbs so the reader knows what IS available.
      expect(r.stderr).toMatch(/backup/);
      expect(r.stderr).toMatch(/restore/);
      expect(r.stderr).toMatch(/auth/);
      expect(r.stderr).toMatch(/rebuild/);
      // Mentions the rejected verb so the error is specific.
      expect(r.stderr).toMatch(/seed/);
      // NOTHING was exec'd into the container.
      expect(execCalls(runner)).toEqual([]);
      // No stack trace leaked.
      expect(r.stderr).not.toMatch(/at \w+.*\(/);
    });
  });

  it("an unknown verb (`frobnicate`) → teaching error naming the allowed verbs, NO exec", async () => {
    await withTempHome(async (home) => {
      const runner = adminReady();
      setDockerRunner(runner);

      const r = await runCli(["server", "admin", "frobnicate"], { home, interactive: false });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/backup.*restore.*auth.*rebuild|backup|restore|auth|rebuild/);
      expect(execCalls(runner)).toEqual([]);
    });
  });

  it("no verb at all → teaching error naming the allowed verbs, NO exec", async () => {
    await withTempHome(async (home) => {
      const runner = adminReady();
      setDockerRunner(runner);

      const r = await runCli(["server", "admin"], { home, interactive: false });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/backup/);
      expect(execCalls(runner)).toEqual([]);
    });
  });
});

describe("server admin — a failing exec REDACTS secret-bearing output (I-3)", () => {
  it("redacts a libadmin token + 64-hex run from a failed exec's surfaced detail", async () => {
    await withTempHome(async (home) => {
      // Assembled from sub-threshold parts so no realistic secret literal is committed.
      const fakeAdminToken = "libadmin_" + "FAKETOKENVALUE";
      const fakeAdminLine =
        "Generated a new admin token (LIBRARIAN_ADMIN_TOKEN): " + fakeAdminToken;
      const fakeHexKey = "0123456789abcdef".repeat(4); // a 64-hex master-key shape

      const runner = adminReady().onRun(
        "docker",
        ["exec", "the-librarian", "the-librarian", "restore", "--secret-key", fakeHexKey],
        {
          // The in-container CLI echoes the secret-bearing argv + a token line on failure.
          stderr: `restore failed for --secret-key ${fakeHexKey}\n${fakeAdminLine}\nsee logs\n`,
          code: 1,
        },
      );
      setDockerRunner(runner);

      const r = await runCli(["server", "admin", "restore", "--secret-key", fakeHexKey], {
        home,
        interactive: false,
      });
      expect(r.exitCode).toBe(1);

      // The surfaced error must carry NEITHER the admin token, the gen line, nor
      // the raw 64-hex key.
      expect(r.stderr).not.toContain(fakeAdminToken);
      expect(r.stderr).not.toMatch(/Generated a new admin token/i);
      expect(r.stderr).not.toContain(fakeHexKey);
      // ...but the non-secret remainder is still surfaced for triage.
      expect(r.stderr).toMatch(/restore failed|see logs/i);
    });
  });
});

describe("server admin — preflight + container-running guards", () => {
  it("docker missing → teaching error, NO exec", async () => {
    await withTempHome(async (home) => {
      const runner = new FakeRunner(); // nothing on PATH
      setDockerRunner(runner);

      const r = await runCli(["server", "admin", "backup"], { home, interactive: false });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/docker/i);
      expect(r.stderr).toMatch(/install/i);
      expect(execCalls(runner)).toEqual([]);
    });
  });

  it("container not running → teaching error pointing at `server up`, NO exec", async () => {
    await withTempHome(async (home) => {
      // docker + daemon fine, but `inspect` reports the container is absent.
      const runner = new FakeRunner()
        .withWhich("docker")
        .withWhich("git")
        .onRun("docker", ["info"], { code: 0 })
        .onRun("docker", ["inspect", "--format", "{{.State.Status}}", "the-librarian"], {
          stderr: "Error: No such object: the-librarian\n",
          code: 1,
        });
      setDockerRunner(runner);

      const r = await runCli(["server", "admin", "backup"], { home, interactive: false });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/not running|isn't running|is not running/i);
      expect(r.stderr).toMatch(/server up/);
      expect(execCalls(runner)).toEqual([]);
      // No stack trace leaked.
      expect(r.stderr).not.toMatch(/at \w+.*\(/);
    });
  });
});
