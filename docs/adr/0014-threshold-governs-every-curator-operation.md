# ADR 0014 — The threshold governs every curator operation

- **Status:** Accepted
- **Date:** 2026-10-07
- **Amends:** ADR 0007 (D13, the one apply rule); retires the force-proposal directive from ADR 0004
- **Related:** ADR 0013 (flags corrected by grooming)

## Context

D13 gave the curator one apply rule with three exceptions. Whatever the confidence
threshold:

- `archive` and `split` always became proposals;
- any operation on a memory marked `requires_approval` became a proposal;
- a submission carrying the `forceProposal` hint became a proposal.

The threshold slider says "Never raises proposals" at 0, but the exceptions made
that untrue. An operator who set the threshold to 0 to stop reviewing curator work
still got every archive on the Flagged page (a proposed archive is filed as a
curator flag, "curator proposes archive: …") and every split on the Proposals page.
After ADR 0013 moved flag correction into grooming, those exceptions were the only
source of review items on such an install. A few days of live grooming at threshold
0 left six split proposals and three archive flags for a person who had asked for
none.

The exceptions had also lost their reasons:

- **`requires_approval`** is now only the "awaiting review" marker on proposals.
  Agents cannot set it (the MCP tools ignore it), approval clears it, and a memory
  approved before that fix reads as unprotected. A memory protected on purpose can
  still exist, but nothing in the product creates one.
- **`forceProposal`** has had no producer since ADR 0006 removed `propose_memory`.
  The 2026-09-29 codebase review already listed it as dead.
- **Archive and split** delete nothing. An archived memory stays in the vault and
  on the Archive page; a split creates its replacements before it archives the
  source; git history keeps every earlier body, and the Activity page can restore
  the vault. The threshold already guards `merge` and `update`, which rewrite and
  retire memories in the same way.

## Decision

1. **One rule, no exceptions.** `noop` skips. Every other operation (`create`,
   `update`, `merge`, `split`, `archive`) applies at confidence ≥
   `curator.apply.confidence_threshold` and becomes a proposal below it. This holds
   in intake and grooming alike.
2. **Archive and split gain an apply path.**
   - An applied archive archives its sources as the curator actor. Below the
     threshold it still rides the flag-review queue, as before.
   - An applied split creates its replacements as active memories, then archives
     the source. The shared `splitMemory` primitive keeps that data-loss-safe order.
   - An applied archive or split settles the source's agent flags (ADR 0013), as an
     applied merge already did.
3. **`requires_approval` no longer gates curator writes.** The curator's apply
   paths write a protected memory like any other (`allowProtected`). The field
   still marks a proposal as awaiting review, and manual dashboard edits are
   unchanged.
4. **The force-proposal directive is removed.** It disappears from the decision
   function, intake, and the inbox format. An old inbox file that still carries
   `force_proposal: true` is read without it.
5. **The prompt says so.** The curator prompt (v6.1) drops "archive and split always
   go to a person" and the `requires_approval` rule. It asks the model to score
   archive and split as carefully as a merge, because a confident one now applies
   unwatched.

## Consequences

- **Threshold 0 means what the slider says.** Nothing reaches the review queues
  except what was already there.
- **Default installs see more unattended changes.** At the default 0.8, a confident
  archive or split now applies without review. That is a behaviour change, so it
  is called out in the CHANGELOG. Operators who want every archive and split
  reviewed can raise the threshold. There is no per-operation knob; add one only
  if practice shows it is needed.
- **One full re-groom.** The prompt version bump changes the grooming input hash,
  so the first scheduled groom after upgrading reprocesses the corpus once.
- **Items already queued stay queued.** Existing proposals and curator archive
  flags are not applied retroactively; a person clears them once. The prompt still
  tells grooming to leave a memory with an open curator archive flag alone, so
  those flags do not resolve themselves.
- **Future reflective jobs choose their own gate.** The draft "reflection, not
  initiative" direction wanted derived synthesis held to always-propose, alongside
  archive and split. That class no longer exists in D13. A synthesis feature must
  state its own gate when it is designed, rather than inherit one.
