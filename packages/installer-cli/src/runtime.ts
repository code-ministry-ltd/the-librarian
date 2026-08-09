// The `librarian` CLI runtime — an async function over argv.
//
// `runCli(argv, options)` resolves to `{ stdout, stderr, exitCode }` so the
// bin entry shapes it into a real process exit and tests assert against
// captured output without spawning a subprocess. Everything that touches the
// system is injectable through `options`: `home` (temp dir), `shell`, a
// `prompter` (prompt answers), and the per-module seams the commands pull in
// (`setRunner` / `setHomeOverride` / `setAdapterFetcher` / `setLatestFetcher`
// / `setServerProbe`). NOTHING here touches the real system, network, or
// stdin in tests.

import { runInstall } from "./commands/install.js";
import { runUninstall } from "./commands/uninstall.js";
import { runUpdate } from "./commands/update.js";
import { formatConfig, readConfig, redact, setConfig, type LibrarianConfig } from "./config.js";
import { doctor } from "./doctor.js";
import { detectShell, type Shell } from "./env.js";
import { allHarnesses } from "./harnesses/index.js";
import { flagBool, flagString, parseArgs, type FlagMap } from "./parse-args.js";
import { createPrompter, MissingValueError, type Prompter } from "./prompt.js";
import { runAdmin } from "./server/admin.js";
import {
  autoUpdateStatus,
  disableAutoUpdate,
  enableAutoUpdate,
  runAutoUpdate,
  uninstallAutoUpdate,
} from "./server/autoupdate.js";
import { disableBoot, enableBoot } from "./server/boot.js";
import { runDown } from "./server/down.js";
import { isServerSubcommand, serverSubcommandUsage, serverUsage } from "./server/index.js";
import { runLogs } from "./server/logs.js";
import { serverStatus } from "./server/status.js";
import { runUp } from "./server/up.js";
import { runUpdate as runServerUpdate } from "./server/update.js";
import { status } from "./status.js";
import { cliVersion } from "./version.js";

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RuntimeOptions {
  /** Override the home dir (tests). Defaults to the real `os.homedir()`. */
  home?: string;
  /** Override the detected shell (tests / `--shell`). */
  shell?: Shell;
  /** Inject a prompter (tests). Defaults to a real stdio-backed prompter. */
  prompter?: Prompter;
  /**
   * The process environment to read existing `LIBRARIAN_*` vars from (BUG 2).
   * Injectable so tests never touch the real `process.env` and never log a
   * token. Defaults to `process.env` in `runInstall`.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Whether the run is interactive (a TTY is attached). Gates `server up`'s
   * best-effort offers (the Tailscale offer; the `0.0.0.0` confirm). Defaults
   * to `process.stdin.isTTY` — a non-interactive run never silently exposes the
   * server beyond localhost (it keeps `127.0.0.1`). Injectable for tests.
   */
  interactive?: boolean;
  /**
   * The host platform, defaulting to `process.platform`. Threads into the
   * `server` ops that branch on it: preflight's daemon hint and boot
   * persistence (Linux systemd vs the macOS deferred notice). Injectable so the
   * darwin path is testable from a Linux host.
   */
  platform?: NodeJS.Platform;
}

const PHASE_2_STUBS = new Set(["report", "self-update"]);

/**
 * The CLI entrypoint. Dispatches to the command handlers and — crucially —
 * turns any escaped error into one clean stderr line + exit 1, so a failure
 * never leaks a stack trace into the user's terminal (house rule: "never
 * leak a stack trace"). `MissingValueError` (a required prompt with no value
 * in a non-interactive run) gets a specific, actionable message.
 */
