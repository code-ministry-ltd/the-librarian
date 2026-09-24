# The Librarian — Claude Code integration

[The Librarian](https://github.com/code-ministry-ltd/the-librarian) gives Claude Code
durable, shared memory and cross-harness handoffs over plain MCP: 7 tools
(`recall`, `remember`, `flag_memory`, `store_handoff`, `list_handoffs`,
`claim_handoff`, `search_references`) plus a ≤2KB primer that Claude Code
loads natively from the MCP server's `instructions` field at connect time.

**The MCP config alone is fully functional.** Claude Code renders the
server's instructions and tool descriptions natively, and those carry every
protocol (the recall/remember loop, the five-section handoff template, the
learn flow, private mode). The plugin below adds only optional sugar: four
slash commands that restate the same protocols as convenient prompts.

Flagging a wrong or outdated memory with `flag_memory` queues targeted
correction review; safe exact claims may be removed or proposed, while unsafe
cases stay flagged. The response reports queue status, not completion, and
whole-memory Archive remains a separate human action.

This integration replaces the standalone
[`the-librarian-claude-plugin`](https://github.com/JimJafar/the-librarian-claude-plugin)
repo (archived). Its old per-turn conv-state injection was retired with the
server's conv_state surface. The plugin now ships a new, fail-soft set of hooks
for **automatic capture** and **awareness** (see
[Automatic capture & awareness](#automatic-capture--awareness) below).

## Install with the Librarian CLI (recommended)

One command wires Claude Code in — the plugin, the MCP config, and the
auto-capture hooks — and keeps it current:

```sh
npx @the-librarian/cli install      # choose Claude Code; paste your MCP URL + token
npx @the-librarian/cli update       # later: pull the latest plugin + hooks
```

`install` drives Claude's native `plugin install`, so you get everything in
[Option B](#option-b--the-plugin-option-a--slash-commands) without the manual
steps; it prompts for the MCP URL and agent token printed by
`librarian server up`. Run it with `npx`, or `npm i -g @the-librarian/cli` once
and call `librarian install` / `librarian update` directly. Prefer to wire it by
hand? The two manual options below do the same thing.

## Option A — plain MCP config (no plugin)

Add the server to any scope you like. Project scope (`.mcp.json` in your
project root):

```json
{
  "mcpServers": {
    "librarian": {
      "type": "http",
      "url": "${LIBRARIAN_MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${LIBRARIAN_AGENT_TOKEN}"
      }
    }
  }
}
```

Or user scope, one command (note this writes the *literal* expanded values
into your user config):

```sh
claude mcp add --scope user --transport http librarian "$LIBRARIAN_MCP_URL" \
  --header "Authorization: Bearer $LIBRARIAN_AGENT_TOKEN"
```

Set the env vars in your shell profile and restart Claude Code:

```sh
export LIBRARIAN_MCP_URL="https://librarian.example.com/mcp"
export LIBRARIAN_AGENT_TOKEN="<your-token>"
```

That's everything. The primer arrives via MCP `instructions` at session
start; the 7 tools appear under the `librarian` server.

## Option B — the plugin (Option A + slash commands)

In Claude Code:

```
/plugin marketplace add code-ministry-ltd/the-librarian
/plugin install the-librarian@the-librarian
```

Set the same two environment variables (above) and restart Claude Code.
The plugin ships the `.mcp.json` from Option A plus four commands:

| Command | What it does |
| --- | --- |
| `/handoff` | Author a five-section narrative and persist it via `store_handoff` for cross-harness pickup |
| `/takeover` | List candidate handoffs (`list_handoffs`), atomically claim one (`claim_handoff`), inject the document |
| `/learn` | Extract durable lessons from the conversation and submit each via `remember` |
| `/toggle-private` | Flip the `[librarian:private=on\|off]` marker — pure in-conversation, no server state; the server cannot verify it, and correction work queued from a public flag may still finish after switching private |

All four are thin prompt templates over the primer protocols — saying
"hand this off" or "go private" in plain language works identically.

### Claude Cowork (desktop app)

Claude Code (CLI) and **Claude Cowork** (the desktop app) share the same plugin
system, so Cowork installs the **same** plugin — no separate adapter. The only
differences are the install surface and how the desktop app reads environment
variables:

1. **Install via the GUI.** Open the Cowork tab → click **Customize** in the
   sidebar → **Browse plugins** → install **The Librarian**. (There is no
   `claude` CLI to drive, so `librarian install` stays CLI-only; Cowork is a
   point-and-click install.)
2. **Set the env vars in the desktop editor, not your shell.** The desktop app
   does **not** inherit `LIBRARIAN_MCP_URL` / `LIBRARIAN_AGENT_TOKEN` from your
   shell profile — it only reads `PATH`. Use the app's local environment editor
   (the environment dropdown next to the prompt box → **Local** → gear icon) to
   add both. The token is only ever sent in the request header.

Because it's the same plugin, the slash commands and the automatic capture +
awareness hooks below are all present in Cowork too.

> **Unverified on the desktop host (as of this writing).** Capture *should* work
> unchanged — it's the identical plugin — but we have not yet confirmed on the
> Cowork desktop app that its plugin host actually fires the per-turn
> `UserPromptSubmit` / `Stop` / `SessionEnd` hooks and hands `on-stop.mjs` a
> payload with `transcript_path` + a stable session id (including whether Claude
> bug [#29767](https://github.com/anthropics/claude-code/issues/29767) manifests
> there too). All hooks are fail-soft, so a desktop divergence degrades to *not
> capturing*, never to a broken turn. See the
> [capability matrix](../../docs/harness-capture-capability.md) for status.

## Automatic capture & awareness

The plugin ships a small set of fail-soft hooks (in
[`hooks/hooks.json`](./hooks/hooks.json) + [`scripts/`](./scripts)) that make the
Librarian the thing your memory flows through, without relying on the agent to
remember the verbs (spec `2026-06-16-harness-auto-capture`, ADR 0009):

| Hook | Script | What it does |
| --- | --- | --- |
| `UserPromptSubmit` (primary), `Stop`, `SessionEnd` | `on-stop.mjs` | Tail the conversation transcript from a byte-offset cursor and ship each turn's delta to the server (`POST /transcript`), which extracts durable lessons for you — **zero agent memory calls**. Driven by `UserPromptSubmit` (primary), with `Stop` / `SessionEnd` wired for redundancy; `SessionEnd` is the explicit-end accelerator (the server extracts immediately instead of waiting out the idle window). The `UserPromptSubmit` routing also worked around Claude bug [#29767](https://github.com/anthropics/claude-code/issues/29767), where plugin-scoped `Stop` hooks didn't fire — since fixed in Claude Code 2.1.179. |
| `PreToolUse` (`Write\|Edit\|MultiEdit`) | `block-memory-write.mjs` | Block writes to Claude's **native memory store** (`**/.claude/**/memory/**`) and redirect you to the `remember` tool — durable facts belong in the shared Librarian, not a local `MEMORY.md` the next session/agent/harness can't see. Narrow by design (only the native store) and **fail-open**. |
| `SessionStart` | `on-session-start.mjs` | Inject a deterministic banner: you have `recall`/`remember`, plus the current **capture status** (warns, with the fix, when capture is off). Re-fires after a compaction, so the awareness survives it. |

**Capture is default-on**, gated two ways:

- **Per-turn private skip.** A turn under `[librarian:private=on]` is never
  shipped (forward-only — a private-then-public sequence never retroactively
  ships the private turns). Private mode is an in-conversation instruction; the
  server cannot verify its marker. A correction job queued by a flag from public
  context may still finish after switching private; the toggle does not cancel
  queued work.
- **`LIBRARIAN_AUTO_SAVE=false`** — the per-machine kill-switch: set it and the
  capture hook ships and buffers nothing on this machine.
- **Server-authoritative** — the server buffers only when its curator intake gate
  (`curator.intake.enabled`, toggled in the dashboard) is on; the SessionStart
  banner warns when it is off.

Every hook is fail-soft: a Librarian/network/parse error never blocks your turn,
never leaks a stack trace into the model's context, and errs toward *not*
capturing. The cursor and a one-line skip log live under
`${CLAUDE_PLUGIN_DATA:-$HOME/.librarian/claude-plugin-data}/`.

For the per-harness status of automatic capture (Claude authoritative and
shipped; Codex and OpenCode ported in Phase 2A with end-to-end verification on
the real runtime pending; Claude Cowork inherits this plugin with desktop
hook-firing unverified; Pi and Hermes tracked in Phase 2B), see the
[harness-capture capability matrix](../../docs/harness-capture-capability.md).

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `LIBRARIAN_MCP_URL` | yes | Librarian HTTP MCP URL, e.g. `https://librarian.example.com/mcp` |
| `LIBRARIAN_AGENT_TOKEN` | yes | Bearer token (only ever sent in the request header) |
| `LIBRARIAN_AUTO_SAVE` | no | Set to `false` to disable automatic capture on this machine (default-on). Anything else (unset, `true`, …) leaves capture on. |

### Remote Librarian

The Librarian's no-auth mode is **localhost-only**, so a remote endpoint
**must** carry a token over **HTTPS**. On the Librarian host:

```sh
LIBRARIAN_HOST=0.0.0.0 LIBRARIAN_AGENT_TOKENS="claude-code:<strong-token>" pnpm run serve
```

Then set `LIBRARIAN_MCP_URL` and `LIBRARIAN_AGENT_TOKEN` to match.

## Troubleshooting

**The `librarian` server doesn't appear in `/mcp`.** Verify both env vars
are set in the shell that launched Claude Code, then test the endpoint
directly:

```sh
curl -X POST "$LIBRARIAN_MCP_URL" \
  -H "Authorization: Bearer $LIBRARIAN_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A healthy response lists exactly 7 tools.

**The agent doesn't follow the protocols.** The primer is served from the
server's `vault/primer.md` (editable in the dashboard); check
`GET <server>/primer.md` returns it. Claude Code truncates server
instructions at ~2KB — the server enforces the same cap on save.

## License

Apache-2.0 (same as the monorepo).
