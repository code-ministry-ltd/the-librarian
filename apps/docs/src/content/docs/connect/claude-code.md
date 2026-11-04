---
title: Claude Code
description: Connect Claude Code to The Librarian — shared memory, handoffs, and automatic capture.
---

[Claude Code](https://www.anthropic.com/claude-code) is Anthropic's command-line
coding agent. It speaks the standard protocol The Librarian uses (MCP), so
connecting it is just a matter of pointing it at your server — no extra plugin
code is required for the core experience.

**When you'd use this:** you run Claude Code and want it to share memory with your
other tools, hand work off, and learn from your sessions automatically.

**Before you start:** you need a running Librarian server, its **MCP URL**, and an
**agent token** — see [Install](/start-here/install/).

## The easy way

One command wires Claude Code in — the connection, the optional slash commands,
and the automatic-capture hooks — and keeps it current:

```sh
npx @the-librarian/cli install      # choose Claude Code; paste your MCP URL + token
npx @the-librarian/cli update       # later: pull the latest version
```

That is all most people need. Restart Claude Code afterwards.

## The manual way

If you'd rather wire it by hand, add the server to Claude Code's MCP config. For a
single project, create a `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "librarian": {
      "type": "http",
      "url": "${LIBRARIAN_MCP_URL}",
      "headers": { "Authorization": "Bearer ${LIBRARIAN_AGENT_TOKEN}" }
    }
  }
}
```

Then set the two values in your shell profile and restart Claude Code:

```sh
export LIBRARIAN_MCP_URL="https://librarian.example.com/mcp"
export LIBRARIAN_AGENT_TOKEN="<your-token>"
```

That wires up memory itself — the **eight tools and the primer**, and nothing more.
The three slash commands and automatic capture ride on the *plugin*, not bare MCP, so
use **The easy way** above if you want those too. The briefing (primer) arrives
automatically at session start.

## What you get

- **Eight memory, handoff and journal tools** — Claude Code can recall, remember,
  flag a wrong memory, store and claim handoffs, search references, and read the
  [journal](/guides/journal/).
- **The primer** — Claude Code reads The Librarian's briefing natively, so it
  knows how and when to use those tools without any prompting from you.
- **Three optional slash commands** — `/handoff`, `/takeover`, and the
  local-only `/toggle-private`. These are convenient shortcuts; saying "hand this
  off" or "go private" in plain English does exactly the same thing.
- **Automatic capture** — Claude Code is the most thoroughly tested harness for
  this. It quietly ships each turn to your server, which extracts durable lessons
  for you. The capture hook ships enabled, but nothing is filed until you switch on
  the curator's **Intake** in the dashboard (**Settings → Curator**) — it is **off
  by default**. Capture skips anything under [private mode](/guides/private-mode/)
  and can be turned off per machine with `LIBRARIAN_AUTO_SAVE=false`.
- **The journal at session start** — when the server's [journal](/guides/journal/)
  is on, each new session (and each session after a compaction) starts with your
  recent entries, newest kept first. Claude Code shows a hook at most 10,000
  characters, so older entries are left out and Claude is told to use the
  `journal` tool for them. Turn it off per machine with `LIBRARIAN_JOURNAL=off`.

## Claude Cowork (the desktop app)

Claude Cowork shares the same plugin system, so it uses the **same** integration —
install it through the app's GUI (**Customize → Browse plugins → The Librarian**)
and set the two environment values in the app's local environment editor rather
than your shell. Automatic capture *should* work unchanged but has not yet been
confirmed on the desktop host; if it diverges it simply does not capture, never
breaking a turn.

## Check it worked

In Claude Code, open the connected-tools view (`/mcp`). A healthy Librarian lists
exactly **seven** tools under `librarian`. If it does not appear, confirm both
environment values are set in the shell that launched Claude Code.

## Full technical reference

For the complete option-by-option setup, the capture hook details, and
troubleshooting, see the
[Claude Code integration README](https://github.com/code-ministry-ltd/the-librarian/tree/main/integrations/claude).
