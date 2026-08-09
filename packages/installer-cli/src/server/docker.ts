// Injectable `docker` / `git` runner for the `server` command group.
//
// Every `server` subcommand (up / update / down / status / logs / boot /
// admin) drives the host's `docker` and `git` binaries. They go through THIS
// seam rather than `node:child_process` directly, so tests stub the runner and
// assert the exact argv each command invokes — WITHOUT spawning a real process
// or touching a real Docker daemon.
//
// This mirrors `src/exec.ts` (the harness CLI runner) deliberately: same
// `Runner` shape, same `run`/`which`/`setRunner`/`resetRunner` surface. It is a
// SEPARATE module-level runner, though — the harness commands and the server
// commands inject independently, so a test that stubs one never disturbs the
// other. Reusing `exec.ts`'s `Runner`/`RunResult`/`RunOptions` types keeps a
// single fake (`FakeRunner`) usable for both.
//
// Security (AGENTS.md): a command may *carry* a bearer token via an env var its
// native mechanism reads, but this module never logs, echoes, or persists the
// streams it returns.
//
// Two surfaces, two seams:
//   - `run` CAPTURES a process's streams and resolves on close. Right for a
//     command that EXITS on its own (`docker logs` without `-f`, `docker stop`,
//     `docker info`): you want the whole output, after the fact.
//   - `stream` does NOT capture — it hands each stdout/stderr chunk to a callback
//     as it arrives and resolves only when the process exits. Right for a FOLLOW
//     (`docker logs -f`), which never closes on its own: capturing it would buffer
//     forever and emit nothing until the user Ctrl-Cs. Each seam injects
//     independently (`setRunner`/`setStreamer`) so a test stubs exactly what it
//     exercises, and neither ever spawns a real `docker`.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { RunOptions, RunResult, Runner } from "../exec.js";

export type { RunOptions, RunResult, Runner } from "../exec.js";

// --- the streaming seam (for follows that never close on their own) -------

/** Per-stream chunk handlers for a streaming spawn. Chunks arrive as they do. */
export interface StreamHandlers {
  /** Called with each stdout chunk (decoded utf8) as it arrives. */
  onStdout?: (chunk: string) => void;
  /** Called with each stderr chunk (decoded utf8) as it arrives. */
  onStderr?: (chunk: string) => void;
}

/**
 * The streaming counterpart to {@link Runner}. Spawns `cmd args…`, forwards
 * each stdout/stderr chunk to the handlers LIVE (never buffered to the end),
 * and resolves with the exit code when the process exits — `null` if it was
 * signalled (e.g. the user Ctrl-Cs a `-f` follow, or the container stops).
 */
export interface Streamer {
  stream(
    cmd: string,
    args: readonly string[],
    handlers: StreamHandlers,
    opts?: RunOptions,
  ): Promise<number | null>;
}

// --- the real, process-spawning runner -----------------------------------

const realRunner: Runner = {
  run(cmd, args, opts = {}) {
    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn(cmd, [...args], {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      // ENOENT (binary not on PATH) surfaces here, not as a non-zero exit.
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({ stdout, stderr, code });
      });
    });
  },

  async which(cmd) {
    return resolveExecutable(cmd);
  },
};

