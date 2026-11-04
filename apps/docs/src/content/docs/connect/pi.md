---
title: Pi
description: Connect the Pi coding agent to The Librarian with a single extension.
---

[Pi](https://pi.dev) is a coding agent from earendil-works. Pi has no built-in MCP
support, so The Librarian ships a small **extension** that does the wiring itself:
it registers the eight tools natively and adds the agent briefing to the system
prompt. One install, no config files.

**When you'd use this:** you use Pi and want shared memory and handoffs with your
other tools.

**Before you start:** you need a running Librarian server, its **MCP URL**, and an
**agent token** — see [Install](/start-here/install/).

## The easy way

```sh
npx @the-librarian/cli install      # choose Pi; paste your MCP URL + token
npx @the-librarian/cli update       # later: pull the latest extension
```

This runs Pi's native install for you and saves your server URL and token.

:::caution[Pending npm publish]
The easy way installs the extension from npm
(`pi install npm:@the-librarian/pi-extension`), but that package is **not yet
published**. Until it is, use **[The manual way](#the-manual-way)** below — it
installs from a local clone of the repository and works today.
:::

## The manual way

Install the extension from a local clone of the repository (the package lives in a
subdirectory, so install from a path):

```sh
git clone https://github.com/code-ministry-ltd/the-librarian
pi install /path/to/the-librarian/integrations/pi
```

Then set two environment values in the shell that launches `pi`:

```sh
export LIBRARIAN_MCP_URL="https://your-librarian/mcp"
export LIBRARIAN_AGENT_TOKEN="<your-token>"
```

Without both values the extension stays dormant — no tools, no network calls —
and only its three slash commands register, explaining what is missing.

## What you get

- **Eight memory, handoff and journal tools** — identical to every other harness, so Pi is
  taught the same protocols.
- **The primer** — fetched once per process and added to the system prompt.
- **The journal at session start** — when the server's [journal](/guides/journal/)
  is on, your recent entries follow the primer in the system prompt, fetched once
  per session. Turn it off per machine with `LIBRARIAN_JOURNAL=off`.
- **Three optional slash commands** — `/handoff`, `/takeover`,
  `/toggle-private`.
- **Automatic capture** — after each completed turn Pi ships the turn to your
  server for the curator to mine. On by default; opt out per machine with
  `LIBRARIAN_AUTO_SAVE=false`. [Private mode](/guides/private-mode/) is honoured.
- **Fail-soft everywhere** — if your server is down, tools return a short error and
  your turn is never blocked.

:::note[Honest status]
The capture hook is confirmed against Pi's published types but a full live
end-to-end run is still pending. As with every harness, capture fails quietly if
anything is unexpected.
:::

## Full technical reference

For configuration, the security posture, and publishing notes, see the
[Pi integration README](https://github.com/code-ministry-ltd/the-librarian/tree/main/integrations/pi).
