// `librarian server update` — re-pin forward, rebuild, recreate, migrate.
//
// The tag-pinned, deploy-dir-owning successor to `pull-and-restart.sh` (the
// stash/branch dance is gone — the CLI owns its deploy dir, so it just fetches
// tags and checks out the resolved ref). The flow (spec §8, success criterion 5):
//
//   1. Resolve the target ref: `--ref <tag|main>` pins it; default = the latest
//      release tag (`fetchLatestVersion`).
//   2. IDEMPOTENCY FIRST: read deploy-state (current ref) + the container's
//      health. Already at the resolved ref AND healthy → a CLEAN no-op (no
//      build, no run, no recreate). When `--ref` is given, compare against it.
//   3. Otherwise update, IN THE DEPLOY DIR:
//        git fetch --tags origin → git checkout <ref>
//        → docker build -f docker/all-in-one.Dockerfile -t the-librarian:<ref> .
//        → read back the EXISTING agent token + master key + optional bootstrap
//          claim secret from the running container's env (so clients keep
//          working, secrets stay decryptable, and pending claims stay armed)
//          BEFORE removing it
//        → docker stop → docker rm <container>   (NEVER `-v`, NEVER `volume rm`)
//        → write the 0600 deploy env-file (preserved/fresh token + preserved-or-
//          omitted master key + loopback ALLOW_NO_AUTH) then docker run …
//          (buildRunArgs with the SAME host + dataVolume from deploy-state, via
//          `--env-file`)
//        → waitForHealthy (rolls back with `docker rm -f` on failure — reusing
//          up's pattern, so a failed recreate leaves no half-up container and
//          does NOT advance deploy-state)
//        → docker exec the-librarian the-librarian migrate-data-dir
//          (server boot only WARNS about pending data-dir migrations; the admin
//           CLI APPLIES them — see packages/cli/src/commands/migrate-data-dir.ts.
//           The `the-librarian` runtime binary is bundled into the image in S7;
//           this slice asserts the argv, the runtime target arrives with S7.)
//   4. writeDeployState with the new ref/imageTag (host/dataVolume unchanged).
//
// SECRETS ON UPDATE (decision): recreating the container needs the agent token,
// the master key (`LIBRARIAN_SECRET_KEY`), and any optional bootstrap-claim
// secret. They are persisted host-side only in the 0600 deploy env-file. We read
// the running values back via `docker inspect` BEFORE removal and use the
// protected file as the claim-secret fallback when the container is unreadable.
//
//   - AGENT TOKEN: prefer the read-back token; only if the old container is
//     gone/unreadable do we mint a FRESH token and surface it ONCE with a
//     "clients must update their token" note.
//   - MASTER KEY: prefer the read-back key. If it can't be read back we DO NOT
//     mint a fresh one — re-minting would orphan every secret encrypted under
//     the old key. Instead we OMIT `LIBRARIAN_SECRET_KEY` from the new env-file
//     so the server resolves it from `/data/secret.key` (env → file → generate),
//     which preserves a pre-P4 on-disk key (and only generates when the data dir
//     is genuinely fresh — nothing to orphan).
//
// These secrets ride ONLY in the 0600 deploy env-file fed to `docker run
// --env-file` — never inline on argv, never in any other host file or log (the
// spec's no-leak boundary; tests scan for them).
//
// The DATA VOLUME is sacred: recreate removes the CONTAINER only (`docker rm`),
// never the named volume (the `-v` flag / `docker volume rm` never appear), so
// `up`/`update`/`down` all recall the same memories from the untouched volume.
//
// Everything goes through the injectable `docker.ts` runner + the injectable
// latest-release fetcher, so tests assert the exact argv (and its order) WITHOUT
// a real daemon, network, or git.

import path from "node:path";
import { librarianDir } from "../paths.js";
import { fetchLatestVersion } from "../status.js";
import { type DeployState, readDeployState, writeDeployState } from "./deploy-state.js";
import { run, type RunResult } from "./docker.js";
import { sourcePreflight } from "./preflight.js";
import { redactSecrets } from "./redact.js";
import {
  buildRunArgs,
  CONTAINER_NAME,
  dirOwner,
  LEGACY_DASHBOARD_PORT,
  mintAgentToken,
  readDeployEnvFile,
  waitForHealthy,
  writeDeployEnvFile,
} from "./up.js";
import { acquireUpdateLock, UpdateInProgressError, updateLockPath } from "./update-lock.js";

