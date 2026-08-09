// `librarian server logs [-f] [--service mcp|dashboard|all]`.
//
// Maps to `docker logs [-f] the-librarian`. The all-in-one image runs BOTH
// services (mcp-server + dashboard) in ONE container under `docker/supervisor.mjs`,
// which spawns its children with `stdio: "inherit"` — so it emits NO per-service
// prefix. The two streams are interleaved with no supervisor-added label.
//
// How `--service` filtering works, given that constraint:
//   - The mcp-server logs structured pino NDJSON — every line is a JSON object
//     carrying `"service":"the-librarian"` (see packages/mcp-server/src/logging.ts).
//   - The dashboard (Next.js standalone `server.js`) logs plain text.
//   So we distinguish them by SHAPE: a line that parses as a JSON object is an
//   mcp-server line; anything else is a dashboard line. `--service mcp` keeps the
//   NDJSON lines; `--service dashboard` keeps the rest; `all` (default) is
//   unfiltered. This is the most reliable signal available without changing the
//   image to prefix each child's output.
//
// `-f` (follow) vs one-shot — two different `docker.ts` seams, because the two
// commands have opposite lifetimes:
//   - WITHOUT `-f`, `docker logs the-librarian` prints what's there and EXITS.
//     The capturing `run()` seam is right: it resolves on close with the whole
//     output, which we then service-filter and return for stdout.
//   - WITH `-f`, `docker logs -f the-librarian` NEVER closes on its own — it
//     tails until the container stops or the user Ctrl-Cs. Capturing it would
//     buffer forever and emit nothing until then (the old bug). So `-f` uses the
//     STREAMING seam (`stream()`): each line is service-filtered and written to
//     the terminal AS IT ARRIVES, and the call resolves with the process's exit
//     code when the follow ends. Both paths apply the identical JSON-shape
//     `--service` filter; only the delivery (buffered-then-returned vs.
//     live-per-line) differs.

import { run, stream } from "./docker.js";
import { dockerPreflight } from "./preflight.js";
import { CONTAINER_NAME } from "./up.js";

/** The services `--service` can target. `all` (default) is unfiltered. */
export type LogsService = "mcp" | "dashboard" | "all";

const SERVICES: readonly LogsService[] = ["mcp", "dashboard", "all"];

export interface LogsOptions {
  /** Follow the log output (`-f` / `--follow`). */
  follow?: boolean | undefined;
  /** Which service to show. Default `all` (unfiltered). */
  service?: string | undefined;
  /** Platform for preflight's daemon hint. Default `process.platform`. */
  platform?: NodeJS.Platform | undefined;
  /**
   * Where a FOLLOW (`-f`) writes its (service-filtered) lines, AS THEY ARRIVE.
   * Defaults to `process.stdout` so a live tail reaches the terminal directly —
   * never buffered to the end. Injectable so tests observe ordering without a
   * real terminal. Unused by the one-shot path (it returns its output instead).
   */
  write?: ((chunk: string) => void) | undefined;
}

/** A teaching error from `logs`; the runtime renders `.message` as one stderr line. */
export class LogsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogsError";
  }
}

export interface LogsResult {
  /**
   * The (service-filtered) log output for stdout. Populated by the one-shot
   * (no-`-f`) path; EMPTY for a follow, which streams its lines live via
   * `write` rather than returning them.
   */
  output: string;
  /**
   * The followed process's exit code (`-f` path), or `0` for the one-shot path.
   * `null` when the follow was signalled (e.g. Ctrl-C / container stop).
   */
  exitCode: number | null;
}

/** Validate + default the `--service` value, or throw a teaching error. */
function resolveService(raw: string | undefined): LogsService {
  if (raw === undefined) return "all";
  if ((SERVICES as readonly string[]).includes(raw)) return raw as LogsService;
  throw new LogsError(
    `Unknown --service '${raw}'. Valid values: mcp, dashboard, all (default). ` +
      "`mcp` shows the MCP server's structured logs, `dashboard` shows the Next.js " +
      "dashboard's, `all` shows both.",
  );
}