export async function runCli(argv: string[], options: RuntimeOptions = {}): Promise<CliResult> {
  try {
    return await dispatch(argv, options);
  } catch (error) {
    if (error instanceof MissingValueError) {
      return err(
        "MCP URL and token are required — re-run interactively, or pass --mcp-url/--token.",
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return err(`librarian: ${message}`);
  }
}

async function dispatch(argv: string[], options: RuntimeOptions): Promise<CliResult> {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    return ok(usage());
  }
  if (command === "--version" || command === "-v" || command === "version") {
    return ok(cliVersion());
  }

  if (command === "config") {
    return runConfig(rest, options);
  }

  if (command === "install") {
    return runInstallCommand(rest, options);
  }
  if (command === "uninstall") {
    return runUninstallCommand(rest, options);
  }
  if (command === "update") {
    return runUpdateCommand(rest, options);
  }
  if (command === "status") {
    return ok(await status(options.home));
  }
  if (command === "doctor") {
    // Diagnostic: exits 0 even when it flags problems.
    return ok(await doctor(options.home));
  }

  if (command === "server") {
    return runServerCommand(rest, options);
  }

  if (PHASE_2_STUBS.has(command)) {
    return runPhase2Stub(command);
  }

  return err(`Unknown command: ${command}\n\n${usage()}`);
}

// --- config (fully implemented) ------------------------------------------

function runConfig(rest: string[], options: RuntimeOptions): CliResult {
  const { flags } = parseArgs(rest);
  const mcpUrl = flagString(flags["mcp-url"]) ?? flagString(flags.url);
  const token = flagString(flags.token);
  const shell = options.shell ?? resolveShellFlag(flags);

  const wantsSet = mcpUrl !== undefined || token !== undefined;
  if (wantsSet) {
    const updated = setConfig({ mcpUrl, token }, { home: options.home, shell });
    // Confirm what changed WITHOUT echoing the token.
    return ok(["Updated config.", "", formatConfig(redact(updated))].join("\n"));
  }

  const current: LibrarianConfig | null = readConfig(options.home);
  if (!current) {
    return ok(
      [
        "No config set yet.",
        "",
        "Set it with:",
        "  librarian config --mcp-url <url> --token <token>",
      ].join("\n"),
    );
  }
  return ok(formatConfig(redact(current)));
}

function resolveShellFlag(flags: FlagMap): Shell | undefined {
  const raw = flagString(flags.shell);
  if (!raw) return undefined;
  return detectShell(raw);
}

// --- harness-touching commands -------------------------------------------

async function runInstallCommand(rest: string[], options: RuntimeOptions): Promise<CliResult> {
  const { positionals, flags } = parseArgs(rest);
  const shell = options.shell ?? resolveShellFlag(flags);
  const prompter = options.prompter ?? createPrompter();
  try {
    const outcome = await runInstall(positionals, {
      home: options.home,
      shell,
      prompter,
      env: options.env,
    });
    // A mid-install failure makes the command non-zero so scripts notice; a
    // pure skip (CLI absent) is a success.
    return outcome.failed.length > 0 ? errOut(outcome.output) : ok(outcome.output);
  } finally {
    // Tear down the shared readline (BUG 1) so an open interface doesn't keep
    // the event loop alive and hang the process after the command completes.
    prompter.close();
  }
}

async function runUninstallCommand(rest: string[], options: RuntimeOptions): Promise<CliResult> {
  const { positionals, flags } = parseArgs(rest);
  const shell = options.shell ?? resolveShellFlag(flags);
  const prompter = options.prompter ?? createPrompter();
  try {
    const outcome = await runUninstall(positionals, { home: options.home, shell, prompter });
    return outcome.failed.length > 0 ? errOut(outcome.output) : ok(outcome.output);
  } finally {
    prompter.close();
  }
}

async function runUpdateCommand(rest: string[], options: RuntimeOptions): Promise<CliResult> {
  const { positionals } = parseArgs(rest);
  const outcome = await runUpdate(positionals, { home: options.home });
  return outcome.failed.length > 0 ? errOut(outcome.output) : ok(outcome.output);
}

// --- server command group (self-host) ------------------------------------

/**
 * `librarian server [subcommand]`. With no subcommand (or `--help`/`-h`) it
 * prints the command surface (§4). Implemented: `up` (S2/S3), `down` / `logs` /
 * `status` (S4), `update` (S5), `enable-boot` / `disable-boot` (S6), `admin`
 * (S7a). An unknown subcommand errors with the surface. Preflight + the
 * `docker.ts` seam (S1) back every container op.
 */
async function runServerCommand(rest: string[], options: RuntimeOptions): Promise<CliResult> {
  const [subcommand, ...subRest] = rest;

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return ok(serverUsage());
  }
  if (isServerSubcommand(subcommand) && subRest.some((arg) => arg === "--help" || arg === "-h")) {
    return ok(serverSubcommandUsage(subcommand));
  }
  if (subcommand === "up") {
    return runServerUpCommand(subRest, options);
  }
  if (subcommand === "update") {
    return runServerUpdateCommand(subRest, options);
  }
  if (subcommand === "down") {
    return runServerDownCommand();
  }
  if (subcommand === "logs") {
    return runServerLogsCommand(subRest);
  }
  if (subcommand === "status") {
    return runServerStatusCommand(subRest, options);
  }
  if (subcommand === "enable-boot") {
    return runServerEnableBootCommand(options);
  }
  if (subcommand === "disable-boot") {
    return runServerDisableBootCommand(options);
  }
  if (subcommand === "autoupdate") {
    return runServerAutoUpdateCommand(subRest, options);
  }
  if (subcommand === "admin") {
    return runServerAdminCommand(subRest, options);
  }
  return err(`Unknown server subcommand: ${subcommand}\n\n${serverUsage()}`);
}

