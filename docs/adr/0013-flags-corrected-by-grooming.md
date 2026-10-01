# ADR 0013 — Flagged memories are corrected by grooming, not a separate worker

- **Status:** Accepted
- **Date:** 2026-10-01
- **Supersedes:** ADR 0012 (flagged-memory partial correction)
- **Related:** ADR 0006 (agent-facing MCP surface), D13 (the one apply rule), ADR 0007 (private mode)

## Context

ADR 0012 added a dedicated worker for flagged memories. It may only delete exact,
standalone quoted text: one sentence or one whole list item, mapped uniquely back
to the source. Anything else falls back to a person, whose only tools are Dismiss
and whole-memory Archive.

That design fitted small, single-fact memories. Memories are now cumulative: one
memory holds the evolving story of a project, a person, or a policy. When one
statement in it goes stale, the right fix is usually to rewrite or remove that
statement, and the exact-quote worker rarely can. In practice most flags end in
manual review, and the operator sees no partial-fix option at all.

Grooming already has the operation this needs: `update` replaces a memory's body
and is governed by the D13 confidence threshold. But grooming does not see agent
flags. Its evidence carries only `has_open_curator_flag`. The shared curator rules
also forbid the edit: "Never drop, reword, or restate existing prose", and the
grooming mode demands that a stale fact keep its arc ("was A; now B").

## Decision

### 1. A flag is a request to grooming

- `flag_memory` records the flag and nothing else. It no longer creates correction
  work.
- A new grooming trigger, `flag`, arms a **targeted groom** 10 minutes after the
  latest pending flag, and never later than 30 minutes after the first, so a
  burst of flags shares one run. It follows the pattern
  of the `post_intake` trigger: a debounce window, and it fires only while grooming
  is enabled.
- A targeted groom runs over a small slice:
  - the flagged memories;
  - the 5 active memories that recall ranks most related to each one, so
    the model can tell which statement is the current one;
  - the usual tombstones and prepass findings.
  It is not the newest-first, 200-memory slice that scheduled grooming uses.
- Scheduled and manual grooms also pin every flagged memory into their evidence,
  whatever its position in the newest-first order. So a flag that arrived while
  grooming was off is still picked up by the next run.

### 2. Grooming sees the flags

- Each flagged memory in the evidence gains `open_flags: [{ reason, flagged_at }]`.
- The reasons are untrusted data. They are redacted like bodies and bounded in
  count and length (at most 10 flags; 2,000 characters each, as `flag_memory`
  already enforces).
- Curator archive flags keep their existing `has_open_curator_flag` marker and
  meaning.

### 3. The curator corrects by `update`, and just fixes the text

- The shared rule "Never drop, reword, or restate existing prose" gains one
  exception. The curator may remove or rewrite a statement when either holds:
  - an open flag identifies the statement as wrong or outdated; or
  - newer evidence in the bundle clearly contradicts it.
- Everything else in the memory must be preserved; the existing claim-ledger
  audit applies to the rest of the body.
