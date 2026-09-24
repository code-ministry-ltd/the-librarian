import { SYSTEM_ACTOR_IDS } from "./caller-identity.js";
import { decideApplication } from "./curator-apply-policy.js";
import { LlmClientError, type LlmClient } from "./grooming-llm-client.js";
import {
  buildMemoryCorrectionCandidate,
  buildMemoryCorrectionMessages,
  parseMemoryCorrectionOutput,
  prepareMemoryCorrectionInput,
} from "./memory-correction.js";
import { redactSecrets } from "./grooming-redaction.js";
import type { MemoryCorrectionWorkItem, MemoryStore } from "./store/memory-types.js";

const DEFAULT_LEASE_MS = 6 * 60_000;
const RETRY_DELAYS_MS = [30_000, 2 * 60_000] as const;
const MAX_RESPONSE_CHARS = 50_000;
const MAX_COMPLETION_TOKENS = 2_000;

type CorrectionStore = Pick<
  MemoryStore,
  | "getMemory"
  | "claimMemoryCorrection"
  | "updateMemoryCorrectionWork"
  | "applyMemoryCorrection"
  | "getMemoryCorrectionProposal"
  | "createMemoryCorrectionProposal"
>;

export interface ProcessMemoryCorrectionWorkOptions {
  store: CorrectionStore;
  item: MemoryCorrectionWorkItem;
  /** Exact shelf this store handle is rooted at. */
  shelfId: string;
  /** Current, server-resolved flagger actor identity. */
  principalId: string;
  /** Revalidated against the current router's exact writable shelf set. */
  authorizedToWrite: boolean;
  /** Revalidated against the current admin reviewer's exact recall shelf set. */
  adminCanReview: boolean;
  /** A disabled or incomplete existing Grooming gate is terminal for this snapshot. */
  preconditionFailure?: string;
  llmClient?: LlmClient;
  confidenceThreshold: number;
  leaseMs?: number;
  now?: () => Date;
}

export type ProcessMemoryCorrectionWorkResult =
  | { status: "applied" }
  | { status: "proposal_pending"; proposal_id: string }
  | { status: "manual_review"; reason_code: string }
  | { status: "retry_scheduled"; reason_code: string }
  | { status: "stale"; reason_code: string }
  | { status: "claim_lost" };

/**
 * Process exactly one digest-fenced correction marker. Authorization and exact shelf routing are
 * supplied by the server composition root; no model-produced field can choose either identity.
 */
