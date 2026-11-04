---
title: Handoff & takeover
description: Stop work in one agent and pick it up cleanly in another.
---

A **handoff** lets you stop a piece of work in one place and resume it elsewhere —
in a fresh session, or in a completely different tool — without re-explaining
everything. One agent writes a structured summary; another reads it back and
carries on. This is what makes The Librarian a *cross-tool* layer rather than just
per-tool memory.

## Handing work off

When you are about to stop, tell your agent to **hand off**. You can use the
`/handoff` command where it exists, or just say "hand this off" or "we're done for
now" — both do the same thing. The agent writes a handoff document with five fixed
sections:

- **Start & intent** — what you set out to do.
- **Journey** — what happened along the way.
- **Current state** — where things stand right now.
- **What's left** — the remaining work.
- **Open questions** — anything undecided.

All five are required — the system refuses a document missing any of them, which is
what keeps handoffs genuinely useful. The agent saves it and returns an id you can
reference later.

## Picking work back up

In the new session or tool, tell the agent to **take over**. Use `/takeover`, or
say "pick up where I left off" or "what was I doing?". The agent lists the handoffs
waiting for the current project, you choose one, and it **claims** it and continues
from where the document leaves off.

Claiming is **one-shot and atomic**: only one agent can claim a given handoff. If
two try at once, the loser is simply told who already has it — so work is never
accidentally picked up twice.

## Reading handoffs yourself

You can read any handoff in the dashboard's [Handoffs](/dashboard/handoffs/) page —
the document and all its details. Note the dashboard is read-only for handoffs:
*claiming* is something agents do, because claiming is part of resuming the work.

## Handoffs vs memories

They are different tools for different jobs:

- A **handoff** describes *in-progress work* and is claimed exactly once. It is
  evidence of where you were, not a permanent fact.
- A **memory** is a *durable fact* you want to keep. To promote something you
  learned during the work into lasting memory, ask the agent to remember it
  ("save what we learned"). Automatic capture also picks lessons up as you go.

## A note on private mode

If you are in [private mode](/guides/private-mode/), handing off writes to the
server, so the agent will ask you to confirm before it saves anything.
