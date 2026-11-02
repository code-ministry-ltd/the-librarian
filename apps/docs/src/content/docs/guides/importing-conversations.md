---
title: Import past conversations
description: Send conversations from before you set up The Librarian through memory intake and the journal, safely and within limits you set.
---

Live capture starts when you install The Librarian. Everything you said to your agents
before that is still on disk, in each harness's own history. `librarian import` reads it
on the machine where it lives and sends it through the same two steps live capture uses:
**memory intake** (memories) and **the journal**.

```sh
librarian import --dry-run   # see what would be imported, send nothing
librarian import             # show the plan, ask, then send
```

Run it on each machine you've used agents on. It uses the same server address and
token as the harness integrations (`librarian config`).

## What gets imported

**Each step only takes conversations that ended before that step first ran on your
server.** After that point live capture already has the conversation, so importing it
again could only duplicate. The server keeps one cutoff per step:

| Step | Its cutoff |
|---|---|
| Memories | When curator intake first ran |
| Journal | The start of your earliest journal entry |

If a step has never run, every past conversation qualifies for it. Its cutoff is set
the first time it runs, or the first time an import uses it.

Each cutoff is **set once and never moves**. Imports write journal entries dated in
the past, and they start intake runs. If the cutoffs were worked out again each time,
a second import, or an import from a second machine, would see a different rule. So
you can import from as many machines as you like, in any order.

The server also keeps a **ledger of conversation ids**, written whenever capture
finishes a step, whether the conversation arrived live or by import. A conversation
already in the ledger is never imported twice. That covers re-running the importer,
a resumed import, and a history folder synced between machines.

Some conversations are **never imported**:

- conversations that ended in the last day, because live capture still covers them;
- anything older than the server's **maximum age**;
- subagent conversations, tool calls and output, and the model's reasoning, exactly
  as with live capture;
- the recap a harness writes when it compacts a long conversation;
- anything inside a [private-mode](/guides/private-mode/) span.

## The server's limits

Every imported conversation costs the same model calls as a live one. Two limits on
**Settings → Curator → Intake → Import** keep an import from running up a bill or
flooding the queue:

- **Maximum age** (default 90 days): older conversations are never imported.
- **Allowance** (default 200 conversations): each imported conversation uses one.
  At 0, imports stop until you raise it. The importer says so and tells you how many
  were left.

The server enforces both limits, so a modified or outdated importer can't get past
them. Imported conversations are processed a few per sweep, after live capture, so
an import never slows down today's capture. They appear in your memories and journal
over the following hours.

## Options

| Flag | What it does |
|---|---|
| `--only memories` / `--only journal` | Run just one step. If you've used The Librarian for a while, `--only journal` fills in the journal for your earlier conversations. |
| `--harness claude,pi` | Only read these harnesses. The default is all five. |
| `--dry-run` | Show the server's plan and send nothing. Only conversation ids and end times go to the server; no text. |
| `--yes` | Don't ask before sending. |

If both intake and the journal are off on the server, the importer says so and stops
without reading anything. If one is off, it warns you and imports into the other.

## Where each harness keeps its history

| Harness | Location | How long it's kept |
|---|---|---|
| Claude Code | `~/.claude/projects/` | **30 days by default** (`cleanupPeriodDays`) |
| Codex | `~/.codex/sessions/` | No automatic deletion |
| OpenCode | `~/.local/share/opencode/opencode.db` | No automatic deletion |
| Pi | `~/.pi/agent/sessions/` | No automatic deletion |
| Hermes | `~/.hermes/state.db` | Kept unless `sessions.auto_prune` is on |

Claude Code deletes conversations older than 30 days by default. You can raise
`cleanupPeriodDays` in Claude Code's settings if you want to keep more, at the cost
of disk space. The Librarian doesn't change it for you.

Reading OpenCode and Hermes histories needs Node.js 22.13 or later, for its built-in
SQLite support.
