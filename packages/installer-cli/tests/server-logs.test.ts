// S4 — `librarian server logs [-f] [--service mcp|dashboard|all]`.
//
// `logs` maps to `docker logs [-f] the-librarian`. The all-in-one image runs
// BOTH services (mcp-server + dashboard) in ONE container under a supervisor
// that uses `stdio: "inherit"` — so it emits NO per-service prefix. The
// mcp-server logs structured pino NDJSON (each line a JSON object carrying
// `"service":"the-librarian"`); the dashboard (Next.js standalone) logs plain
// text. `--service mcp` keeps the NDJSON lines; `--service dashboard` keeps the
// rest; `all` (default) is unfiltered. `-f` follows.

import { afterEach, describe, expect, it } from "vitest";
import { resetRunner } from "../src/exec.js";
import { runCli } from "../src/runtime.js";
import {
  resetRunner as resetDockerRunner,
  resetStreamer as resetDockerStreamer,
  setRunner as setDockerRunner,
  setStreamer as setDockerStreamer,
} from "../src/server/docker.js";
import { runLogs } from "../src/server/logs.js";
import { FakeRunner, FakeStreamer, withTempHome } from "./helpers.js";

afterEach(() => {
  resetRunner();
  resetDockerRunner();
  resetDockerStreamer();
});

// A combined log stream: two mcp-server NDJSON lines + two dashboard text lines.
const MCP_LINE_A = '{"level":30,"time":1,"service":"the-librarian","msg":"http listening on 3838"}';
const MCP_LINE_B = '{"level":40,"time":2,"service":"the-librarian","msg":"recall hit"}';
const DASH_LINE_A = "  ▲ Next.js 14.2.0";
const DASH_LINE_B = "  - Local:   http://0.0.0.0:3000";
const COMBINED = [MCP_LINE_A, DASH_LINE_A, MCP_LINE_B, DASH_LINE_B].join("\n") + "\n";

/** docker present + daemon reachable, with a scripted `docker logs` output. */
function dockerReady(logsArgs: string[]): FakeRunner {
  return new FakeRunner()
    .withWhich("docker")
    .onRun("docker", ["info"], { code: 0 })
    .onRun("docker", logsArgs, { stdout: COMBINED, code: 0 });
}

/** docker present + daemon reachable, WITHOUT scripting `docker logs` (follow streams). */
function dockerReadyForFollow(): FakeRunner {
  return new FakeRunner().withWhich("docker").onRun("docker", ["info"], { code: 0 });
}

/** The argv (after `docker`) of the recorded `logs` call. */
function logsArgs(runner: FakeRunner): string[] | undefined {
  return runner.calls.find((c) => c.cmd === "docker" && c.args[0] === "logs")?.args;
}

/** The argv (after `docker`) of the recorded streaming `logs` call. */
function streamLogsArgs(streamer: FakeStreamer): string[] | undefined {
  return streamer.calls.find((c) => c.cmd === "docker" && c.args[0] === "logs")?.args;
}

describe("server logs — default/all is unfiltered", () => {
  it("`logs` maps to `docker logs the-librarian` and prints every line", async () => {
    await withTempHome(async (home) => {
      const runner = dockerReady(["logs", "the-librarian"]);
      setDockerRunner(runner);

      const r = await runCli(["server", "logs"], { home });
      expect(r.exitCode).toBe(0);
      expect(logsArgs(runner)).toEqual(["logs", "the-librarian"]);
      // Unfiltered — both services' lines present.
      expect(r.stdout).toContain("http listening on 3838");
      expect(r.stdout).toContain("Next.js");
    });
  });

  it("`--service all` is explicit-but-unfiltered (no -f)", async () => {
    await withTempHome(async (home) => {
      const runner = dockerReady(["logs", "the-librarian"]);
      setDockerRunner(runner);

      const r = await runCli(["server", "logs", "--service", "all"], { home });
      expect(r.exitCode).toBe(0);
      expect(logsArgs(runner)).toEqual(["logs", "the-librarian"]);
      expect(r.stdout).toContain("http listening on 3838");
      expect(r.stdout).toContain("Next.js");
    });
  });
});