- The correction **just fixes the text**. No "was A; now B" arc is written into
  the memory; the vault's git history is the record of what it used to say. The
  grooming mode's "keep the arc… never a silent deletion" line is replaced
  accordingly. So is the shared HISTORY value ("When new information supersedes
  old, keep the arc"). History stays worth recording when it is itself the
  subject of a memory (a deliberately reversed decision, say), but a correction
  no longer keeps the arc by default.
- This applies to unflagged memories too. Routine grooming may fix a statement
  contradicted by newer evidence in the same way, under the same threshold.
- Intake follows the same rule: a `supersede` replacement states the current
  facts without a "was A; now B" arc.
- An `update` that addresses open flags sets a new field, `resolves_flags: true`.
  It must address every open flag on that memory, the same all-or-nothing rule as
  ADR 0012: addressing only some of the flags is not allowed.
- The D13 threshold decides the outcome as for any update:
  - **Apply:** the memory is rewritten and its agent flags are cleared, in one
    write.
  - **Propose:** a normal grooming update proposal is created. Approving it
    activates the corrected memory without the flags and archives the source.
  - `requires_approval` memories always become proposals.
- A memory that is wholly obsolete may still get `archive`. That remains a curator
  archive proposal for a person, exactly as today.

### 4. Truncated memories are never rewritten

- Today evidence bodies are cut at 4,000 characters. An `update` built from a
  truncated body would silently drop the tail.
- Flagged memories travel with their full body up to 20,000 characters (ADR
  0012's existing bound). A memory longer than that is not offered for
  correction. Its flag shows "too long for automatic correction — edit it
  yourself".
- Validation rejects any `update` whose source body was truncated in the
  evidence, for flagged and unflagged memories alike. This also closes the same
  gap in today's routine grooming.

### 5. Every flag gets a visible outcome

- Each flag records what the curator last did with it: `review: { at, outcome,
  run_id, rationale? }`. The outcome is one of:
  - `corrected`: the update was applied, and the flag is gone;
  - `proposed`: a correction is waiting on the Proposals page;
  - `no_change`: the model reviewed the memory and changed nothing; its rationale
    is shown;
  - `declined`: a person rejected the correction proposal;
  - `too_long`: the memory is over the size bound.
- **No loops:**
  - A `declined` or `no_change` flag is left out of later targeted grooms until
    something changes: a new flag, the memory being edited, or a person pressing
    **Ask the curator again**.
  - Scheduled grooms still show the memory, but not its declined flags.
  - The existing open-proposal dedupe (`openProposalCovers`) stops a second
    proposal while one is pending.

### 6. The Flagged page becomes a status view

- Each card shows its flags and the latest review outcome, with a link to the
  proposal when there is one. Actions:
  - **Edit:** opens the existing memory editor. Saving a manual edit clears the
    flags.
  - **Ask the curator again:** queues a targeted groom of this memory, clearing
    `declined` / `no_change`.
  - **Dismiss:** as today.
  - **Archive:** whole memory, as today.
- Re-assess, the correction-reason codes, and "Recent corrections" (the correction
  history) are removed. An applied correction shows in the memory's history and in
  the grooming run log, like any other grooming update.

### 7. The ADR 0012 worker is retired

- Removed:
  - `memory-correction.ts` and `memory-correction-worker.ts`;
  - the correction runtime and its scheduler and wake/drain wiring;
  - the twelve correction store methods;
  - the `correction_work` frontmatter;
  - the flagged-correction proposal type and its special approve/reject paths;
  - the dashboard correction-history component;
  - their tests.
- **Upgrade:**
  - `correction_work` is ignored on read and dropped on the next write of that
    memory.
  - Open flagged-correction proposals are withdrawn at boot: archived with a
    resolution note, the same path ADR 0012 uses for superseded corrections.
  - Their source flags stay open, so the first targeted groom picks them up.
  - Every memory with open agent flags is queued for one targeted groom at boot.

### 8. The contracts change together

- The `flag_memory` input schema is unchanged; the 7-verb surface stays the same.
- Its description and `reason` text change from "safe exact-claim removal" to
  "the curator reviews the memory and may correct it, propose a correction, or
  leave it for you". The changed text lands in one PR across:
  - the server tool registry;
  - the Hermes and Pi mirrors and their drift-guard tests;
  - the primer, `docs/slash-commands.md`, and the regenerated reference pages;
  - the `/toggle-private` templates and integration READMEs that mention a queued
    correction;
  - `README.md` and the docs-site Flagged and Proposals pages.
- The private-mode sentence keeps its meaning: a flag raised in public context
  may still lead to a correction after a later private toggle; the toggle does not
  cancel queued grooming.

## Consequences

- **More fixes, fewer dead ends.** A stale statement in a cumulative memory can
  be corrected or removed in place, with the rest of the memory kept. Confident
  fixes apply on their own; the rest are ordinary proposals reviewed with
  ordinary tools.
- **One correction path.** Flags, routine tidying, and contradictions all go
  through grooming's validation, threshold, proposal, and run log. A large amount
  of special-case code goes away, including two parallel proposal-review paths.
- **Rewrites are broader than deletions.** The model now writes a whole new body
  rather than deleting exact quoted text. The safeguards are:
  - the claim-ledger audit;
  - the threshold;
  - the truncation guard;
  - the existing validators (no secrets, no empty body, no duplicate, no
    tombstone resurrection);
  - git history.
  A wrong confident rewrite is possible; it is reversible from git and visible in
  the grooming run log.
- **Just fixing the text loses the in-memory arc.** Recall no longer sees "this
  used to be A". Git still has it.
- **Corrections cost grooming tokens.** A targeted groom is small (the flagged
  memories plus a few neighbours), but it is a grooming model call. On a slow
  local model it shares the grooming queue; the v1.29.0 limits apply.
- **One full re-groom on upgrade.** The prompt version bump (and the new evidence
  fields) changes the grooming input hash, so the first scheduled groom after
  upgrade reprocesses the whole slice. Operators on a slow local model should
  expect one long run.
- **Grooming must be on.** With grooming disabled, flags wait (still visible on
  the Flagged page) and nothing is corrected automatically. This matches today,
  where the correction worker also needs the Grooming model.

## Resolved questions

1. **Intake supersede also just fixes the text.** Intake's `supersede` no longer
   asks the model to "carry the arc forward". A replacement body states the current
   facts; git history keeps the old version. Curator corrections then behave the
   same way whichever job makes them.
2. **Debounce and neighbours are fixed, not settings.** A targeted groom runs 10
   minutes after the latest pending flag, and never later than 30 minutes after
   the first. A run shows each flagged memory with its 5 most related active
   memories. Both can become settings later if they prove wrong in practice.
3. **One threshold for every correction.** A correction nobody flagged follows the
   same D13 auto-apply threshold as any other `update`: at or above it, it applies;
   below it, it becomes a proposal. There is no extra bar for unflagged corrections.

## Plan

One PR, MINOR release:

1. Core:
   - `open_flags` evidence and full-body flagged evidence;
   - the truncation guard in `grooming-validate`;
   - `resolves_flags` on `update`, with apply and approve clearing flags;
   - flag review outcomes;
   - the `flag` trigger with targeted slices, and pinning in scheduled runs;
   - prompt changes (grooming and intake supersede) and the
     `CURATOR_PROMPT_VERSION` bump.
2. Retire the ADR 0012 worker, runtime, store methods, frontmatter and proposal
   paths. Add the boot migration from §7.
3. Dashboard: Flagged page status view, Edit, Ask the curator again; remove
   Re-assess and the correction history.
4. Contracts and docs per §8; regenerate the reference pages; mark ADR 0012
   superseded.
5. Tests:
   - a regression test first: a flagged cumulative memory gets the one stale
     statement corrected, with the rest of the memory unchanged;
   - the truncation guard;
   - flags cleared on apply and on approve;
   - declined and no-change outcomes don't loop;
   - boot migration of legacy work and proposals;
   - the drift guards across Hermes and Pi.

## Implementation notes (v1.30.0)

- **The incomplete-body guard is wider than §4.** Validation refuses any operation
  that writes a new body from a source the curator did not see whole: an `update`
  with a body, a `merge`, or a `split`. "Not whole" covers truncation and a body
  whose secret-looking text was masked. Both would otherwise be written back as
  lost or placeholder text.
- **A targeted groom takes at most 5 flagged memories.** Five flagged memories
  with up to 5 neighbours each fit one model call. While more unreviewed flags
  remain, the trigger re-arms for another 10-minute window.
- **The flag groom's timer follows grooming's.** `LIBRARIAN_GROOMING_TICK_MS=0`
  turns it off too. The stdio server runs no curator jobs; a flag recorded there
  is picked up by the HTTP server that grooms the vault, at its boot scan or next
  groom.
- **Review outcomes are written as memory updates.** They are frontmatter-only
  changes and don't bump `updated_at`. Their commits use the `memory: update`
  subject, so the audit export classifies them without a new audit action, which
  would be a MAJOR change.
- **A manual edit clears flags only when asked.** The Flagged page's Edit sends
  `resolve_flags`. An edit elsewhere in the dashboard leaves the flags alone.