/**
 * `librarian server up [flags]`. Parses the flags, builds a prompter (for the
 * loop-closer env offer), and runs the selected published-image or source flow.
 * A failure surfaces as one clean stderr line via the top-level catch — no
 * stack trace, and the master key (carried only on the success stdout) never
 * reaches an error path.
 */
async function runServerUpCommand(rest: string[], options: RuntimeOptions): Promise<CliResult> {
  const { flags } = parseArgs(rest);
  const prompter = options.prompter ?? createPrompter();
  // Interactivity gates the best-effort offers (Tailscale; the `0.0.0.0`
  // confirm). Explicit override wins; otherwise a TTY means interactive. A
  // non-interactive run never silently exposes the server beyond localhost.
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY);
  try {
    const result = await runUp(
      {
        ref: flagString(flags.ref),
        dir: flagString(flags.dir),
        host: flagString(flags.host),
        dataVolume: flagString(flags["data-volume"]),
        dataDir: flagString(flags["data-dir"]),
        dashboardPort: flagString(flags["dashboard-port"]),
        enableBoot: flagBool(flags["enable-boot"]),
        yes: flagBool(flags.yes),
      },
      {
        home: options.home,
        prompter,
        interactive,
        env: options.env,
        ...(options.platform ? { platform: options.platform } : {}),
      },
    );
    return ok(result.output);
  } finally {
    prompter.close();
  }
}

/**
 * `librarian server enable-boot` (S6). On Linux, installs + enables the systemd
 * unit that starts the existing named container on boot (the unit references the
 * container by name and carries NO secret). On macOS, prints the deferred notice
 * and exits 0 (NOT an error). A real failure surfaces as one clean stderr line.
 */
async function runServerEnableBootCommand(options: RuntimeOptions): Promise<CliResult> {
  const result = await enableBoot(options.platform ? { platform: options.platform } : {});
  return ok(result.output);
}

/**
 * `librarian server disable-boot` (S6). On Linux, disables + removes the systemd
 * unit and reloads systemd; safe if already disabled/absent (a teaching message,
 * no crash). On macOS, prints the deferred notice and exits 0.
 */
async function runServerDisableBootCommand(options: RuntimeOptions): Promise<CliResult> {
  const result = await disableBoot(options.platform ? { platform: options.platform } : {});
  return ok(result.output);
}