export interface UpdateOptions {
  /** Pinned ref (`vX.Y.Z` tag or `main`). Default: the latest release tag. */
  ref?: string | undefined;
  /** Auto-accept prompts (none today; wired for surface parity with `up`). */
  yes?: boolean | undefined;
  /** Deploy dir override. Default: `~/.librarian/server`. */
  dir?: string | undefined;
  /** Override home (tests). */
  home?: string | undefined;
  /** Platform for preflight's daemon hint. Default `process.platform`. */
  platform?: NodeJS.Platform | undefined;
  /** Health-wait bound: how many polls before declaring failure (small in tests). */
  healthAttempts?: number | undefined;
  /** Milliseconds between health polls (0 in tests). */
  healthIntervalMs?: number | undefined;
  /** Lines of `docker logs` to surface on a failed health-wait. */
  logTailLines?: number | undefined;
}

/** A teaching error from `update`; the runtime renders `.message` as one stderr line. */
export class UpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateError";
  }
}

export interface UpdateResult {
  /** Human-readable report for stdout (carries a FRESH agent token at most once). */
  output: string;
}

/**
 * Run `server update`. Throws `UpdateError` (teaching message) on a failure
 * before/around the recreate; a failed health-wait throws the (already
 * secret-redacted) `UpError` from `waitForHealthy` after rolling the new
 * container back. deploy-state is advanced ONLY after a confirmed-healthy
 * recreate, so a failed update never records the new ref.
 */
export async function runUpdate(options: UpdateOptions = {}): Promise<UpdateResult> {
  // 1) Preflight: docker (daemon reachable) + git, or a teaching error.
  await sourcePreflight(options.platform ? { platform: options.platform } : {});

  const deployDir = options.dir ?? path.join(librarianDir(options.home), "server");

  // The deploy-state is authoritative for the bind host + data volume to reuse.
  // Without it we cannot recreate the container with the same config — teach.
  const state = readDeployState(deployDir);
  if (!state) {
    throw new UpdateError(
      `No deploy-state found at ${deployDir} — this host has not run \`librarian server up\` ` +
        "(or the deploy dir is wrong). Run `librarian server up` first, " +
        "or pass `--dir <path>` to point at an existing deploy dir.",
    );
  }

  // SPEC 074 SC5: ONE exclusive lock serialises EVERY update — manual runs and
  // auto-update timer fires alike — so two can never interleave stop/rm/run on
  // the same container (a window with no running container takes the server
  // down). Before 074 only the timer wrapper locked, so a manual update could
  // race a fire. Held around everything from ref resolution to deploy-state
  // write; released on success AND failure (a failure must not wedge the next
  // fire — the stale-reclaim window is for crashes, not ordinary errors).
  const lockPath = updateLockPath({ home: options.home, dir: options.dir });
  const lock = acquireUpdateLock(lockPath);
  if (!lock) throw new UpdateInProgressError(lockPath);
  try {
    return await performUpdate(options, deployDir, state);
  } finally {
    lock.release();
  }
}

