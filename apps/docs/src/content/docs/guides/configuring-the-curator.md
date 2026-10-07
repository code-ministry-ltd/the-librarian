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
  material to be worth a tidy-up. It also corrects memories an agent has
  [flagged](/dashboard/flagged/) as wrong or outdated, about 10 minutes after the
  flag: it rewrites or removes the stale statement and keeps the rest.
- **Chronicle** writes a searchable weekly review under `references/chronicle/`.
  Its factual digest does not require an LLM; a configured model adds an optional
  narrative and possible blog seeds. It never changes memories. See
  [The Chronicle](/guides/chronicle/) for the full walkthrough.

You can enable each job independently. If you turn **intake off**, new memories from
agents (and automatic capture) stop being filed — so leave it on unless you have a
reason not to.

## The one rule that governs what happens automatically

The curator applies a change itself when it is confident enough, and asks you
otherwise:

- **Every operation** (create, update, merge, split and archive) is applied
  automatically **when the curator's confidence is at or above the threshold**, and
  becomes a [proposal](/dashboard/proposals/) for you to approve below it. The
  **Auto-apply threshold** slider appears in **both Intake and Grooming** under
  [Settings → Curator](/dashboard/curator/). These are two views of **the same
  setting**, defaulting to 0.8; saving it in either tab changes both jobs. **Raise
  it to review more proposals; lower it to let the curator apply more unattended.**
- **At 0, nothing comes to you.** The curator archives, splits and rewrites on its
  own. Nothing is deleted: an archived memory stays on the
  [Archive](/dashboard/archive/) page, and the vault's history keeps every earlier
  version, with a restore on the [Activity](/dashboard/activity/) page. At **1**,
  nearly everything becomes a proposal.

Lowering the threshold does not remove proposals already in the queue; review or
reject those separately.

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

### Output limit and thinking level

Each job's model settings have two more fields:

- **Output limit (tokens)** caps how long one reply can be. The defaults are
  16,384 for Intake, 32,768 for Grooming, 8,192 for Chronicle, and 16,384 for the
  curator chat. Any thinking the model does counts towards this limit, so a model
  that thinks heavily needs more room. You can set anything from 256 to
  1,048,576.
- **Thinking level** is sent to the provider as `reasoning_effort` (None, Low,
  Medium, or High). Leave it on **Provider default** to send nothing, which is
  also the right choice for a provider that doesn't support the field.

A reply that reaches the output limit before it finishes is **thrown away, never
used**. The curator never files a memory, applies a correction, or writes a
chronicle narrative from a cut-off answer. What happens instead depends on the
job: an intake submission is retried later (see below), and a flagged memory
stays waiting for the curator's next look. If you see these, raise that job's
output limit.

### When the model is slow or down

The curator streams every reply. When a request times out, the curator
disconnects and the provider stops generating, so an abandoned request doesn't
keep a local model busy after the curator has given up on it.

- **A timeout or an unavailable provider stops the run.** If the model times
  out, drops the connection, or answers with a rate limit or server error, the
  intake sweep and the transcript extraction stop there. They don't send the
  next item into the same queue. The remaining items wait for the next run.
- **Run now never overlaps a running sweep.** Pressing *Run now* on Intake while
  a sweep is already running reports "a sweep is already running" instead of
  starting a second one against the same model.
- **Failed items are retried, but not forever.** An intake submission that fails
  is retried about an hour later. After its third failure it is set aside in
  `inbox/.failed/` in your vault, and the run summary says so. Nothing is
  deleted: to retry it, move the file back into `inbox/`.
- **A failed transcript extraction keeps the conversation.** If extracting facts
  from an automatically captured conversation fails, the conversation is kept and
  retried about an hour later. After the third failure it is deleted, as a
  captured conversation always is once processed: captured text is never kept
  indefinitely.

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