/**
 * True iff a log line is an mcp-server line — i.e. it parses as a JSON object
 * (the pino NDJSON shape). The dashboard's plain-text lines do not parse as JSON
 * objects, so they're treated as `dashboard`.
 */
function isMcpLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * True iff a single line belongs to `service`. `all` keeps everything; `mcp`
 * keeps the NDJSON lines; `dashboard` keeps the non-NDJSON, non-blank lines.
 * The SAME predicate drives both the buffered and the streaming paths.
 */
function keepLine(line: string, service: LogsService): boolean {
  if (service === "all") return true;
  if (service === "mcp") return isMcpLine(line);
  // dashboard: everything that isn't an mcp NDJSON line, skipping blanks so the
  // output isn't padded.
  return line.trim().length > 0 && !isMcpLine(line);
}

/** Keep only the lines belonging to `service` (preserving order + blanks for `all`). */
function filterByService(text: string, service: LogsService): string {
  if (service === "all") return text;
  return text
    .split("\n")
    .filter((l) => keepLine(l, service))
    .join("\n");
}

/**
 * A streaming line filter: feed it raw stdout chunks (which may split mid-line),
 * and it emits each COMPLETE line that belongs to `service` to `write` as soon
 * as the line is whole — never buffering to the end. Returns a `flush()` for any
 * trailing partial line left when the stream closes.
 */
function makeLineFilter(
  service: LogsService,
  write: (chunk: string) => void,
): { push: (chunk: string) => void; flush: () => void } {
  let buffer = "";
  const emit = (line: string): void => {
    if (keepLine(line, service)) write(line + "\n");
  };
  return {
    push(chunk: string): void {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        emit(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    },
    flush(): void {
      if (buffer.length > 0) {
        emit(buffer);
        buffer = "";
      }
    },
  };
}

/**
 * Run `server logs`. Preflights docker, then either:
 *   - FOLLOW (`-f`): streams `docker logs -f the-librarian` through the streaming
 *     seam, writing each service-matching line to `write` (default
 *     `process.stdout`) AS IT ARRIVES, resolving with the process's exit code
 *     when the follow ends (Ctrl-C / container stop). Output is empty (already
 *     streamed live).
 *   - ONE-SHOT (no `-f`): captures `docker logs the-librarian` via the capturing
 *     runner (it exits on its own), service-filters the captured output, and
 *     returns it for stdout.
 *
 * An unknown `--service` is a teaching error; a non-zero one-shot `docker logs`
 * exit surfaces its stderr as a teaching error (e.g. "No such container").
 */
export async function runLogs(options: LogsOptions = {}): Promise<LogsResult> {
  const service = resolveService(options.service);
  await dockerPreflight(options.platform ? { platform: options.platform } : {});

  if (options.follow) {
    // Live tail: stream line-by-line, never buffer to close.
    const write = options.write ?? ((chunk: string) => process.stdout.write(chunk));
    const filter = makeLineFilter(service, write);
    const exitCode = await stream("docker", ["logs", "-f", CONTAINER_NAME], {
      onStdout: (chunk) => filter.push(chunk),
      // `docker logs` writes the container's stderr stream here too; service
      // filtering applies the same way so it isn't lost or unfiltered.
      onStderr: (chunk) => filter.push(chunk),
    });
    filter.flush();
    return { output: "", exitCode };
  }

  // One-shot: `docker logs` exits on its own, so capture + filter is correct.
  const result = await run("docker", ["logs", CONTAINER_NAME]);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new LogsError(
      `\`docker logs ${CONTAINER_NAME}\` failed (exit ${result.code ?? "signal"})` +
        (detail ? `:\n${detail}` : ".") +
        "\n\nIs the server up? Run `librarian server status`.",
    );
  }

  return { output: filterByService(result.stdout, service), exitCode: result.code };
}