/** The locked body of {@link runUpdate} — everything after preflight/state/lock. */
async function performUpdate(
  options: UpdateOptions,
  deployDir: string,
  state: DeployState,
): Promise<UpdateResult> {
  // 2) Resolve the target ref (explicit `--ref` wins; else the latest tag).
  const targetRef = await resolveRef(options.ref);

  // 3) IDEMPOTENCY FIRST: already at the resolved ref AND healthy → clean no-op.
  if (state.ref === targetRef && (await isHealthy())) {
    return {
      output: [
        `Already up to date (${targetRef}) — the container is healthy.`,
        "Nothing to do. Pin a different ref with `--ref <tag|main>` to change it.",
      ].join("\n"),
    };
  }

  // 4) Update, in the deploy dir: fetch tags → checkout the resolved ref.
  await git(["-C", deployDir, "fetch", "--tags", "origin"]);
  await checkoutRef(deployDir, targetRef);

  // 5) Build the new image from the deploy dir.
  await dockerInDir(
    ["build", "-f", "docker/all-in-one.Dockerfile", "-t", `${CONTAINER_NAME}:${targetRef}`, "."],
    deployDir,
  );

  // 6) Read the EXISTING secrets back from the running container's env BEFORE
  //    removal (one `docker inspect`; ADR 0008 P4 put them there via
  //    `--env-file`). PREFER reusing them:
  //      - agent token: reuse, else mint fresh (clients re-paste).
  //      - master key: reuse, else OMIT (server resolves /data/secret.key) —
  //        NEVER mint a fresh key, which would orphan encrypted secrets.
  //      - bootstrap claim: reuse, falling back to the protected deploy file,
  //        so a stopped/unreadable container does not silently become unarmed.
  const existingEnv = await readExistingContainerEnv();
  const existingToken = existingEnv.get("LIBRARIAN_AGENT_TOKEN") ?? null;
  const existingKey = existingEnv.get("LIBRARIAN_SECRET_KEY") ?? null;
  const persistedDeployEnv = readDeployEnvFile(deployDir);
  const existingBootstrapClaimSecret =
    existingEnv.get("LIBRARIAN_BOOTSTRAP_CLAIM_SECRET") ??
    persistedDeployEnv.LIBRARIAN_BOOTSTRAP_CLAIM_SECRET ??
    null;
  const agentToken = existingToken ?? mintAgentToken();
  const tokenIsFresh = existingToken === null;

  // 7) Recreate — CONTAINER ONLY. `docker stop` then `docker rm <name>`:
  //    NEVER `-v`, NEVER `docker volume rm`. The named data volume persists.
  await dockerStop();
  await dockerRm();

  // 8) Write the 0600 deploy env-file, then run the new container with the SAME
  //    host + data volume from deploy-state, secrets via `--env-file` (ADR 0008
  //    P4 — never inline on argv). The master key is the preserved one, or
  //    omitted (then the server resolves it from /data/secret.key).
  const envFile = writeDeployEnvFile(deployDir, {
    agentToken,
    secretKey: existingKey ?? undefined,
    bootstrapClaimSecret: existingBootstrapClaimSecret ?? undefined,
    host: state.host,
  });
  // Reuse the published dashboard port from deploy-state. A state written before
  // `dashboardPort` existed has none → treat it as the historical 3000, so an
  // existing server keeps its port across the update (no silent jump to 3042).
  const dashboardPort = state.dashboardPort ?? LEGACY_DASHBOARD_PORT;
  await dockerInDir(
    buildRunArgs({
      host: state.host,
      dataVolume: state.dataVolume,
      dashboardPort,
      // Reuse the same storage: a bind-mounted host dir (run as its owner) when
      // the deploy chose one, else the named volume. The data is sacred either way.
      dataDir: state.dataDir,
      runAsUser: state.dataDir ? dirOwner(state.dataDir) : undefined,
      imageRef: `${CONTAINER_NAME}:${targetRef}`,
      envFile,
    }),
    deployDir,
  );

  // 9) Wait for health (rolls back with `docker rm -f` on failure — up's
  //    pattern). If this throws, deploy-state is NOT advanced below.
  await waitForHealthy(options);

  // 10) Apply pending data-dir migrations via the bundled admin CLI (S7 bundles
  //     the `the-librarian` binary into the image; this slice asserts the argv).
  await dockerExecMigrate();

  // 11) Persist the new ref/imageTag — host/dataVolume/containerName unchanged.
  writeDeployState(deployDir, {
    containerName: state.containerName,
    host: state.host,
    dataVolume: state.dataVolume,
    dataDir: state.dataDir,
    // Backfill the port we just recreated with — so a legacy state (no port)
    // becomes an explicit 3000 and never drifts to the fresh-install default.
    dashboardPort,
    ref: targetRef,
    imageTag: `${CONTAINER_NAME}:${targetRef}`,
    imageSource: "source",
    imageRef: `${CONTAINER_NAME}:${targetRef}`,
  });

  return { output: renderSuccess(targetRef, tokenIsFresh ? agentToken : null) };
}

// --- ref + health probes -------------------------------------------------

/** Resolve the target ref: an explicit `--ref` wins; else the latest tag. */
async function resolveRef(ref: string | undefined): Promise<string> {
  if (ref && ref.trim().length > 0) return ref.trim();
  const latest = await fetchLatestVersion();
  if (!latest) {
    throw new UpdateError(
      "Could not resolve the latest release tag from GitHub. " +
        "Check your network, or pin a ref with `--ref <tag|main>`.",
    );
  }
  // `fetchLatestVersion` strips the leading `v`; the tag we check out keeps it.
  return `v${latest}`;
}

/**
 * True iff the container exists AND reports `healthy`. Used by the idempotency
 * check — already at the ref but unhealthy means we still recreate. A failing
 * `docker inspect` (no such container) → not healthy.
 */
async function isHealthy(): Promise<boolean> {
  const status = await run("docker", ["inspect", "--format", "{{.State.Status}}", CONTAINER_NAME]);
  if (status.code !== 0 || status.stdout.trim() !== "running") return false;
  const health = await run("docker", [
    "inspect",
    "--format",
    "{{.State.Health.Status}}",
    CONTAINER_NAME,
  ]);
  return health.code === 0 && health.stdout.trim() === "healthy";
}

// --- secret read-back (clients keep working; secrets stay decryptable) ----

