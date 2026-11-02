---
title: Hermes
description: Connect a Hermes agent to The Librarian with the stdlib-only Memory Provider.
---

[Hermes](https://github.com/NousResearch/hermes-agent) is an open agent framework.
The Librarian plugs into it as a **Memory Provider** — a small Python adapter
(Python 3.11+, no extra packages to install) that proxies the eight tools to your
server and feeds the agent its briefing.

**When you'd use this:** you run a Hermes agent and want it to share The
Librarian's memory and handoffs with your other tools.

**Before you start:** you need a running Librarian server, its **MCP URL**, and an
**agent token** — see [Install](/start-here/install/).

## The easy way

```sh
npx @the-librarian/cli install      # choose Hermes; paste your MCP URL + token
npx @the-librarian/cli update       # later: refresh the provider
```

This copies the provider into `~/.hermes/plugins/librarian` and sets it as your
memory provider in the Hermes config.

## The manual way

Hermes discovers memory providers by scanning a plugins directory, so installing
is a copy plus a config change:

```sh
# 1. Put the provider where Hermes looks for plugins:
cp -r integrations/hermes/librarian ~/.hermes/plugins/librarian

# 2. Provide the token (never written into a config file):
export LIBRARIAN_AGENT_TOKEN="<your-agent-token>"

# 3. Activate and point it at your server:
hermes memory setup          # pick "librarian", enter the endpoint
```

## What you get

- **Eight memory, handoff and journal tools** — recall, remember, flag,
  store/list/claim handoffs, search references, and read the
  [journal](/guides/journal/), each proxied to your server.
- **The primer in the system prompt** — fetched from your server and added to the
  agent's prompt, so it learns the recall/remember loop and the handoff, learn,
  and private-mode protocols.
- **The journal at session start** — when the server's [journal](/guides/journal/)
  is on, your recent entries follow the primer, fetched once per session. Entries
  are labelled with the git repository Hermes runs in, if any. Turn it off per machine with `LIBRARIAN_JOURNAL=off`.
- **Automatic capture** — after each completed turn Hermes hands the provider both
  halves of the exchange and the adapter ships it to your server for the curator
  to mine. On by default; opt out with `LIBRARIAN_AUTO_SAVE=false`. Private mode is
  honoured per exchange.
- **Fail-soft everywhere** — if your server is unreachable the briefing degrades to
  empty and tool calls return a tidy error, never blocking a turn.

This is one of the best-tested capture paths: the installed Hermes agent has been
confirmed to feed the provider on every completed turn.

## Full technical reference

For the configuration fields, security posture, and development notes, see the
[Hermes integration README](https://github.com/code-ministry-ltd/the-librarian/tree/main/integrations/hermes).