/**
 * `librarian server autoupdate <enable|disable|uninstall|status> [--cadence …]`
 * and the internal `--run` (T3). `enable` installs a host scheduler (systemd timer
 * / cron fallback) that fires hourly and runs `--run`, plus writes enabled+cadence
 * into the running server (so the dashboard reflects it). `disable` flips the
 * setting off (timer stays). `uninstall` removes the timer/cron. `status` reports
 * timer-installed + the server's enabled/cadence/last-run + up-to-date. `--run` is
 * the wrapper the timer calls: it reads the settings from the running server,
 * applies the due-check, and conditionally runs `server update` — FULLY fail-soft
 * (never throws out of the timer). A real failure on the operator-facing verbs
 * surfaces as one clean stderr line via the top-level catch.
 */
async function runServerAutoUpdateCommand(
  subRest: string[],
  options: RuntimeOptions,
): Promise<CliResult> {
  const { positionals, flags } = parseArgs(subRest);
  const platformOpt = options.platform ? { platform: options.platform } : {};
  const base = { home: options.home, dir: flagString(flags.dir), ...platformOpt };

  // `--run` is the timer's wrapper. It is fail-soft by construction (it never
  // throws) and always exits 0 so the timer's unit never fails; its one-line
  // outcome is its stdout.
  if (flagBool(flags.run)) {
    const result = await runAutoUpdate(base);
    return ok(result.output);
  }

  const [verb] = positionals;
  if (verb === "enable") {
    const result = await enableAutoUpdate({ ...base, cadence: flagString(flags.cadence) });
    return ok(result.output);
  }
  if (verb === "disable") {
    return ok((await disableAutoUpdate(base)).output);
  }
  if (verb === "uninstall") {
    return ok((await uninstallAutoUpdate(base)).output);
  }
  if (verb === "status" || verb === undefined) {
    return ok((await autoUpdateStatus(base)).output);
  }
  return err(
    `Unknown autoupdate subcommand: ${verb}\n\n` +
      "Usage: librarian server autoupdate <enable|disable|uninstall|status> [--cadence daily|weekly]",
  );
}

/**
 * `librarian server admin <backup|restore|auth|rebuild> [args…]` (S7a). Runs a
 * curated admin verb inside the running container via
 * `docker exec [-it] the-librarian the-librarian <verb> [args…]` (spec §7). The
 * args are passed through VERBATIM — so we do NOT run them through `parseArgs`
 * (that would reorder/strip flags); the in-container CLI parses them. An
 * interactive run adds `-it` so the CLI can prompt (e.g. `restore`'s
 * `--secret-key`). A rejected verb or a down container surfaces as one clean
 * stderr line via the top-level catch, with no `docker exec`.
 */
async function runServerAdminCommand(
  subRest: string[],
  options: RuntimeOptions,
): Promise<CliResult> {
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY);
  const result = await runAdmin(subRest, {
    interactive,
    ...(options.platform ? { platform: options.platform } : {}),
  });
  return ok(result.output);
}

/**
 * `librarian server update [--ref <tag|main>] [--yes]`. Pulls and verifies an
 * exact stable release, or prepares/builds an explicit development ref, before
 * replacing the container while preserving storage and credentials. A failed
 * replacement recovers the previous executable where possible and reports the
 * exact recovery outcome. Idempotent: the exact healthy target is a clean no-op.
 */
async function runServerUpdateCommand(rest: string[], options: RuntimeOptions): Promise<CliResult> {
  const { flags } = parseArgs(rest);
  const result = await runServerUpdate({
    ref: flagString(flags.ref),
    dir: flagString(flags.dir),
    yes: flagBool(flags.yes),
    home: options.home,
  });
  return ok(result.output);
}

/**
 * `librarian server down` (S4). Stops the container — DATA SACRED (it issues
 * only `docker stop`, never any `rm`/volume op). A not-running container is a
 * friendly success; a real failure surfaces via the top-level catch as one
 * clean stderr line. No flags today.
 */
