---
title: The journal
description: A dated, self-compressing history of your conversations with your agents, written from captured conversations.
---

The **journal** is a dated history of what you and your agents talked about. Every
captured conversation gets a short entry: when it happened, which harness and
project it was in, what was done, which way things went and why, and what was left
open. Entries are deliberately brief, like a colleague's work log: they record the
outcome, not details such as exact values, paths or small tweaks that the code
already holds. Recent days stay detailed; older weeks and months are summarised.

Memories answer *what is true*. The journal answers *what happened, and why*. "We
tried X, it broke Y, so we moved to Z" survives in the journal as a story, where
memory would keep three separate facts.

The journal is **off by default**. Turn it on under **Settings → Curator → Intake
→ Journal**. It has its own switch, independent of
[intake](/guides/configuring-the-curator/): turning either one on captures your
conversations, and each settled conversation is journalled while the journal is
on and mined for memories while intake is on. You can run the journal without
intake, for a history of what you did with no memories filed. Both use the intake
model.

## What it costs

- **Two extra model calls per conversation.** When a captured conversation settles
  (30 minutes idle, or when the session ends), the intake model drafts its entry
  alongside the usual fact extraction, then a second, much smaller call edits that
  draft down: it sees only the draft, may only cut, and drops details such as exact
  values or small tweaks while keeping names, decisions and anything left open. If
  the edit fails, the draft is kept. A long session with no break is split into
  consecutive parts of about 30,000 characters, each with its own entry and model
  call, so the later work isn't squeezed out of a single short entry. A prompt that
  never got a reply makes no entry and costs nothing.
- **One model call per week and per month** of history, when older entries are
  summarised.

Only the conversation text is used: capture never sends tool calls, tool output or
the model's private reasoning, and [private mode](/guides/private-mode/) turns are
never captured at all. Neither is the recap a harness writes when it compacts a long
conversation (Claude Code, OpenCode): it only repeats what was already captured.

Conversations from before you turned the journal on can be added with
[`librarian import --only journal`](/guides/importing-conversations/).

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

The `<!-- episode: … -->` line identifies the conversation (and the part, for a long
session split into several entries: `…#s4-1`, `…#s4-2`), so a retried conversation
never gets a second entry. Leave it in place if you edit the file.

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
its size (20,000 tokens by default); when it is over, the oldest entries are left
out first and the window ends by pointing at the `journal` tool. A client whose
channel has a hard size limit can ask for less with `?max_chars=` (1,000 to
400,000 characters).

Every connected agent also has the **`journal`** tool (see the
[MCP verbs](/reference/mcp-verbs/#journal) reference), in every harness:

- **Retrieve** — with no `query`, it returns the entries between `from` and `to`
  (default: the last 30 days), oldest first. Asking for an older range works the
  same way and returns that period's summaries. If the reply is too long for
  `max_tokens`, the oldest entries are left out and the reply says which `to` date
  to ask for next.
- **Search** — with a `query`, it returns the best-matching entries and summaries
  from the last year (or the range you give), each labelled with its date.
- **Filter** — `project` and `harness` narrow either mode. Entries are matched
  exactly; weekly and monthly summaries are matched when they mention the name,
  and are labelled as a looser match.

The tool only reads, so it stays available in [private mode](/guides/private-mode/),
like `recall`. Its queries reach the server's logs like any other read.

Every harness also loads the recent window automatically when a session starts:

| Harness | How it arrives | Again after a compaction? |
|---|---|---|
| Claude Code | a `SessionStart` hook | yes |
| Codex | a `SessionStart` hook | yes |
| OpenCode | the plugin adds it to the system prompt | once per session |
| Pi | added to the system prompt after the primer | once per session |
| Hermes | added to the system prompt after the primer | once per session |

Each one asks for the same amount, about 9,500 characters — what Claude Code can
show from a hook. The newest entries are kept, older ones are left out whole, and
the window ends by pointing the agent at the `journal` tool for the rest. The
window is loaded once and then stays the same for the session, so it doesn't
disturb prompt caching; anything newer is a `journal` call away. Set
`LIBRARIAN_JOURNAL=off` on a machine to stop the automatic load there.

Entries are labelled with their harness and, where the harness knows it, their
project: the git repository the agent ran in, else the folder name. Hermes labels
a project only inside a git repository, since it often runs as a chat gateway
from a service folder; its entries still say `hermes`.

## Reading it in the dashboard

The **Journal** page (in the top navigation) shows the whole journal, newest first:
days entry by entry, then the weekly and monthly summaries.

- **Where you are.** A large date beside the page names the period you're reading,
  with how long ago it was. Beneath it, a timeline runs from today down to the oldest
  entry; a marker follows your scroll. The timeline is stretched towards the present,
  like the journal itself: the last fortnight gets as much room as the months before
  it.
- **Travel through time.** Click or drag along the timeline to jump there. Focus it
  with the keyboard and use the arrow keys, Page Up/Down, Home and End, or press
  <kbd>J</kbd> / <kbd>K</kbd> anywhere on the page for the next older or newer
  period.
- **Search.** Press <kbd>/</kbd> and type. It runs exactly the search your agents get
  from the `journal` tool — the same matching, ranking and last-year default — and
  can be narrowed by project or harness. Matches also appear as dots on the timeline;
  pick one to jump to it.
- **Delete.** Remove a single conversation's entry, a whole day, or a week or month
  summary. You're asked to confirm, and the deletion is permanent from the
  dashboard and for agents; the vault's git history keeps a copy, like every other
  vault change.

## Turning it off

Untick **Keep a journal of captured conversations**. Nothing more is written,
`/journal.md` answers 404, and the `journal` tool tells agents the journal is off. Existing entries stay in the vault until you delete
them there.

## For operators

`LIBRARIAN_JOURNAL_TICK_MS` sets how often the server checks whether the nightly
compaction is due (default 15 minutes; `0` turns automatic compaction off).
