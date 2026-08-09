// S5 — `librarian server update`: re-pin forward, rebuild, recreate, migrate.
//
// Every test drives the public `runCli(["server", "update", …])` entry against
// a fresh temp home, the injected `docker.ts` FakeRunner (so the EXACT git/docker
// argv + ITS ORDER is asserted), a stubbed latest-release fetcher, a no-op
// health-poll sleep, and a deterministic agent-token minter. No real daemon,
// network, or git is ever touched.
//
// The load-bearing properties (success criterion 5 + spec §8/§11):
//   - upgrade sequence: git fetch tags → checkout newest → docker build →
//     stop → rm (container, NOT volume) → docker run (same host/volume) →
//     health poll → `docker exec … migrate-data-dir`;
//   - idempotent no-op: already at the resolved ref + healthy → no build/run/rm;
//   - VOLUME SACRED: no `docker volume rm`, no `docker rm -v`, ever;
//   - rollback: a failed health-wait force-removes the new container, errors,
//     and does NOT advance deploy-state; surfaced logs are redacted;
//   - agent-token: read back from the OLD container's env before removal and
//     reused on recreate (clients keep working); never written to a file/log.
//   - master-key (ADR 0008 P4): read back from the OLD container's env (it now
//     rides there via `--env-file`) and reused on recreate — re-minting it would
//     orphan every settings.json secret encrypted under it. When the old env is
//     unreadable, the key is OMITTED from the new env-file so the server resolves
//     it from /data/secret.key (env -> file -> generate) — never a destructive
//     fresh mint. The key + token ride only in the 0600 deploy env-file.

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetRunner } from "../src/exec.js";
import { runCli } from "../src/runtime.js";
import { readDeployState, writeDeployState } from "../src/server/deploy-state.js";
import {
  resetRunner as resetDockerRunner,
  setRunner as setDockerRunner,
} from "../src/server/docker.js";
import {
  deployEnvFilePath,
  resetSecretKeyMinter,
  resetSleep,
  resetTokenMinter,
  setSecretKeyMinter,
  setSleep,
  setTokenMinter,
  writeDeployEnvFile,
} from "../src/server/up.js";
import { resetLatestFetcher, setLatestFetcher } from "../src/status.js";
import { FakeRunner, withTempHome } from "./helpers.js";

const OLD_REF = "v1.4.2";
const LATEST = "1.5.0"; // fetchLatestVersion returns the v-stripped version
const LATEST_TAG = "v1.5.0";
const EXISTING_AGENT_TOKEN = "agent-token-already-running-in-the-old-container";
const FRESH_AGENT_TOKEN = "fresh-agent-token-minted-on-update";
const EXISTING_MASTER_KEY = "master-key-already-running-in-the-old-container";
const EXISTING_BOOTSTRAP_CLAIM_SECRET = "existing-bootstrap-claim-secret-".repeat(2);
// If the CLI ever (wrongly) minted a fresh master key on update, this is what it
// would be — tests assert it NEVER appears (re-minting orphans encrypted secrets).
const FRESH_MASTER_KEY = "fresh-master-key-that-must-never-be-minted-on-update";

afterEach(() => {
  resetRunner();
  resetDockerRunner();
  resetLatestFetcher();
  resetSleep();
  resetTokenMinter();
  resetSecretKeyMinter();
});

/** The deploy env-file path under a temp home's default deploy dir. */
function deployEnvOf(home: string): string {
  return deployEnvFilePath(path.join(home, ".librarian", "server"));
}

/** The deploy dir under a temp home. */
function deployDirOf(home: string): string {
  return path.join(home, ".librarian", "server");
}

