# The Librarian — Codex integration

[The Librarian](https://github.com/code-ministry-ltd/the-librarian) gives
[Codex](https://developers.openai.com/codex) durable, shared memory and
cross-harness handoffs over plain MCP. **No plugin, no code — one config
block.** Modern Codex speaks streamable HTTP MCP natively and renders the
server's `instructions` field as server-wide guidance alongside the tools,
so the Librarian primer and tool descriptions teach the model everything.

This integration replaces the standalone
[`the-librarian-codex-plugin`](https://github.com/JimJafar/the-librarian-codex-plugin)
repo (archived). Its stdio↔HTTP proxy existed only because older Codex
couldn't take an env-var URL for a remote MCP server, and its hook existed
only for per-turn conv-state injection — both needs are gone (conv_state was
retired server-side; Codex now supports HTTP MCP servers directly).

## Install with the Librarian CLI (recommended)

One command wires Codex in and keeps it current:

```sh
npx @the-librarian/cli install      # choose Codex; paste your MCP URL + token
npx @the-librarian/cli update       # later: refresh the integration
```

`install` writes the `[mcp_servers.librarian]` block for you (via `codex mcp
add`) and installs the auto-capture hooks into `~/.codex/hooks.json`. One manual
step remains: Codex won't **fire** hooks until you enable the feature — add
`codex_hooks = true` under `[features]` in `~/.codex/config.toml` (see
[Automatic capture](#automatic-capture-default-on-with-two-gates)). Run it with
`npx`, or `npm i -g @the-librarian/cli` once and call `librarian install` /
`librarian update` directly. Prefer to wire it by hand? See below.

## Manual setup

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.librarian]
url = "https://librarian.example.com/mcp"
bearer_token_env_var = "LIBRARIAN_AGENT_TOKEN"
```

Or via the CLI (the URL is written into `config.toml` literally; the token
stays an env-var *name*, never a value):

```sh
codex mcp add librarian \
  --url "$LIBRARIAN_MCP_URL" \
  --bearer-token-env-var LIBRARIAN_AGENT_TOKEN
```

Then set the token in your shell profile and restart Codex:

```sh
export LIBRARIAN_AGENT_TOKEN="<your-token>"
```

The `/mcp` panel should now list `librarian` with 7 tools.

Config reference: [Codex MCP docs](https://developers.openai.com/codex/mcp)
— `url` (required), `bearer_token_env_var` (sent as the `Authorization`
header), plus `http_headers` / `env_http_headers` if you need extra headers.

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `LIBRARIAN_AGENT_TOKEN` | yes | Bearer token. Referenced by *name* in `config.toml`; Codex sends it only in the `Authorization` request header. |
| `LIBRARIAN_MCP_URL` | for the CLI one-liner | The Librarian HTTP MCP URL, e.g. `https://librarian.example.com/mcp`. Codex stores the resolved URL in `config.toml`. |

The Librarian's no-auth mode is **localhost-only** — a remote endpoint must
carry a token over **HTTPS**. On the Librarian host:

```sh
LIBRARIAN_HOST=0.0.0.0 LIBRARIAN_AGENT_TOKENS="codex:<strong-token>" pnpm run serve
```

## What you get

**The 7 Librarian tools:**

| Tool | Purpose |
| --- | --- |
| `recall` | Hybrid search over durable memories — call before answering anything with prior context |
| `remember` | Save a durable fact, preference, or decision — fire-and-forget; the curator files it |
| `flag_memory` | Queue targeted correction review for a wrong/outdated memory: a safe exact claim may be removed, a proposal may be created, or an unsafe case may stay flagged. The tool reports queue status, not completion; Archive remains a separate human action. |
| `store_handoff` | Persist a five-section handoff document for another agent to resume |
| `list_handoffs` | List unclaimed handoffs waiting to be picked up |
| `claim_handoff` | Atomically claim a handoff and receive its document |
| `search_references` | Search long-form reference docs (deliberately not auto-recalled) |

**The primer as namespace description:** Codex reads the MCP `instructions`
field returned at initialization and presents it as server-wide guidance
alongside the server's tools. The Librarian serves its ≤2KB primer there
(source: `vault/primer.md` on your server, editable in the dashboard), so
the behavioural loop — recall before answering, remember durable facts,
the handoff protocol, private mode — rides into every Codex session with
zero Codex-side setup.

## Automatic capture (default-on, with two gates)

Beyond the 7 tools, the Codex integration can capture your conversation
**automatically** so durable lessons are extracted with the agent making zero
memory calls (spec `2026-06-16-harness-auto-capture`, Phase 2A). A per-turn hook
ships each turn's delta to the server's `POST /transcript` endpoint, which
redacts, buffers, settles, and runs one curator pass — the **same uniform
contract and server pipeline** the Claude integration uses.

This mirrors the Claude acquisition adapter: Codex fires the same command-hook
events, so the adapter tails the conversation transcript from a per-conversation
byte-offset cursor and ships the new non-private turns, advancing the cursor only
on a server ack (idempotent; fail-soft — a capture error never blocks your turn).

### Enable it

The CLI installer wires the capture hooks for you (it merges them into
`~/.codex/hooks.json` idempotently and copies the adapter under
`~/.librarian/codex-capture`). Codex will not **fire** lifecycle hooks until you
turn the feature flag on — add this to `~/.codex/config.toml` and restart Codex:

```toml
[features]
codex_hooks = true
```

### Gates

- **Per-turn private skip.** A turn under `[librarian:private=on]` is never
  shipped; a private-then-public sequence never retroactively ships the private
  turns (forward-only cursor + per-turn skip).
- **`LIBRARIAN_AUTO_SAVE=false` — the per-machine kill-switch.** Set it in the
  shell that launches Codex and the hook ships nothing and buffers nothing on that
  machine. Anything other than the literal `false` (unset, `true`, …) is
  default-on.
- **`curator.intake.enabled` — the server gate.** The server buffers a delta only
  when its intake gate (toggled in the dashboard) is on; if off it refuses and
  buffers nothing.

### conv_id and concurrency

Capture keys all per-conversation state by a **stable conversation id**, never
`$USER` or `cwd` — two concurrent Codex runs by the same user, or two
conversations in one working directory, must never collide. The id is derived,
degrading gracefully: the hook's `session_id` → the transcript filename → a clean
no-op (capture skips that turn rather than guess a colliding id).

### Native transcript handling

The hook fields and rollout JSONL format are confirmed against Codex 0.144.3.
The adapter captures the canonical user display event and canonical assistant
response item once each. It deliberately ignores the adjacent duplicate records,
developer context, reasoning, and tool traffic, so only visible conversation prose
reaches `/transcript`.

Capture remains fail-soft. A future Codex version with an unknown record or payload
variant—and any malformed complete JSONL record—does not block the user's turn and,
importantly, does not advance the byte cursor. Records larger than the normal 256
KiB batch are read through their line boundary when they fit the safe request
ceiling; still-larger records are held rather than discarded.

Releases through 1.4.1 used the wrong Claude-style parser and could advance a
cursor without reconstructing private-mode state. On upgrade, v1.4.2 locally
replays only the already-consumed prefix to restore that state, then resumes at the
existing offset without uploading the prefix. Codex cursors are retained rather
than age-pruned, because deleting one while its rollout archive still exists would
cause an unwanted restart from byte zero.

## The protocols, in natural language

Codex has no Librarian slash commands — the primer carries the protocols,
and the model drives them from what you say:

| You say… | The agent does |
| --- | --- |
| "hand this off" / "we're done for now" | Authors a five-section document — Start & intent, Journey, Current state, What's left, Open questions — and persists it via `store_handoff` |
| "pick up where I left off" / "what was I doing" | `list_handoffs`, presents the candidates, atomically claims your pick with `claim_handoff`, resumes from the document |
| "save what we learned" | Extracts durable lessons, submits the ones you approve via `remember` (one call per lesson; the curator dedupes and files them) |
| "go private" / "back on the record" | Emits the `[librarian:private=on\|off]` marker — pure in-conversation. While private: no `remember`/`store_handoff`/`flag_memory`; `recall`/`search_references` stay allowed (those queries reach the server's logs). Private mode is an in-conversation instruction; the server cannot verify its marker. A correction job queued by a flag from public context may still finish after switching private; the toggle does not cancel queued work. |
| "what do I know about …" | `recall` |
| "remember that …" | `remember` |
| (a recalled memory was wrong) | `flag_memory(memory_id, reason)` |

The same protocols work identically in every Librarian harness (Claude
Code, OpenCode, Hermes, Pi) — handoffs stored here are claimable there and
vice versa.

## Troubleshooting

**`/mcp` doesn't list `librarian`.** Verify `LIBRARIAN_AGENT_TOKEN` is set
in the shell that launched Codex, then test the endpoint directly:

```sh
curl -X POST "https://librarian.example.com/mcp" \
  -H "Authorization: Bearer $LIBRARIAN_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A healthy response lists exactly 7 tools.

**If the server is down**, the tools fail at the harness level and the
primer tells the agent to continue without memory — your turn is never
blocked.

## License

Apache-2.0 (same as the monorepo).
