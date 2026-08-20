---
title: Self-host
description: Run and operate your own Librarian server with the one-command CLI.
---

The Librarian runs as one small self-hosted server. The lowest-friction way to run
it is the `librarian server` command group, which drives an all-in-one Docker
container end to end — it pulls and verifies the exact stable image, manages your
data, mints your secrets, waits for health, and prints the values you paste into
clients. You never hand-write a `docker run` for the happy path.

This page is the operator reference. If you just want to get started, the gentler
[Install](/start-here/install/) walkthrough is the place to begin. Prefer to drive
Docker yourself? See [Manual deployment](/deploy-and-operate/manual-install/).

## Standing it up

On a host with native Docker (Git is not required for a stable release):

```sh
npx @the-librarian/cli server up
```

`server up` does the following:

1. **Pulls and verifies.** It resolves the latest stable GitHub release, pulls its
   exact `ghcr.io/code-ministry-ltd/the-librarian:vX.Y.Z` image, verifies its OCI
   metadata and `linux/amd64` platform, matches its source commit to the GitHub tag,
   and matches its digest to the release's `docker-image-digest.txt` receipt. It
   runs the verified repository digest, never the mutable `latest` tag.
2. **Runs and health-checks.** It starts the all-in-one container on a named data
   volume (`librarian_data`), waits for **both** the MCP server and the dashboard to
   report healthy, and rolls back if they don't — your data volume is never touched
   on a failed start.
3. **Mints the master key.** It generates the master key and writes it, with the
   agent token, into a `0600` env-file kept **off** the data volume, then runs the
   container from that file. The key is shown **once** with a `SAVE THIS KEY`
   warning. Copy it now — it is excluded from backups, so without it you cannot
   decrypt a restored backup later.
4. **Prints the connection details.** The MCP URL (`http://<host>:3838/mcp`), the
   dashboard URL (`http://<host>:3042` by default — see `--dashboard-port` below),
   and a fresh agent token. Paste the MCP URL and token into `librarian install`
   on each client.
5. **Optionally configures this machine.** It offers to write this box's own client
   config, so a single-machine setup is done in one shot.

The managed deploy directory is `~/.librarian/server` by default (`--dir`
overrides it). `deploy.env` contains the protected runtime credentials and is mode
`0600`; `deploy-state.json` contains only non-secret configuration and provenance,
including whether the deployment is `registry` or `source`, its readable image
reference, and the immutable digest for a published release. A fresh stable install
does not clone the repository. If an older source-managed deployment already has a
checkout there, adopting a published release preserves it; the CLI never deletes it
automatically.

:::caution[Use native Docker, not the snap package]
`librarian server` requires **native Docker** (Docker CE / `docker.io`). It does
**not** work on snap-packaged Docker (common on Ubuntu, especially inside LXC),
whose sandboxing breaks image/container inspection and hides container health in
ways that surface as confusing, unrelated-looking failures. On Ubuntu/LXC, install
the official Docker CE packages instead (and enable LXC nesting first if you're in
an unprivileged container). With native Docker, no extra flags are needed.
:::

## Reaching it from other machines (`--host`)

By default the server binds to `127.0.0.1` — reachable only from the machine it runs
on, where it runs with a localhost no-auth bypass. To reach it from elsewhere, pick a
bind address:

- `--host <address>` binds a specific reachable address, such as a Tailscale IP. An
  interactive `up` even offers a detected Tailscale address; it never binds beyond
  localhost without your say-so.
- `--host 0.0.0.0` binds **all** interfaces. This is ask-first — a plain `up` prompts
  before exposing everything (`--yes` auto-accepts). `0.0.0.0` is a bind directive,
  not an address to connect to; point clients at the machine's real LAN or tailnet
  IP.

Binding beyond localhost publishes **two** ports on that host: the **agent** surface
on `:3838` (`/mcp`, `/healthz`, `/primer.md`), gated by the agent token, **and the
admin dashboard on `:3042`** (the default; `--dashboard-port` changes it). The
decrypted-secrets admin *API* itself stays off the
network — it runs on a separate internal listener and a request to the published port
just 404s — but the dashboard that drives it is exposed too, and **dashboard login is
off by default**. Reaching the dashboard is reaching admin power, so protect it: keep
the host on a private/tailnet network **and** turn on owner login — see
[Authentication & secrets](/deploy-and-operate/auth-and-secrets/). **Put both published
ports behind TLS** (a reverse proxy) on any host reachable beyond loopback.

