---
title: Install
description: Stand up a Librarian server and connect your first agent, in a few commands.
---

Getting started takes two steps: **run a server** (the small service your agents
talk to), then **connect a harness** (your AI tool) to it. Both are driven by one
command-line tool, `librarian`, which you run with `npx` — no permanent install
required.

You need [Node.js](https://nodejs.org) (version 22 or newer) on the machines
involved, and [Docker](https://docs.docker.com/get-docker/) on whichever machine
will host the server.

:::tip[Already have a server?]
If someone on your team has already run The Librarian and given you an **MCP URL**
and an **agent token**, you can skip straight to step 2 and connect your agent.
:::

## Step 1 — Run a server

On the machine that will host The Librarian (a spare box, a small cloud VM, or
even your laptop to try it out), run:

```sh
npx @the-librarian/cli server up
```

This resolves the latest stable release, pulls and verifies its exact published
image, starts it by immutable digest, waits until it is healthy, and then prints
three things. You do not need Git or a source checkout for this stable path:

- an **MCP URL** (like `http://your-host:3838/mcp`) — the address your agents
  connect to,
- a freshly generated **agent token** — the password your agents authenticate
  with, and
- a **master key**, shown **once**, with a "SAVE THIS KEY" warning.

**Copy the master key somewhere safe now.** It is deliberately left out of every
backup, so if you lose it you cannot decrypt a restored backup later. Keep the MCP
URL and agent token handy too — you will paste them in step 2.

:::caution[Use real Docker, not the snap package]
`librarian server` does not work on snap-packaged Docker (common on Ubuntu).
Install Docker CE instead. The full reasons, plus how to host on a network rather
than just your own machine, are in
[Deploy & operate → Self-host](/deploy-and-operate/self-host/).
:::

By default the server is reachable only from the machine it runs on. To reach it
from your other devices, and to control where your data lives, see the
[self-host guide](/deploy-and-operate/self-host/).

## Step 2 — Connect your agent

On each machine where you use an AI tool, wire it up with:

```sh
npx @the-librarian/cli install
```

With no arguments this opens an interactive menu: choose which of your tools to
connect (Claude Code, Codex, OpenCode, Hermes, Pi), then paste the **MCP URL** and
**agent token** from step 1 when prompted. The command edits each tool's own
configuration for you, so you do not have to hand-edit five different config
files.

When you add a new tool or want the latest version of an integration, run it
again, or update everything at once:

```sh
npx @the-librarian/cli update
```

:::note[Prefer a permanent command?]
Install the tool globally once with `npm i -g @the-librarian/cli`, then call
`librarian install` / `librarian update` directly instead of `npx …`.
:::

### What it writes to your machine

The `librarian` tool keeps everything under `~/.librarian/`. Your agent token is
written to `~/.librarian/env` (readable by you alone) and is **never** printed to the
screen or put in a URL. For bash/zsh it adds one small block to your shell startup
file that *sources* that env file, so the token lives in just the one place. (On
**fish**, which can't source a POSIX file, the token is also written directly into
`~/.config/fish/conf.d/librarian.fish`, kept at the same `0600` permissions.) To
change the token later, run `librarian config --token <new>`.

## Check it worked

After connecting, you can confirm a harness sees The Librarian from inside that
tool — most show their connected tools under a `/mcp` view, and a healthy
Librarian lists exactly **seven** tools. Per-tool checks live on each
[Connect your agent](/connect/claude-code/) page.

You can also point a browser at the **dashboard** (printed by `server up`,
usually `http://your-host:3042`) — the admin cockpit where you review what your
agents remember.

## Next steps

- [First run](/start-here/first-run/) — what to expect in your first session.
- [Connect your agent](/connect/claude-code/) — detailed setup for each tool.
- [Self-host](/deploy-and-operate/self-host/) — the full server operator guide
  (networking, data location, updates, boot persistence).
