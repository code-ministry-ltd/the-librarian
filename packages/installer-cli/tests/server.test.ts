import { afterEach, describe, expect, it } from "vitest";
import { resetRunner } from "../src/exec.js";
import { runCli } from "../src/runtime.js";
import {
  resetRunner as resetDockerRunner,
  setRunner as setDockerRunner,
} from "../src/server/docker.js";
import { dockerPreflight, PreflightError, sourcePreflight } from "../src/server/preflight.js";
import { FakeRunner } from "./helpers.js";

afterEach(() => {
  resetRunner();
  resetDockerRunner();
});

describe("librarian --help — both command groups", () => {
  it("reveals BOTH a harness command (install) and the server group", async () => {
    const r = await runCli(["--help"]);
    expect(r.exitCode).toBe(0);
    // A harness command from the original surface…
    expect(r.stdout).toMatch(/\binstall\b/);
    // …and the new server group.
    expect(r.stdout).toMatch(/\bserver\b/);
  });
});

describe("librarian server (no subcommand) — the command surface", () => {
  it("prints the server command surface (spec §4)", async () => {
    const r = await runCli(["server"]);
    expect(r.exitCode).toBe(0);
    // Every subcommand from the surface table appears.
    for (const sub of [
      "up",
      "update",
      "down",
      "status",
      "logs",
      "enable-boot",
      "disable-boot",
      "admin",
    ]) {
      expect(r.stdout).toContain(sub);
    }
    expect(r.stdout).toMatch(/pull.*exact release/i);
    expect(r.stdout).toMatch(/source.*build/i);
    expect(r.stdout).not.toContain("Self-host the Librarian server (build + run");
    expect(r.stdout).not.toContain("Re-pin to a release, rebuild");
  });

  it("--help on the group also prints the surface", async () => {
    const r = await runCli(["server", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("up");
    expect(r.stdout).toContain("admin");
  });

  it("an unknown subcommand errors and shows the surface", async () => {
    const r = await runCli(["server", "frobnicate"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Unknown server subcommand/);
    expect(r.stderr).toContain("up");
  });
});

describe("server Docker preflight — teaching errors via the injected runner", () => {
  it("docker missing: names docker and how to install it (never a stack trace)", async () => {
    setDockerRunner(new FakeRunner()); // nothing on PATH
    await expect(dockerPreflight()).rejects.toBeInstanceOf(PreflightError);
    const message = await dockerPreflight().catch((e: Error) => e.message);
    expect(message).toMatch(/docker/i);
    expect(message).toMatch(/install/i);
    // Actionable, not a bare "invalid"/"error".
    expect(message).not.toMatch(/^(invalid|error)$/i);
    expect(message).not.toMatch(/PreflightError/);
  });

  it("docker present but daemon unreachable: teaches that the daemon is down", async () => {
    setDockerRunner(
      new FakeRunner()
        .withWhich("docker")
        .withWhich("git")
        .onRun("docker", ["info"], { code: 1, stderr: "Cannot connect to the Docker daemon" }),
    );
    const message = await dockerPreflight({ platform: "linux" }).catch((e: Error) => e.message);
    expect(message).toMatch(/daemon/i);
    expect(message).toMatch(/running/i);
    // Linux hint does NOT mention Docker Desktop.
    expect(message).not.toMatch(/Docker Desktop/);
  });

  it("on macOS the daemon-unreachable message mentions Docker Desktop", async () => {
    setDockerRunner(
      new FakeRunner().withWhich("docker").withWhich("git").onRun("docker", ["info"], { code: 1 }),
    );
    const message = await dockerPreflight({ platform: "darwin" }).catch((e: Error) => e.message);
    expect(message).toMatch(/Docker Desktop/);
  });

  it("docker present and daemon reachable resolves without requiring git", async () => {
    setDockerRunner(
      new FakeRunner()
        .withWhich("docker") // docker present, daemon ok (info exits 0 by default)
        .onRun("docker", ["info"], { code: 0 }),
      // git deliberately NOT marked present
    );
    await expect(dockerPreflight({ platform: "linux" })).resolves.toBeUndefined();
  });

  it("never invokes a real binary — every probe goes through the injected runner", async () => {
    const runner = new FakeRunner().withWhich("docker");
    setDockerRunner(runner);
    await dockerPreflight({ platform: "linux" });
    // The only `run` recorded is the daemon probe; `which` is recorded too.
    expect(runner.calls).toContainEqual(expect.objectContaining({ cmd: "docker", args: ["info"] }));
  });
});

describe("server source preflight — Docker plus Git", () => {
  it("git missing (docker fine): names git and how to install it", async () => {
    setDockerRunner(new FakeRunner().withWhich("docker").onRun("docker", ["info"], { code: 0 }));
    const message = await sourcePreflight({ platform: "linux" }).catch((e: Error) => e.message);
    expect(message).toMatch(/git/i);
    expect(message).toMatch(/install/i);
  });

  it("all source tools present + daemon reachable: resolves (no throw)", async () => {
    setDockerRunner(
      new FakeRunner().withWhich("docker").withWhich("git").onRun("docker", ["info"], { code: 0 }),
    );
    await expect(sourcePreflight({ platform: "linux" })).resolves.toBeUndefined();
  });
});
