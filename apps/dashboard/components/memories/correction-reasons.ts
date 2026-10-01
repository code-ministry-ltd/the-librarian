// Plain-English explanations for the reason codes the flagged-correction worker
// records when it hands a flag back for manual review. Unknown codes fall back
// to a generic sentence that still names the code, so a new server-side code is
// never silently hidden.

const CORRECTION_REASONS: Record<string, string> = {
  // The model's answer could not be applied safely.
  quote_not_standalone_claim:
    "The flagged text isn't a complete sentence or list item (or it has nested items), so it can't be removed on its own.",
  quote_missing_or_ambiguous:
    "The curator quoted text that doesn't appear exactly once in the memory.",
  quote_intersects_redaction: "The flagged text overlaps something that looks like a secret.",
  quotes_overlap: "The curator's suggested removals overlap each other.",
  source_map_mismatch: "The suggested removal couldn't be matched back to the stored text.",
  too_many_quotes: "The correction would touch too many separate places at once.",
  quote_total_limit_exceeded: "The correction would remove too much text at once.",
  no_reviewable_content: "Removing the flagged text would leave the memory empty.",
  no_safe_candidate: "The curator found no part it could safely remove to address the flags.",
  no_candidate: "The curator found no part it could safely remove to address the flags.",
  incomplete_flag_coverage: "The curator could address some of the flags but not all of them.",
  invalid_json: "The curator's model returned an answer that couldn't be read.",
  invalid_shape: "The curator's model returned an answer in the wrong format.",
  response_too_large: "The curator's model returned an answer that was too large.",
  // Limits on what the worker will send.
  body_limit_exceeded: "The memory is too long for automatic correction.",
  redacted_body_limit_exceeded: "The memory is too long for automatic correction.",
  flag_count_exceeded: "There are too many open flags for automatic correction.",
  flag_reasons_limit_exceeded: "The flag reasons are too long for automatic correction.",
  redacted_flag_reasons_limit_exceeded: "The flag reasons are too long for automatic correction.",
  empty_flag_reason: "A flag has no reason to act on.",
  no_open_flags: "There were no open flags to act on.",
  // Setup and access.
  grooming_disabled: "Grooming is turned off, and automatic correction uses the Grooming model.",
  provider_unavailable: "No working Grooming model is configured.",
  token_unavailable: "The Grooming provider's API key couldn't be read.",
  provider_failed: "The Grooming model request failed.",
  provider_output_limit:
    "The Grooming model's reply hit its output limit before it finished, so it was discarded. Raise the Grooming output limit in Curator settings, then Re-assess.",
  retry_exhausted: "The Grooming model kept failing, so the curator stopped retrying.",
  max_attempts: "The curator stopped after the maximum number of attempts.",
  invalid_apply_threshold: "The auto-apply threshold setting is invalid.",
  no_admin_scope: "No administrator can review this shelf automatically.",
  no_worker_scope: "The curator doesn't have access to this shelf.",
  no_write_scope: "The agent that raised the flag can't write to this shelf.",
  custom_router_unverified: "Automatic correction isn't available with a custom shelf router.",
  shelf_mismatch: "The memory is no longer on the shelf it was flagged on.",
  principal_mismatch: "The flag's owner couldn't be confirmed.",
  // The memory moved on.
  snapshot_drift: "The memory or its flags changed while it was being assessed.",
  snapshot_changed: "The memory or its flags changed while it was being assessed.",
  ineligible_status: "Only active memories can be corrected automatically.",
  proposal_closed: "A correction proposal for these flags was already rejected.",
  correction_proposal_rejected: "You rejected the curator's correction proposal for these flags.",
  correction_proposal_missing: "The correction proposal for these flags has gone missing.",
  correction_proposal_resolution_drifted:
    "The memory changed after its correction proposal was resolved.",
  correction_proposal_resolution_mismatch:
    "The correction proposal was resolved in a way that no longer matches the memory.",
  correction_source_missing: "The memory this correction applied to is missing.",
  invalid_correction_baseline: "The correction proposal no longer matches the memory.",
};

// A fresh pass over the same body and flags would find the proposal already
// decided and stop straight away, so Re-assess is not offered for these.
const NOT_REASSESSABLE = new Set(["proposal_closed", "correction_proposal_rejected"]);

export function canReassessCorrection(code: string | undefined): boolean {
  return !code || !NOT_REASSESSABLE.has(code);
}

export function describeCorrectionReason(code: string | undefined): string | null {
  if (!code) return null;
  return CORRECTION_REASONS[code] ?? `The curator stopped with reason “${code}”.`;
}
