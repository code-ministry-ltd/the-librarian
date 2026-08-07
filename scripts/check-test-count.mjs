#!/usr/bin/env node
// Test-count floor guard.
//
// Counts every Vitest test discovered across the workspace (via
// `pnpm -r exec vitest run --reporter=json` for the packages plus a
// root `vitest run --reporter=json` for `test/**/*.test.ts`). Adds
// the count from any remaining `*.test.js` files under test/ or
// packages/*/tests/ via `node --test` so the migration to Vitest is
// coverage-neutral. Fails if the combined total drops below
// test/baseline.json's `count`.
//
// Rationale: a silent test deletion is the easiest way to lose coverage
// during a multi-phase migration. The baseline is updated deliberately,
// in a PR, with an explanation in the description. Counting both runners
// means converting node:test → Vitest is coverage-neutral and does not
// trip the guard.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const baselinePath = path.join(repoRoot, "test", "baseline.json");

async function main() {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const floor = Number(baseline.count);
  if (!Number.isFinite(floor) || floor < 0) {
    console.error(`[check-test-count] invalid baseline.count in ${baselinePath}`);
    process.exit(2);
  }

  const nodeTestFiles = collectNodeTestFiles(repoRoot);

  try {
    const nodeCount = nodeTestFiles.length ? await countNodeTests(nodeTestFiles) : 0;
    const vitestCount = await countVitestTests();
    const total = nodeCount + vitestCount;

    if (total < floor) {
      console.error(
        `[check-test-count] FAIL: ${total} tests reported (node:test=${nodeCount}, vitest=${vitestCount}), floor is ${floor}. ` +
          "Update test/baseline.json in this PR and explain the reduction in the description.",
      );
      process.exit(1);
    }

    console.log(
      `[check-test-count] OK: ${total} tests (node:test=${nodeCount}, vitest=${vitestCount}) >= floor ${floor}`,
    );
  } catch (err) {
    console.error(`[check-test-count] ${err.message}`);
    process.exit(2);
  }
}

// Only run the guard when invoked as the entry point. Without this the whole
// suite re-ran on mere `import` — which made the module untestable, since a test
// importing the helpers below would recursively spawn the very run it counts.
// Same convention as scripts/stamp-version.mjs.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}

function collectNodeTestFiles(root) {
  const out = [];
  const rootTestDir = path.join(root, "test");
  if (fs.existsSync(rootTestDir)) {
    for (const name of fs.readdirSync(rootTestDir)) {
      if (name.endsWith(".test.js")) out.push(path.join("test", name));
    }
  }
  const packagesDir = path.join(root, "packages");
  if (fs.existsSync(packagesDir)) {
    for (const pkg of fs.readdirSync(packagesDir)) {
      const pkgTests = path.join(packagesDir, pkg, "tests");
      if (!fs.existsSync(pkgTests)) continue;
      for (const name of fs.readdirSync(pkgTests)) {
        if (name.endsWith(".test.js")) out.push(path.join("packages", pkg, "tests", name));
      }
    }
  }
  return out;
}

function countNodeTests(testFiles) {
  return new Promise((resolve, reject) => {
    const args = ["--no-warnings", "--test", "--test-reporter=tap", ...testFiles];
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", (err) => reject(new Error(`failed to spawn node --test: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`node --test exited ${code}; aborting guard`));
        return;
      }
      const planMatch = stdout.match(/^1\.\.(\d+)\s*$/m);
      if (!planMatch) {
        reject(new Error("could not find TAP plan line (1..N) in node:test output"));
        return;
      }
      resolve(Number(planMatch[1]));
    });
  });
}

export async function countVitestTests(
  countWorkspace = countWorkspaceVitestTests,
  countRoot = countRootVitestTests,
) {
  // Keep these runs sequential. The root suite starts several live HTTP/tRPC
  // servers with deliberately short startup deadlines; competing with every
  // workspace suite at once can exhaust a busy development host and turn this
  // counting guard into a source of false timeout failures.
  const workspace = await countWorkspace();
  const root = await countRoot();
  return workspace + root;
}

export function countWorkspaceVitestTests(run = runJsonReporter) {
  // Run vitest in every workspace package via `pnpm -r exec` so every
  // package that ships a Vitest config gets counted automatically. Keep pnpm's
  // workspace concurrency at one: several packages start real servers and the
  // guard is measuring discovery, not parallel-test throughput.
  return run([
    "pnpm",
    "-r",
    "--workspace-concurrency=1",
    "exec",
    "vitest",
    "run",
    "--reporter=json",
  ]);
}

