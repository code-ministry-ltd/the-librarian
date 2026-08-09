// Healthcheck script integration tests.
//
// Ported from test/healthcheck.test.js (node:test) to Vitest as part
// of T5.2's "flip pnpm test to Vitest exclusively" cleanup.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "./helpers.js";

interface HealthcheckRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runHealthcheck(
  extraArgs: string[] = [],
  envOverrides: Record<string, string | undefined> = {},
): Promise<HealthcheckRun> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = { ...process.env, NO_COLOR: "1" } as Record<string, string>;
    for (const [key, value] of Object.entries(envOverrides)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    const child = spawn(
      process.execPath,
      ["--no-warnings", "scripts/healthcheck.js", ...extraArgs],
      {
        cwd: path.resolve("."),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ) as ChildProcessWithoutNullStreams;
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("healthcheck script", () => {
  // The full local healthcheck (JSONL + index-rebuild + MCP-stdio + HTTP-MCP +
  // tool-surface) is expensive — it spawns servers internally. Three tests used
  // to run it independently, paying that cost 3x and tripping the per-test 5s
  // timeout under load (the flake). Run it ONCE here and assert against the
  // captured output. Likewise, one shared HTTP server backs both `--remote` tests.
  let local: HealthcheckRun;
  let server: Awaited<ReturnType<typeof startHttpServer>>;
  let serverDataDir: string;

  beforeAll(async () => {
    local = await runHealthcheck();
    serverDataDir = makeTempDir();
    server = await startHttpServer({
      dataDir: serverDataDir,
      token: "remote-admin",
      agentToken: "remote-agent",
    });
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    if (serverDataDir) cleanupTempDir(serverDataDir);
  });

  it("exits 0 on a clean system", () => {
    expect(
      local.code,
      `healthcheck failed:\nstdout:\n${local.stdout}\nstderr:\n${local.stderr}`,
    ).toBe(0);
  });

  it("output names each documented check", () => {
    const text = local.stdout + local.stderr;
    for (const probe of [
      /Vault durability/i,
      /Index rebuild/i,
      /MCP stdio/i,
      /MCP tool surface/i,
      /HTTP MCP/i,
    ]) {
      expect(text).toMatch(probe);
    }
    expect(text).toMatch(/PASS/);
  });

  it("MCP tool surface check passes when the registry matches the current contract", () => {
    const text = local.stdout + local.stderr;
    expect(text).toMatch(/PASS\s{2}MCP tool surface/);
    expect(text).not.toMatch(/FAIL\s{2}MCP tool surface/);
  });

  it("isolates its local admin listener from an occupied configured port", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const address = blocker.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected the blocker to bind a TCP port");
    }

    try {
      const result = await runHealthcheck([], {
        LIBRARIAN_TRPC_PORT: String(address.port),
      });
      expect(
        result.code,
        `healthcheck reused an occupied admin port:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }, 60_000);

  it("--help describes its purpose without running checks", async () => {
    const result = await runHealthcheck(["--help"]);
    expect(result.code).toBe(0);
    const text = result.stdout + result.stderr;
    expect(text).toMatch(/healthcheck/i);
    expect(text).toMatch(/usage/i);
  });

  it("--remote probes /healthz + /mcp against an existing server", async () => {
    const result = await runHealthcheck(["--remote", server.url, "--agent-token", "remote-agent"]);
    const text = result.stdout + result.stderr;
    expect(
      result.code,
      `--remote healthcheck failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(0);
    expect(text).toMatch(/mode: remote/);
    expect(text).toMatch(/Remote HTTP reachability \+ auth/);
    expect(text).toMatch(/PASS/);
    expect(text).not.toMatch(/JSONL append/);
  });

  it("--remote fails fast without a bearer token", async () => {
    const result = await runHealthcheck(["--remote", server.url], {
      LIBRARIAN_HEALTHCHECK_AGENT_TOKEN: undefined,
      LIBRARIAN_AGENT_TOKEN: undefined,
      LIBRARIAN_ADMIN_TOKEN: undefined,
    });
    const text = result.stdout + result.stderr;
    expect(result.code).toBe(1);
    expect(text).toMatch(/No bearer token available/);
  });
});
