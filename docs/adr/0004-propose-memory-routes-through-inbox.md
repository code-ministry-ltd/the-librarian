# ADR 0004 — `propose_memory` routes through the inbox (force-proposal)

- **Status:** Accepted
- **Date:** 2026-06-07
- **Context:** Curator unification (spec 043) follow-up; closes a write-path gap.

> **Historical correction (2026-07-18):** The `propose_memory` MCP tool described below
> was subsequently retired with the closed seven-verb MCP surface (ADR 0006).
> `InboxSubmissionHints.forceProposal` remains an internal curator routing mechanism;
> this ADR records the decision that introduced it and does not define a current MCP
> verb.
>
> **Retired (2026-10-07):** ADR 0014 removed `forceProposal` altogether. Nothing set
> it after `propose_memory` went, and the threshold is now the only apply gate.

## Context

Spec 043 introduced the inbox/intake model: `remember` became a
fire-and-forget submission to the consolidator inbox (`remember.ts` →
`store.submitToInbox`), where navigate→judge→edit dedups, merges, and
files it — landing it active, or as a proposal when a category is
protected or the intake addendum is `under_evaluation`.

`propose_memory` was **never cut over**. It still does the pre-043
direct write:

```ts
store.createMemory({ ...scoped, status: "proposed" }, { status: "proposed" });
```

`createMemory` runs `detectRelated` and returns a `duplicates` list, but
`propose_memory` discards it. The consequence is three holes:

1. **No merge/dedup.** Every `propose_memory` call creates a brand-new
   standalone proposal, even when it restates an existing memory. On
   approval that becomes a duplicate active memory. The detected
   duplicates aren't even surfaced to the caller.
2. **`/learn` over-proposes.** The `/learn` skill calls `propose_memory`
   for every hand-picked lesson, so already-chosen lessons land as fresh
   proposals needing a second approval, with zero dedup. (Addressed
   separately — `/learn` switches to `remember`.)
3. **Bypasses the under-evaluation gate.** The protection for an unproven
   curator prompt is that the intake/grooming jobs force their own
   would-be auto-applies into proposals for review
   (`curator-force-propose.ts`). That gate sits in front of the inbox.
   `propose_memory` writes around it — a proposal approved during a new
   prompt's evaluation reaches active memory having passed through no
   curator prompt at all. The mechanism works; the coverage had a hole.

## Decision

Route `propose_memory` through the inbox, like `remember`, with a
**force-proposal** terminal so its "for review" intent survives curation.

- A new `forceProposal` directive rides on the inbox submission
  (`InboxSubmissionHints.forceProposal`). It is a routing directive, not
  a filing hint, but travels the same submission→item→apply path.
- The apply layer (`consolidator/apply.ts`) already force-proposes for
  `underEvaluation`: a would-be auto-apply or active `create_new` is
  re-routed to a proposal of the raw submission; a would-be auto-archive
  is skipped (archive isn't proposable). `forceProposal` reuses that
  exact routing — `forcePropose = underEvaluation || forceProposal` —
  **minus** the addendum-version tagging, which stays specific to
  `underEvaluation` evaluation batches.
- `propose_memory` submits to the inbox with `forceProposal: true` when
  intake is enabled, returning a "queued for review" message. When intake
  is off it keeps the legacy direct write, but now **surfaces detected
  duplicates** in its response (parity with `remember`).

Net: a `propose_memory` submission is navigated and judged (so it
dedups/merges against the corpus), but always terminates as a proposal,
never an auto-apply.

## Consequences

**Positive**

- `propose_memory` proposals are deduped/merged before a human ever sees
  them — no more duplicate proposals, and the judge can route an obvious
  restatement to an augment/supersede proposal instead of a fresh doc.
- The under-evaluation gate now covers every memory write. No path
  reaches active memory without passing the curator.
- The legacy (intake-off) path stops silently swallowing duplicates.

**Negative / trade-offs**

- **Asynchronous.** The proposal no longer appears synchronously in the
  tool response; it lands after the next consolidator tick. The response
  message changes to "queued for review."
- **Exact-duplicate submissions may produce no proposal.** If the judge
  decides the submission is already covered (skip), nothing is filed —
  arguably correct (the knowledge exists), but a behaviour change from
  "always creates a proposal."
- A `forceProposal` augment/supersede proposal records the intended
  action (`proposed_action`) but not a target id, same limitation the
  under-evaluation path already has. Acceptable: the common
  `propose_memory` case is new knowledge (`create`).

## Related

- Spec 043 — curator unification / inbox cutover.
- Spec 044 — self-improving curator (the `under_evaluation` force-propose
  machinery this reuses).
- `/learn` skill change (switch to `remember`) — sibling fix, separate
  cross-repo PR across the five plugin repos.
