# ADR 0015 — Deterministic guards refuse unsafe curator writes

- **Status:** Accepted
- **Date:** 2026-10-12
- **Amends:** nothing — ADR 0014 (the threshold governs every operation) stands as written
- **Related:** ADR 0013 (flags corrected by grooming), ADR 0014

## Context

An audit of a live corpus (531 active memories, 851 archived, curated at
threshold 0) found that the curator degrades memories over time:

- **Memories only grow.** Since 1 September, 3,473 inbox submissions produced
  357 new memories and 3,051 updates. `augment` is append-only and nothing caps a
  body, so popular memories became grab-bags; the largest reached 36,461
  characters. 18 of the 31 active memories over 500 words were judged seriously
  damaged: unrelated facts joined on a shared word, contradictions, or a title
  that no longer matched the content.
- **Merges lose detail.** Across 860 merge edges, the merged memory kept only 41%
  of its sources' specific terms (ports, versions, file and model names). 29% of
  memories created by grooming merges had serious problems, against 5% of
  intake-created ones.
- **The worst memories cannot be repaired.** Grooming sees bodies cut to 4,000
  characters and, per ADR 0013, refuses to rewrite a body it cannot see in full.
  The 25 memories over that window could never be split.

The prompt already asks the curator to preserve every source claim. It does not
reliably do so, and at threshold 0 nobody reviews the result.

## Decision

1. **Code checks every write the threshold would apply.** After the threshold says
   "apply", two deterministic guards run against the authoritative stored bodies:
   - **Size.** A new body (create, merge or split replacement) may not exceed
     4,000 characters, the grooming evidence window. An existing memory may shrink
     or stay the same size but never grow past the larger of the cap and its
     current size, so corrections to an already oversized memory still apply.
   - **Detail.** Distinctive terms are 4+ character tokens with a digit,
     underscore, slash, camelCase boundary, inner hyphen or inner dot, counted
     over title and body. A **merge or split** only reorganises memories, so it
     may drop at most `max(3, 10%)` of its sources' terms. A **rewrite** (a
     grooming update with a body, an intake supersede) may drop up to half,
     because corrections and the prompt's de-brittling legitimately remove paths
     and identifiers; losing more than that is gutting, and is refused. Terms
     named by the submission or the source's open flag reasons never count,
     because a correction may remove what it corrects. Replayed against the
     audited history, the merge rule would have refused 206 of 291 past merges
     (71%).
2. **A failed guard refuses; it never queues.** Nothing is written and nothing is
   added to a review queue, so ADR 0014's promise holds: at threshold 0, nothing
   reaches a person. The refusal is recorded with a fixed, content-free reason.
   - **Intake** re-judges the submission once, with the reason in a
     `GUARD FEEDBACK` block. If the second judgment is refused too, the item ends
     as a rejection that carries the reason.
   - **Grooming** records the operation as skipped. The next run sees the same
     memories and can choose a different operation.
3. **Guards only ever make the curator more conservative.** They never turn a
   refusal into an apply and never touch a below-threshold proposal. A person who
   approves a proposal is the review; guards don't second-guess them.
4. **Splits are not undone.** Every split stamps `curator_note.split_from` on its
   replacements. Grooming validation rejects a merge of two memories split from
   the same source; a person can still merge them by hand.
5. **The prompt says so.** Curator prompt v6.2 states the cap and the
   keep-every-detail rule in both modes, marks intake candidates at 3,600
   characters or more as `at_size_cap`, and stops weaving a bundled submission's
   unrelated facts into the primary target.

## Consequences

- The grooming evidence window and the memory size cap are one constant
  (`MAX_MEMORY_BODY_CHARS`), so any memory the guards let exist can be seen whole,
  and repaired, by grooming.
- Memories that are already over the cap stay as they are until something splits
  them; they can no longer grow.
- A bundled submission's secondary facts that aren't about the primary subject are
  named in the decision log's rationale rather than filed. Letting intake file
  several memories from one submission is the planned fix.
- The prompt version bump changes the grooming input hash, so every slice is
  re-groomed once after upgrading (as with any prompt change).
- The thresholds (4,000 characters, `max(3, 10%)`) were chosen from the audit data.
  They are constants, not settings; change them in code with new evidence.