The `librarian server up` command deliberately keeps this established two-port
default. Operators who need a single public HTTPS port can use the all-in-one image
or Compose directly with the opt-in dashboard proxy; the complete recipe is in
[Manual deployment: one published port](/deploy-and-operate/manual-install/#one-published-port).

## Where your data lives (`--data-dir`)

By default the vault lives in a Docker-managed named volume. To keep it at a host
path **you** control — to back it up with your own tooling, put it on a particular
disk, or move it between hosts — pass an absolute directory:

```sh
librarian server up --data-dir /srv/librarian
```

This bind-mounts that directory at the container's `/data` and runs the container as
the directory's owner, so the vault stays owned by — and writable by — you. The
directory is created if absent. `--data-dir` and `--data-volume` are mutually
exclusive, and later `update` / `down` / `status` reuse your choice automatically.
Whichever you pick, the data is sacred: recreating the container never touches it.

To move an existing named-volume deploy onto a host directory, copy the volume's
contents across first, then re-`up` with `--data-dir`.

## Choosing the dashboard port (`--dashboard-port`)

By default the dashboard is published on host port **3042**. (3000 — the old
default — collides with almost every other Node/Next app on a dev box, so a fresh
`up` now uses 3042.) To publish it somewhere else:

```sh
librarian server up --dashboard-port 8080
```

Only the **published** host port changes; the container still listens on 3000
internally, so nothing else moves. The port must be a whole number from 1 to 65535
and may not be `3838` (the agent/MCP port already lives there). Your choice is
recorded in the deploy state, so `update` and auto-update reuse it automatically —
re-run `up --dashboard-port <n>` to change it later.

:::note[Existing servers keep `:3000`]
A server first brought up before 3042 became the default keeps publishing on
`:3000` across updates — its port is pinned, so an auto-update never moves it out
from under you. Run `up --dashboard-port 3042` (or any port) to opt into a change.
:::

## Reaching a tailnet-only LLM (`--dns`)

The container's default resolv.conf is Docker's public resolvers. A curator LLM
provider that exists only on your Tailscale tailnet (a Tailscale-Serve hostname)
fails with `ENOTFOUND` from inside the container while the same URL works on the
host. Pointing the curator at the `100.x` IP is not a workaround: Serve TLS needs
the hostname (SNI).

Give the container the Tailscale resolver:

```sh
librarian server up --dns 100.100.100.100
# existing deploy — works even when you are already on the latest image:
librarian server update --dns 100.100.100.100
```

`--dns-fallback 8.8.8.8` is optional. The container's resolver (c-ares) never
consults a later nameserver after an NXDOMAIN, so the Tailscale resolver must
come **first**; MagicDNS already forwards public lookups, so the single resolver
usually suffices. `--no-dns` returns to Docker's default. Unset, nothing
changes — there is no Tailscale default, because that resolver adds latency on
hosts that are not on a tailnet.

The choice is recorded in deploy-state, so later `update` / auto-update reuse it.
A same-version `update` with no DNS flags does **not** no-op past a *new* `--dns`
the way it no-ops an unchanged image; that is how an already-current server picks
this up. Compose stacks use `LIBRARIAN_DNS` instead — see
[Manual deployment](/deploy-and-operate/manual-install/).

## Scripted first-owner bootstrap

The normal first run is still the dashboard's **Settings → Auth** wizard. For an
automated or remotely provisioned deployment, you can instead arm a one-shot owner
claim. While the claim is pending, every protected dashboard route — including the
otherwise-open auth settings page — redirects to `/claim`. A visitor without a signed
claim cannot take ownership.

### Arm, mint, and claim

1. Generate a fresh secret and put it in the **MCP server's** environment as
   `LIBRARIAN_BOOTSTRAP_CLAIM_SECRET`, then start or restart the server. For a
   fresh managed install, arm it in the same command that creates the container:

   ```sh
   LIBRARIAN_BOOTSTRAP_CLAIM_SECRET="$(openssl rand -base64 48)" \
     npx @the-librarian/cli server up
   ```

   `server up` validates the value, stores it only in the managed `0600`
   `~/.librarian/server/deploy.env`, and keeps it off argv and command output.
   `server update` preserves it, including when the old container cannot be
   inspected. The value must be at least 32 characters. Leaving it unset on a
   fresh install keeps the feature completely dormant. For Compose, put the value
   in the root `.env`; an absent or empty value is dormant.

2. In the same armed environment, mint a short-lived link:

   ```sh
   the-librarian auth mint-claim --email owner@example.com
   ```

   The default lifetime is 15 minutes. `--ttl-minutes <n>` accepts 1–1440, and
   `--return-to https://console.example.com/claimed` sends the signed-in owner back
   to a provisioner after success with a signed receipt. In the managed all-in-one
   container, use
   `librarian server admin auth mint-claim --email owner@example.com`.

3. Prepend the dashboard's HTTPS origin to the printed `/claim?token=…` path and open
   it. The email is fixed by the signed token; set a password of at least 12
   characters. On success The Librarian creates the owner, enables enforcement,
   writes `${LIBRARIAN_DATA_DIR}/bootstrap-claim.json` with mode `0600`, and signs
   the owner in. A second token is refused even if the flag is lost, because an
   already-enabled instance independently refuses ownership claims.

   Claim submissions are throttled per best-effort client IP. A client over the
   dashboard's in-process window receives an actual HTTP `429` from the dedicated
   claim route; the signed, one-shot token remains the authoritative gate.

The token is a short-lived, single-use credential carried in a query string. That is
convenient for a browser handoff, but it can remain in browser history and edge access
logs. Keep the default 15-minute lifetime where possible and send the link only to
the intended owner. The managed CLI keeps the secret in its protected deploy file
so updates can recreate the container safely; after a successful claim it is inert
because both the burn flag and enabled-owner gate refuse every further token.
Manually managed deployments may remove it from their persisted environment and
recreate the container. The burn flag and enabled-owner gate remain authoritative
either way.

### Re-arm after owner lockout

Re-arming deliberately requires host access. Do these steps together during a
maintenance window so only the intended claimant receives the fresh link:

1. Delete `${LIBRARIAN_DATA_DIR}/bootstrap-claim.json`.
2. Run `the-librarian auth disable` (or
   `librarian server admin auth disable`) against the same data directory.
3. Replace `LIBRARIAN_BOOTSTRAP_CLAIM_SECRET` with a **new** 32+ character value and
   restart the server.
4. Mint and redeem a fresh claim as above.

Disabling does not erase the old password. The fresh claim safely overwrites it before
re-enabling enforcement. Deleting only the flag is not enough: an instance whose auth
is still enabled refuses claims. Disabling only auth is also not enough: the durable
burn flag refuses claims until the operator removes it.

## Keeping it running and up to date

- **`server update`** re-pins forward: resolve the latest stable release, pull and
  verify its exact image while the current server keeps serving, then recreate the
  container by immutable digest. Storage, host/ports, credentials, restart policy,
  bootstrap-claim secret, operator DNS (`--dns`), and legacy dashboard-port choices
  are preserved. Pending
  data migrations run only after the replacement is healthy. Once the target
  release is resolved, an already-current, healthy deployment is a no-op before
  pulling it again, **unless** you pass `--dns` / `--no-dns` that differs from
  what is stored and running; an exact `--ref vX.Y.Z` also avoids resolving the
  latest release.
- **`server down`** stops the container with `docker stop` only. It never removes the
  container or the volume; a later `up`/`update` recalls the same memories.
- **`server status`** reports whether it's running, its health, the deployed and
  latest versions, and an up-to-date / update-available badge. Provenance appears as
  `published vX.Y.Z (<short-digest>)`, `source <ref>`, or `legacy <ref>`; offline or
  unresolvable values degrade to `unknown` rather than crashing. Normal state-backed
  status does not need Git.
- **`server logs [-f] [--service mcp|dashboard|all]`** tails the container logs;
  `-f` follows live and `--service` filters the stream.
- **`--ref vX.Y.Z`** selects that exact published release. With no `--ref`, the CLI
  resolves the latest stable release. **`--ref main` and every other branch, tag, or
  commit are development targets:** they require Git, use the managed checkout, and
  build a local source image. A registry, authentication, network, provenance, or
  unsupported-architecture failure is reported with recovery guidance; it never
  silently falls back to a source build.

### Update recovery

`server update` finishes the pull or source build and prepares protected credentials
before it interrupts the old container. It captures the old immutable image and
complete run configuration, then replaces the container under the update lock. If
the replacement fails to start or become healthy, the CLI recreates the previous
executable and configuration, verifies it is healthy, and leaves deploy state
unchanged.

That recovery restores the executable, **not a historical copy of `/data`**. If a
failure happens after a migration begins, the message states that persistent data
changes were not rolled back. If restoring the old executable also fails, the CLI
does not claim success: it preserves the data, protected credentials and state,
reports both failures, and prints commands using immutable container/image IDs for
manual recovery. Follow those commands before retrying; do not delete the named
volume, bind mount, deploy files, or protected recovery env file.

### Automatic updates

`server update` is manual. To have the server keep itself current, install the
host auto-update timer — **on the machine running the server, as the user who
ran `server up`**:

```sh
librarian server autoupdate enable                   # daily due-check (default)
librarian server autoupdate enable --cadence weekly
```

This installs a systemd timer (or an hourly cron line where systemd is absent)
that fires hourly and performs a `server update` when the cadence says one is
due. The timer runs as the enabling user against their deploy dir — which is
why the user matters: `enable` refuses, with an explanation, if it can't find
the deploy state where it's looking. A due update resolves, pulls, and verifies
the exact stable release and does not invoke Git or a local build; this also lets
an older source-built deployment adopt the published image in place.

The dashboard's [Settings → Dashboard](/dashboard/settings/#dashboard) page
holds the enable toggle and the cadence as *settings*; the host timer is what
acts on them. Flipping the toggle without installing the timer updates nothing
— the dashboard can't recreate the server's own container from inside it.

- **`autoupdate status`** — is the timer installed, is the setting on, the
  cadence, the last auto-update, and the up-to-date badge.
- **`autoupdate disable`** — flips the setting off; the timer stays installed
  and the next fire no-ops.
- **`autoupdate uninstall`** — removes the timer/cron entirely.

A failed auto-update is fail-soft and retries at the next fire. A pull or
verification failure leaves the current container serving; a replacement failure
uses the same executable-recovery contract as manual `server update`.

:::note[If auto-update seems to do nothing]
The timer logs one line per hourly fire to the **system** journal, which needs
sudo to read:

```sh
sudo journalctl -u the-librarian-autoupdate.service -n 20 --no-pager
```

That line says exactly what happened: not due yet, skipped, updated, or why an
update failed. If the timer was installed by a CLI older than v1.17.1, it ran
as root against root's home and every fire failed with "No deploy-state found"
— upgrade the CLI and re-run `librarian server autoupdate enable` as the user
who ran `server up`.
:::

### Start on boot (Linux)

`librarian server enable-boot` (or `server up --enable-boot`) installs a systemd unit
so the container starts on boot. The unit references the existing container and
carries **no secret** — your agent token is never written into the world-readable
unit file. `server disable-boot` reverses it. (macOS boot persistence is deferred;
those commands print a "Linux-only for now" notice and skip cleanly — start the
server manually with `server up`.)

## Admin from the host (`server admin`)

`librarian server admin <command>` runs the bundled admin tool **inside** the
container, so it works even when the dashboard is locked — which is exactly what
makes recovery reliable:

- **`backup`** — push the vault to your configured GitHub backup remote.
- **`restore`** — clone the backup remote back into the data dir. It needs the master
  key (supplied with `--secret-key`, or prompted for with the echo muted), since the
  key is excluded from backups by design. Use `--force` to replace a populated vault.
- **`auth status | reset-password | mint-claim | disable`** — set up or recover
  dashboard login from the host shell (mint a first-owner claim, clear a lockout, set
  a new password, or break-glass disable enforcement) without the UI.
- **`rebuild`** — regenerate the in-memory recall index from the vault.

## Checking health from the command line

```sh
pnpm run healthcheck -- --remote http://<host>:3838 --agent-token "$LIBRARIAN_AGENT_TOKEN"
```

In `--remote` mode this probes `/healthz` reachability and `/mcp` authentication
against a running server — handy after an update or for monitoring.

## What `server` does not drive

`librarian server` manages the all-in-one container only. The two-container Docker
Compose stack stays the manual/advanced path — use it when you want the split
mcp-server and dashboard processes, or Compose-native operations. See
[Manual deployment](/deploy-and-operate/manual-install/).
