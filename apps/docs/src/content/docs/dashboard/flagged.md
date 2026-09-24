---
title: Flagged
description: Review memories an agent reported as wrong, misleading, or out of date.
---

When an agent recalls a memory that looks wrong, it can **flag** it with a reason
rather than changing or archiving it on its own. Flagging demotes the memory below
unflagged matches in recall while targeted correction review runs asynchronously.

![The Flagged memories page](../../../assets/screenshots/flagged.png)

## What you'll see

The page lists flagged memories with their title, text, and **flag details** — the
reason given, which agent raised it, and when. It also shows whether correction
work is queued, needs manual review, or has produced a proposal. A flag stays open
until a safe correction applies or an administrator resolves it.

Automatic review uses the configured Grooming provider and runs only while Grooming
is enabled and operational. Before sending the source text and flag reasons to the
provider, the system redacts known secret patterns. Redaction is best-effort; it
cannot guarantee removal of arbitrary sensitive text.

The agent's `flag_memory` response reports whether the flag was recorded and
review was queued; it does **not** report the eventual correction outcome. If a
persistence error says the write could not be confirmed, the flag may already be
recorded—check this page before retrying. The agent should relay the returned
status and must not claim the memory is corrected until the outcome is confirmed
here.

## Targeted corrections

The correction worker may remove only exact, confidently identified claim spans;
it constructs the corrected text itself so unrelated facts remain unchanged. If
the shared confidence policy allows it, the correction applies and clears the
reviewed flags. Unsafe or unreviewable cases remain flagged for a person.

When a safe candidate needs human approval — for example, because it is below the
shared confidence threshold or the memory is protected — the system creates a
single-memory proposal. The original stays active and flagged until an administrator
approves the correction. Approval activates the corrected replacement and archives
the superseded source; it does not discard the useful facts retained in that
replacement. Rejecting the proposal keeps the original active and flagged for manual
review.

## The main task

- **Dismiss** — the flag was unfounded; clear the flags and keep the memory active.
- **Archive** — explicitly archive the whole memory and clear its flags. This remains
a separate human action; an unsafe correction never falls back to whole-memory
archival.

## Recent corrections

Applied corrections appear in **Recent corrections** for 30 days, including the
memory and shelf and whether the correction was applied directly or approved as a
proposal. If nothing is flagged or no correction has been applied in that window,
the page shows the corresponding empty state.
