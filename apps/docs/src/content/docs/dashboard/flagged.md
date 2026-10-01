---
title: Flagged
description: Review memories an agent reported as wrong, misleading, or out of date.
---

When an agent recalls a memory that looks wrong, it can **flag** it with a reason
rather than changing or archiving it on its own. Flagging demotes the memory below
unflagged matches in recall and asks the curator to look at it again.

![The Flagged memories page](../../../assets/screenshots/flagged.png)

## How the curator handles a flag

About 10 minutes after the latest flag, the curator runs a small, focused grooming
pass. Flags that arrive close together share one pass, and none waits more than 30
minutes. It reads each flagged memory in full, the flag reasons, and
the five memories most closely related to it, then does one of these:

- **Corrects it.** It rewrites or removes the statement the flag reports and keeps
  the rest of the memory as it was. When its confidence is at or above the
  auto-apply threshold in [Curator settings](/dashboard/settings/#curator), the fix
  applies straight away and the flag closes.
- **Proposes a correction.** Below the threshold, or for a protected memory, the fix
  goes to the [Proposals](/dashboard/proposals/) page. Approving it replaces the
  memory and closes the flag; rejecting it keeps the original and marks the flag
  declined.
- **Proposes archiving it.** When the whole memory is obsolete, the curator proposes
  archiving it; you decide on this page.
- **Leaves it.** When it cannot tell what is true now, it changes nothing and says
  why.

A correction states the current facts; it does not add a "was A; now B" note. The
vault's git history keeps the earlier text. The curator never rewrites a memory it
could not read in full (very long memories, or ones with secret-looking text that
had to be masked); those are left for you.

Correction uses the Grooming model and runs only while Grooming is turned on. With
Grooming off, flags wait here. Before the memory and flag reasons are sent to the
model, known secret patterns are redacted. Redaction is best-effort; it cannot
guarantee removal of arbitrary sensitive text.

The agent's `flag_memory` response reports that the flag was recorded and the
curator will review it; it does **not** report the outcome. If a persistence error
says the write could not be confirmed, the flag may already be recorded—check this
page before retrying.

## What you'll see

Each flagged memory shows its title, text, and **flag details**: the reason given,
which agent raised it, and when. A line underneath says where it stands:

- **Waiting for the curator** — it has not reviewed the flag yet.
- **The curator proposed a correction** — with a link to the proposal.
- **The curator made no change** — with its reason.
- **You rejected the curator's correction.**
- **Too long for the curator to rewrite safely.**
- **The curator proposes archiving this whole memory.**

## The main task

- **Edit** — fix the memory yourself. Saving closes the flags.
- **Ask the curator again** — after it made no change, after you rejected its
  correction, or after you shortened a long memory. It takes another look about
  10 minutes later.
- **Dismiss** — the flag was unfounded; clear the flags and keep the memory active.
- **Archive** — explicitly archive the whole memory and clear its flags. The curator
  never archives a memory on its own.