/** Seed a deploy-state recording the (old) deployed ref + a managed clone. */
function seedDeployState(home: string, ref = OLD_REF): string {
  const dir = deployDirOf(home);
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

/** The argv (after `docker`) of the `run -d …` call recorded by the runner. */
function dockerRunArgs(runner: FakeRunner): string[] | undefined {
  return runner.calls.find((c) => c.cmd === "docker" && c.args[0] === "run")?.args;
}

/**
 * The ordered list of `<cmd> <verb>` for git/docker calls. For docker the verb
 * is `args[0]`; for git the verb is the first arg that isn't the `-C <dir>`
 * prefix (so `git -C <dir> fetch …` reads as `git fetch`).
 */
function verbSequence(runner: FakeRunner): string[] {
  return runner.calls
    .filter((c) => c.cmd === "docker" || c.cmd === "git")
    .map((c) => {
      if (c.cmd === "git" && c.args[0] === "-C") return `git ${c.args[2]}`;
      return `${c.cmd} ${c.args[0]}`;
    });
}

/** True iff the runner ever issued a volume-destroying op (rm -v / volume rm). */
function ranVolumeDestructive(runner: FakeRunner): boolean {
  return runner.calls.some(
    (c) =>
      c.cmd === "docker" &&
      ((c.args[0] === "rm" && c.args.includes("-v")) ||
        (c.args[0] === "volume" && c.args.includes("rm"))),
  );
}

/**
 * A FakeRunner wired for a successful UPGRADE: docker + git on PATH, daemon up,
 * the OLD container reports its agent token via `docker inspect` env, and the
 * NEW container becomes healthy.
 */
function upgradeRunner(): FakeRunner {
  return (
    new FakeRunner()
      .withWhich("docker")
      .withWhich("git")
      .onRun("docker", ["info"], { code: 0 })
      // Read the existing agent token + master key from the running container's
      // env (ADR 0008 P4 puts the master key there via `--env-file`).
      .onRun(
        "docker",
        ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", "the-librarian"],
        {
          stdout:
            `PATH=/usr/bin\nLIBRARIAN_AGENT_TOKEN=${EXISTING_AGENT_TOKEN}\n` +
            `LIBRARIAN_SECRET_KEY=${EXISTING_MASTER_KEY}\nNODE_ENV=production\n`,
          code: 0,
        },
      )
      // The container is running (idempotency probe) ...
      .onRun("docker", ["inspect", "--format", "{{.State.Status}}", "the-librarian"], {
        stdout: "running\n",
        code: 0,
      })
      // ... and (re)created healthy.
      .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", "the-librarian"], {
        stdout: "healthy\n",
        code: 0,
      })
  );
}

/** Install the deterministic seams the update tests share. */
function stubSeams(): void {
  setLatestFetcher(async () => LATEST);
  setTokenMinter(() => FRESH_AGENT_TOKEN);
  // The master-key minter is wired so a test can PROVE update never calls it
  // (re-minting orphans encrypted secrets). FRESH_MASTER_KEY must never surface.
  setSecretKeyMinter(() => FRESH_MASTER_KEY);
  setSleep(async () => undefined);
}

