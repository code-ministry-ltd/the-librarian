# ADR 0012 — Safely correct flagged memories without discarding mixed records

- **Status:** Accepted
- **Date:** 2026-09-24
- **Related:** ADR 0006 (agent-facing MCP surface), ADR 0007 (the rethink and private-mode protocol)

## Context

A flagged memory may combine an outdated claim with useful facts. Sending every flag to human review is safe but slow; archiving the entire record can discard the useful facts, while accepting a model-generated replacement risks changing claims the user did not flag. Correction is also a new model call over stored text and must respect shelf authority, the shared confidence policy, and the in-context private-mode limitation.

## Decision

1. `flag_memory` persists the flag and a digest-only work marker together, then returns without waiting for the correction worker. The marker contains routing and snapshot metadata, never body or reason text. Only new explicit markers are processed; legacy flags are not swept.
2. The worker receives redacted, bounded source text and all open flag reasons as untrusted data. It may remove only uniquely mapped exact spans that form a safe standalone claim. All open flags are one batch: resolve none unless the candidate addresses every flag. The worker constructs the deletion itself and preserves all non-target content.
3. The shared D13 confidence threshold is the sole confidence gate for direct application. Eligible unprotected corrections may apply at or above the threshold, including confidence `0` when the threshold is `0`. A safe candidate blocked by the threshold or another approved gate becomes a single-target review proposal; a candidate that cannot be isolated safely remains flagged for manual review. Whole-memory Archive is never an automatic fallback.
4. Correction work and review are bound to server-resolved exact shelves and source/flag/content snapshots. Generic proposal approval, rejection, and update paths cannot bypass the correction-specific checks. Approval activates the corrected replacement and archives its superseded source; the replacement must retain every non-target fact.
5. Proposal and source finalization use separate synchronous memory-document writes; the store does not provide a cross-file transaction. The proposal records its terminal review outcome, timestamp, and reviewer in the same write that activates or rejects it. Startup/poll recovery reconciles an interrupted source write only when the exact proposal, shelf, source, and flag snapshots still match. On missing or drifted state it preserves the source and marks the work for manual review. This is recovery, not atomicity.
6. Private mode remains an in-conversation instruction. The server cannot verify the marker. Agents must not issue new write calls while private, but a correction already queued by a valid public flag may finish after a later private toggle; toggling does not cancel it.
7. Preserve the existing synchronous file/Git write model. Do not add a single-writer runtime restriction or interprocess lock in this change. Competing processes and external vault editors may still race, overwrite work, or create duplicate work; no cross-process isolation is claimed.

## Consequences

- Mixed memories retain useful facts while safe, exact stale claims can be removed asynchronously. If certainty or source mapping is insufficient, the item stays visible for a person rather than being broadly rewritten or archived.
- The agent-facing response reports queue status, not completion. If a storage/commit error occurs after a file write, the outcome is uncertain rather than a confirmed no-op; the response directs the user to check the Flagged page before retrying. Harness guidance must relay returned status without claiming the correction has already happened.
- Automatic review uses the configured Grooming provider. Known secret patterns are redacted, but redaction is best-effort and cannot guarantee removal of arbitrary sensitive text.
- Durable proposal outcomes permit recovery from interruption between proposal and source writes without claiming a multi-document transaction. Drift, missing authority, or unrecoverable state remains flagged for manual review. If an approved correction supersedes another correction proposal for the same source, the stale proposal is archived with a resolution marker rather than sent through generic proposal resolution.
- The MCP surface remains the existing seven verbs with the same `flag_memory` input schema. Dashboard history and review controls provide the human decision surface.