export async function processMemoryCorrectionWork(
  options: ProcessMemoryCorrectionWorkOptions,
): Promise<ProcessMemoryCorrectionWorkResult> {
  const { store, item, shelfId, principalId } = options;
  const shelfMismatch = item.work.shelf_id !== shelfId;

  const claimed = store.claimMemoryCorrection({
    id: item.memory_id,
    snapshot_digest: item.work.snapshot_digest,
    lease_ms: options.leaseMs ?? DEFAULT_LEASE_MS,
    agent_id: SYSTEM_ACTOR_IDS.memoryCurator,
  });
  if (!claimed) return { status: "claim_lost" };

  const manual = (reason_code: string): ProcessMemoryCorrectionWorkResult => {
    const updated = store.updateMemoryCorrectionWork({
      id: item.memory_id,
      snapshot_digest: claimed.snapshot_digest,
      claim_attempt: claimed.attempt_count,
      patch: { status: "manual_review", reason_code },
      agent_id: SYSTEM_ACTOR_IDS.memoryCurator,
    });
    return updated
      ? { status: "manual_review", reason_code }
      : { status: "stale", reason_code: "snapshot_changed" };
  };

  const retryOrReview = (reason_code: string): ProcessMemoryCorrectionWorkResult => {
    if (claimed.attempt_count >= 3) return manual("retry_exhausted");
    const delay = RETRY_DELAYS_MS[claimed.attempt_count - 1];
    if (delay === undefined) return manual("retry_exhausted");
    const updated = store.updateMemoryCorrectionWork({
      id: item.memory_id,
      snapshot_digest: claimed.snapshot_digest,
      claim_attempt: claimed.attempt_count,
      patch: {
        status: "pending",
        reason_code,
        next_attempt_at: new Date(
          (options.now ?? (() => new Date()))().getTime() + delay,
        ).toISOString(),
      },
      agent_id: SYSTEM_ACTOR_IDS.memoryCurator,
    });
    return updated
      ? { status: "retry_scheduled", reason_code }
      : { status: "stale", reason_code: "snapshot_changed" };
  };

  if (shelfMismatch) return manual("shelf_mismatch");
  if (principalId !== claimed.principal_id) return manual("principal_mismatch");
  if (!options.authorizedToWrite) return manual("no_write_scope");
  if (!options.adminCanReview) return manual("no_admin_scope");
  if (options.preconditionFailure) return manual(options.preconditionFailure);
  if (!options.llmClient) return manual("provider_unavailable");
  if (
    !Number.isFinite(options.confidenceThreshold) ||
    options.confidenceThreshold < 0 ||
    options.confidenceThreshold > 1
  ) {
    return manual("invalid_apply_threshold");
  }

  const memory = store.getMemory(item.memory_id);
  if (!memory || memory.status !== "active") return manual("ineligible_status");
  try {
    const existingProposal = store.getMemoryCorrectionProposal({
      source_memory_id: memory.id,
      snapshot_digest: claimed.snapshot_digest,
    });
    if (existingProposal) {
      if (existingProposal.status !== "proposed") return manual("proposal_closed");
      const updated = store.updateMemoryCorrectionWork({
        id: item.memory_id,
        snapshot_digest: claimed.snapshot_digest,
        claim_attempt: claimed.attempt_count,
        patch: { status: "proposal_pending", proposal_id: existingProposal.id },
        agent_id: SYSTEM_ACTOR_IDS.memoryCurator,
      });
      return updated
        ? { status: "proposal_pending", proposal_id: existingProposal.id }
        : { status: "stale", reason_code: "snapshot_changed" };
    }
  } catch {
    return retryOrReview("proposal_lookup_failed");
  }

  const prepared = prepareMemoryCorrectionInput(
    memory.body,
    memory.flags.map(({ reason }) => ({ reason })),
  );
  if (!prepared.ok) return manual(prepared.reason_code);

  let completion;
  try {
    completion = await options.llmClient.complete({
      messages: buildMemoryCorrectionMessages(prepared.value),
      temperature: 0,
      maxTokens: MAX_COMPLETION_TOKENS,
    });
  } catch (error) {
    return retryableProviderFailure(error)
      ? retryOrReview(providerFailureCode(error))
      : manual("provider_failed");
  }

  if (completion.content.length > MAX_RESPONSE_CHARS) return manual("response_too_large");
  const parsed = parseMemoryCorrectionOutput(completion.content);
  if (!parsed.ok) return manual(parsed.reason_code);
  const addressed = [...parsed.value.addressed_flags].sort((a, b) => a - b);
  if (
    parsed.value.quotes.length === 0 ||
    addressed.length !== memory.flags.length ||
    addressed.some((index, position) => index !== position)
  ) {
    return manual(
      parsed.value.quotes.length === 0 ? "no_safe_candidate" : "incomplete_flag_coverage",
    );
  }

  const candidate = buildMemoryCorrectionCandidate(
    memory.body,
    prepared.value.body,
    parsed.value.quotes,
  );
  if (!candidate.ok) return manual(candidate.reason_code);

  const decision = decideApplication({
    operation: "update",
    confidence: parsed.value.confidence,
    threshold: options.confidenceThreshold,
    targetRequiresApproval: memory.requires_approval,
  });
  if (decision === "apply") {
    try {
      const applied = store.applyMemoryCorrection({
        id: item.memory_id,
        snapshot_digest: claimed.snapshot_digest,
        claim_attempt: claimed.attempt_count,
        spans: candidate.value.spans,
        agent_id: SYSTEM_ACTOR_IDS.memoryCurator,
      });
      return applied ? { status: "applied" } : { status: "stale", reason_code: "snapshot_changed" };
    } catch {
      return retryOrReview("store_write_failed");
    }
  }

  try {
    const proposal = store.createMemoryCorrectionProposal({
      source_memory_id: memory.id,
      snapshot_digest: claimed.snapshot_digest,
      source_digest: claimed.source_digest,
      flags_digest: claimed.flags_digest,
      claim_attempt: claimed.attempt_count,
      shelf_id: item.work.shelf_id,
      proposed_body: candidate.value.body,
      spans: candidate.value.spans,
      confidence: parsed.value.confidence,
      rationale: redactSecrets(parsed.value.rationale).redacted,
      agent_id: SYSTEM_ACTOR_IDS.memoryCurator,
    });
    if (!proposal) return { status: "stale", reason_code: "snapshot_changed" };
    if (proposal.status !== "proposed") return manual("proposal_closed");
    const updated = store.updateMemoryCorrectionWork({
      id: item.memory_id,
      snapshot_digest: claimed.snapshot_digest,
      claim_attempt: claimed.attempt_count,
      patch: { status: "proposal_pending", proposal_id: proposal.id },
      agent_id: SYSTEM_ACTOR_IDS.memoryCurator,
    });
    return updated
      ? { status: "proposal_pending", proposal_id: proposal.id }
      : { status: "stale", reason_code: "snapshot_changed" };
  } catch {
    // Retry lets the next attempt's targeted proposal lookup recover a create that
    // persisted before a later write/commit error. Never log proposal/model content.
    return retryOrReview("proposal_write_failed");
  }
}

function retryableProviderFailure(error: unknown): boolean {
  if (!(error instanceof LlmClientError)) return false;
  if (error.kind === "timeout" || error.kind === "network") return true;
  return (
    error.kind === "http" &&
    (error.status === 429 || (error.status !== undefined && error.status >= 500))
  );
}

function providerFailureCode(error: unknown): string {
  if (!(error instanceof LlmClientError)) return "provider_failed";
  if (error.kind === "timeout" || error.kind === "network") return `provider_${error.kind}`;
  return error.status === 429 ? "provider_rate_limited" : "provider_server_error";
}