/** Resolve an executable without depending on a host `which`/`where` utility. */
async function resolveExecutable(cmd: string): Promise<string | null> {
  const isWindows = process.platform === "win32";
  const hasSeparator = cmd.includes("/") || (isWindows && cmd.includes("\\"));
  const directories = hasSeparator ? [""] : (process.env.PATH ?? "").split(path.delimiter);
  const extensions = isWindows
    ? commandExtensions(cmd, process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    : [""];

  for (const directory of directories) {
    const base = hasSeparator ? cmd : path.resolve(directory || ".", cmd);
    for (const extension of extensions) {
      const candidate = `${base}${extension}`;
      try {
        await fs.promises.access(candidate, isWindows ? fs.constants.F_OK : fs.constants.X_OK);
        if ((await fs.promises.stat(candidate)).isFile()) return path.resolve(candidate);
      } catch {
        // Not an executable file; continue searching PATH.
      }
    }
  }
  return null;
}

function commandExtensions(cmd: string, pathExt: string): string[] {
  const extensions = pathExt
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
  return extensions.some((extension) => cmd.toLowerCase().endsWith(extension)) ? [""] : extensions;
}

// --- the real, process-spawning streamer ----------------------------------

const realStreamer: Streamer = {
  stream(cmd, args, handlers, opts = {}) {
    return new Promise<number | null>((resolve, reject) => {
      const child = spawn(cmd, [...args], {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        // pipe (not inherit) so the caller can filter/transform per chunk; the
        // caller is responsible for writing kept output to the terminal.
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        handlers.onStdout?.(chunk.toString("utf8"));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        handlers.onStderr?.(chunk.toString("utf8"));
      });
      // ENOENT (binary not on PATH) surfaces here, not as a non-zero exit.
      child.on("error", reject);
      // Resolves only when the process EXITS — for `docker logs -f` that means
      // the container stopped or the user Ctrl-C'd; until then chunks stream.
      child.on("close", (code) => {
        resolve(code);
      });
    });
  },
};

// --- the swappable module-level runner -----------------------------------

let current: Runner = realRunner;
let currentStreamer: Streamer = realStreamer;

/** Run a command (`docker`/`git`) through the current server runner. */
export function run(cmd: string, args: readonly string[], opts?: RunOptions): Promise<RunResult> {
  return current.run(cmd, args, opts);
}

/** Resolve a command to its PATH location through the current server runner. */
export function which(cmd: string): Promise<string | null> {
  return current.which(cmd);
}

/**
 * Stream a command (e.g. `docker logs -f`) through the current server streamer,
 * forwarding each stdout/stderr chunk to `handlers` LIVE. Resolves with the exit
 * code when the process exits.
 */
export function stream(
  cmd: string,
  args: readonly string[],
  handlers: StreamHandlers,
  opts?: RunOptions,
): Promise<number | null> {
  return currentStreamer.stream(cmd, args, handlers, opts);
}

/** Swap in a fake runner (tests). Returns the previous runner. */
export function setRunner(runner: Runner): Runner {
  const prev = current;
  current = runner;
  return prev;
}

/** Restore the real, process-spawning runner (tests). */
export function resetRunner(): void {
  current = realRunner;
}

/** Swap in a fake streamer (tests). Returns the previous streamer. */
export function setStreamer(streamer: Streamer): Streamer {
  const prev = currentStreamer;
  currentStreamer = streamer;
  return prev;
}

/** Restore the real, process-spawning streamer (tests). */
export function resetStreamer(): void {
  currentStreamer = realStreamer;
}

// --- the interactive (inherited-stdio) exec seam --------------------------

/**
 * An exec that INHERITS the parent's stdio so the in-container process can prompt
 * the operator's real terminal (e.g. `the-librarian restore` / `auth reset-password`
 * reading a secret no-echo). The capture `run` above uses `stdio:["ignore",…]`, so
 * it can NEVER carry a working `docker exec -t` — pairing them is exactly what
 * produced "the input device is not a TTY". Interactive `server admin` uses this.
 */
export interface InteractiveRunner {
  runInteractive(cmd: string, args: readonly string[], opts?: RunOptions): Promise<number | null>;
}

const realInteractiveRunner: InteractiveRunner = {
  runInteractive(cmd, args, opts = {}) {
    return new Promise<number | null>((resolve, reject) => {
      const child = spawn(cmd, [...args], {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        stdio: "inherit", // the whole point: a real TTY for `-it` + live prompts
      });
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    });
  },
};

let currentInteractive: InteractiveRunner = realInteractiveRunner;

/** Run an interactive (inherited-stdio) command through the current seam. */
export function runInteractive(
  cmd: string,
  args: readonly string[],
  opts?: RunOptions,
): Promise<number | null> {
  return currentInteractive.runInteractive(cmd, args, opts);
}

/** Swap in a fake interactive runner (tests). Returns the previous one. */
export function setInteractiveRunner(runner: InteractiveRunner): InteractiveRunner {
  const prev = currentInteractive;
  currentInteractive = runner;
  return prev;
}

/** Restore the real inherited-stdio interactive runner (tests). */
export function resetInteractiveRunner(): void {
  currentInteractive = realInteractiveRunner;
}
