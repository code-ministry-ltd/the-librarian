---
title: Reviewing & accepting proposals
description: The everyday task — judging the curator's suggested changes and approving or rejecting them.
---

The curator does most of its filing silently. The exceptions — anything that would
**throw away or restructure** what you know — it brings to you as a **proposal**.
Working through that queue is the one recurring job The Librarian asks of you, and
it usually takes a minute or two. This guide explains how to do it well.

## Why some changes need you and others don't

The curator follows one simple rule. Any change it is **confident enough** about —
creating, updating, merging, splitting or archiving a memory — it applies on its
own. Anything below the **auto-apply threshold** in
[Settings → Curator](/dashboard/curator/) becomes a proposal. The queue, in other
words, is the set of changes the curator was unsure of, and nothing else. Set the
threshold to 0 and the queue stays empty.

## The workflow

1. Open **[Proposals](/dashboard/proposals/)** in the dashboard. Each card is one
   suggested change.
2. **Read the reasoning, the plan, and the diff.** The card tells you what action
   it is (Update, Merge, Split, Archive, New), why the curator suggests it, and
   shows the before-and-after. An intake card also shows the **curator's plan** —
   what it *wanted* to do ("Wanted to augment ‹Elaine› with: …"), a preview of
   the result, and how confident it was. For a merge you see every source and the
   combined result; for a split, the original and its pieces.
3. **Decide.** The buttons name their exact consequence, so there is no guessing:
   - **Approve as augment of ‹X›** / **Approve — replaces ‹X›** executes the plan
     exactly as previewed.
   - **Approve curated version** activates the curator's cleaned-up title and
     body; **Approve raw submission** files the text exactly as it arrived.
   - **Discuss this proposal** opens the curator chat grounded in the card — ask
     why, or redirect it to a different action; confirming a chat-proposed fix
     also clears the proposal.
   - **Reject** leaves everything untouched; **Reject & make an example** also
     teaches the curator (see below).
4. **Tidy up a split.** When a split has produced good replacement memories, use the
   **Archive original** button beneath them to retire the source.

## When a proposal goes out of date

A proposal is a judgement about specific memories, frozen at the moment the
curator wrote it. If one of those memories changes while the proposal waits —
you edited it, or an agent filed something that changed it — the proposal no
longer describes the memory it would replace. Approving it would archive your
newer version and put back text written against the old one.

The Librarian will not let that happen. A card whose sources have changed is
marked **Out of date**, names which memory moved, and has its Approve buttons
disabled. There is no override, deliberately: a warning you can click past is a
warning you learn to click past.

**Reject it — that costs you nothing.** Editing a memory is exactly the kind of
change that brings the curator back to it, so on its next grooming run it re-reads
your current version and may well propose something similar against the text you
actually have. To talk it through first, **Discuss this proposal** still works,
and shows the curator the current state of every memory the proposal would
replace.

Proposals created before this behaviour existed have nothing recorded to compare
against, so they are neither marked nor blocked; they clear as you work the queue.

## When two proposals cover the same memory

The curator will not file a proposal identical to one already waiting — same
action, same memories. It may still propose something genuinely *different* about
a memory that already has a proposal open (a merge with a neighbour, say,
alongside a pending update), because those are separate judgements and both
deserve your eyes.

Approve one of them and any other open proposal that would have replaced the same
memory is withdrawn for you — it was a decision about a memory that is no longer
in your active set. Withdrawn proposals are archived with a note recording which
approval superseded them, so nothing disappears silently, and if the curator still
believes the other change is right it will propose it again against the new text.

## How to judge a proposal

- **Archive proposals** — ask "is this really stale or wrong?" Archiving is
  reversible (the memory moves to the [Archive](/dashboard/archive/), not oblivion),
  so you can approve with low risk and undo later.
- **Merge proposals** — check the merged text did not drop a nuance from one of the
  sources. If it reads worse than the originals, reject.
- **Split proposals** — confirm each piece stands on its own and nothing was lost in
  the division.
- **When unsure, reject.** Rejecting is always safe — it changes nothing. A fact you
  reject today can be proposed again later, or you can fix it yourself on the
  [Memories](/dashboard/memories/) page.

## Teaching the curator from what you see

A plain **Reject** is silent — the curator learns nothing from it, by design.
When a rejection is *instructive* — "stop extracting one-off task reminders from
my conversations" — use **Reject & make an example** instead. A short dialog runs:

1. Optionally note *why* it's not worth remembering.
2. The curator distills the rejection into its single **examples document** — a
   small, size-capped file of rejected-submission classes it reads before every
   intake judgment. It merges and generalises rather than piling up verbatim
   entries.
3. You see the proposed change to that document as a diff, and only your explicit
   confirm commits it — then the proposal is rejected.

Only flag the rejections bad enough to be made an example of; the document is
deliberately small (the `curator.intake.examples_max_bytes` setting, 4 KB by
default) so every entry earns its place. The document is a committed vault file
(`.curator/intake-examples.md`) — git history is its undo trail.

For broader steering ("don't merge security notes", say), the per-job
**addendum** on the [Curator](/dashboard/curator/) page is still the tool. Tuning
by reacting to real proposals — not by chasing a metric — is exactly how the
curator is meant to improve; see
[Configuring the curator](/guides/configuring-the-curator/).

## Related

- [Proposals page](/dashboard/proposals/) — the screen itself.
- [Flagged](/dashboard/flagged/) — a related queue, for memories an agent reported
  as wrong.