describe("server logs — -f STREAMS live (never buffers to close)", () => {
  it("`-f` uses the streaming seam — `docker logs -f the-librarian`, NOT the buffering run()", async () => {
    const runner = dockerReadyForFollow();
    setDockerRunner(runner);
    const streamer = new FakeStreamer().withStdout(COMBINED).withExit(0);
    setDockerStreamer(streamer);

    const lines: string[] = [];
    const code = await runLogs({ follow: true, write: (s) => lines.push(s) });

    // The streaming seam carried the follow — NOT the capturing run().
    expect(streamLogsArgs(streamer)).toEqual(["logs", "-f", "the-librarian"]);
    expect(runner.ran("docker", ["logs", "-f", "the-librarian"])).toBe(false);
    // Resolves with the followed process's exit code.
    expect(code.exitCode).toBe(0);
    // Every line reached the sink (live).
    expect(lines.join("")).toContain("http listening on 3838");
    expect(lines.join("")).toContain("Next.js");
  });

  it("lines reach the terminal AS THEY ARRIVE, in order (not end-buffered)", async () => {
    const runner = dockerReadyForFollow();
    setDockerRunner(runner);
    // Three separate chunks, emitted one at a time by the streamer.
    const streamer = new FakeStreamer()
      .withStdout("line one\n", "line two\n", "line three\n")
      .withExit(0);
    setDockerStreamer(streamer);

    const writes: string[] = [];
    await runLogs({ follow: true, service: "dashboard", write: (s) => writes.push(s) });

    // Each line was written separately, in arrival order — not concatenated once.
    const joined = writes.join("");
    expect(joined.indexOf("line one")).toBeLessThan(joined.indexOf("line two"));
    expect(joined.indexOf("line two")).toBeLessThan(joined.indexOf("line three"));
  });

  it("`-f` via the CLI streams to the terminal and exits cleanly", async () => {
    await withTempHome(async (home) => {
      const runner = dockerReadyForFollow();
      setDockerRunner(runner);
      const streamer = new FakeStreamer().withStdout(COMBINED).withExit(0);
      setDockerStreamer(streamer);

      const r = await runCli(["server", "logs", "-f"], { home });
      expect(r.exitCode).toBe(0);
      expect(streamLogsArgs(streamer)).toEqual(["logs", "-f", "the-librarian"]);
      // The CLI did NOT route the follow through the capturing run().
      expect(runner.ran("docker", ["logs", "-f", "the-librarian"])).toBe(false);
    });
  });

  it("`--follow` is the long form of `-f` (also streams)", async () => {
    await withTempHome(async (home) => {
      const runner = dockerReadyForFollow();
      setDockerRunner(runner);
      const streamer = new FakeStreamer().withStdout(COMBINED).withExit(0);
      setDockerStreamer(streamer);

      const r = await runCli(["server", "logs", "--follow"], { home });
      expect(r.exitCode).toBe(0);
      expect(streamLogsArgs(streamer)).toEqual(["logs", "-f", "the-librarian"]);
    });
  });
});

describe("server logs — --service filters the combined stream", () => {
  it("`-f --service mcp` STREAMS and keeps only the mcp-server (NDJSON) lines, live", async () => {
    const runner = dockerReadyForFollow();
    setDockerRunner(runner);
    // Emit the four lines one at a time, interleaved, as a follow would.
    const streamer = new FakeStreamer()
      .withStdout(MCP_LINE_A + "\n", DASH_LINE_A + "\n", MCP_LINE_B + "\n", DASH_LINE_B + "\n")
      .withExit(0);
    setDockerStreamer(streamer);

    const writes: string[] = [];
    const code = await runLogs({ follow: true, service: "mcp", write: (s) => writes.push(s) });

    // Streaming seam carried the follow.
    expect(streamLogsArgs(streamer)).toEqual(["logs", "-f", "the-librarian"]);
    expect(code.exitCode).toBe(0);
    const joined = writes.join("");
    // The mcp (NDJSON) lines are kept, in order...
    expect(joined).toContain("http listening on 3838");
    expect(joined).toContain("recall hit");
    expect(joined.indexOf("http listening on 3838")).toBeLessThan(joined.indexOf("recall hit"));
    // ...and the dashboard (plain-text) lines are filtered OUT.
    expect(joined).not.toContain("Next.js");
    expect(joined).not.toContain("Local:");
    // Filtered line-by-line: each kept mcp line was a SEPARATE write (not one blob).
    const mcpWrites = writes.filter((w) => w.includes("the-librarian"));
    expect(mcpWrites.length).toBe(2);
  });

  it("`--service dashboard` keeps only the dashboard (non-NDJSON) lines", async () => {
    await withTempHome(async (home) => {
      const runner = dockerReady(["logs", "the-librarian"]);
      setDockerRunner(runner);

      const r = await runCli(["server", "logs", "--service", "dashboard"], { home });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Next.js");
      expect(r.stdout).toContain("Local:");
      // The mcp NDJSON lines are filtered out.
      expect(r.stdout).not.toContain("http listening on 3838");
      expect(r.stdout).not.toContain("recall hit");
    });
  });

  it("an unknown --service value teaches the valid choices (no crash)", async () => {
    await withTempHome(async (home) => {
      const runner = dockerReady(["logs", "the-librarian"]);
      setDockerRunner(runner);

      const r = await runCli(["server", "logs", "--service", "frobnicate"], { home });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/mcp/);
      expect(r.stderr).toMatch(/dashboard/);
      expect(r.stderr).toMatch(/all/);
    });
  });
});

describe("server logs — preflight teaches when docker is missing", () => {
  it("docker absent → teaching error", async () => {
    await withTempHome(async (home) => {
      setDockerRunner(new FakeRunner()); // nothing on PATH
      const r = await runCli(["server", "logs"], { home });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/docker/i);
      expect(r.stderr).toMatch(/install/i);
    });
  });
});