function countRootVitestTests() {
  // Run vitest at the repo root (picks up `test/**/*.test.ts` via the
  // root vitest.config.ts). passWithNoTests in the config means this
  // emits a valid JSON report with numTotalTests: 0 if test/ ever
  // empties out.
  return runJsonReporter(["pnpm", "exec", "vitest", "run", "--reporter=json"]);
}

/**
 * Pull every complete top-level JSON document out of a captured stdout stream.
 *
 * `pnpm -r exec` runs vitest once per workspace, so stdout carries several whole
 * JSON reports back to back, interleaved with pnpm's own prefixes and anything
 * the tests printed. `JSON.parse(stdout)` therefore throws, and parsing only the
 * first document loses every later workspace. Brace-matching (string- and
 * escape-aware, so a `{` inside a failure message can't unbalance it) is what
 * survives that stream. Each opening brace is an independent candidate so an
 * unmatched brace or quote in earlier log noise cannot poison later reports.
 * Exported for tests.
 */
export function extractJsonDocuments(text) {
  const docs = [];
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;
    const end = findJsonDocumentEnd(text, start);
    if (end === -1) continue;
    const candidate = text.slice(start, end + 1);
    try {
      JSON.parse(candidate);
    } catch {
      continue;
    }
    docs.push(candidate);
    start = end;
  }
  return docs;
}

function findJsonDocumentEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The failing tests named in a `--reporter=json` stdout stream.
 *
 * Never throws: unparseable fragments are skipped. This runs only on a path that
 * is ALREADY failing, so a helper that could throw would just replace one
 * uninformative failure with another. Exported for tests.
 */
export function collectFailedTests(stdout) {
  const failures = [];
  for (const doc of extractJsonDocuments(stdout)) {
    let parsed;
    try {
      parsed = JSON.parse(doc);
    } catch {
      continue; // log noise that happened to look like a JSON object
    }
    if (!Array.isArray(parsed?.testResults)) continue;
    for (const file of parsed.testResults) {
      for (const assertion of file?.assertionResults ?? []) {
        if (assertion?.status !== "failed") continue;
        // First line only: a full stack per failure buries the list in CI.
        const message = String(assertion.failureMessages?.[0] ?? "")
          .split("\n")[0]
          .trim();
        failures.push({
          file: file?.name ?? "(unknown file)",
          name: assertion.fullName || assertion.title || "(unnamed test)",
          message,
        });
      }
    }
  }
  return failures;
}

/**
 * The guard's message for a non-zero runner exit — naming the failing tests when
 * the report identified any, and saying plainly that it could not when it did
 * not (a config error or a crashed worker fails the run without failing a test).
 * Exported for tests.
 */
export function formatRunFailure(args, code, failures) {
  const header = `${args.join(" ")} exited with code ${code}; aborting guard`;
  if (!failures.length) {
    return `${header}\n  The run reported no failing test — likely a config error or a crashed worker. Re-run this command locally to see the runner's own output.`;
  }
  const noun = failures.length === 1 ? "1 failing test" : `${failures.length} failing tests`;
  const lines = failures.map((f) => {
    const where = path.relative(repoRoot, f.file) || f.file;
    return `  ✗ ${f.name}\n      ${where}${f.message ? `\n      ${f.message}` : ""}`;
  });
  return `${header}\n  ${noun}:\n${lines.join("\n")}`;
}

function runJsonReporter(args) {
  return new Promise((resolve, reject) => {
    const [bin, ...rest] = args;
    const child = spawn(bin, rest, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "inherit"],
      shell: false,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", (err) => reject(new Error(`failed to spawn ${bin}: ${err.message}`)));
    child.on("close", (code) => {
      // vitest exits 0 on success and on `passWithNoTests: true` + no
      // tests; any non-zero exit (config error, runtime crash, failing
      // test) must surface as a guard failure so a silently-zeroed
      // numTotalTests can't slip past the floor check.
      //
      // The report is on the stdout we just captured, so name the failing
      // tests instead of throwing them away: this used to reject with the
      // exit code alone, which left CI saying only "exited with code 1" and
      // made a flaky timeout indistinguishable from a real regression.
      if (code !== 0) {
        reject(new Error(formatRunFailure(args, code, collectFailedTests(stdout))));
        return;
      }
      let total = 0;
      const matches = stdout.matchAll(/"numTotalTests"\s*:\s*(\d+)/g);
      for (const m of matches) total += Number(m[1]);
      resolve(total);
    });
  });
}
