// T3 — `librarian server autoupdate <enable|disable|uninstall|status|--run>`: the
// HOST half of server auto-update (spec 2026-06-16-server-autoupdate).
//
// Every test drives the seam: the pure unit/cron generators are asserted
// directly, and enable/disable/uninstall/status/--run route systemctl / crontab /
// docker through the injected `docker.ts` FakeRunner so the EXACT argv is asserted
// — no real systemd, cron, docker, or container. The `docker exec the-librarian
// node -e <script>` settings-bridge is intercepted by op (a get returns scripted
// config JSON; a set/stampRun returns ok) without spawning a real container.
//
// HOST-DEPENDENCE NOTE (honesty, AGENTS.md): these tests prove the argv we WOULD
// run + the fail-soft gating logic. Whether a real systemd timer fires hourly, a
// real cron entry runs, and `docker exec node -e` reaches the in-container tRPC on
// a live host is NOT provable here — it needs a real systemd/docker host. Those
// integration properties are called out in the build report, not asserted here.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunOptions, RunResult } from "../src/exec.js";
import { resetRunner } from "../src/exec.js";
import { runCli } from "../src/runtime.js";
import {
  AUTOUPDATE_SERVICE_NAME,
  AUTOUPDATE_TIMER_NAME,
  CRON_MARKER,
  cronLine,
  generateServiceUnit,
  generateTimerUnit,
  runAutoUpdate,
  UNIT_DESCRIPTION_MARKER,
} from "../src/server/autoupdate.js";
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
  resetFinalizationRenamer,
  resetFinalizationRestorer,
  resetSecretKeyMinter,
  resetSleep,
  resetStagedEnvIdMinter,
  resetTokenMinter,
  setSecretKeyMinter,
  setFinalizationRenamer,
  setFinalizationRestorer,
  setSleep,
  setStagedEnvIdMinter,
  setTokenMinter,
  writeDeployEnvFile,
} from "../src/server/up.js";
import { updateLockPath } from "../src/server/update-lock.js";
import { resetLatestFetcher, setLatestFetcher } from "../src/status.js";
import { FakeRunner, withTempHome } from "./helpers.js";

const SERVICE_PATH = "/etc/systemd/system/the-librarian-autoupdate.service";
const TIMER_PATH = "/etc/systemd/system/the-librarian-autoupdate.timer";

afterEach(() => {
  resetRunner();
  resetDockerRunner();
  resetLatestFetcher();
  resetSleep();
  resetTokenMinter();
  resetSecretKeyMinter();
  resetStreamer();
  resetStagedEnvIdMinter();
  resetReleaseProvenanceResolver();
  resetFinalizationRenamer();
  resetFinalizationRestorer();
});

/** The config JSON a `get` bridge call returns, shaped like autoupdate.get's data. */
interface RunningConfig {
  enabled: boolean;
  cadence: "daily" | "weekly";
  lastRunAt: string | null;
}

/**
 * Wrap a FakeRunner so any `docker exec the-librarian node -e <script>` call is
 * answered by INSPECTING the embedded op (autoupdate.get / .set / .stampRun) and
 * returning a scripted result — modelling the in-container tRPC bridge without a
 * real container. Records every bridge op for assertions.
 */
function withBridge(
  runner: FakeRunner,
  opts: {
    getConfig?: RunningConfig | null; // null → simulate an unreachable server (ALL exec ops fail)
    bridgeOps: string[];
    setScripts?: string[]; // each set/stampRun script captured, for body assertions
  },
): void {
  const realRun = runner.run.bind(runner);
  const down = opts.getConfig === null; // a down server fails every bridge op
  runner.run = async (
    cmd: string,
    args: readonly string[],
    runOpts?: RunOptions,
  ): Promise<RunResult> => {
    const isExecNode =
      cmd === "docker" && args[0] === "exec" && args[2] === "node" && args[3] === "-e";
    if (isExecNode) {
      const script = String(args[4] ?? "");
      const op = script.includes("autoupdate.get")
        ? "get"
        : script.includes("autoupdate.stampRun")
          ? "stampRun"
          : "set";
      opts.bridgeOps.push(op);
      if (op !== "get") opts.setScripts?.push(script);
      runner.calls.push({ cmd, args: [...args], opts: runOpts });
      // A down server makes every bridge op (get/set/stampRun) fail with exit 1.
      if (down) return { stdout: "", stderr: "down", code: 1 };
      if (op === "get") {
        return { stdout: JSON.stringify(opts.getConfig ?? {}), stderr: "", code: 0 };
      }
      return { stdout: "ok", stderr: "", code: 0 };
    }
    return realRun(cmd, args, runOpts);
  };
}

// ── pure generators ─────────────────────────────────────────────────────────

describe("autoupdate unit/cron generators — NO secret, the right schedule", () => {
  it("the oneshot service runs AS THE ENABLING USER against the baked deploy dir (spec 074 SC1)", () => {
    const unit = generateServiceUnit({
      librarianPath: "/usr/local/bin/librarian",
      user: "deploy-owner",
      deployDir: "/home/deploy-owner/.librarian/server",
    });
    expect(unit).toContain("Type=oneshot");
    // Spec 074: the unit must NOT run as root — root's home has no deploy-state,
    // The enabling user (who ran `server up`) is the one context where deploy
    // state and docker-group access resolve. Source refs additionally need that
    // user's managed checkout; stable published updates do not need Git.
    expect(unit).toContain("User=deploy-owner");
    expect(unit).toContain(
      "ExecStart=/usr/local/bin/librarian server autoupdate --run --dir /home/deploy-owner/.librarian/server",
    );
    // FIX I1(b): defense-in-depth on the auto-executing unit.
    expect(unit).toContain("NoNewPrivileges=true");
    // FIX I2: the unit carries our marker (Description=), which uninstall keys on
    // to confirm a file is ours before deleting it.
    expect(unit).toContain(UNIT_DESCRIPTION_MARKER);
    expect(unit).not.toMatch(/token|secret|key/i);
    expect(unit).not.toContain("LIBRARIAN_AGENT_TOKEN");
  });

  it("the timer fires hourly (the cadence is a due-check, not the timer period)", () => {
    const unit = generateTimerUnit();
    expect(unit).toContain("[Timer]");
    expect(unit).toContain("OnCalendar=hourly");
    expect(unit).toContain("Persistent=true");
    expect(unit).toContain(`Unit=${AUTOUPDATE_SERVICE_NAME}`);
    expect(unit).toContain("WantedBy=timers.target");
    expect(unit).not.toMatch(/token|secret|key/i);
  });

  it("the cron line runs the wrapper hourly against the baked deploy dir, tagged, no secret", () => {
    const line = cronLine("/usr/local/bin/librarian", "/home/deploy-owner/.librarian/server");
    // Spec 074 SC2: cron already fires as the enabling user, but the dir is baked
    // explicitly so a custom `--dir` passed to `enable` is honoured there too.
    expect(line).toContain(
      "/usr/local/bin/librarian server autoupdate --run --dir /home/deploy-owner/.librarian/server",
    );
    expect(line).toContain(CRON_MARKER);
    expect(line).toMatch(/^\d+ \* \* \* \*/); // a valid hourly cron schedule
    expect(line).not.toMatch(/token|secret|key/i);
  });
});

