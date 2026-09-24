# The Librarian — Pi extension

A [Pi](https://pi.dev) package that gives the Pi coding agent durable memory and
cross-harness handoffs, backed by a remote
[Librarian](https://github.com/code-ministry-ltd/the-librarian) MCP server.

Pi's core has **no MCP support**, so this extension does the wiring itself: it
registers the Librarian's 7 agent verbs as native Pi tools (each one a thin,
fail-soft proxy over the server's stateless `/mcp` endpoint) and injects the
Librarian primer into the system prompt. One install, zero config files.

## What you get

- **7 tools, identical to every other harness** — `recall`, `remember`,
  `flag_memory`, `store_handoff`, `list_handoffs`, `claim_handoff`,
  `search_references`. Descriptions and schemas mirror the server's
  (a drift-guard test pins them), so the model is taught the same protocol in
  Pi as in Claude Code, Codex, OpenCode, and Hermes. `flag_memory` queues
  targeted asynchronous correction review: a safe exact claim may be removed or
  proposed, while unsafe cases stay flagged. The response reports queue status,
  not completion; whole-memory Archive remains a separate human action.
- **Primer injection** — the operator-editable `vault/primer.md` (≤2KB) is
  fetched once per process from `GET <server>/primer.md` and appended to the
  system prompt via `before_agent_start`.
- **Automatic per-turn capture** — after every completed turn Pi fires
  `agent_end` with the turn's messages in-payload, and the adapter ships the
  non-private prose as a delta to the server's `POST /transcript` door for the
  curator to mine for durable memories. Default-on; opt out with
  `LIBRARIAN_AUTO_SAVE=false`. Forward-only private mode is honoured (a
  `[librarian:private=on]` turn and every turn until `[librarian:private=off]`
  is never shipped, and never retroactively sent), the conversation is keyed by
  Pi's own session id (`getSessionId()` — concurrent sessions never collide,
  never `$USER`/cwd), the seq advances only on a server 2xx ack, the bearer
  token travels in the header only (`redirect:"error"`), and it is fully
  fail-soft — a Librarian outage never blocks a turn or leaks a stack trace.
  Private mode is an in-conversation instruction; the server cannot verify its
  marker. A correction job queued by a flag from public context may still finish
  after switching private; the toggle does not cancel queued work.
- **Four slash commands** (optional sugar): `/handoff`, `/takeover`, `/learn`,
  `/toggle-private` — thin prompt templates that drive the corresponding tool
  flows. See [`docs/slash-commands.md`](../../docs/slash-commands.md).
- **Fail-soft everywhere** — if the Librarian is down, tools return a short
  error string (never a thrown harness error), the primer is skipped, and the
  user's turn is never blocked.

## Install

### The easy way — the Librarian CLI (recommended)

```sh
npx @the-librarian/cli install      # choose Pi; paste your MCP URL + token
npx @the-librarian/cli update       # later: pull the latest extension
```

`install` runs Pi's native `pi install` for you and persists your server URL +
token. Run it with `npx`, or `npm i -g @the-librarian/cli` once and call
`librarian install` / `librarian update` directly. Prefer to wire it by hand?
See below.

### Manual setup

From npm (once published — see "Publishing" below):

```sh
pi install npm:@the-librarian/pi-extension
```

From source (works today):

```sh
git clone https://github.com/code-ministry-ltd/the-librarian
pi install /path/to/the-librarian/integrations/pi
```

(`pi install git:…` of the monorepo root won't work — the package lives in the
`integrations/pi` subdirectory, so install from a local clone path.)

## Configure

Set two environment variables in the shell that launches `pi`:

| Variable | Meaning |
| --- | --- |
| `LIBRARIAN_MCP_URL` | The server's MCP endpoint, e.g. `https://your-librarian/mcp` (auto-capture posts to `/transcript` on the same origin) |
| `LIBRARIAN_AGENT_TOKEN` | A per-agent bearer token issued by your Librarian |
| `LIBRARIAN_TIMEOUT_MS` | *(optional)* per-call timeout for the tool proxies, default `15000` |
| `LIBRARIAN_AUTO_SAVE` | *(optional)* set to `false` to disable automatic capture on this machine (default-on). Anything else (unset, `true`, …) leaves capture on. |
| `LIBRARIAN_PI_DATA` | *(optional)* where the per-session capture state lives, default `$HOME/.librarian/pi-extension-data` |

Without both required variables the extension stays **dormant**: no tools, no
network calls — only the four slash commands register, and they explain what's
missing.

Security posture (inherited from the security-reviewed clients in this family):
the bearer token travels only in the `Authorization` header, redirects are
refused so a 3xx can't carry the token cross-origin, the endpoint scheme is
allowlisted to http(s), and response bodies are size-capped.

## Develop

This package is part of the `the-librarian` pnpm workspace:

```sh
pnpm install
pnpm --filter @the-librarian/pi-extension test        # vitest
pnpm --filter @the-librarian/pi-extension typecheck   # tsc --noEmit
```

The schema-parity suite imports the compiled `@librarian/mcp-server`, which is
built automatically on `pnpm install` (its `prepare` script).

## Publishing

The package is publishable (`"private": false`) and carries the `pi-package`
keyword, so `npm publish` from `integrations/pi/` both releases it and lists it
in Pi's gallery at `pi.dev/packages`. **Publishing is a repo-owner action** —
it is deliberately not part of any automated flow here. Until it's published,
use the "from source" install above.
