# The Librarian

![The Librarian](./assets/The%20Librarian.png)

[![CI](https://github.com/code-ministry-ltd/the-librarian/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/code-ministry-ltd/the-librarian/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@the-librarian/cli?color=3f9c8e&label=npm)](https://www.npmjs.com/package/@the-librarian/cli)
[![npm downloads](https://img.shields.io/npm/dw/@the-librarian/cli?color=3f9c8e)](https://www.npmjs.com/package/@the-librarian/cli)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Website](https://img.shields.io/badge/website-codeministry.net-3f9c8e)](https://codeministry.net/the-librarian/)

> **[Project site →](https://codeministry.net/the-librarian/)** — what The Librarian is, how it works, and why you'd want it.

**The Librarian is a living, markdown-native knowledge graph for AI agents — with
a resident curator that tends it.** It is a markdown+git vault of three note
types — **memories**, **handoffs**, and **references** — linked into a graph by
`[[wikilinks]]`; a resident "librarian" curates the collection as it grows,
filing each new memory where it belongs, linking it to its neighbours, and
organising the whole for *retrieval*, not just storage. It's all plain files you
can read, edit, and reorganise yourself (in the dashboard or in Obsidian); git
gives it history; nothing is locked in a database.

Practically, that makes it a portable **memory + handoff layer for AI agents**:
served to any harness over MCP as **7 verbs**, taught to agents by one ≤2KB
**primer**, with an explicit **cross-harness handoff surface** so work started
in one harness (Claude Code, Codex, Hermes, OpenCode, Pi) can be packaged into a
single document and picked up cleanly in another.

It runs as a small self-hosted server, reachable locally or over the network.

## Self-host in one command

The `librarian` CLI's `server` command group stands up the server for you — it
builds and runs the all-in-one container, surfaces the master key once, and hands
you the MCP URL + agent token to paste into clients. Run it with `npx` — no
install needed:

```sh
npx @the-librarian/cli server up
```

(Or `npm i -g @the-librarian/cli` once and call `librarian server up` directly,
if you'll run it often.)

Want the data at a path you choose — to back it up, put it on a specific disk, or
move it between hosts? Add `--data-dir`; it bind-mounts a host directory at `/data`
and runs the container as its owner, so the vault stays yours to read and write:

```sh
npx @the-librarian/cli server up --data-dir /srv/librarian
```

`server up`/`update`/`down`/`status`/`logs`, Linux boot persistence
(`enable-boot`), and host-side admin (`server admin backup|restore|auth|rebuild`)
are all covered in the
[self-host guide](apps/docs/src/content/docs/deploy-and-operate/self-host.md) in
the docs site.

> **Use native Docker, not the snap.** `librarian server` is unsupported on
> snap-packaged Docker (common on Ubuntu / LXC) — its confinement breaks the build
> and hides container health. Install Docker CE. See the
> [self-host guide](apps/docs/src/content/docs/deploy-and-operate/self-host.md).

Prefer to operate Docker yourself? The same all-in-one server and dashboard is
published at `ghcr.io/code-ministry-ltd/the-librarian`. Pull `:latest` for a
quick first run, or pin a `:vX.Y.Z` release for reproducible upgrades and
rollbacks. An image-only Compose file and protected env-file template are in
[`docker/`](./docker); see [Manual deployment](apps/docs/src/content/docs/deploy-and-operate/manual-install.md)
for the two-command lifecycle.

## Install on any harness

Once your server is running, the `librarian` CLI wires The Librarian into your
harnesses and keeps them up to date — the package-manager-style tool you keep.
It covers all five harnesses (Claude Code, Codex, OpenCode, Hermes, Pi), drives
each one's native install path, and wires automatic capture where supported. Any
harness already has Node, so one command does it:

```sh
npx @the-librarian/cli install      # wire your harnesses; prompts for the MCP URL + token
npx @the-librarian/cli update       # later: bring every installed integration up to date
```

(Or install it globally once — `npm i -g @the-librarian/cli` — then run
`librarian install` / `librarian update` whenever you add or refresh a harness.)

See [`packages/installer-cli`](./packages/installer-cli/README.md) for the
full command reference and what it writes to your environment.

## Harness integrations

`librarian install` above wires all five for you; this section is the manual
reference for each. Run the server, then add one config block per harness. Claude
Code, Codex, and OpenCode need **no plugin code at all** — the MCP config (plus,
for OpenCode, one `instructions` line pointing at the server's `GET /primer.md`)
is a full integration. Hermes and Pi get thin in-tree adapters. Each harness's
exact config and install steps live in its README:

| Harness | Integration | Shape |
|---|---|---|
| Claude Code | [`integrations/claude`](./integrations/claude) | MCP config; optional plugin adds 4 slash commands |
| Codex | [`integrations/codex`](./integrations/codex) | MCP config block in `~/.codex/config.toml` — no code |
| OpenCode | [`integrations/opencode`](./integrations/opencode) | MCP config + one remote-URL `instructions` line — no code |
| Hermes | [`integrations/hermes`](./integrations/hermes) | Python MemoryProvider (stdlib-only) proxying the 7 verbs |
| Pi | [`integrations/pi`](./integrations/pi) | Pi extension: primer hook + 7 native tool proxies |

All five teach the model the same protocols: the primer rides each harness's
thinnest native channel (MCP `instructions` where honored, a one-hook adapter
where not), and the 7 tools carry protocol-bearing descriptions that render in
every harness.

## Features

- **Durable memory** — `recall` / `remember` / `flag_memory` over one shared,
  curated corpus with project-key scoping and a three-state
  (`active` / `proposed` / `archived`) model.
- **Cross-harness handoffs** — `store_handoff` packages the work in a
  five-section document; `claim_handoff` claims it atomically in another
  agent / harness.
- **References** — long-form background material (specs, papers, manuals)
  uploaded by the admin, chunk-indexed with persistently cached embeddings so a
  500KB document is searchable end-to-end via `search_references` — deliberately
  *not* auto-recalled.
- **Memory curator** — one curator, one prompt core, one apply rule: routine
  operations (`create`/`update`/`merge`) auto-apply above a single confidence
  threshold; destructive ones (`archive`/`split`) always become human-reviewed
  proposals.
- **Dashboard as the complete admin surface** — memory browser, proposal +
  flag queues, curator config/chat/run history, **vault explorer/editor**
  (Obsidian-lite: tree, rendered markdown, wikilinks, backlinks, validated
  editing), and **history/diff/rollback** backed by the server-owned git repo —
  operators never need git or Obsidian.

Markdown-native and dependency-light: memories are plain `[[wikilinked]]` notes
in a git-backed vault, recall runs over a disposable in-memory index (keyword +
vector + backlinks, RRF-fused) rebuilt from the vault — no external database to
run.

## Quick start

The fastest path is the one-command self-host above, then `librarian install` to
wire your harnesses. The full getting-started walkthrough — stand up a server,
connect your first agent, and verify it — is in the docs site:
**[Install](apps/docs/src/content/docs/start-here/install.md)** and
**[First run](apps/docs/src/content/docs/start-here/first-run.md)**.

Prefer to drive Docker yourself (single container, Compose, or Fly)? See
**[Manual deployment](apps/docs/src/content/docs/deploy-and-operate/manual-install.md)**.
For working on The Librarian itself (local two-service dev, tests, lint), see
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Configuration

A fresh install needs **zero** auth/secret env vars. Auth and secrets are managed
from the dashboard at **`/settings/auth`** (password and/or GitHub/Google),
enforced without a redeploy. The **agent token is the network auth boundary**;
there is no admin token (the admin tRPC API is served only on a trusted internal
listener, never the published port — ADR 0008).

The full picture — the auth model, dashboard owner-login and lockout recovery, and
the master-key externalization ladder — lives in
[Authentication & secrets](apps/docs/src/content/docs/deploy-and-operate/auth-and-secrets.md)
in the docs site.

## MCP tools — the 7-verb agent surface

Agents talk to the Librarian over `/mcp` with a bearer token. The surface is
exactly seven tools — contract-tested, with zero internal tools:

### Memory

- `recall` — hybrid search over memories (`active` only by default; pass
  `include_ids: true` for `[mem_…]`-prefixed lines so callers can flag).
- `remember` — fire-and-forget: each submission lands in the curator's intake
  inbox; the curator dedupes, merges, and files it asynchronously.
- `flag_memory` — flag a memory as wrong / misleading / outdated with a
  free-text reason; routes it to review (and soft-demotes it in recall) rather
  than archiving unilaterally.

Memories are `active`, `proposed`, or `archived`. Admin/curatorial ops
(archive, approve, update, list proposals) are **not** agent MCP tools — they
live on the dashboard tRPC surface (ADR 0006).

### Handoffs

- `store_handoff` — store a handoff document (five required headings: *Start &
  intent*, *Journey*, *Current state*, *What's left*, *Open questions*).
- `list_handoffs` — list handoffs in the current project / cwd.
- `claim_handoff` — atomically claim a handoff by id. Claiming is one-shot —
  once claimed, the handoff is closed to other callers.

### References

- `search_references` — search the long-form reference corpus. A separate verb
  by design: references are background material, never auto-recalled.

## Teaching the agent — the primer

Agents are taught by the **primer** — one ≤2KB operator-editable document at
`vault/primer.md`, served at connect time as the MCP `initialize` `instructions`
field and at the unauthenticated `GET /primer.md` endpoint — plus each tool's own
protocol-bearing description. It carries the recall/remember loop, the
handoff/takeover and learn protocols, private mode, and the fail-soft rule. Edit
it from the dashboard's Vault page (the server enforces the 2KB cap). Design:
[`docs/adr/0007-the-rethink.md`](./docs/adr/0007-the-rethink.md).

The four optional slash commands (`/handoff`, `/takeover`, `/learn`, and the
local-only `/toggle-private`) are thin sugar over those protocols — plain language
works identically. Contract: [`docs/slash-commands.md`](./docs/slash-commands.md).
Walkthroughs for operators are in the docs site:
[Handoff & takeover](apps/docs/src/content/docs/guides/handoff-takeover.md) and
[Private mode](apps/docs/src/content/docs/guides/private-mode.md).

## Dashboard

The Next.js admin cockpit (published on port `3042` by default — override with
`server up --dashboard-port`) is the complete operator surface —
**Memories**, **Proposals**, **Flagged**, **Archive**, **Analytics**,
**Handoffs**, the **Curator** cockpit, the Obsidian-lite **Vault** explorer,
**Activity**, **Health**, and **Settings** (auth, backups, connect, curator,
ingest, primer, tokens, dashboard). The dashboard reaches the admin tRPC API over
a trusted internal listener with **no bearer** (ADR 0008) — the published agent
port serves no admin surface, so there is no admin credential to reach the
browser.

A guided, screenshot-backed tour of every area is in the docs site:
[Using the dashboard](apps/docs/src/content/docs/dashboard/index.md).

## CLI

Two CLIs ship with The Librarian: `@the-librarian/cli` (the `librarian` installer
and `server` group — wire harnesses, self-host the server) and the bundled admin
binary `the-librarian` (`rebuild`, `seed`, `backup`, `export`, `auth`, `handoffs`,
`migrate-data-dir`). The admin verbs run from the host shell — directly, or via
`librarian server admin <verb>` inside the container even when the dashboard is
locked. See
[Self-host → admin from the host](apps/docs/src/content/docs/deploy-and-operate/self-host.md).

## Curator and Chronicle

The curator engine does two corpus-maintenance jobs, configured and observed from
**Settings → Curator** and discussed in the dashboard **Curator** cockpit
(`/curator`): **Intake** consolidates each new submission as
it lands (create / update / merge against the corpus), and **Grooming** tends the
existing corpus (dedupe, archive stale, refine) — triggered, not scheduled. Under
**one apply rule** (ADR 0007), `create` / `update` / `merge` auto-apply once the
curator's confidence clears a single threshold (default **0.8**), while `archive`
and `split` — the only operations that destroy or restructure information —
**always** become proposals for human review. The curator's LLM API token is one
of the server's own credentials that `LIBRARIAN_SECRET_KEY` encrypts; the master
key protects those creds, not the vault (your memories stay plaintext markdown by
design; ADR 0008).

The same settings area has a third, independent job: **Chronicle** writes one
searchable weekly review per writable system shelf at
`references/chronicle/YYYY-Www.md`. Its deterministic evidence digest always
works; an optional LLM adds narrative and up to three possible blog seeds. See
[The Chronicle](apps/docs/src/content/docs/guides/chronicle.md).

You teach the curator through use — editing each job's advisory, git-versioned
**addendum** and judging the real proposals it produces. The full operator guide,
including the self-improving loop and the curator chat, is in the docs site:
[Configuring the curator](apps/docs/src/content/docs/guides/configuring-the-curator.md).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the workspace layout, "where to
add what" recipes (new MCP tool / tRPC procedure / dashboard page / CLI verb),
and local test/lint commands.

Architecture decisions live in [`docs/adr/`](./docs/adr/); the active spec and
backlog live in [`docs/`](./docs/).

## License

Apache-2.0.
