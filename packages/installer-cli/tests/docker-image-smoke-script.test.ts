import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { smokeDockerImage } from "../../../scripts/smoke-docker-image.mjs";

interface Call {
  command: string;
  args: string[];
}

describe("Docker image smoke script", () => {
  it("waits for both endpoints and removes the container after success", async () => {
    const calls: Call[] = [];
    let probes = 0;
    const output: string[] = [];

    await smokeDockerImage({
      imageRef: "librarian-all-in-one:test",
      containerName: "librarian-smoke-test",
      attempts: 3,
      intervalMs: 0,
      sleep: async () => undefined,
      log: (line: string) => output.push(line),
      run: async (command: string, args: string[]) => {
        calls.push({ command, args });
        if (args[0] === "exec") {
          probes += 1;
          return { code: probes === 2 ? 0 : 1, stdout: "", stderr: "starting" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    expect(probes).toBe(2);
    expect(calls.at(0)?.args.slice(0, 4)).toEqual(["run", "-d", "--name", "librarian-smoke-test"]);
    expect(calls.at(0)?.args).toContain("--env-file");
    expect(calls.at(0)?.args.join(" ")).not.toContain("LIBRARIAN_AGENT_TOKEN=");
    expect(calls.some((call) => call.args[0] === "logs")).toBe(false);
    expect(calls.at(-1)?.args).toEqual(["rm", "-f", "librarian-smoke-test"]);
    expect(output).toContain("both endpoints healthy");
  });

  it("redacts container logs, removes the failed container and deletes its env file", async () => {
    const calls: Call[] = [];
    let envFile = "";
    let agentToken = "";

    const result = smokeDockerImage({
      imageRef: "librarian-all-in-one:broken",
      containerName: "librarian-smoke-broken",
      attempts: 1,
      intervalMs: 0,
      sleep: async () => undefined,
      log: () => undefined,
      run: async (command: string, args: string[]) => {
        calls.push({ command, args });
        if (args[0] === "run") {
          envFile = args[args.indexOf("--env-file") + 1] ?? "";
          const env = fs.readFileSync(envFile, "utf8");
          agentToken = env.match(/^LIBRARIAN_AGENT_TOKEN=(.+)$/m)?.[1] ?? "";
          return { code: 0, stdout: "container-id", stderr: "" };
        }
        if (args[0] === "exec") return { code: 1, stdout: "", stderr: "not ready" };
        if (args[0] === "logs") {
          return { code: 0, stdout: `boot failed with ${agentToken}`, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    await expect(result).rejects.toThrow("boot failed with [REDACTED]");
    await expect(result).rejects.not.toThrow(agentToken);
    expect(calls.at(-1)?.args).toEqual(["rm", "-f", "librarian-smoke-broken"]);
    expect(fs.existsSync(envFile)).toBe(false);
  });

  it("reports docker run failure and still performs best-effort cleanup", async () => {
    const calls: Call[] = [];

    await expect(
      smokeDockerImage({
        imageRef: "librarian-all-in-one:missing",
        containerName: "librarian-smoke-missing",
        run: async (command: string, args: string[]) => {
          calls.push({ command, args });
          if (args[0] === "run") {
            return { code: 125, stdout: "", stderr: "unable to find image" };
          }
          return { code: 1, stdout: "", stderr: "no such container" };
        },
      }),
    ).rejects.toThrow("docker run failed (exit 125):\nunable to find image");

    expect(calls.map((call) => call.args[0])).toEqual(["run", "rm"]);
  });

  it("rejects an unsafe container name before invoking Docker", async () => {
    const calls: Call[] = [];

    await expect(
      smokeDockerImage({
        imageRef: "librarian-all-in-one:test",
        containerName: "smoke; docker rm",
        run: async (command: string, args: string[]) => {
          calls.push({ command, args });
          return { code: 0, stdout: "", stderr: "" };
        },
      }),
    ).rejects.toThrow("containerName contains unsupported characters");

    expect(calls).toEqual([]);
  });
});
