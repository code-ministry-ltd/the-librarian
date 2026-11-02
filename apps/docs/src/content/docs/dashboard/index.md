---
title: Using the dashboard
description: A guided tour of The Librarian's admin cockpit — what each area is for and how to use it.
---

The dashboard is your cockpit for everything The Librarian holds. It runs at the
address `server up` printed (usually `http://your-host:3042`) and is where you
read what your agents remember, approve or reject the curator's suggestions,
browse and edit the vault, and manage settings. Your agents never touch it — it is
just for you, the operator.

:::caution[Reaching the dashboard means admin access]
The dashboard is the only thing that can reach The Librarian's admin controls, and
it does so over a private internal channel with no password of its own. So anyone
who can open the dashboard has full admin power. Keep it on a private network, and
turn on [owner login](/dashboard/settings/#auth) for anything reachable from the
internet.
:::

## Finding your way around

A bar across the top of every page holds the main areas. From left to right:

- **[Vault](/dashboard/vault/)** — browse and edit the raw files (the dashboard
  opens here).
- **[Curator](/dashboard/curator/)** — chat with the curator and teach it.
- **[Memories](/dashboard/memories/)** — browse, search, and create memories.
- **[Journal](/guides/journal/#reading-it-in-the-dashboard)** — read, search and prune the dated history of your conversations with your agents.
- **[Handoffs](/dashboard/handoffs/)** — read work handed between agents.
- **[Analytics](/dashboard/analytics/)** — corpus and curator-usage figures.
- **[Proposals](/dashboard/proposals/)** — the curator's review queue.
- **[Flagged](/dashboard/flagged/)** — memories an agent reported as wrong.
- **[Archive](/dashboard/archive/)** — retired memories.

A **Settings** menu (top right) covers [Dashboard, Auth, Primer, Curator, Tokens,
Connect, Captures, and Backups](/dashboard/settings/). Also on the right are a
version badge, a **?** button that lists keyboard shortcuts, a light/dark theme
toggle, and a sign-out button when login is enabled. Press **⌘K** (or **Ctrl+K**)
anywhere to open a command palette and jump to any page or recent item.

The closely-related **[Activity](/dashboard/activity/)** and
**[Health](/dashboard/health/)** views round out the tour.

## The everyday rhythm

Most days you will spend your time in one place: the
**[Proposals](/dashboard/proposals/)** queue, approving or rejecting the changes
the curator wants to make. Everything else is there when you need it — searching a
memory, reading a handoff, editing the briefing, or checking a backup ran.

Start with [Reviewing & accepting proposals](/guides/reviewing-proposals/) for the
core task, then dip into any area below.

## Seeing and browsing tags

Memory cards show up to three tags in their stored order, followed by **+N more**
when a memory has additional tags. The same compact tag row appears in Browse,
Recall, Proposals, Flagged, and Archive so you can see how a memory is classified
without opening it.

In **Memories → Browse**, choose **Tag** to search the tag catalogue. Each option
shows the number of active memories with that exact tag across the shelves you
can recall. Picking an option—or selecting a tag directly on a Browse card—adds
an exact-tag filter. Use the tag's **×** or **Clear all** to remove it. Tags on
Recall and the review queues are informational and do not change those views.
