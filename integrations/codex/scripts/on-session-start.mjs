#!/usr/bin/env node
// Codex `SessionStart` hook entry (spec 078) — a thin shell over
// lib/session-start.mjs: it puts the recent window of the conversation journal in
// front of the model when a session starts, resumes or is compacted, and records
// whether the server accepts `project` on /transcript.
//
// Its contract is the exit code: ALWAYS 0, never a stack trace. Every failure prints
// nothing, and the session starts as it would without The Librarian.

import process from "node:process";
import { runSessionStart } from "./lib/session-start.mjs";

/**
 * Read all of stdin (the hook JSON) as a string. Resolves "" if there is none.
 *
 * NO-HANG: fail-soft must never depend on the harness closing the pipe. A
 * held-open stdin would otherwise hang this process until the harness's own
 * timeout. We resolve on `end`/`error`, but ALSO arm a short internal timeout that
 * resolves with whatever we have so far so the entry can fail-soft no-op promptly.
 */
function readStdin(timeoutMs = 2500) {
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    const timer = setTimeout(() => finish(data), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => finish(data));
    process.stdin.on("error", () => finish(data));
  });
}

async function main() {
  const raw = await readStdin();
  let hook;
  try {
    hook = raw ? JSON.parse(raw) : {};
  } catch {
    hook = {};
  }
  const line = await runSessionStart(hook, process.env);
  if (line) process.stdout.write(`${line}\n`);
}

main()
  .catch(() => {
    // Absolute backstop: never propagate; the session must start regardless.
  })
  .finally(() => {
    process.exit(0);
  });