describe("server update — upgrade path argv sequence (SC 5)", () => {
  it("fetch tags → checkout newest → build → stop → rm → run → health → migrate, in order", async () => {
    await withTempHome(async (home) => {
      const dir = seedDeployState(home);
      const runner = upgradeRunner();
      setDockerRunner(runner);
      stubSeams();

      const r = await runCli(["server", "update"], { home });
      expect(r.exitCode).toBe(0);

      // Each step, with its exact argv.
      expect(runner.ran("git", ["-C", dir, "fetch", "--tags", "origin"])).toBe(true);
      // The ref is resolved on `rev-parse --end-of-options` (the injection guard
      // `git checkout` does NOT honor, S-1); the resolved SHA is then checked out.
      expect(
        runner.ran("git", [
          "-C",
          dir,
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${LATEST_TAG}^{commit}`,
        ]),
      ).toBe(true);
      expect(
        runner.ran("docker", [
          "build",
          "-f",
          "docker/all-in-one.Dockerfile",
          "-t",
          `the-librarian:${LATEST_TAG}`,
          ".",
        ]),
      ).toBe(true);
      expect(runner.ran("docker", ["stop", "the-librarian"])).toBe(true);
      // Container removed — NOT the volume (no `-v`).
      expect(runner.ran("docker", ["rm", "the-librarian"])).toBe(true);
      // Recreated with the SAME host + volume from deploy-state.
      const runArgs = dockerRunArgs(runner);
      expect(runArgs).toContain("127.0.0.1:3838:3838");
      // Legacy state (no dashboardPort) recreates on the historical :3000.
      expect(runArgs).toContain("127.0.0.1:3000:3000");
      expect(runArgs).toContain("librarian_data:/data");
      expect(runArgs?.[runArgs.length - 1]).toBe(`the-librarian:${LATEST_TAG}`);
      // Migrations applied AFTER the new container is healthy.
      expect(
        runner.ran("docker", ["exec", "the-librarian", "the-librarian", "migrate-data-dir"]),
      ).toBe(true);

      // The relative ORDER of the load-bearing steps.
      const seq = verbSequence(runner);
      const idx = (needle: string): number => seq.indexOf(needle);
      expect(idx("git fetch")).toBeGreaterThanOrEqual(0);
      expect(idx("git fetch")).toBeLessThan(idx("git checkout"));
      expect(idx("git checkout")).toBeLessThan(idx("docker build"));
      expect(idx("docker build")).toBeLessThan(idx("docker stop"));
      expect(idx("docker stop")).toBeLessThan(idx("docker rm"));
      expect(idx("docker rm")).toBeLessThan(idx("docker run"));
      // The migrate exec is the last docker verb of the flow.
      expect(idx("docker run")).toBeLessThan(idx("docker exec"));

      // deploy-state advanced to the new ref (host/volume unchanged). The legacy
      // seed had no dashboardPort, so the update BACKFILLS it to the historical
      // 3000 — an existing server keeps its port (no silent jump to 3042).
      expect(readDeployState(dir)).toEqual({
        containerName: "the-librarian",
        host: "127.0.0.1",
        dataVolume: "librarian_data",
        dashboardPort: 3000,
        ref: LATEST_TAG,
        imageTag: `the-librarian:${LATEST_TAG}`,
        imageSource: "source",
        imageRef: `the-librarian:${LATEST_TAG}`,
      });
    });
  });

  it("reuses a persisted custom dashboard port across the update (survives autoupdate)", async () => {
    await withTempHome(async (home) => {
      const dir = deployDirOf(home);
      fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
      // An operator who ran `up --dashboard-port 3500` — the port is in deploy-state.
      writeDeployState(dir, {
        containerName: "the-librarian",
        host: "127.0.0.1",
        dataVolume: "librarian_data",
        dashboardPort: 3500,
        ref: OLD_REF,
        imageTag: `the-librarian:${OLD_REF}`,
      });
      const runner = upgradeRunner();
      setDockerRunner(runner);
      stubSeams();

      const r = await runCli(["server", "update"], { home });
      expect(r.exitCode).toBe(0);

      // Recreated on the SAME published port — not the fresh-install default.
      const runArgs = dockerRunArgs(runner) ?? [];
      expect(runArgs).toContain("127.0.0.1:3500:3000");
      expect(runArgs).not.toContain("127.0.0.1:3042:3000");
      // ...and carried forward in deploy-state for the next update.
      expect(readDeployState(dir)?.dashboardPort).toBe(3500);
    });
  });

  it("reuses the existing agent token via the env-file (clients keep working); never on argv", async () => {
    await withTempHome(async (home) => {
      seedDeployState(home);
      const runner = upgradeRunner();
      setDockerRunner(runner);
      stubSeams();

      const r = await runCli(["server", "update"], { home });
      expect(r.exitCode).toBe(0);

      // ADR 0008 P4: the recreate delivers secrets via `--env-file`, NOT inline -e.
      const runArgs = dockerRunArgs(runner) ?? [];
      expect(runArgs).toContain("--env-file");
      expect(runArgs).not.toContain("-e");
      expect(runArgs.some((a) => a.includes(EXISTING_AGENT_TOKEN))).toBe(false);

      // The env-file carries the EXISTING token (reused), not a freshly minted one.
      const envBody = fs.readFileSync(deployEnvOf(home), "utf8");
      expect(envBody).toContain(`LIBRARIAN_AGENT_TOKEN=${EXISTING_AGENT_TOKEN}`);
      expect(envBody).not.toContain(FRESH_AGENT_TOKEN);

      // The token was inspected from the old container BEFORE it was removed.
      const inspectIdx = runner.calls.findIndex(
        (c) =>
          c.cmd === "docker" &&
          c.args[0] === "inspect" &&
          c.args.includes("{{range .Config.Env}}{{println .}}{{end}}"),
      );
      const rmIdx = runner.calls.findIndex((c) => c.cmd === "docker" && c.args[0] === "rm");
      expect(inspectIdx).toBeGreaterThanOrEqual(0);
      expect(rmIdx).toBeGreaterThan(inspectIdx);

      // The token NEVER appears in the surfaced output, and lands in NO file other
      // than the 0600 deploy env-file.
      expect(r.stdout).not.toContain(EXISTING_AGENT_TOKEN);
      expect(filesContaining(home, EXISTING_AGENT_TOKEN)).toEqual([deployEnvOf(home)]);
    });
  });

  it("PRESERVES the existing master key on recreate — never re-mints it (would orphan encrypted secrets)", async () => {
    await withTempHome(async (home) => {
      seedDeployState(home);
      const runner = upgradeRunner();
      setDockerRunner(runner);
      stubSeams();

      const r = await runCli(["server", "update"], { home });
      expect(r.exitCode).toBe(0);

      // The env-file carries the EXISTING master key read back from the old
      // container's env — NOT a freshly minted one (re-minting orphans every
      // settings.json secret encrypted under the old key).
      const envBody = fs.readFileSync(deployEnvOf(home), "utf8");
      expect(envBody).toContain(`LIBRARIAN_SECRET_KEY=${EXISTING_MASTER_KEY}`);
      expect(envBody).not.toContain(FRESH_MASTER_KEY);

      // The master key is off argv, off stdout, and in NO file but the env-file.
      const runArgs = dockerRunArgs(runner) ?? [];
      expect(runArgs.some((a) => a.includes(EXISTING_MASTER_KEY))).toBe(false);
      expect(r.stdout).not.toContain(EXISTING_MASTER_KEY);
      expect(r.stdout).not.toContain(FRESH_MASTER_KEY);
      expect(filesContaining(home, EXISTING_MASTER_KEY)).toEqual([deployEnvOf(home)]);
      expect(filesContaining(home, FRESH_MASTER_KEY)).toEqual([]);
    });
  });

  it("preserves an armed bootstrap claim secret across container recreation", async () => {
    await withTempHome(async (home) => {
      seedDeployState(home);
      const runner = upgradeRunner().onRun(
        "docker",
        ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", "the-librarian"],
        {
          stdout:
            `LIBRARIAN_AGENT_TOKEN=${EXISTING_AGENT_TOKEN}\n` +
            `LIBRARIAN_SECRET_KEY=${EXISTING_MASTER_KEY}\n` +
            `LIBRARIAN_BOOTSTRAP_CLAIM_SECRET=${EXISTING_BOOTSTRAP_CLAIM_SECRET}\n`,
          code: 0,
        },
      );
      setDockerRunner(runner);
      stubSeams();

      const r = await runCli(["server", "update"], { home });

      expect(r.exitCode).toBe(0);
      expect(fs.readFileSync(deployEnvOf(home), "utf8")).toContain(
        `LIBRARIAN_BOOTSTRAP_CLAIM_SECRET=${EXISTING_BOOTSTRAP_CLAIM_SECRET}`,
      );
      expect(
        dockerRunArgs(runner)?.some((arg) => arg.includes(EXISTING_BOOTSTRAP_CLAIM_SECRET)),
      ).toBe(false);
      expect(r.stdout).not.toContain(EXISTING_BOOTSTRAP_CLAIM_SECRET);
      expect(r.stderr).not.toContain(EXISTING_BOOTSTRAP_CLAIM_SECRET);
    });
  });

  it("preserves the protected deploy-file claim secret when the old container is unreadable", async () => {
    await withTempHome(async (home) => {
      const deployDir = seedDeployState(home);
      writeDeployEnvFile(deployDir, {
        agentToken: EXISTING_AGENT_TOKEN,
        secretKey: EXISTING_MASTER_KEY,
        bootstrapClaimSecret: EXISTING_BOOTSTRAP_CLAIM_SECRET,
        host: "127.0.0.1",
      });
      const runner = upgradeRunner().onRun(
        "docker",
        ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", "the-librarian"],
        { stderr: "No such container", code: 1 },
      );
      setDockerRunner(runner);
      stubSeams();

      const r = await runCli(["server", "update"], { home });

      expect(r.exitCode).toBe(0);
      expect(fs.readFileSync(deployEnvOf(home), "utf8")).toContain(
        `LIBRARIAN_BOOTSTRAP_CLAIM_SECRET=${EXISTING_BOOTSTRAP_CLAIM_SECRET}`,
      );
    });
  });

  it("OMITS LIBRARIAN_SECRET_KEY when the old env has no key (let the server resolve /data/secret.key — never re-mint)", async () => {
    await withTempHome(async (home) => {
      seedDeployState(home);
      // A PRE-P4 container: its env carries the agent token but NO master key
      // (the key lived on /data/secret.key). The update must NOT mint a fresh
      // key — it must omit LIBRARIAN_SECRET_KEY so the server resolves the key
      // from the data volume (env -> file -> generate), preserving secrets.
      const runner = upgradeRunner().onRun(
        "docker",
        ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", "the-librarian"],
        { stdout: `PATH=/usr/bin\nLIBRARIAN_AGENT_TOKEN=${EXISTING_AGENT_TOKEN}\n`, code: 0 },
      );
      setDockerRunner(runner);
      stubSeams();

      const r = await runCli(["server", "update"], { home });
      expect(r.exitCode).toBe(0);

      const envBody = fs.readFileSync(deployEnvOf(home), "utf8");
      // The token is preserved; the key is OMITTED (no env line at all) and a
      // fresh key is NEVER minted.
      expect(envBody).toContain(`LIBRARIAN_AGENT_TOKEN=${EXISTING_AGENT_TOKEN}`);
      expect(envBody).not.toContain("LIBRARIAN_SECRET_KEY=");
      expect(envBody).not.toContain(FRESH_MASTER_KEY);
      expect(filesContaining(home, FRESH_MASTER_KEY)).toEqual([]);
    });
  });
});

describe("server update — reuses a bind-mounted data dir (run as its owner)", () => {
  it("recreates with the host data dir at /data and --user <owner> from deploy-state", async () => {
    await withTempHome(async (home) => {
      const dir = deployDirOf(home);
      fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
      const dataDir = path.join(home, "vault");
      fs.mkdirSync(dataDir, { recursive: true });
      // A deploy that chose a host data dir (rather than the named volume).
      writeDeployState(dir, {
        containerName: "the-librarian",
        host: "127.0.0.1",
        dataVolume: "librarian_data",
        dataDir,
        ref: OLD_REF,
        imageTag: `the-librarian:${OLD_REF}`,
      });
      const runner = upgradeRunner();
      setDockerRunner(runner);
      stubSeams();

      const r = await runCli(["server", "update"], { home });
      expect(r.exitCode).toBe(0);

      const runArgs = dockerRunArgs(runner) ?? [];
      // Reuse the SAME bind-mount — never silently fall back to the named volume.
      expect(runArgs).toContain(`${dataDir}:/data`);
      expect(runArgs).not.toContain("librarian_data:/data");
      // Recreate runs as the directory's owner so the vault stays operator-writable.
      const owner = `${process.getuid?.()}:${process.getgid?.()}`;
      const u = runArgs.indexOf("--user");
      expect(u).toBeGreaterThan(-1);
      expect(runArgs[u + 1]).toBe(owner);
      // The data dir survives in deploy-state across the update.
      expect(readDeployState(dir)?.dataDir).toBe(dataDir);
      // The data is sacred either way — no volume-destructive op ran.
      expect(ranVolumeDestructive(runner)).toBe(false);
    });
  });
});

describe("server update — --ref reflected in checkout + build tag", () => {
  it("--ref main checks out + builds main", async () => {
    await withTempHome(async (home) => {
      const dir = seedDeployState(home);
      const runner = upgradeRunner();
      setDockerRunner(runner);
      stubSeams();

      const r = await runCli(["server", "update", "--ref", "main"], { home });
      expect(r.exitCode).toBe(0);

      expect(
        runner.ran("git", [
          "-C",
          dir,
          "rev-parse",
          "--verify",
          "--end-of-options",
          "main^{commit}",
        ]),
      ).toBe(true);
      expect(
        runner.ran("docker", [
          "build",
          "-f",
          "docker/all-in-one.Dockerfile",
          "-t",
          "the-librarian:main",
          ".",
        ]),
      ).toBe(true);
      const runArgs = dockerRunArgs(runner);
      expect(runArgs?.[runArgs.length - 1]).toBe("the-librarian:main");
      expect(readDeployState(dir)).toMatchObject({
        ref: "main",
        imageTag: "the-librarian:main",
        imageSource: "source",
        imageRef: "the-librarian:main",
      });
    });
  });

  it("preserves explicit source provenance while advancing the local image ref", async () => {
    await withTempHome(async (home) => {
      const dir = seedDeployState(home);
      writeDeployState(dir, {
        containerName: "the-librarian",
        host: "127.0.0.1",
        dataVolume: "librarian_data",
        ref: OLD_REF,
        imageTag: `the-librarian:${OLD_REF}`,
        imageSource: "source",
        imageRef: `the-librarian:${OLD_REF}`,
      });
      const runner = upgradeRunner();
      setDockerRunner(runner);
      stubSeams();

      const r = await runCli(["server", "update"], { home });
      expect(r.exitCode).toBe(0);
      expect(readDeployState(dir)).toMatchObject({
        ref: LATEST_TAG,
        imageTag: `the-librarian:${LATEST_TAG}`,
        imageSource: "source",
        imageRef: `the-librarian:${LATEST_TAG}`,
      });
    });
  });
});

describe("server update — idempotent no-op (SC 5)", () => {
  it("already at latest + healthy → prints up-to-date, NO build/run/rm", async () => {
    await withTempHome(async (home) => {
      // deploy-state ref EQUALS the resolved latest.
      seedDeployState(home, LATEST_TAG);
      const runner = upgradeRunner();
      setDockerRunner(runner);
      stubSeams();

      const r = await runCli(["server", "update"], { home });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/already up to date/i);
      expect(r.stdout).toContain(LATEST_TAG);

      // The hallmark of a clean no-op: NO build, NO run, NO rm, NO stop, NO checkout.
      expect(runner.calls.some((c) => c.cmd === "docker" && c.args[0] === "build")).toBe(false);
      expect(runner.calls.some((c) => c.cmd === "docker" && c.args[0] === "run")).toBe(false);
      expect(runner.calls.some((c) => c.cmd === "docker" && c.args[0] === "rm")).toBe(false);
      expect(runner.calls.some((c) => c.cmd === "docker" && c.args[0] === "stop")).toBe(false);
      expect(runner.calls.some((c) => c.cmd === "git" && c.args.includes("checkout"))).toBe(false);
    });
  });

  it("--ref pinned to the current ref + healthy → no-op", async () => {
    await withTempHome(async (home) => {
      seedDeployState(home, OLD_REF);
      const runner = upgradeRunner();
      setDockerRunner(runner);
      stubSeams();

      // Pin --ref to exactly what's deployed; even though latest is newer, the
      // pinned compare wins → no-op.
      const r = await runCli(["server", "update", "--ref", OLD_REF], { home });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/already up to date/i);
      expect(runner.calls.some((c) => c.cmd === "docker" && c.args[0] === "build")).toBe(false);
      expect(runner.calls.some((c) => c.cmd === "docker" && c.args[0] === "run")).toBe(false);
    });
  });

  it("at the ref but NOT healthy → recreates (not a no-op)", async () => {
    await withTempHome(async (home) => {
      seedDeployState(home, LATEST_TAG);
      // The container is at the ref but reports `exited` (not healthy) → recreate.
      const runner = upgradeRunner().onRun(
        "docker",
        ["inspect", "--format", "{{.State.Status}}", "the-librarian"],
        { stdout: "exited\n", code: 0 },
      );
      setDockerRunner(runner);
      stubSeams();

      const r = await runCli(["server", "update"], { home });
      expect(r.exitCode).toBe(0);
      // It DID rebuild + recreate because the container wasn't healthy.
      expect(runner.calls.some((c) => c.cmd === "docker" && c.args[0] === "build")).toBe(true);
      expect(runner.calls.some((c) => c.cmd === "docker" && c.args[0] === "run")).toBe(true);
    });
  });
});

describe("server update — VOLUME SACRED across the whole flow (SC 5/6)", () => {
  it("an upgrade never issues `docker volume rm` nor `docker rm -v`", async () => {
    await withTempHome(async (home) => {
      seedDeployState(home);
      const runner = upgradeRunner();
      setDockerRunner(runner);
      stubSeams();

      const r = await runCli(["server", "update"], { home });
      expect(r.exitCode).toBe(0);
      expect(ranVolumeDestructive(runner)).toBe(false);
      // The `rm` that DID run is the container only — no `-v`.
      const rmCall = runner.calls.find((c) => c.cmd === "docker" && c.args[0] === "rm");
      expect(rmCall?.args).toEqual(["rm", "the-librarian"]);
    });
  });
});

describe("server update — rollback on a failed health-wait (SC 5)", () => {
  it("new container goes unhealthy → force-removed, errors, deploy-state NOT advanced, logs redacted", async () => {
    await withTempHome(async (home) => {
      const dir = seedDeployState(home);
      // Assembled from sub-threshold parts so no realistic secret literal is committed.
      const fakeAdminLine =
        "Generated a new admin token (LIBRARIAN_ADMIN_TOKEN): " + "libadmin_" + "FAKETOKENVALUE";
      const fakeAdminToken = "libadmin_" + "FAKETOKENVALUE";

      const runner = new FakeRunner()
        .withWhich("docker")
        .withWhich("git")
        .onRun("docker", ["info"], { code: 0 })
        .onRun(
          "docker",
          ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", "the-librarian"],
          { stdout: `LIBRARIAN_AGENT_TOKEN=${EXISTING_AGENT_TOKEN}\n`, code: 0 },
        )
        // The recreated container never becomes healthy.
        .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", "the-librarian"], {
          stdout: "unhealthy\n",
          code: 0,
        })
        // Boot logs carry the one-time admin-token generation line.
        .onRun("docker", ["logs", "--tail", "50", "the-librarian"], {
          stdout: `boot: starting up\n${fakeAdminLine}\nboot: health probe failed\n`,
          code: 0,
        });
      setDockerRunner(runner);
      stubSeams();

      const r = await runCli(["server", "update"], { home });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/did not become healthy|rolled back/i);

      // Rolled back — the new container was force-removed.
      expect(runner.ran("docker", ["rm", "-f", "the-librarian"])).toBe(true);

      // The surfaced error must NOT carry the boot-logged token nor the gen line.
      expect(r.stderr).not.toContain(fakeAdminToken);
      expect(r.stderr).not.toMatch(/Generated a new admin token/i);
      // ...but the (redacted) tail is still surfaced for debugging.
      expect(r.stderr).toMatch(/boot: starting up/);

      // deploy-state was NOT advanced — still the old ref.
      expect(readDeployState(dir)?.ref).toBe(OLD_REF);

      // The agent token never leaked into the error, and lands in NO file other
      // than the 0600 deploy env-file (written before the recreate; it persists
      // through the rollback — the next `update` overwrites it).
      expect(r.stderr).not.toContain(EXISTING_AGENT_TOKEN);
      expect(filesContaining(home, EXISTING_AGENT_TOKEN)).toEqual([deployEnvOf(home)]);
      // The deploy env-file is still 0600 even on the failed path.
      expect(fs.statSync(deployEnvOf(home)).mode & 0o777).toBe(0o600);
    });
  });
});

describe("server update — fresh token when the old container is unreadable", () => {
  it("old container gone (inspect env fails) → mints a fresh token, surfaces it once with a re-paste note", async () => {
    await withTempHome(async (home) => {
      seedDeployState(home);
      const runner = new FakeRunner()
        .withWhich("docker")
        .withWhich("git")
        .onRun("docker", ["info"], { code: 0 })
        // Env inspect fails — the old container is gone/unreadable.
        .onRun(
          "docker",
          ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", "the-librarian"],
          { stderr: "Error: No such object: the-librarian\n", code: 1 },
        )
        .onRun("docker", ["inspect", "--format", "{{.State.Health.Status}}", "the-librarian"], {
          stdout: "healthy\n",
          code: 0,
        });
      setDockerRunner(runner);
      stubSeams();

      const r = await runCli(["server", "update"], { home });
      expect(r.exitCode).toBe(0);

      // A fresh AGENT token was minted and delivered via the env-file (clients
      // re-paste). Secrets ride in the env-file, NOT inline -e.
      const runArgs = dockerRunArgs(runner) ?? [];
      expect(runArgs).toContain("--env-file");
      expect(runArgs).not.toContain("-e");
      const envBody = fs.readFileSync(deployEnvOf(home), "utf8");
      expect(envBody).toContain(`LIBRARIAN_AGENT_TOKEN=${FRESH_AGENT_TOKEN}`);

      // The MASTER KEY is OMITTED (the old env was unreadable) — NEVER re-minted.
      // The server resolves it from /data/secret.key, preserving encrypted secrets.
      expect(envBody).not.toContain("LIBRARIAN_SECRET_KEY=");
      expect(envBody).not.toContain(FRESH_MASTER_KEY);
      expect(filesContaining(home, FRESH_MASTER_KEY)).toEqual([]);

      // The fresh agent token is surfaced exactly once, with a clients-must-update
      // note, and never written to any file but the 0600 deploy env-file.
      expect(r.stdout).toContain(FRESH_AGENT_TOKEN);
      expect(r.stdout.split(FRESH_AGENT_TOKEN).length - 1).toBe(1);
      expect(r.stdout).toMatch(/clients|update.*token|re-?paste/i);
      expect(filesContaining(home, FRESH_AGENT_TOKEN)).toEqual([deployEnvOf(home)]);
    });
  });
});

describe("server update — preflight + no-deploy-state teach", () => {
  it("docker absent → teaching error, no git/docker ops", async () => {
    await withTempHome(async (home) => {
      seedDeployState(home);
      const runner = new FakeRunner(); // nothing on PATH
      setDockerRunner(runner);
      stubSeams();

      const r = await runCli(["server", "update"], { home });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/docker/i);
      expect(r.stderr).toMatch(/install/i);
    });
  });

  it("no deploy-state → teaching error pointing at `server up`", async () => {
    await withTempHome(async (home) => {
      // No deploy-state seeded.
      const runner = upgradeRunner();
      setDockerRunner(runner);
      stubSeams();

      const r = await runCli(["server", "update"], { home });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/server up|no.*deploy|not.*deployed|deploy-state/i);
      // It never tried to build/run without knowing the config.
      expect(runner.calls.some((c) => c.cmd === "docker" && c.args[0] === "build")).toBe(false);
    });
  });
});

describe("server update — the exclusive update lock (spec 074 SC5)", () => {
  it("a manual update while another update holds the lock is refused, disturbing nothing", async () => {
    // Before 074 only the TIMER wrapper took the lock — a manual `server update`
    // could interleave stop/rm/run with a timer fire, leaving a window with NO
    // running container. The lock now lives in runUpdate: one acquisition point
    // covers every caller.
    await withTempHome(async (home) => {
      const dir = seedDeployState(home);
      const lockPath = path.join(dir, ".autoupdate.lock");
      // A concurrent update (e.g. a timer fire mid-build) holds a FRESH lock.
      fs.writeFileSync(lockPath, `4242 ${Date.now()}\n`, { flag: "wx" });

      const runner = upgradeRunner().withFallback({ code: 0 });
      setDockerRunner(runner);
      stubSeams();

      const r = await runCli(["server", "update"], { home });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/another update is already in progress/i);
      // The in-flight update was not disturbed: no build, no stop/rm/run.
      expect(runner.calls.some((c) => c.cmd === "docker" && c.args[0] === "build")).toBe(false);
      expect(runner.calls.some((c) => c.cmd === "docker" && c.args[0] === "rm")).toBe(false);
      // The holder's lock is left intact — only the acquirer ever releases.
      expect(fs.existsSync(lockPath)).toBe(true);
    });
  });

  it("the lock is released after a SUCCESSFUL update (the next update isn't blocked)", async () => {
    await withTempHome(async (home) => {
      const dir = seedDeployState(home);
      const runner = upgradeRunner().withFallback({ code: 0 });
      setDockerRunner(runner);
      stubSeams();

      const r = await runCli(["server", "update"], { home });
      expect(r.exitCode).toBe(0);
      expect(fs.existsSync(path.join(dir, ".autoupdate.lock"))).toBe(false);
    });
  });

  it("the lock is released after a FAILED update too (a failure never wedges the next fire)", async () => {
    await withTempHome(async (home) => {
      const dir = seedDeployState(home);
      const runner = upgradeRunner()
        .onRun(
          "docker",
          ["build", "-f", "docker/all-in-one.Dockerfile", "-t", `the-librarian:${LATEST_TAG}`, "."],
          { code: 1, stderr: "build blew up" },
        )
        .withFallback({ code: 0 });
      setDockerRunner(runner);
      stubSeams();

      const r = await runCli(["server", "update"], { home });
      expect(r.exitCode).toBe(1);
      expect(fs.existsSync(path.join(dir, ".autoupdate.lock"))).toBe(false);
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