/**
 * Read the running container's env (`docker inspect .Config.Env`) into a map,
 * BEFORE the container is removed, so an `update` reuses the existing secrets
 * rather than silently breaking clients or orphaning encrypted settings. Returns
 * an EMPTY map when the container is gone/unreadable (a non-zero inspect) — the
 * caller then mints a fresh agent token and omits the master key. Empty values
 * are dropped (treated as "not present"). The values are returned for reuse on
 * recreate — never logged.
 */
async function readExistingContainerEnv(): Promise<Map<string, string>> {
  const env = new Map<string, string>();
  const result = await run("docker", [
    "inspect",
    "--format",
    "{{range .Config.Env}}{{println .}}{{end}}",
    CONTAINER_NAME,
  ]);
  if (result.code !== 0) return env;
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue; // no `=`, or a leading `=` (no name) → skip
    const name = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (value.length > 0) env.set(name, value);
  }
  return env;
}

// --- thin runner wrappers (teaching errors on a non-zero exit) ----------

/** Run a `git …` command; a non-zero exit is a teaching error. */
async function git(args: string[]): Promise<void> {
  const result = await run("git", args);
  failIfNonZero("git", args, result);
}

/**
 * Check out `ref` in `dir` without letting a `--…`-shaped ref inject a git
 * option (S-1). `git checkout` does NOT honor `--end-of-options` — it reads the
 * marker itself as a pathspec (verified on git 2.43) — so we resolve the ref to
 * a commit SHA with `git rev-parse` (which DOES honor it, the injection guard
 * that works), then check out that SHA — a hex object id can't be an option.
 */
async function checkoutRef(dir: string, ref: string): Promise<void> {
  const resolved = await run("git", [
    "-C",
    dir,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  failIfNonZero("git", ["-C", dir, "rev-parse", ref], resolved);
  await git(["-C", dir, "checkout", resolved.stdout.trim()]);
}

/** Run a `docker …` command from the deploy dir; non-zero exit → teaching error. */
async function dockerInDir(args: string[], cwd: string): Promise<void> {
  const result = await run("docker", args, { cwd });
  failIfNonZero("docker", args, result);
}

/** Stop the old container. A not-running/not-found container is fine (we recreate). */
async function dockerStop(): Promise<void> {
  const result = await run("docker", ["stop", CONTAINER_NAME]);
  if (result.code === 0) return;
  if (isNotFound(result.stderr)) return; // nothing to stop — proceed to rm/run
  failIfNonZero("docker", ["stop", CONTAINER_NAME], result);
}

/**
 * Remove the old CONTAINER (NOT the volume). `docker rm <name>` — never `-v`,
 * never `docker volume rm`. A not-found container is fine (we recreate).
 */
async function dockerRm(): Promise<void> {
  const result = await run("docker", ["rm", CONTAINER_NAME]);
  if (result.code === 0) return;
  if (isNotFound(result.stderr)) return; // already gone — proceed to run
  failIfNonZero("docker", ["rm", CONTAINER_NAME], result);
}

/** Apply pending data-dir migrations inside the (now-healthy) container. */
async function dockerExecMigrate(): Promise<void> {
  const args = ["exec", CONTAINER_NAME, CONTAINER_NAME, "migrate-data-dir"];
  const result = await run("docker", args);
  failIfNonZero("docker", args, result);
}

/** True when a docker error means the container simply isn't there. */
function isNotFound(stderr: string): boolean {
  return /no such container|no such object|is not running/i.test(stderr);
}

function failIfNonZero(cmd: string, args: string[], result: RunResult): void {
  if (result.code === 0) return;
  // Redact in case a non-zero docker step echoed a secret-shaped line.
  const detail = redactSecrets(result.stderr.trim() || result.stdout.trim());
  throw new UpdateError(
    `\`${cmd} ${args[0]}\` failed (exit ${result.code ?? "signal"})` +
      (detail ? `:\n${detail}` : ".") +
      "\n\nResolve the error above, then re-run `librarian server update`.",
  );
}

// --- success report ------------------------------------------------------

/**
 * The success report. `freshToken` is non-null ONLY when we had to mint a new
 * agent token (the old container's token was unreadable) — then we surface it
 * ONCE with a clients-must-update note. When the existing token was reused,
 * nothing about the token is printed (clients keep working untouched).
 */
function renderSuccess(ref: string, freshToken: string | null): string {
  const lines = [
    `Updated The Librarian server to ${ref} — the container is healthy.`,
    "The data volume was preserved; pending data-dir migrations were applied.",
  ];
  if (freshToken) {
    lines.push(
      "",
      "NOTE: the previous container's agent token could not be read back, so a " +
        "FRESH agent token was minted. Existing clients must update their token:",
      `  Agent token: ${freshToken}`,
      "Paste it into `librarian install` / `librarian config --token <token>` on your clients.",
    );
  }
  return lines.join("\n");
}
