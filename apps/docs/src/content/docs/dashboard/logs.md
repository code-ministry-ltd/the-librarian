---
title: Logs
description: Every log The Librarian keeps, in one place, each readable page by page and downloadable in full.
---

The **Logs** page gathers everything The Librarian records about what happens to it. Each log
has its own tab, shows its newest entries first, and has a **Download** button that saves the
whole log as NDJSON (one JSON record per line) so you can analyse it elsewhere.

## The logs

| Tab | What it records |
| --- | --- |
| **Reads** | What agents asked for and what came back: every `recall` and `search_references`, and the primer and journal each new session receives. Off until you turn it on. |
| **Refusals** | Requests the server turned away: bad or missing tokens, blocked origins, rate limits, failed sign-ins, and writes to shelves the caller can't write to. |
| **Captures** | References sent in from the browser extension or your phone, and whether each was saved. |
| **Intake runs** | Each time the curator filed captured conversations into memories. |
| **Curation runs** | Each time the curator tidied existing memories. |
| **Backups** | Each push of the vault to its backup remote. |
| **Vault history** | Every change to the vault, from its git history. |

Each entry shows when it happened, whether it is routine (**OK**, **Info**), worth a look
(**Note**) or a failure (**Error**), and a one-line summary. Open **Full record** to see the
entry exactly as it is stored.

Some logs also have a fuller, purpose-built page: [Activity](/dashboard/activity/) for the
vault history (with per-file diffs and restore), the [Curator](/dashboard/curator/) page for
runs, and [Captures](/dashboard/settings/#captures) and [Backups](/dashboard/settings/#backups)
in Settings. The Logs page is for reading across them and downloading.

## Turning on the read log

The read log is off by default, because the queries agents send can be as personal as the
memories themselves. Turn it on in **[Settings → Dashboard](/dashboard/settings/#dashboard)**
under **Read log**. It takes effect at once; no restart.

A **Reads** entry marked **Note** is a recall or reference search that returned nothing. That is
rare: recall ranks by similarity with no relevance cut-off, so it almost always returns its
nearest matches, relevant or not. Whether those results were any use can't be read from the log
alone; it needs the conversation they were returned into. What each entry holds, and how the file
is bounded and protected, is in
[Seeing what agents read](/deploy-and-operate/self-host/#seeing-what-agents-read).

## Downloads

Downloads are oldest first. Reads and refusals download everything the server still keeps.
Intake and curation runs include every decision the curator made in each run, with its
reasoning. Run and vault histories stop at the newest 20,000 entries.

Downloads can contain query text, memory titles and network addresses. Treat them like the
data folder they come from.
