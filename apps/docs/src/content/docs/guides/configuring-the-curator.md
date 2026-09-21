---
title: Configuring the curator
description: Choose the curator's language model, set when it runs, and teach it over time.
---

The **curator** is the resident librarian that tends your collection: it files each
new memory, links related notes, removes duplicates, and keeps the whole thing tidy
for finding things later. It uses a language model to do this, so before it can
work you give it a provider, and then you decide how aggressively it runs. This
guide covers both, plus how to keep improving it.

## The three jobs

The Curator settings contain three distinct jobs, configured side by side under
**[Settings → Curator](/dashboard/settings/#curator)**:

- **Intake** consolidates each new submission as it arrives — gathering the evidence
  around it and then creating, updating, or merging against what you already know.
  This is what turns "remember that…" into a filed memory.
- **Grooming** tends the *existing* collection slice by slice — de-duplicating,
  archiving stale notes, refining. Grooming is **triggered, not scheduled**: it runs
  when you press *Run now*, and automatically after intake has added enough new
  material to be worth a tidy-up.
- **Chronicle** writes a searchable weekly review under `references/chronicle/`.
  Its factual digest does not require an LLM; a configured model adds an optional
  narrative and possible blog seeds. It never changes memories. See
  [The Chronicle](/guides/chronicle/) for the full walkthrough.

You can enable each job independently. If you turn **intake off**, new memories from
agents (and automatic capture) stop being filed — so leave it on unless you have a
reason not to.

## The one rule that governs what happens automatically

The curator applies safe changes itself and asks you about risky ones:

- **Create, update, and merge** are applied automatically **when the curator is
  confident enough** — the **Auto-apply threshold** slider on
  [Settings → Curator](/dashboard/curator/) is the single knob, defaulting to a
  cautious 0.8. **Raise it to review more proposals; lower it to let the curator
  apply more unattended.**
- **Archive and split** — the only operations that lose or reshape information —
  **always** become [proposals](/dashboard/proposals/) for you to approve, no matter
  how confident the curator is.

So you are never surprised by a memory vanishing; the most a confident curator does
on its own is add and tidy.

## Choosing a model

On **Settings → Curator**, add an **LLM provider** (such as Anthropic or OpenAI)
with its API credentials and **test** the connection. Then, in the Intake and
Grooming tabs, pick the model to use; Chronicle can optionally use a model for its
narrative. The provider's API key is one of the
server's own secrets — it is encrypted at rest with your master key, and it never
appears in a memory, a backup, or a log. (Your memories themselves stay as plain
Markdown by design; the master key protects the curator's credentials, not your
notes.)

Keep an eye on token usage on the [Analytics](/dashboard/analytics/) page, broken
down per model, to balance quality against cost.

## Teaching it over time — the self-improving loop

Intake and Grooming get better through use, and you steer them with plain English rather than
code. On the [Curator](/dashboard/curator/) page each of those two jobs has an editable **guidance
addendum** — extra instructions appended to its standing prompt, like "prefer to
merge near-duplicate deployment notes" or "keep security facts verbatim". Edit it,
**Commit addendum**, and the next run uses it immediately; if it makes things worse,
**roll it back**.

This guidance is **advisory only**. The curator's built-in safety and structural
rules are re-checked on every operation regardless of what the guidance says, and
the guidance is size-capped, so you can experiment freely without ever overriding an
invariant. The right way to tune is to **react to the real proposals** the change
produces — see [Reviewing & accepting proposals](/guides/reviewing-proposals/) —
not to chase a number.

The addendum has a sibling the curator maintains for you: the **intake examples
document**, a small file of rejected-submission classes built up through
**Reject & make an example** on the proposals queue. Where the addendum is your
standing prose, the examples document is distilled from your actual rejections —
both ride the intake prompt, both are size-capped, git-versioned vault files.
See [teaching the curator from what you see](/guides/reviewing-proposals/#teaching-the-curator-from-what-you-see).
