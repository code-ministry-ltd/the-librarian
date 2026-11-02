---
title: OpenCode
description: Connect opencode to The Librarian — shared memory and handoffs via two config entries.
---

[opencode](https://opencode.ai) is an open-source terminal coding agent. It
supports The Librarian's standard protocol (MCP) and can load the agent briefing
from a URL, so connecting it takes **two short entries** in its config — no plugin
required for the core experience.

**When you'd use this:** you work in opencode and want shared memory and handoffs
across your tools.

**Before you start:** you need a running Librarian server, its **MCP URL**, and an
**agent token** — see [Install](/start-here/install/).

## The easy way

```sh
npx @the-librarian/cli install      # choose OpenCode; paste your MCP URL + token
npx @the-librarian/cli update       # later: refresh the integration
```

This edits your `opencode.json` (both the tools and the briefing), installs the
optional automatic-capture plugin, and saves your server URL and token.

## The manual way

Add these to your `opencode.json` (global at `~/.config/opencode/opencode.json`,
or per-project), replacing the host with your server:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "librarian": {
      "type": "remote",
      "url": "https://librarian.example.com/mcp",
      "enabled": true,
      "headers": { "Authorization": "Bearer {env:LIBRARIAN_AGENT_TOKEN}" }
    }
  },
  "instructions": ["https://librarian.example.com/primer.md"]
}
```

Set the token in your shell profile and restart opencode:

```sh
export LIBRARIAN_AGENT_TOKEN="<your-token>"
```

The first block adds the eight tools; the `instructions` line loads The
Librarian's briefing. (opencode fetches that briefing with a 5-second timeout — if
your server is down it is simply skipped and your session still starts.)

## What you get

- **Eight memory, handoff and journal tools** — recall, remember, flag,
  store/list/claim handoffs, search references, and read the
  [journal](/guides/journal/).
- **The primer** — loaded into the model's instructions at session start.
- **Plain-language control** — saying "hand this off", "pick up where I left off",
  "save what we learned", or "go private" is the whole interface. Four optional
  command files (`/handoff`, `/takeover`, `/learn`, `/toggle-private`) can be
  copied in if you prefer typed shortcuts.
- **Automatic capture** (optional) — a small opencode plugin can learn from your
  sessions as they happen. It is on by default once installed, skips
  [private mode](/guides/private-mode/), and obeys the `LIBRARIAN_AUTO_SAVE=false`
  kill switch.

## Check it worked

The seven `librarian` tools should appear in opencode. If not, confirm
`LIBRARIAN_AGENT_TOKEN` is exported in the shell that launched it. To check the
briefing serves, open `https://librarian.example.com/primer.md` in a browser (that
one address needs no token).

## Full technical reference

For the exact config schema, sources, and capture details, see the
[OpenCode integration README](https://github.com/code-ministry-ltd/the-librarian/tree/main/integrations/opencode).
