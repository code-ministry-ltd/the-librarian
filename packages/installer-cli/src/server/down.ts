// `librarian server down` — stop the container. DATA IS SACRED.
//
// `down` maps to ONE command: `docker stop the-librarian`. It NEVER removes the
// container (`docker rm`), never passes `-v`, never touches the data volume
// (`docker volume rm`), and never force-removes (`rm -f`). A later `up`/`update`
// brings the SAME memories back from the untouched named volume — that is the
// whole point (spec §11, success criterion 6).
//
// Idempotent-ish: if the container isn't running (or doesn't exist), `docker
// stop` exits non-zero with a "No such container" message — `down` turns that
// into a friendly "nothing to stop" outcome rather than a crash or a stack
// trace. A genuine daemon error (anything that isn't the not-found case) still
// surfaces as a teaching error.
//
// Everything goes through the injectable `docker.ts` runner, so tests assert the
// exact argv without a real daemon.

import { run } from "./docker.js";
import { dockerPreflight } from "./preflight.js";
import { CONTAINER_NAME } from "./up.js";

export interface DownOptions {
  /** Platform for preflight's daemon hint. Default `process.platform`. */
  platform?: NodeJS.Platform | undefined;
}

/** A teaching error from `down`; the runtime renders `.message` as one stderr line. */
export class DownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownError";
  }
}

export interface DownResult {
  /** Human-readable report for stdout. */
  output: string;
}

/** True when `docker stop`'s failure means the container simply isn't there. */
function isNotRunning(stderr: string): boolean {
  return /no such container|is not running/i.test(stderr);
}

/**
 * Run `server down`. Preflights docker, then `docker stop the-librarian` — the
 * ONLY command it ever issues. A not-found/not-running container is a friendly
 * no-op; any other non-zero exit is a teaching `DownError`.
 */
export async function runDown(options: DownOptions = {}): Promise<DownResult> {
  await dockerPreflight(options.platform ? { platform: options.platform } : {});

  // The single, data-safe command. No `rm`, no `-v`, no `volume`, no `-f`.
  const result = await run("docker", ["stop", CONTAINER_NAME]);

  if (result.code === 0) {
    return {
      output: [
        `Stopped ${CONTAINER_NAME}.`,
        "The data volume is preserved — `librarian server up` brings the same memories back.",
      ].join("\n"),
    };
  }

  const detail = result.stderr.trim();
  if (isNotRunning(detail)) {
    return {
      output: [
        `${CONTAINER_NAME} is not running — nothing to stop.`,
        "The data volume (if any) is untouched.",
      ].join("\n"),
    };
  }

  // A real failure (daemon error, permission, etc.) — teach, don't crash.
  throw new DownError(
    `\`docker stop ${CONTAINER_NAME}\` failed (exit ${result.code ?? "signal"})` +
      (detail ? `:\n${detail}` : ".") +
      "\n\nResolve the error above, then re-run `librarian server down`.",
  );
}
