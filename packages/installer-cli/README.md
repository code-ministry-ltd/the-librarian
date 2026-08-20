# `@the-librarian/cli` — the `librarian` installer

A small CLI that does two jobs for
[The Librarian](https://github.com/code-ministry-ltd/the-librarian): it **wires it into
your AI agents** (installs/updates the integration for each harness, across all
your machines) and **self-hosts the server** they talk to (`server up` /
`update`). Think of it as the package manager for your Librarian setup: one tool
you keep, driving each harness's **native** install path rather than hand-editing
five config formats.

Harnesses it manages: **Claude Code, Codex, OpenCode, Hermes, Pi.** For the
server side, see [Self-host the server](#self-host-the-server).

## Install

Run it straight from npm with `npx` — no global install needed:

```sh
npx @the-librarian/cli install
```

Prefer a persistent command? Install it globally once and call `librarian`
directly:

```sh
npm i -g @the-librarian/cli
librarian install
```

That's it — any harness you'd install into already has Node, so there's no
bootstrap script. `librarian install` with no args opens the interactive
multi-select and prompts once for your MCP URL + token; pass harness ids to
target specific ones. Re-run it any time to add a harness.

## Commands

```
librarian install   [harness…]   Install into one or more harnesses
                                  (no args → interactive multi-select; prompts
                                  for MCP URL + token once)
librarian uninstall [harness…]   Remove The Librarian from each harness
librarian update    [harness…]   Update the integration to the current version
librarian status                 Live table: harness · installed · version
librarian doctor                 Token set? server reachable? which harness CLIs?
librarian config                 Show or set MCP URL, token, server URL
librarian self-update            Update the CLI itself (coming in a later release)
librarian report                 Push this machine's state to the server
                                  (coming in a later release)

librarian server up              Self-host the server with Docker; prints the
                                  MCP URL + agent token to paste into `install`
librarian server update          Upgrade the server to the latest release
                                  (pulls before stop; data/config are preserved)
librarian server down|status|logs  Stop / inspect / tail the running server
```

Useful flags: `--mcp-url <url>`, `--token <token>` (never printed),
`--shell <bash|zsh|fish>` to override shell detection, `-h/--help`,
`-v/--version`. Harness ids: `claude`, `codex`, `opencode`, `hermes`, `pi`. A
harness whose CLI isn't installed is reported `not-detected` and skipped — not
an error.

## Self-host the server

The Librarian needs a server to talk to. `server up` stands one up with Docker —
it resolves the latest stable release, pulls and verifies the exact published
image, runs its immutable digest, mints your secrets, waits for health, and prints
the MCP URL + agent token to paste into `librarian install`. Stable installs need
Docker but not Git; pass `--ref main` (or another development ref) to use the
Git-backed source checkout and local build path:

```sh
npx @the-librarian/cli server up
```

To close the first-owner setup window on an automated fresh install, arm a
one-shot owner claim at creation time:

```sh
LIBRARIAN_BOOTSTRAP_CLAIM_SECRET="$(openssl rand -base64 48)" \
  npx @the-librarian/cli server up
librarian server admin auth mint-claim --email owner@example.com
```

The secret is validated and stored only in the managed `0600` deploy env-file;
`server update` preserves it. See the
[self-host guide](https://librarian-docs.codeministry.net/deploy-and-operate/self-host/#scripted-first-owner-bootstrap)
for the full claim and recovery ceremonies.

By default the vault lives in a Docker-managed named volume (`librarian_data`).
To keep your data at a path **you** choose — so you can back it up, put it on a
specific disk, or move it between hosts — pass `--data-dir`:

```sh
npx @the-librarian/cli server up --data-dir /srv/librarian
```

With `--data-dir`, the server bind-mounts that directory at `/data` and runs the
container **as the directory's owner**, so the vault stays owned by — and
writable by — you, not a container user. The directory is created if it doesn't
exist, and `server update` reuses it automatically. (`--data-dir` and
`--data-volume` are mutually exclusive.)

If the curator's LLM is only reachable on a tailnet, pass `--dns 100.100.100.100`
on `server up` or `server update` (the latter works even when the image is
already current). The nameserver is recorded in deploy-state so later updates
keep it. Compose stacks use `LIBRARIAN_DNS` instead.

Other server commands: `server update` pulls and verifies before stopping the old
container, preserving storage, ports, credentials, restart policy, operator DNS
(`--dns`), and deploy state. A failed replacement restores and health-checks the previous executable;
if migration began, persistent data changes are explicitly **not** claimed as
rolled back. `server status` labels deployments as published (with a short
digest), source, or legacy. `server down` / `logs` and `server enable-boot`
(Linux systemd) complete the lifecycle. Run it on a private network / behind a
VPN, or expose it with auth — see the
[deployment guide](https://github.com/code-ministry-ltd/the-librarian/blob/main/DEPLOYMENT.md).

The managed server files live in `~/.librarian/server` by default:
`deploy.env` is protected mode `0600`, while `deploy-state.json` contains only
non-secret configuration and image provenance. Stable registry/network/auth/
architecture failures are teaching errors and never trigger a source-build
fallback. Existing source checkouts are preserved when a deployment adopts a
published image.

## What it writes to your environment

The CLI keeps everything under `~/.librarian/`:

- **`~/.librarian/env`** — a POSIX env file (`chmod 600`, owner-only) holding
  your two secrets:

  ```sh
  export LIBRARIAN_MCP_URL="…"
  export LIBRARIAN_AGENT_TOKEN="…"
  ```

- **`~/.librarian/machine-id`** — a UUID generated on first run, so the same
  setup on different machines stays distinct in the dashboard.

It adds **one** idempotent managed block to your shell rc (`~/.bashrc` /
`~/.zshrc`) that sources the env file:

```sh
# >>> librarian >>>
[ -f "$HOME/.librarian/env" ] && . "$HOME/.librarian/env"
# <<< librarian <<<
```

Fish can't source a POSIX file, so it instead gets a native
`~/.config/fish/conf.d/librarian.fish` with `set -gx`. Re-running any command
replaces the block — it never duplicates. `librarian config` rewrites
`~/.librarian/env`.

## Security

Your agent token is a credential. The CLI treats it like one:

- It's written **only** to `~/.librarian/env`, which is `chmod 600`
  (owner read/write only) — never to a committed or world-readable file.
- It is **never printed** (not in `status`, `doctor`, `config`, or logs) and
  never put in a URL — bearer tokens travel in headers, to the configured
  server, over the configured URL, and nowhere else.

If you ever need to rotate it, re-run `librarian config --token <new>` (or edit
`~/.librarian/env` directly).

> **Avoid `--token <value>` on a shared or audited machine.** A value passed on
> the command line is visible to anyone who can run `ps` while the command runs,
> and it lands in your shell history. Prefer entering the token at the
> interactive prompt — `librarian install` reads it with the echo **muted**, so
> it never appears on screen, in `ps`, or in history — or edit the `chmod 600`
> `~/.librarian/env` file directly.
