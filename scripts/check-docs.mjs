#!/usr/bin/env node
// Drift-guard for the generated docs reference (docs-site spec criterion #5 /
// T2.3). Regenerates the technical-appendix pages from canonical source and
// compares them to what's committed under apps/docs/src/content/docs/reference/.
// Any divergence fails the build, naming the stale page(s) and the fix command —
// so editing a verb description, a parameter, the primer, a CLI command, or an
// included doc without running `pnpm docs:gen` cannot reach main.
//
// Like the generator, this reads the BUILT packages (K8), so CI must run it
// AFTER `pnpm build` — never against stale dist.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateReference } from "./docs-gen.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// Match the trailing-newline normalisation the generator writes with, so a file
// that differs only by its final newline is not falsely flagged as drift.
function normalize(contents) {
  return contents.endsWith("\n") ? contents : `${contents}\n`;
}

function readFromDisk(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

/** The repo-relative paths whose committed content no longer matches a fresh
 *  regeneration (or that are missing entirely). `reference` and `readFile` are
 *  injectable for testing; by default they regenerate and read from disk. */
export function findStaleReferencePages(reference = generateReference(), readFile = readFromDisk) {
  const stale = [];
  for (const [relPath, contents] of Object.entries(reference)) {
    const expected = normalize(contents);
    let actual;
    try {
      actual = readFile(relPath);
    } catch {
      actual = null; // missing file → stale
    }
    if (actual !== expected) stale.push(relPath);
  }
  return stale;
}

/** The message for a drift verdict. Extracted (rather than inlined in `main`)
 *  so the guidance itself is testable: the wrong guidance here is worse than no
 *  guidance, because "re-run docs:gen and commit" against a stale build writes an
 *  OLDER page over the correct one. */
export function stalePagesMessage(stale) {
  const list = stale.map((p) => `  - ${p}`).join("\n");
  return (
    `check:docs FAILED — these generated reference pages differ from a fresh regeneration:\n${list}\n\n` +
    "Two different causes produce this, and the fix differs:\n\n" +
    "  1. A canonical source changed and the committed page was not regenerated.\n" +
    "     Fix: pnpm build && pnpm docs:gen   (then commit the updated pages)\n\n" +
    "  2. The built packages this guard reads are STALE, so it regenerated OLD\n" +
    "     content and these pages only look stale — nothing is wrong with the\n" +
    "     committed pages.\n" +
    "     Fix: pnpm build   (then re-run this check)\n\n" +
    "Run `pnpm build` first, always: it is required for (1) and it is the only\n" +
    "thing that rules out (2). Do NOT commit `pnpm docs:gen` output until a check\n" +
    "against freshly built packages still reports drift — regenerating from stale\n" +
    "output overwrites a correct page with an older one. This is why CI runs the\n" +
    "guard after its Build step (docs-site spec K8)."
  );
}

function main() {
  const stale = findStaleReferencePages();
  if (stale.length === 0) {
    console.log("check:docs — generated reference pages are in sync.");
    return;
  }
  console.error(stalePagesMessage(stale));
  process.exit(1);
}

// Only run the check when invoked directly (`pnpm check:docs`); importing the
// comparator (the drift test) must have no side effects.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