// ── enable (systemd) ─────────────────────────────────────────────────────────

/** A FakeRunner with docker + systemctl + sudo present, all calls succeeding. */
function systemdReady(): FakeRunner {
  return new FakeRunner()
    .withWhich("docker")
    .withWhich("systemctl")
    .withWhich("sudo")
    .withWhich("librarian")
    .withFallback({ code: 0 });
}

function ranSudo(runner: FakeRunner, ...match: string[]): boolean {
  return runner.calls.some((c) => c.cmd === "sudo" && match.every((m) => c.args.includes(m)));
}

describe("autoupdate enable (systemd) — installs the timer + writes settings", () => {
  it("writes both unit files (User= + --dir baked in), daemon-reloads, enables the TIMER, sets the server", async () => {
    const runner = systemdReady();
    const bridgeOps: string[] = [];
    // Capture the unit content handed to `sudo cp` (the FakeRunner doesn't move it).
    const copied = new Map<string, string>();
    const realRun = runner.run.bind(runner);
    runner.run = async (cmd, args, opts) => {
      if (cmd === "sudo" && args[0] === "cp") {
        copied.set(args[2] as string, fs.readFileSync(args[1] as string, "utf8"));
      }
      return realRun(cmd, args, opts);
    };
    withBridge(runner, {
      getConfig: { enabled: true, cadence: "daily", lastRunAt: null },
      bridgeOps,
    });
    setDockerRunner(runner);

    await withTempHome(async (home) => {
      const dir = seedDeployState(home);
      const r = await runCli(["server", "autoupdate", "enable"], { home, platform: "linux" });
      expect(r.exitCode).toBe(0);

      // Both unit files landed at the system paths with the right content (no secret).
      // Spec 074 SC1: the service carries the enabling user + the resolved deploy
      // dir, so the timer fires in the context that owns the deploy — not root's.
      expect(copied.get(SERVICE_PATH)).toContain(`server autoupdate --run --dir ${dir}`);
      expect(copied.get(SERVICE_PATH)).toContain(`User=${os.userInfo().username}`);
      expect(copied.get(TIMER_PATH)).toContain("OnCalendar=hourly");
      for (const content of copied.values()) expect(content).not.toMatch(/token|secret/i);

      // daemon-reload, then enable --now the TIMER (not the oneshot service).
      expect(ranSudo(runner, "systemctl", "daemon-reload")).toBe(true);
      expect(ranSudo(runner, "systemctl", "enable", "--now", AUTOUPDATE_TIMER_NAME)).toBe(true);
      // The oneshot service is NOT separately enabled (the timer fires it).
      expect(ranSudo(runner, "systemctl", "enable", "--now", AUTOUPDATE_SERVICE_NAME)).toBe(false);

      // It wrote enabled+cadence into the running server (the bridge `set`).
      expect(bridgeOps).toContain("set");
      expect(r.stdout).toMatch(/cadence: daily/i);
    });
  });

  it("refuses to install when no deploy-state exists at the resolved dir (spec 074 SC3)", async () => {
    // THE 074 TRAP, caught at enable time: `enable` run in a context whose
    // `~/.librarian/server` holds no deploy-state (wrong user, wrong machine)
    // would install a timer that fails silently every hour. Refuse loudly NOW.
    const runner = systemdReady();
    setDockerRunner(runner);

    await withTempHome(async (home) => {
      const r = await runCli(["server", "autoupdate", "enable"], { home, platform: "linux" });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/No deploy-state found/i);
      expect(r.stderr).toMatch(/as the user who ran/i);
      // NOTHING was installed — no unit copied, no systemctl, no crontab.
      expect(runner.calls.some((c) => c.cmd === "sudo")).toBe(false);
      expect(runner.calls.some((c) => c.cmd === "crontab")).toBe(false);
    });
  });

  it("the refusal names SUDO_USER as the likely right user when run under sudo (spec 074 D2)", async () => {
    const runner = systemdReady();
    setDockerRunner(runner);
    const prev = process.env.SUDO_USER;
    process.env.SUDO_USER = "jane";
    try {
      await withTempHome(async (home) => {
        const r = await runCli(["server", "autoupdate", "enable"], { home, platform: "linux" });
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toMatch(/sudo/i);
        expect(r.stderr).toMatch(/jane/);
      });
    } finally {
      if (prev === undefined) delete process.env.SUDO_USER;
      else process.env.SUDO_USER = prev;
    }
  });

  it("rejects a deploy dir unsafe to interpolate unquoted BEFORE touching the host (spec 074 SC4)", async () => {
    const runner = systemdReady();
    setDockerRunner(runner);

    await withTempHome(async (home) => {
      const bad = path.join(home, "has space", "server");
      const r = await runCli(["server", "autoupdate", "enable", "--dir", bad], {
        home,
        platform: "linux",
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/not safe to schedule|whitespace|metacharacter/i);
      expect(runner.calls.some((c) => c.cmd === "sudo")).toBe(false);
    });
  });

  it("--cadence weekly is written through to the server set", async () => {
    const runner = systemdReady();
    const bridgeOps: string[] = [];
    const setScripts: string[] = [];
    withBridge(runner, {
      getConfig: { enabled: true, cadence: "weekly", lastRunAt: null },
      bridgeOps,
      setScripts,
    });
    setDockerRunner(runner);

    await withTempHome(async (home) => {
      seedDeployState(home);
      const r = await runCli(["server", "autoupdate", "enable", "--cadence", "weekly"], {
        home,
        platform: "linux",
      });
      expect(r.exitCode).toBe(0);
      // The set bridge script carried the weekly cadence in its POST body.
      expect(setScripts.some((s) => s.includes("autoupdate.set") && s.includes("weekly"))).toBe(
        true,
      );
    });
  });

  it("rejects an invalid cadence BEFORE touching the host (no systemctl runs)", async () => {
    const runner = systemdReady();
    setDockerRunner(runner);

    const r = await runCli(["server", "autoupdate", "enable", "--cadence", "hourly"], {
      platform: "linux",
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/cadence must be one of/i);
    // Nothing was installed — a bad cadence is a pre-flight teaching error.
    expect(runner.calls.some((c) => c.cmd === "sudo")).toBe(false);
  });

  it("rejects a librarian path containing a space BEFORE touching the host (FIX I1)", async () => {
    // `which librarian` resolves under an npm prefix in a home dir WITH A SPACE —
    // an unquoted ExecStart / cron line would silently break. enable must reject it.
    const runner = systemdReady();
    runner.which = async (cmd: string) =>
      cmd === "librarian" ? "/home/jane doe/.npm/bin/librarian" : `/usr/bin/${cmd}`;
    setDockerRunner(runner);

    const r = await runCli(["server", "autoupdate", "enable"], { platform: "linux" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/not safe to schedule|whitespace|metacharacter/i);
    // Nothing was installed — the unsafe path is a pre-flight teaching error.
    expect(runner.calls.some((c) => c.cmd === "sudo")).toBe(false);
  });

  it("is idempotent: enable twice targets the SAME unit paths, no duplicate units", async () => {
    const runner = systemdReady();
    const bridgeOps: string[] = [];
    withBridge(runner, {
      getConfig: { enabled: true, cadence: "daily", lastRunAt: null },
      bridgeOps,
    });
    setDockerRunner(runner);

    await withTempHome(async (home) => {
      seedDeployState(home);
      await runCli(["server", "autoupdate", "enable"], { home, platform: "linux" });
      await runCli(["server", "autoupdate", "enable"], { home, platform: "linux" });
    });

    const enables = runner.calls.filter(
      (c) => c.cmd === "sudo" && c.args[0] === "systemctl" && c.args.includes("enable"),
    );
    expect(enables.length).toBe(2);
    for (const e of enables) expect(e.args).toContain(AUTOUPDATE_TIMER_NAME);
    // No alternate unit name was ever created (no `-2.timer` etc).
    expect(runner.calls.some((c) => c.args.some((a) => /-autoupdate-\d|\.timer\.\d/.test(a)))).toBe(
      false,
    );
  });

  it("a down server during enable is a non-fatal hint — the timer is still installed", async () => {
    const runner = systemdReady();
    const bridgeOps: string[] = [];
    withBridge(runner, { getConfig: null, bridgeOps }); // server unreachable
    setDockerRunner(runner);

    await withTempHome(async (home) => {
      seedDeployState(home);
      const r = await runCli(["server", "autoupdate", "enable"], { home, platform: "linux" });
      expect(r.exitCode).toBe(0); // not a failure — the timer is what matters
      expect(ranSudo(runner, "systemctl", "enable", "--now", AUTOUPDATE_TIMER_NAME)).toBe(true);
      expect(r.stdout).toMatch(/could not reach the running server/i);
    });
  });
});

// ── enable (cron fallback) ───────────────────────────────────────────────────

describe("autoupdate enable (cron fallback) — systemd absent", () => {
  it("installs our tagged hourly cron line via `crontab <file>`, idempotently", async () => {
    const runner = new FakeRunner()
      .withWhich("docker")
      .withWhich("crontab")
      .withWhich("librarian")
      .withFallback({ code: 0 })
      // An empty crontab to start (`crontab -l` exits non-zero with "no crontab").
      .onRun("crontab", ["-l"], { code: 1, stderr: "no crontab for user\n" });
    const bridgeOps: string[] = [];
    let installedContent: string | undefined;
    const realRun = runner.run.bind(runner);
    runner.run = async (cmd, args, opts) => {
      // `crontab <file>` (not `-l`) installs the new crontab — capture its content.
      if (cmd === "crontab" && args[0] !== "-l") {
        installedContent = fs.readFileSync(args[0] as string, "utf8");
      }
      return realRun(cmd, args, opts);
    };
    withBridge(runner, {
      getConfig: { enabled: true, cadence: "daily", lastRunAt: null },
      bridgeOps,
    });
    setDockerRunner(runner);

    await withTempHome(async (home) => {
      const dir = seedDeployState(home);
      const r = await runCli(["server", "autoupdate", "enable"], { home, platform: "linux" });
      expect(r.exitCode).toBe(0);
      // Spec 074 SC2: the cron line pins the resolved deploy dir too.
      expect(installedContent).toContain(`server autoupdate --run --dir ${dir}`);
      expect(installedContent).toContain(CRON_MARKER);
      // No systemd path was taken.
      expect(runner.calls.some((c) => c.cmd === "sudo")).toBe(false);
      expect(r.stdout).toMatch(/cron/i);
    });
  });

  it("does not duplicate our cron line when one already exists (idempotent)", async () => {
    const existing = `0 1 * * * /usr/bin/other-job\n17 * * * * /usr/local/bin/librarian server autoupdate --run ${CRON_MARKER}`;
    const runner = new FakeRunner()
      .withWhich("docker")
      .withWhich("crontab")
      .withWhich("librarian")
      .withFallback({ code: 0 })
      .onRun("crontab", ["-l"], { code: 0, stdout: existing });
    const bridgeOps: string[] = [];
    let installedContent: string | undefined;
    const realRun = runner.run.bind(runner);
    runner.run = async (cmd, args, opts) => {
      if (cmd === "crontab" && args[0] !== "-l") {
        installedContent = fs.readFileSync(args[0] as string, "utf8");
      }
      return realRun(cmd, args, opts);
    };
    withBridge(runner, {
      getConfig: { enabled: true, cadence: "daily", lastRunAt: null },
      bridgeOps,
    });
    setDockerRunner(runner);

    await withTempHome(async (home) => {
      seedDeployState(home);
      await runCli(["server", "autoupdate", "enable"], { home, platform: "linux" });
    });
    // Exactly ONE marker line, and the unrelated job is preserved.
    const markerCount = (installedContent?.match(new RegExp(CRON_MARKER, "g")) ?? []).length;
    expect(markerCount).toBe(1);
    expect(installedContent).toContain("/usr/bin/other-job");
  });
});

// ── disable / uninstall ──────────────────────────────────────────────────────

describe("autoupdate disable — flips the setting off, leaves the timer", () => {
  it("sets enabled=false in the running server and installs/removes NO unit", async () => {
    const runner = systemdReady();
    const bridgeOps: string[] = [];
    withBridge(runner, {
      getConfig: { enabled: false, cadence: "daily", lastRunAt: null },
      bridgeOps,
    });
    setDockerRunner(runner);

    const r = await runCli(["server", "autoupdate", "disable"], { platform: "linux" });
    expect(r.exitCode).toBe(0);
    expect(bridgeOps).toContain("set"); // wrote enabled=false
    // No unit was touched (the timer stays installed; the next fire no-ops).
    expect(runner.calls.some((c) => c.cmd === "sudo")).toBe(false);
    expect(r.stdout).toMatch(/disabled/i);
  });

  it("a down server during disable is a teaching error (can't flip a setting we can't reach)", async () => {
    const runner = systemdReady();
    const bridgeOps: string[] = [];
    withBridge(runner, { getConfig: null, bridgeOps });
    setDockerRunner(runner);

    const r = await runCli(["server", "autoupdate", "disable"], { platform: "linux" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/could not reach the running server/i);
  });
});

/** A systemdReady runner whose `sudo cat <unit>` returns OUR generated unit text. */
function systemdReadyWithOurUnits(): FakeRunner {
  return systemdReady()
    .onRun("sudo", ["cat", TIMER_PATH], { code: 0, stdout: generateTimerUnit() })
    .onRun("sudo", ["cat", SERVICE_PATH], {
      code: 0,
      stdout: generateServiceUnit({
        librarianPath: "/usr/local/bin/librarian",
        user: "deploy-owner",
        deployDir: "/home/deploy-owner/.librarian/server",
      }),
    });
}

describe("autoupdate uninstall — removes the timer/cron entirely", () => {
  it("disables --now the timer, removes both unit files (after verifying ours), daemon-reloads", async () => {
    const runner = systemdReadyWithOurUnits();
    setDockerRunner(runner);

    const r = await runCli(["server", "autoupdate", "uninstall"], { platform: "linux" });
    expect(r.exitCode).toBe(0);
    expect(ranSudo(runner, "systemctl", "disable", "--now", AUTOUPDATE_TIMER_NAME)).toBe(true);
    // It read each unit (to confirm ownership) BEFORE removing it.
    expect(
      runner.calls.some(
        (c) => c.cmd === "sudo" && c.args[0] === "cat" && c.args.includes(TIMER_PATH),
      ),
    ).toBe(true);
    expect(
      runner.calls.some(
        (c) => c.cmd === "sudo" && c.args[0] === "rm" && c.args.includes(TIMER_PATH),
      ),
    ).toBe(true);
    expect(
      runner.calls.some(
        (c) => c.cmd === "sudo" && c.args[0] === "rm" && c.args.includes(SERVICE_PATH),
      ),
    ).toBe(true);
    expect(ranSudo(runner, "systemctl", "daemon-reload")).toBe(true);
  });

  it("an already-absent timer is not a crash (tolerates 'not loaded' + a missing unit file)", async () => {
    const runner = systemdReady()
      .onRun("sudo", ["systemctl", "disable", "--now", AUTOUPDATE_TIMER_NAME], {
        code: 1,
        stderr: "Failed to disable unit: Unit the-librarian-autoupdate.timer does not exist.\n",
      })
      // `sudo cat <unit>` of an absent file → non-zero → a clean no-op (nothing removed).
      .onRun("sudo", ["cat", TIMER_PATH], { code: 1, stderr: "No such file or directory\n" })
      .onRun("sudo", ["cat", SERVICE_PATH], { code: 1, stderr: "No such file or directory\n" });
    setDockerRunner(runner);

    const r = await runCli(["server", "autoupdate", "uninstall"], { platform: "linux" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toMatch(/at \w+.*\(/); // no stack trace leaked
    // Nothing was removed (no unit of ours present) and it never `rm`'d blindly.
    expect(runner.calls.some((c) => c.cmd === "sudo" && c.args[0] === "rm")).toBe(false);
  });

  it("leaves a same-named unit that is NOT ours untouched, with a warning (FIX I2)", async () => {
    // A human authored `the-librarian-autoupdate.timer` for something else — it
    // carries NO Librarian marker, so uninstall must NOT delete it.
    const foreignTimer = "[Unit]\nDescription=Someone else's timer\n\n[Timer]\nOnCalendar=daily\n";
    const runner = systemdReady()
      .onRun("sudo", ["cat", TIMER_PATH], { code: 0, stdout: foreignTimer })
      // The service file is genuinely ours (proves we still remove the real one).
      .onRun("sudo", ["cat", SERVICE_PATH], {
        code: 0,
        stdout: generateServiceUnit({
          librarianPath: "/usr/local/bin/librarian",
          user: "deploy-owner",
          deployDir: "/home/deploy-owner/.librarian/server",
        }),
      });
    setDockerRunner(runner);

    const r = await runCli(["server", "autoupdate", "uninstall"], { platform: "linux" });
    expect(r.exitCode).toBe(0);
    // The foreign timer was NOT removed; the warning was surfaced.
    expect(
      runner.calls.some(
        (c) => c.cmd === "sudo" && c.args[0] === "rm" && c.args.includes(TIMER_PATH),
      ),
    ).toBe(false);
    expect(r.stdout).toMatch(/not the Librarian|left it untouched/i);
    // Our genuine service unit WAS removed (verify-before-remove, not remove-nothing).
    expect(
      runner.calls.some(
        (c) => c.cmd === "sudo" && c.args[0] === "rm" && c.args.includes(SERVICE_PATH),
      ),
    ).toBe(true);
  });

  it("cron uninstall strips our tagged line and keeps the rest", async () => {
    const existing = `0 1 * * * /usr/bin/keep-me\n17 * * * * /usr/local/bin/librarian server autoupdate --run ${CRON_MARKER}`;
    const runner = new FakeRunner()
      .withWhich("docker")
      .withWhich("crontab")
      .withFallback({ code: 0 })
      .onRun("crontab", ["-l"], { code: 0, stdout: existing });
    let installedContent: string | undefined;
    const realRun = runner.run.bind(runner);
    runner.run = async (cmd, args, opts) => {
      if (cmd === "crontab" && args[0] !== "-l")
        installedContent = fs.readFileSync(args[0] as string, "utf8");
      return realRun(cmd, args, opts);
    };
    setDockerRunner(runner);

    const r = await runCli(["server", "autoupdate", "uninstall"], { platform: "linux" });
    expect(r.exitCode).toBe(0);
    expect(installedContent).toContain("/usr/bin/keep-me");
    expect(installedContent).not.toContain(CRON_MARKER);
  });
});

// ── status ───────────────────────────────────────────────────────────────────

describe("autoupdate status — timer-installed + server enabled/cadence/last-run + up-to-date", () => {
  it("reports timer installed + the server's config + reuses `server status`", async () => {
    const runner = systemdReady()
      // The timer-installed probe: list-unit-files lists it.
      .onRun("systemctl", ["list-unit-files", AUTOUPDATE_TIMER_NAME], {
        code: 0,
        stdout: `UNIT FILE                          STATE\n${AUTOUPDATE_TIMER_NAME} enabled\n`,
      })
      .onRun("docker", ["info"], { code: 0 })
      // `server status`' container probes.
      .onRun("docker", ["inspect", "--format", "{{.State.Status}}", "the-librarian"], {
        code: 0,
        stdout: "running\n",
      })
      .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", "the-librarian"], {
        code: 0,
        stdout: "healthy\n",
      });
    const bridgeOps: string[] = [];
    withBridge(runner, {
      getConfig: { enabled: true, cadence: "weekly", lastRunAt: "2026-06-15T09:00:00.000Z" },
      bridgeOps,
    });
    setDockerRunner(runner);
    setLatestFetcher(async () => "1.5.0");

    await withTempHome(async (home) => {
      // Seed a deploy-state so `server status` reports a deployed version.
      writeDeployState(path.join(home, ".librarian", "server"), {
        containerName: "the-librarian",
        host: "127.0.0.1",
        dataVolume: "librarian_data",
        ref: "v1.4.0",
        imageTag: "the-librarian:v1.4.0",
      });

      const r = await runCli(["server", "autoupdate", "status"], { home, platform: "linux" });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/Timer installed: yes/i);
      expect(r.stdout).toMatch(/Enabled:\s+yes/i);
      expect(r.stdout).toMatch(/Cadence:\s+weekly/i);
      expect(r.stdout).toMatch(/2026-06-15/);
      // The reused `server status` block (deployed vs latest).
      expect(r.stdout).toMatch(/Deployed:\s+legacy v1\.4\.0/);
      expect(r.stdout).toMatch(/Update:\s+\?/);
    });
  });

  it("a down server degrades the server fields to unknown but still reports the timer state", async () => {
    const runner = systemdReady()
      .onRun("systemctl", ["list-unit-files", AUTOUPDATE_TIMER_NAME], { code: 1, stdout: "" })
      .onRun("docker", ["info"], { code: 0 });
    const bridgeOps: string[] = [];
    withBridge(runner, { getConfig: null, bridgeOps });
    setDockerRunner(runner);
    setLatestFetcher(async () => null);

    const r = await runCli(["server", "autoupdate", "status"], { platform: "linux" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/Timer installed: no/i);
    expect(r.stdout).toMatch(/Enabled:\s+unknown/i);
    expect(r.stdout).toMatch(/not installed/i); // the install hint
  });
});

// ── the `--run` wrapper (the timer's call) — gating + fail-soft ──────────────

/** Seed a deploy-state so the inner `server update` has a deploy dir to read. */
function seedDeployState(home: string, ref = "v1.4.2"): string {
  const dir = path.join(home, ".librarian", "server");
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  writeDeployState(dir, {
    containerName: "the-librarian",
    host: "127.0.0.1",
    dataVolume: "librarian_data",
    ref,
    imageTag: `the-librarian:${ref}`,
  });
  return dir;
}

const AUTOUPDATE_CANDIDATE_ID = "91".repeat(32);
const AUTOUPDATE_IMAGE_ID = `sha256:${"92".repeat(32)}`;
const AUTOUPDATE_DIGEST = `${CANONICAL_IMAGE_NAME}@sha256:${"93".repeat(32)}`;
const AUTOUPDATE_REVISION = "94".repeat(20);
const AUTOUPDATE_STAGED_ID = "autoupdate-test";

function seedExactRegistryDeployment(home: string, ref = "v1.4.2"): string {
  const dir = path.join(home, ".librarian", "server");
  writeDeployState(dir, {
    containerName: "the-librarian",
    host: "127.0.0.1",
    dataVolume: "librarian_data",
    dashboardPort: 3000,
    ref,
    imageTag: `${CANONICAL_IMAGE_NAME}:${ref}`,
    imageSource: "registry",
    imageRef: `${CANONICAL_IMAGE_NAME}:${ref}`,
    imageDigest: AUTOUPDATE_DIGEST,
  });
  writeDeployEnvFile(dir, {
    agentToken: "tok",
    secretKey: "key",
    host: "127.0.0.1",
  });
  return dir;
}

function exactRegistryLive(): string {
  return JSON.stringify({
    Id: "95".repeat(32),
    Image: AUTOUPDATE_IMAGE_ID,
    State: { Status: "running", Health: { Status: "healthy" } },
    Config: {
      Image: AUTOUPDATE_DIGEST,
      User: "node",
      Env: [
        "LIBRARIAN_AGENT_TOKEN=tok",
        "LIBRARIAN_SECRET_KEY=key",
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
        "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "3000" }],
        "3838/tcp": [{ HostIp: "127.0.0.1", HostPort: "3838" }],
      },
    },
    Mounts: [{ Type: "volume", Name: "librarian_data", Destination: "/data" }],
  });
}

/** Script the real stable update path while keeping these wrapper tests offline. */
function configureSuccessfulStableUpdate(home: string, runner: FakeRunner): string[][] {
  const streams: string[][] = [];
  setStreamer({
    stream: async (_cmd, args) => {
      streams.push([...args]);
      return 0;
    },
  });
  setStagedEnvIdMinter(() => AUTOUPDATE_STAGED_ID);
  setReleaseProvenanceResolver(async () => ({
    revision: AUTOUPDATE_REVISION,
    imageDigest: AUTOUPDATE_DIGEST,
  }));
  const dir = path.join(home, ".librarian", "server");
  const stagedEnv = path.join(dir, `deploy.env.next-${AUTOUPDATE_STAGED_ID}`);
  const createArgs = buildCreateArgs({
    host: "127.0.0.1",
    dataVolume: "librarian_data",
    dashboardPort: 3000,
    runAsUser: "node",
    restartPolicy: "unless-stopped",
    imageRef: AUTOUPDATE_DIGEST,
    envFile: stagedEnv,
  });
  createArgs.splice(1, 0, "--cidfile", `${stagedEnv}.cid`);
  const live = JSON.stringify({
    Id: "95".repeat(32),
    Image: AUTOUPDATE_IMAGE_ID,
    State: { Status: "running", Health: { Status: "healthy" } },
    Config: {
      Image: "the-librarian:v1.4.2",
      User: "node",
      Env: [
        "LIBRARIAN_AGENT_TOKEN=tok",
        "LIBRARIAN_SECRET_KEY=key",
        "LIBRARIAN_DATA_DIR=/data",
        "LIBRARIAN_HOST=0.0.0.0",
        "LIBRARIAN_PORT=3838",
        "PORT=3000",
      ],
    },
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
      PortBindings: {
        "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "3000" }],
        "3838/tcp": [{ HostIp: "127.0.0.1", HostPort: "3838" }],
      },
    },
    Mounts: [{ Type: "volume", Name: "librarian_data", Destination: "/data" }],
  });
  runner
    .onRun("docker", ["info", "--format", "{{json .}}"], {
      stdout: JSON.stringify({ OSType: "linux", Architecture: "amd64" }),
    })
    .onRun("docker", ["container", "inspect", "--format", "{{json .}}", "the-librarian"], {
      stdout: live,
    })
    .onRun(
      "docker",
      ["image", "inspect", "--format", "{{json .}}", `${CANONICAL_IMAGE_NAME}:v1.5.0`],
      {
        stdout: JSON.stringify({
          Os: "linux",
          Architecture: "amd64",
          Config: {
            Labels: {
              "org.opencontainers.image.source":
                "https://github.com/code-ministry-ltd/the-librarian",
              "org.opencontainers.image.version": "1.5.0",
              "org.opencontainers.image.revision": AUTOUPDATE_REVISION,
            },
          },
          RepoTags: [`${CANONICAL_IMAGE_NAME}:v1.5.0`],
          RepoDigests: [AUTOUPDATE_DIGEST],
        }),
      },
    )
    .onRun("docker", createArgs, { stdout: `${AUTOUPDATE_CANDIDATE_ID}\n` })
    .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", AUTOUPDATE_CANDIDATE_ID], {
      stdout: "healthy\n",
    });
  const realRun = runner.run.bind(runner);
  runner.run = async (cmd, args, opts) => {
    const result = await realRun(cmd, args, opts);
    if (cmd === "docker" && args[0] === "create" && result.code === 0) {
      const cidfileIndex = args.indexOf("--cidfile");
      if (cidfileIndex >= 0) fs.writeFileSync(args[cidfileIndex + 1]!, `${result.stdout.trim()}\n`);
    }
    return result;
  };
  return streams;
}

describe("autoupdate --run — the gated, fail-soft wrapper the timer fires", () => {
  it("server unreachable → SKIP (never update a server in an unknown state), exit 0", async () => {
    const runner = new FakeRunner().withWhich("docker").withFallback({ code: 0 });
    const bridgeOps: string[] = [];
    withBridge(runner, { getConfig: null, bridgeOps });
    setDockerRunner(runner);
    const logs: string[] = [];

    const result = await runAutoUpdate({ log: (l) => logs.push(l) });
    expect(result.output).toMatch(/unreachable.*skipping/i);
    // It NEVER reached the update flow (no build/run/rm).
    expect(runner.calls.some((c) => c.cmd === "docker" && c.args[0] === "build")).toBe(false);
    expect(logs).toHaveLength(1);
  });

  it("disabled → SKIP, exit 0, no update", async () => {
    const runner = new FakeRunner().withWhich("docker").withFallback({ code: 0 });
    const bridgeOps: string[] = [];
    withBridge(runner, {
      getConfig: { enabled: false, cadence: "daily", lastRunAt: null },
      bridgeOps,
    });
    setDockerRunner(runner);
    const logs: string[] = [];

    const result = await runAutoUpdate({ log: (l) => logs.push(l) });
    expect(result.output).toMatch(/disabled.*skipping/i);
    expect(runner.calls.some((c) => c.cmd === "docker" && c.args[0] === "build")).toBe(false);
  });

  it("enabled but NOT due (cadence not elapsed) → SKIP, exit 0, no update", async () => {
    const runner = new FakeRunner().withWhich("docker").withFallback({ code: 0 });
    const bridgeOps: string[] = [];
    // daily cadence, last run 1h ago → not due.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    withBridge(runner, {
      getConfig: { enabled: true, cadence: "daily", lastRunAt: oneHourAgo },
      bridgeOps,
    });
    setDockerRunner(runner);
    const logs: string[] = [];

    const result = await runAutoUpdate({ log: (l) => logs.push(l), now: new Date() });
    expect(result.output).toMatch(/not due yet.*skipping/i);
    expect(runner.calls.some((c) => c.cmd === "docker" && c.args[0] === "build")).toBe(false);
  });

  it("enabled AND due → invokes `server update`, then stamps last_run_at on success", async () => {
    await withTempHome(async (home) => {
      seedDeployState(home);
      const runner = new FakeRunner()
        .withWhich("docker")
        .onRun("docker", ["info"], { code: 0 })
        .withFallback({ code: 0 });
      const bridgeOps: string[] = [];
      // Enabled + never run → due. (current ref differs from latest so update runs.)
      withBridge(runner, {
        getConfig: { enabled: true, cadence: "daily", lastRunAt: null },
        bridgeOps,
      });
      const streams = configureSuccessfulStableUpdate(home, runner);
      setDockerRunner(runner);
      setLatestFetcher(async () => "1.5.0"); // newer than v1.4.2 → an actual upgrade
      setTokenMinter(() => "fresh-tok");
      setSecretKeyMinter(() => "fresh-key");
      setSleep(async () => undefined);
      const logs: string[] = [];

      const result = await runAutoUpdate({ home, log: (l) => logs.push(l), healthIntervalMs: 0 });

      // The stable update pulled the exact published tag; it did not need Git/build.
      expect(streams).toContainEqual(["pull", `${CANONICAL_IMAGE_NAME}:v1.5.0`]);
      expect(runner.calls.some((call) => call.cmd === "git")).toBe(false);
      expect(runner.calls.some((call) => call.args[0] === "build")).toBe(false);
      expect(runner.calls).toContainEqual(
        expect.objectContaining({
          cmd: "docker",
          args: ["image", "inspect", "--format", "{{json .}}", `${CANONICAL_IMAGE_NAME}:v1.5.0`],
        }),
      );
      expect(readDeployState(path.join(home, ".librarian", "server"))).toMatchObject({
        imageSource: "registry",
        ref: "v1.5.0",
        imageRef: `${CANONICAL_IMAGE_NAME}:v1.5.0`,
        imageDigest: AUTOUPDATE_DIGEST,
      });
      // And the stamp bridge fired AFTER the update succeeded.
      expect(bridgeOps).toContain("stampRun");
      expect(result.output).toMatch(/updated successfully/i);
    });
  });

  it("a due exact healthy target is checked and stamped without claiming an update", async () => {
    await withTempHome(async (home) => {
      seedExactRegistryDeployment(home);
      const runner = new FakeRunner()
        .withWhich("docker")
        .onRun("docker", ["info"], { code: 0 })
        .onRun("docker", ["container", "inspect", "--format", "{{json .}}", "the-librarian"], {
          stdout: exactRegistryLive(),
        })
        .withFallback({ code: 0 });
      const bridgeOps: string[] = [];
      withBridge(runner, {
        getConfig: { enabled: true, cadence: "daily", lastRunAt: null },
        bridgeOps,
      });
      const streams: string[][] = [];
      setStreamer({
        stream: async (_cmd, args) => {
          streams.push([...args]);
          return 0;
        },
      });
      setDockerRunner(runner);
      setLatestFetcher(async () => "1.4.2");

      const result = await runAutoUpdate({ home, log: () => {}, healthIntervalMs: 0 });

      expect(result.output).toMatch(/checked; already up to date/i);
      expect(result.output).not.toMatch(/updated successfully/i);
      expect(bridgeOps).toContain("stampRun");
      expect(streams).toEqual([]);
      expect(runner.calls.some((call) => call.cmd === "git" || call.args[0] === "build")).toBe(
        false,
      );
    });
  });

  it("update FAILS → logs, does NOT stamp last_run_at, exit 0 (retries next fire)", async () => {
    await withTempHome(async (home) => {
      seedDeployState(home);
      const runner = new FakeRunner()
        .withWhich("docker")
        .withWhich("git")
        .onRun("docker", ["info"], { code: 0 })
        // The build fails → the update throws an UpdateError; the wrapper swallows it.
        .onRun(
          "docker",
          ["build", "-f", "docker/all-in-one.Dockerfile", "-t", "the-librarian:v1.5.0", "."],
          { code: 1, stderr: "build blew up" },
        )
        .withFallback({ code: 0 });
      const bridgeOps: string[] = [];
      withBridge(runner, {
        getConfig: { enabled: true, cadence: "daily", lastRunAt: null },
        bridgeOps,
      });
      setDockerRunner(runner);
      setLatestFetcher(async () => "1.5.0");
      setSleep(async () => undefined);
      const logs: string[] = [];

      const result = await runAutoUpdate({ home, log: (l) => logs.push(l), healthIntervalMs: 0 });
      expect(result.output).toMatch(/update did not complete/i);
      expect(result.output).not.toMatch(/previous server running|left the previous/i);
      expect(result.output).toMatch(/inspect.*server status/i);
      // CRUCIAL: a failed update must NOT stamp last_run_at (so it retries).
      expect(bridgeOps).not.toContain("stampRun");
      // It never threw — the wrapper resolved (the timer would exit 0).
      expect(logs.some((l) => /update did not complete/i.test(l))).toBe(true);
    });
  });

  it("a finalization/recovery failure never claims deploy-state integrity", async () => {
    await withTempHome(async (home) => {
      seedDeployState(home);
      const runner = new FakeRunner()
        .withWhich("docker")
        .onRun("docker", ["info"], { code: 0 })
        .withFallback({ code: 0 });
      const bridgeOps: string[] = [];
      withBridge(runner, {
        getConfig: { enabled: true, cadence: "daily", lastRunAt: null },
        bridgeOps,
      });
      configureSuccessfulStableUpdate(home, runner);
      let promotions = 0;
      setFinalizationRenamer((source, destination) => {
        promotions += 1;
        if (promotions === 2) throw new Error("state promotion failed");
        fs.renameSync(source, destination);
      });
      setFinalizationRestorer(() => {
        throw new Error("prior bytes could not be restored");
      });
      setDockerRunner(runner);
      setLatestFetcher(async () => "1.5.0");
      setSleep(async () => undefined);

      const result = await runAutoUpdate({ home, log: () => {}, healthIntervalMs: 0 });

      expect(result.output).toMatch(/update (?:failed|did not complete)/i);
      expect(result.output).toMatch(/restoration.*failed|inconsistent/i);
      expect(result.output).not.toMatch(/deployment state was not advanced/i);
      expect(bridgeOps).not.toContain("stampRun");
    });
  });

  it("a second --run while the update lock is held SKIPS without updating or stamping (FIX C1)", async () => {
    await withTempHome(async (home) => {
      seedDeployState(home);
      // Simulate a concurrent update already running: hold the lock by creating
      // the lockfile with a FRESH timestamp (so it isn't reclaimed as stale).
      const lockPath = updateLockPath({ home });
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, `99999 ${Date.now()}\n`, { flag: "wx" });

      const runner = new FakeRunner()
        .withWhich("docker")
        .withWhich("git")
        .onRun("docker", ["info"], { code: 0 })
        .withFallback({ code: 0 });
      const bridgeOps: string[] = [];
      // Enabled + never run → DUE: the only thing stopping the update is the lock.
      withBridge(runner, {
        getConfig: { enabled: true, cadence: "daily", lastRunAt: null },
        bridgeOps,
      });
      setDockerRunner(runner);
      setLatestFetcher(async () => "1.5.0");
      const logs: string[] = [];

      const result = await runAutoUpdate({ home, log: (l) => logs.push(l), healthIntervalMs: 0 });

      // It skipped on the lock — no build/run/rm, and NO stamp (the holder stamps).
      expect(result.output).toMatch(/another update in progress.*skipping/i);
      expect(runner.calls.some((c) => c.cmd === "docker" && c.args[0] === "build")).toBe(false);
      expect(bridgeOps).not.toContain("stampRun");
      expect(logs).toHaveLength(1);
      // The held lockfile is left intact (the skipping run must not release it).
      expect(fs.existsSync(lockPath)).toBe(true);
    });
  });

  it("a stale lock (older than the reclaim window) is reclaimed so the update proceeds (FIX C1)", async () => {
    await withTempHome(async (home) => {
      seedDeployState(home);
      // A crashed holder left a lockfile ~2h old → stale → reclaimed, update runs.
      const lockPath = updateLockPath({ home });
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      fs.writeFileSync(lockPath, `4242 ${twoHoursAgo}\n`, { flag: "wx" });

      const runner = new FakeRunner()
        .withWhich("docker")
        .onRun("docker", ["info"], { code: 0 })
        .withFallback({ code: 0 });
      const bridgeOps: string[] = [];
      withBridge(runner, {
        getConfig: { enabled: true, cadence: "daily", lastRunAt: null },
        bridgeOps,
      });
      const streams = configureSuccessfulStableUpdate(home, runner);
      setDockerRunner(runner);
      setLatestFetcher(async () => "1.5.0");
      setTokenMinter(() => "fresh-tok");
      setSecretKeyMinter(() => "fresh-key");
      setSleep(async () => undefined);

      const result = await runAutoUpdate({ home, log: () => {}, healthIntervalMs: 0 });

      // The stale lock did NOT block the update.
      expect(streams).toContainEqual(["pull", `${CANONICAL_IMAGE_NAME}:v1.5.0`]);
      expect(result.output).toMatch(/updated successfully/i);
      expect(bridgeOps).toContain("stampRun");
      // The lock was released after the update (so the next fire isn't blocked).
      expect(fs.existsSync(lockPath)).toBe(false);
    });
  });

  it("--run is reachable through the CLI and exits 0 even when the server is down", async () => {
    const runner = new FakeRunner().withWhich("docker").withFallback({ code: 0 });
    const bridgeOps: string[] = [];
    withBridge(runner, { getConfig: null, bridgeOps });
    setDockerRunner(runner);

    const r = await runCli(["server", "autoupdate", "--run"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/unreachable.*skipping/i);
  });

  it("a pre-074 timer's wrong-context failure teaches upgrading + re-running enable (spec 074 SC6)", async () => {
    await withTempHome(async (home) => {
      // NO deploy-state seeded — the exact wrong-home failure a root-run pre-074
      // timer hits every fire (confirmed live on the VPS, 26/07/2026). The line
      // must carry the migration path, since anyone seeing it has the broken unit.
      const runner = new FakeRunner()
        .withWhich("docker")
        .withWhich("git")
        .onRun("docker", ["info"], { code: 0 })
        .withFallback({ code: 0 });
      const bridgeOps: string[] = [];
      withBridge(runner, {
        getConfig: { enabled: true, cadence: "daily", lastRunAt: null },
        bridgeOps,
      });
      setDockerRunner(runner);
      const logs: string[] = [];

      const result = await runAutoUpdate({ home, log: (l) => logs.push(l) });
      expect(result.output).toMatch(/update did not complete/i);
      expect(result.output).toMatch(/re-run `librarian server autoupdate enable`/);
      expect(bridgeOps).not.toContain("stampRun");
      expect(logs).toHaveLength(1);
    });
  });

  it("the outcome reaches the journal ONCE: default sink silent, stdout carries the line (spec 074 SC8)", async () => {
    // Before 074 the wrapper's default sink wrote the line to stderr AND the
    // runtime printed the returned output to stdout — systemd sends both streams
    // to the same journal, so every outcome appeared twice.
    const runner = new FakeRunner().withWhich("docker").withFallback({ code: 0 });
    withBridge(runner, { getConfig: null, bridgeOps: [] });
    setDockerRunner(runner);
    const stderrWrites: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown): boolean => {
      stderrWrites.push(String(chunk));
      return true;
    }) as unknown as typeof process.stderr.write);
    try {
      const r = await runCli(["server", "autoupdate", "--run"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/unreachable.*skipping/i);
      expect(stderrWrites.filter((w) => w.includes("autoupdate:"))).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("weekly cadence: 3 days since last run is NOT due (skips)", async () => {
    const runner = new FakeRunner().withWhich("docker").withFallback({ code: 0 });
    const bridgeOps: string[] = [];
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    withBridge(runner, {
      getConfig: { enabled: true, cadence: "weekly", lastRunAt: threeDaysAgo },
      bridgeOps,
    });
    setDockerRunner(runner);

    const result = await runAutoUpdate({ now: new Date() });
    expect(result.output).toMatch(/not due yet/i);
  });
});
