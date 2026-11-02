---
title: The journal
description: A dated, self-compressing history of your conversations with your agents, written from captured conversations.
---

The **journal** is a dated history of what you and your agents talked about. Every
captured conversation gets a short entry: when it happened, which harness and
project it was in, and what was decided, corrected, preferred, rejected or left
open. Recent days stay detailed; older weeks and months are summarised.

Memories answer *what is true*. The journal answers *what happened, and why*. "We
tried X, it broke Y, so we moved to Z" survives in the journal as a story, where
memory would keep three separate facts.

The journal is **off by default**. Turn it on under **Settings → Curator → Intake
→ Journal**. It only runs while [intake](/guides/configuring-the-curator/) is
enabled, because it is written from the same captured conversations, by the same
model.

## What it costs

- **One extra model call per conversation.** When a captured conversation settles
  (30 minutes idle, or when the session ends), the intake model writes its entry
  alongside the usual fact extraction.
- **One model call per week and per month** of history, when older entries are
  summarised.

Only the conversation text is used: capture never sends tool calls, tool output or
the model's private reasoning, and [private mode](/guides/private-mode/) turns are
never captured at all.

## Where it lives

Entries are Markdown files in the vault, under `journal/`:

```text
journal/days/2026-11-02.md     one file per day, one entry per conversation
journal/weeks/2026-W44.md      one summary per ISO week
journal/months/2026-10.md      one summary per month
```

Because they are vault files, they are versioned and [backed up](/guides/backups-restore/)
with everything else, and you can read or edit them in the [Vault](/dashboard/vault/).
Journal files are not memories: `recall`, `search_references` and the curator never
read them.

A day's entry looks like this:

```markdown
## 14:05–15:40 · claude · the-librarian
<!-- episode: 3f1c…#s4 -->
- Asked whether intake reads the whole transcript; confirmed it is prose-only.
- Decided to add a chronological journal alongside memories.
- Open: whether to keep raw dialogue for exact lookups.
```

The `<!-- episode: … -->` line identifies the conversation, so a retried
conversation never gets a second entry. Leave it in place if you edit the file.

## How it compresses

Once a day, after 02:30 server time:

| Age | Kept as |
|---|---|
| Last 14 days | one entry per conversation |
| 15 to 90 days | one summary per ISO week |
| Older than 90 days | one summary per month |

Summaries keep every decision, correction and preference, and shorten the
narrative first. Nothing is deleted for being old: month summaries are kept
indefinitely. If a summary fails (the model is down, say), its entries stay as
they are and the next night tries again.

## How agents read it

The server serves the **recent window** — the last 14 days of entries plus the
four most recent weekly summaries, about six weeks — at `GET /journal.md`. It
needs the same agent token as `/mcp`. **Session-start budget** in the settings caps
its size (20,000 tokens by default); when it is over, the oldest files are left
out first.

Harness integrations that load the journal at the start of a session, and an MCP
tool for searching older history, are on their way in upcoming releases. Until
then, the journal builds up its history but agents don't read it yet.

## Turning it off

Untick **Keep a journal of captured conversations**. Nothing more is written, and
`/journal.md` answers 404. Existing entries stay in the vault until you delete
them there.

## For operators

`LIBRARIAN_JOURNAL_TICK_MS` sets how often the server checks whether the nightly
compaction is due (default 15 minutes; `0` turns automatic compaction off).
