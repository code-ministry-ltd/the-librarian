// Guards the test-count guard's own diagnostics.
//
// The bug this prevents: \`check-test-count.mjs\` runs the whole suite a second
// time with \`--reporter=json\`, capturing the report on stdout. When vitest
// exited non-zero it discarded that stdout and reported only the exit code, so
// CI printed \`pnpm -r exec vitest run --reporter=json exited with code 1;
// aborting guard\` and nothing else — no test name, no file, no message. A gate
// that can fail without saying why is unusable: you cannot tell a flaky timeout
// from a real regression, so the only move left is to re-run and hope. The
// failing tests were sitting in the captured JSON the whole time.
//
// See scripts/check-test-count.mjs.

import { describe, expect, it } from "vitest";
import {
  collectFailedTests,
  countWorkspaceVitestTests,
  countVitestTests,
  formatRunFailure,
} from "../scripts/check-test-count.mjs";

/** One workspace's \`--reporter=json\` document, as vitest emits it. */
function report(
  testFile: string,
  assertions: Array<{ name: string; status: string; message?: string }>,
): string {
  return JSON.stringify({
    numTotalTests: assertions.length,
    numFailedTests: assertions.filter((a) => a.status === "failed").length,
    testResults: [
      {
        name: testFile,
        status: assertions.some((a) => a.status === "failed") ? "failed" : "passed",
        assertionResults: assertions.map((a) => ({
          ancestorTitles: [],
          title: a.name,
          fullName: a.name,
          status: a.status,
          failureMessages: a.message ? [a.message] : [],
        })),
      },
    ],
  });
}

describe("collectFailedTests", () => {
  it("names the failing test, its file, and the first line of its message", () => {
    const stdout = report("/repo/packages/mcp-server/tests/trpc/vault.test.ts", [
      {
        name: "tRPC vault > edits land as git commits",
        status: "failed",
        message: "Error: Timed out waiting for http://0.0.0.0:37463/healthz\n    at waitForHttp",
      },
    ]);

    const failures = collectFailedTests(stdout);

    expect(failures).toHaveLength(1);
    expect(failures[0].name).toBe("tRPC vault > edits land as git commits");
    expect(failures[0].file).toBe("/repo/packages/mcp-server/tests/trpc/vault.test.ts");
    // The first line only — a full stack per failure buries the list in CI.
    expect(failures[0].message).toBe("Error: Timed out waiting for http://0.0.0.0:37463/healthz");
  });

  it("collects failures across every workspace's report, not just the first", () => {
    // \`pnpm -r exec\` runs vitest per workspace, so stdout carries several
    // complete JSON documents back to back. Parsing only the first (or calling
    // JSON.parse on the whole stream) loses every later workspace's failures.
    const stdout = [
      report("/repo/packages/core/tests/a.test.ts", [{ name: "a passes", status: "passed" }]),
      report("/repo/packages/mcp-server/tests/b.test.ts", [
        { name: "b fails", status: "failed", message: "AssertionError: expected 1 to be 2" },
      ]),
      report("/repo/apps/dashboard/tests/c.test.tsx", [
        { name: "c fails", status: "failed", message: "Error: boom" },
      ]),
    ].join("\n");

    const failures = collectFailedTests(stdout);

    expect(failures.map((f) => f.name)).toEqual(["b fails", "c fails"]);
  });

  it("ignores the pnpm prefixes and log noise interleaved with the reports", () => {
    // Real stdout is not pure JSON: pnpm prefixes lines, and tests themselves
    // print. Anything unparseable must be skipped rather than crash the guard —
    // a diagnostics helper that throws would replace one silent failure with another.
    const stdout = [
      "packages/core test:vitest: Building 4 posts…",
      report("/repo/packages/core/tests/a.test.ts", [
        { name: "a fails", status: "failed", message: "Error: nope" },
      ]),
      "{ not valid json at all",
      "Done.",
    ].join("\n");

    expect(collectFailedTests(stdout).map((f) => f.name)).toEqual(["a fails"]);
  });

  it("resynchronizes when malformed log noise precedes a valid report", () => {
    const valid = report("/repo/packages/core/tests/a.test.ts", [
      { name: "a fails", status: "failed", message: "Error: nope" },
    ]);

    expect(collectFailedTests(`log { not closed\n${valid}`).map((f) => f.name)).toEqual([
      "a fails",
    ]);
    expect(
      collectFailedTests(`log with an unmatched quote: "\n${valid}`).map((f) => f.name),
    ).toEqual(["a fails"]);
    expect(collectFailedTests(`log { not closed\n${valid}\nlog }`).map((f) => f.name)).toEqual([
      "a fails",
    ]);
  });

  it("returns nothing when the run failed with no failing test (a crash or config error)", () => {
    // vitest can exit non-zero without any assertion failing — a config error or
    // a worker crash. The guard must still report *something* rather than
    // claiming a test failed, so an empty list here is the correct answer and
    // formatRunFailure below is what covers the message.
    const stdout = report("/repo/packages/core/tests/a.test.ts", [
      { name: "a passes", status: "passed" },
    ]);

    expect(collectFailedTests(stdout)).toEqual([]);
    expect(collectFailedTests("")).toEqual([]);
  });
});

describe("formatRunFailure", () => {
  it("lists every failing test under the command and exit code", () => {
    const message = formatRunFailure(["pnpm", "-r", "exec", "vitest", "run"], 1, [
      {
        file: "/repo/packages/mcp-server/tests/trpc/vault.test.ts",
        name: "tRPC vault > edits land as git commits",
        message: "Error: Timed out waiting for /healthz",
      },
    ]);

    expect(message).toContain("exited with code 1");
    expect(message).toContain("1 failing test");
    expect(message).toContain("tRPC vault > edits land as git commits");
    expect(message).toContain("packages/mcp-server/tests/trpc/vault.test.ts");
    expect(message).toContain("Error: Timed out waiting for /healthz");
  });

  it("says so explicitly when the runner failed without naming a test", () => {
    // The old behaviour for EVERY failure. Keeping an honest message for the
    // genuinely-unattributable case is the point: never imply we know more than we do.
    const message = formatRunFailure(["pnpm", "exec", "vitest", "run"], 2, []);

    expect(message).toContain("exited with code 2");
    expect(message).toMatch(/no failing test|could not/i);
  });
});

describe("countVitestTests", () => {
  it("finishes workspace suites before starting the live-server root suite", async () => {
    const events: string[] = [];
    let releaseWorkspace!: () => void;
    const workspaceDone = new Promise<void>((resolve) => {
      releaseWorkspace = resolve;
    });

    const totalPromise = countVitestTests(
      async () => {
        events.push("workspace:start");
        await workspaceDone;
        events.push("workspace:end");
        return 12;
      },
      async () => {
        events.push("root:start");
        return 3;
      },
    );

    await Promise.resolve();
    expect(events).toEqual(["workspace:start"]);

    releaseWorkspace();
    await expect(totalPromise).resolves.toBe(15);
    expect(events).toEqual(["workspace:start", "workspace:end", "root:start"]);
  });

  it("runs workspace suites one package at a time", async () => {
    let command: string[] = [];

    await countWorkspaceVitestTests(async (args: string[]) => {
      command = args;
      return 7;
    });

    expect(command).toEqual([
      "pnpm",
      "-r",
      "--workspace-concurrency=1",
      "exec",
      "vitest",
      "run",
      "--reporter=json",
    ]);
  });
});
