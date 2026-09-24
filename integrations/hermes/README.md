# The Librarian — Hermes Memory Provider

A [Hermes Agent](https://github.com/NousResearch/hermes-agent) **Memory
Provider** backed by The Librarian: durable cross-session memory and
cross-harness handoffs, proxied to a Librarian HTTP MCP server you point at
(local or remote). Python ≥ 3.11, **stdlib-only at runtime** (no pip
dependencies).

## What you get

- **The 7-verb agent surface** as Hermes tools — `recall`, `remember`,
  `flag_memory`, `store_handoff`, `list_handoffs`, `claim_handoff`,
  `search_references`. Each call is proxied over HTTP MCP (`tools/call`),
  auto-scoped to your configured `agent_id` (and `project_key` for handoffs),
  with memory ids surfaced so the flag-after-recall loop works.
- **Targeted correction review** — `flag_memory` queues an asynchronous review:
  a safe exact claim may be removed or proposed, while unsafe cases stay
  flagged. Its response reports queue status, not completion; whole-memory
  Archive remains a separate human action.
- **The primer in the system prompt** — `system_prompt_block()` returns the
  operator-editable primer fetched from the server's `GET /primer.md`
  (cached per session). The primer teaches the recall/remember loop and the
  handoff / learn / private-mode protocols, so no per-harness prompt code is
  needed.
- **Automatic per-turn capture** — after every completed turn Hermes hands the
  provider both halves of the exchange (`sync_turn`), and the adapter ships that
  as a delta to the server's `POST /transcript` door for the curator to mine for
  durable memories. Default-on; opt out with `LIBRARIAN_AUTO_SAVE=false`.
  Forward-only private mode is honoured (a `[librarian:private=on]` exchange and
  every exchange until `[librarian:private=off]` is never shipped), the
  conversation is keyed by Hermes' own session id (concurrent sessions never
  collide), and it is fully fail-soft — a Librarian outage never blocks a turn.
  Private mode is an in-conversation instruction; the server cannot verify its
  marker. A correction job queued by a flag from public context may still finish
  after switching private; the toggle does not cancel queued work.
- **Optional slash commands** — `/handoff`, `/takeover`, `/learn`,
  `/toggle-private`: thin prompt templates over the same protocols, registered
  only when the plugin is also enabled as a general plugin. Nothing is lost
  without them; the primer is the canonical definition.
- **Fail-soft everywhere** — if the Librarian is unreachable, the primer
  degrades to empty, tool calls return a JSON error envelope
  (`{"ok": false, "error": {...}}`), and a turn is never blocked.

## Install

### The easy way — the Librarian CLI (recommended)

```sh
npx @the-librarian/cli install      # choose Hermes; paste your MCP URL + token
npx @the-librarian/cli update       # later: refresh the provider
```

`install` copies the provider into `~/.hermes/plugins/librarian` and sets
`memory.provider = librarian` in your Hermes config for you. Run it with `npx`,
or `npm i -g @the-librarian/cli` once and call `librarian install` /
`librarian update` directly. Prefer to wire it by hand? See below.

### Manual setup

The plugin is the `librarian/` directory in this folder — Hermes loads memory
providers by directory scan, not pip. Per the `MemoryProvider` ABC: *"Plugins
ship in `plugins/memory/<name>/` and are activated via the `memory.provider`
config key."*

```sh
# 1. Put the package where Hermes scans for plugins:
cp -r integrations/hermes/librarian ~/.hermes/plugins/librarian
#    (or plugins/memory/librarian/ inside a hermes-agent checkout)

# 2. Provide the bearer token (never stored in config files):
export LIBRARIAN_AGENT_TOKEN="<your-agent-token>"

# 3. Activate + configure:
hermes memory setup          # pick "librarian", enter the endpoint
#    — or set the config key directly: memory.provider = librarian

# 4. (Optional) the slash commands:
hermes plugins enable librarian
```

## Configure

`hermes memory setup` collects (non-secret values land in
`$HERMES_HOME/librarian-plugin/config.json`, mode 0600):

| Field | Required | Notes |
| --- | --- | --- |
| `endpoint` | yes | Librarian HTTP MCP URL, e.g. `https://librarian.example.com/mcp` |
| `token` | yes | Bearer token — read from the `LIBRARIAN_AGENT_TOKEN` env var; never written to disk by this plugin |
| `agent_id` | no | Canonical agent id (omit if the token is agent-bound server-side) |
| `project_key` | no | Default project scope injected into handoff calls (memories are project-less) |
| `timeout_ms` | no | Per-call timeout (default 15000) |

The primer is fetched from `GET <server>/primer.md` (derived from the
endpoint's origin). That endpoint is deliberately unauthenticated server-side,
so the primer fetch sends no credentials.

### Remote Librarian

The Librarian's no-auth mode is **localhost-only**, so a remote endpoint
**must** carry a token over **HTTPS**. The client never follows redirects and
sends the token only in the `Authorization` header of tool calls.

## Development

```sh
cd integrations/hermes
pip install -r requirements-dev.txt
pytest
```

The suite is network-free (injected transports stand in for the HTTP server)
and includes a parity test that checks the advertised tool schemas against the
server's source of truth in `packages/mcp-server/src/mcp/tools/`. CI runs it
via `.github/workflows/hermes-tests.yml`.