async function runServerDownCommand(): Promise<CliResult> {
  const result = await runDown({});
  return ok(result.output);
}

/**
 * `librarian server logs [-f] [--service mcp|dashboard|all]` (S4). `-f` is a
 * short flag the tiny parser treats as a positional, so we accept it there (or
 * `--follow`). `--service` selects which of the two co-located services to show
 * (filtered from the combined stream). A bad `--service` value is a teaching
 * error via the top-level catch.
 *
 * A FOLLOW (`-f`) streams its lines straight to `process.stdout` LIVE inside
 * `runLogs` (a tail never closes on its own — buffering it to return here is the
 * old hang), so there's no captured `output` to print; we just propagate the
 * followed process's exit code. The one-shot path returns its captured output.
 */
async function runServerLogsCommand(rest: string[]): Promise<CliResult> {
  const { positionals, flags } = parseArgs(rest);
  const follow = positionals.includes("-f") || flagBool(flags.follow) || flagBool(flags.f);
  const result = await runLogs({ follow, service: flagString(flags.service) });
  if (follow) {
    // Lines already streamed live; pass through the follow's exit code.
    return { stdout: "", stderr: "", exitCode: result.exitCode ?? 0 };
  }
  return ok(result.output);
}

/**
 * `librarian server status` (S4). Reports running/health (from `docker inspect`)
 * and the deployed-vs-latest badge (deploy-state ref vs `fetchLatestVersion`).
 * Offline/unknown degrades to `unknown`/`?` and still exits 0 — only a missing
 * docker (preflight) makes it non-zero, via the top-level catch.
 */
async function runServerStatusCommand(rest: string[], options: RuntimeOptions): Promise<CliResult> {
  const { flags } = parseArgs(rest);
  const result = await serverStatus({ home: options.home, dir: flagString(flags.dir) });
  return ok(result.output);
}

// --- Phase 2 stubs (friendly "coming later") -----------------------------

function runPhase2Stub(command: string): CliResult {
  const detail =
    command === "report"
      ? "Server reporting (the dashboard's Installs view) arrives in a later release."
      : "Self-update of the CLI arrives in a later release. For now: `npm i -g @the-librarian/cli`.";
  return ok(`librarian ${command}: coming in a later release.\n\n${detail}`);
}

// --- usage ---------------------------------------------------------------

export function usage(): string {
  const harnesses = allHarnesses.map((h) => h.id).join(", ");
  return [
    "Usage: librarian <command> [harness…] [flags]",
    "",
    "Commands:",
    "  install   [harness…]   Install The Librarian into one or more harnesses",
    "  uninstall [harness…]   Remove The Librarian from one or more harnesses",
    "  update    [harness…]   Update the integration to the current version",
    "  status                 Live table of harness / installed / version",
    "  doctor                 Diagnose token, server reachability, harness CLIs",
    "  config                 Show or set MCP URL, token, server URL",
    "  server                 Self-host the Librarian server (run `server` for its commands)",
    "  self-update            Update the librarian CLI itself",
    "  report                 Push this machine's state to the server",
    "",
    "Flags:",
    "  --mcp-url <url>        config: set the MCP endpoint URL",
    "  --token <token>        config: set the bearer token (never printed)",
    "  --shell <bash|zsh|fish>  override shell detection for the rc block",
    "  -h, --help            Show this help",
    "  -v, --version         Show the CLI version",
    "",
    `Harnesses: ${harnesses}`,
  ].join("\n");
}

// --- result helpers ------------------------------------------------------

function ok(stdout: string): CliResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function err(stderr: string): CliResult {
  return { stdout: "", stderr, exitCode: 1 };
}

/** A non-zero result that still carries its (already-formatted) report on stdout. */
function errOut(stdout: string): CliResult {
  return { stdout, stderr: "", exitCode: 1 };
}
