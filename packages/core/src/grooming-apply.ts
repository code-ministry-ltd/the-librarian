// Curator apply execution (spec §11 + §11.1). Consumes the §10.5 validated
// operations, runs each through the ONE apply rule (rethink D13,
// curator-apply-policy.ts), and EXECUTES the verdict against the store — the
// only layer in the curator that mutates live memory.
//
// Invariants:
//   - All memory mutations go through store methods (createMemory / updateMemory /
//     archiveMemory / flagMemory) — never raw writes (the vault + git history
//     stay authoritative).
//   - `curator_note` provenance is set only via createMemory's trusted `options`
//     channel, never via patch (which can't carry it anyway).
//   - Ownership: every write is owned by the curator actor. The agent_id is
//     passed explicitly, never taken from the model.
//   - Auto-applied merges archive their superseded sources in the same
//     operation. Proposed ops NEVER mutate live sources here — they land as a
//     new proposal carrying curator_note.supersedes (or, for archive, a flag).
//   - Every operation (applied / proposed / skipped / failed) is recorded for the
//     admin audit with the unified function's verdict; the recorded rationale is
//     redacted as defence-in-depth.

import { decideApplication } from "./curator-apply-policy.js";
import { memoryContentDigest } from "./formatters/memory-diff.js";
import type { GroomingMemoryPatch, GroomingOperation } from "./grooming-output.js";
import { redactSecrets } from "./grooming-redaction.js";
import type { ValidatedOperation, ValidationContext } from "./grooming-validate.js";
import type { RecordCurationOperationInput } from "./store/curation-store.js";
import { mergeMemory } from "./store/merge-memory.js";
import { type SplitReplacement, splitMemory } from "./store/split-memory.js";

// The authoritative stored memory used to reconstruct a protected-update proposal.
// Must come from the store (getMemory), NOT the evidence projection, which is
// redacted + truncated.
interface StoredMemory {
  title: string;
  body: string;
  // Open review flags (spec 047 / ADR 0006) — read to keep archive proposals
  // idempotent: one open curator flag per target, never a stack.
  flags?: { agent_id: string }[];
  confidence: string;
  tags: string[];
  applies_to: string[];
  project_keys?: string[];
}

// The store surface the apply layer needs (all mutation flows through these).
export interface ApplyStore {
  createMemory: (
    input: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => { memory: { id: string } };
  updateMemory: (id: string, patch?: Record<string, unknown>, agent_id?: string) => unknown;
  archiveMemory: (id: string, agent_id?: string) => unknown;
  // Archive proposals ride the flag-review queue (D13: archive never
  // auto-applies, and there is no replacement doc to file as a proposal).
  flagMemory: (id: string, reason: string, agent_id?: string) => unknown;
  getMemory: (id: string) => StoredMemory | null;
  // Open proposals in the shelf this run writes to — read to suppress an exact
  // repeat (spec 072 D6). UNCAPPED on purpose: `listMemories` clamps at 200, and
  // the evidence bundle shares a 200-memory budget that ACTIVE rows consume
  // first, so either source would silently miss a pending proposal on a large
  // vault and re-file the duplicate this exists to prevent.
  listMemoriesUncapped: (filters?: Record<string, unknown>) => {
    memories: { curator_note?: Record<string, unknown> | null }[];
  };
  recordCurationOperation: (input: RecordCurationOperationInput) => unknown;
}

export interface ApplyDeps {
  store: ApplyStore;
  runId: string;
  /** Curator actor id for common-slice writes (e.g. "system-memory-curator"). */
  actorId: string;
  /** The single curator.apply.confidence_threshold knob (D13; default 0.8). */
  confidenceThreshold: number;
  /** Optional sink for swallowed execution errors (keeps the audit row content-free). */
  onError?: (error: unknown, operation: GroomingOperation) => void;
}

export interface ApplySummary {
  applied: number;
  proposed: number;
  skipped: number;
  failed: number;
}

interface ExecContext {
  store: ApplyStore;
  runId: string;
  actorId: string;
  owner: string;
}

export function applyOperations(
  validated: ValidatedOperation[],
  context: ValidationContext,
  deps: ApplyDeps,
): ApplySummary {
  const exec: ExecContext = {
    store: deps.store,
    runId: deps.runId,
    actorId: deps.actorId,
    // The curator actor owns every write.
    owner: deps.actorId,
  };

  const summary: ApplySummary = { applied: 0, proposed: 0, skipped: 0, failed: 0 };
  for (const { operation, outcome } of validated) {
    if (outcome.decision === "reject") {
      // A rejected op may have been rejected FOR its content (e.g. secrets), so
      // its payload is not persisted — only the value-free reason.
      record(deps, operation, "skipped", outcome.reason, [], {});
      summary.skipped++;
      continue;
    }
    // Accepted ops passed the §10.5 content guards, so their payload is safe to record.
    const payload = operationPayload(operation);
    // The ONE apply rule (D13) — the recorded status below IS this verdict.
    const decision = decideApplication({
      operation: operation.type,
      confidence: operation.confidence,
      threshold: deps.confidenceThreshold,
      targetRequiresApproval: outcome.targetRequiresApproval,
    });
    if (decision === "skip") {
      record(deps, operation, "skipped", operation.rationale, [], payload);
      summary.skipped++;
      continue;
    }
    try {
      if (decision === "propose") {
        // Spec 072 D6: don't file a proposal the queue already holds. TIGHT by
        // design — same action over the same source set, so a pending update{A}
        // does not block a merge{A,B} (different judgments; the operator should
        // see both, and approving either withdraws the other). Inside the try so
        // a store error during the scan records a failed op rather than killing
        // the sweep.
        if (openProposalCovers(deps.store, operation)) {
          record(
            deps,
            operation,
            "skipped",
            "skipped: open proposal already covers these sources",
            [],
            payload,
          );
          summary.skipped++;
          continue;
        }
        const targets = proposeOp(operation, exec);
        // Archive idempotency (Phase 1 review F2): when every source already
        // carries an open curator flag, the re-proposal flagged nothing — record
        // it as a skip so the audit says why, instead of stacking flags run
        // after run. (An admin resolving the flags re-opens the lane: resolved
        // flags are removed from the doc, so they no longer count as open.)
        if (operation.type === "archive" && targets.length === 0) {
          record(deps, operation, "skipped", "skipped: already flagged by curator", [], payload);
          summary.skipped++;
          continue;
        }
        record(deps, operation, "proposed", operation.rationale, targets, payload);
        summary.proposed++;
      } else {
        record(deps, operation, "applied", operation.rationale, applyOp(operation, exec), payload);
        summary.applied++;
      }
    } catch (error) {
      // Never echo the thrown error (could carry store/content detail) into the
      // audit row; surface it to the optional out-of-band sink so a programming
      // bug stays observable.
      deps.onError?.(error, operation);
      record(deps, operation, "failed", operation.rationale, [], payload);
      summary.failed++;
    }
  }
  return summary;
}

// The memories an operation proposes to replace — the identity D6 dedups on.
// `create` has no sources to match against, and `archive` rides the flag-review
// queue, which carries its own per-actor idempotency (review F2).
function proposalSourceIds(op: GroomingOperation): string[] | null {
  switch (op.type) {
    case "update":
    case "split":
      return [op.source_memory_id];
    case "merge":
      return op.source_memory_ids;
    default:
      return null;
  }
}

function sameSourceSet(a: string[], b: string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

// True when an open proposal is already the same judgment about the same
// memories — matched as a SET, so source order never decides it.
function openProposalCovers(store: ApplyStore, op: GroomingOperation): boolean {
  const sources = proposalSourceIds(op);
  if (sources === null || sources.length === 0) return false;
  return store.listMemoriesUncapped({ status: "proposed" }).memories.some((proposal) => {
    const note = proposal.curator_note;
    if (!note || note.proposed_action !== op.type) return false;
    const supersedes = note.supersedes;
    if (!Array.isArray(supersedes)) return false;
    return sameSourceSet(
      supersedes.filter((id): id is string => typeof id === "string"),
      sources,
    );
  });
}

// Auto-apply an operation the D13 rule cleared; returns the target memory ids.
// archive/split never reach here (they ALWAYS propose, by operation type).
function applyOp(op: GroomingOperation, c: ExecContext): string[] {
  switch (op.type) {
    case "create":
      return [createMemory(c, op.memory, []).id];
    case "update":
      c.store.updateMemory(op.source_memory_id, op.patch, c.actorId);
      return [op.source_memory_id];
    case "merge":
      // Auto-applied merge: spin up the merged replacement, then archive the
      // sources. The shared primitive owns the create-then-archive ordering (on a
      // partial failure the duplicate stays active rather than losing a source);
      // pass the actor so it archives the superseded sources (an apply, not a
      // propose).
      return [
        mergeMemory(c.store, {
          replacement: buildCreateCall(c, op.replacement, op.source_memory_ids),
          sourceIds: op.source_memory_ids,
          archiveActorId: c.actorId,
        }),
      ];
    case "archive":
    case "split":
    case "noop":
      // decideApplication routes these to propose/skip, never apply — fail loud.
      throw new Error(`${op.type} is never auto-applied`);
  }
}

// Route an operation to a proposal. Returns the new proposal ids (or, for an
// archive, the flagged source ids). Sources are NOT archived — the admin
// archives the superseded memory after accepting (§11.1). The
// `requiresApproval: true` flag makes `createMemory` land each row at
// `status=proposed` without the legacy category-based bridge.
function proposeOp(op: GroomingOperation, c: ExecContext): string[] {
  const opts = { requiresApproval: true };
  switch (op.type) {
    case "create": {
      // A proposed create supersedes nothing (no source); stamp the action +
      // rationale so the dashboard can badge it and show the curator's reasoning.
      const prov = provenance("create", op.rationale);
      return [createMemory(c, op.memory, [], opts, prov).id];
    }
    case "merge":
      // Proposed merge: spin up the merged replacement at requires_approval (status
      // proposed) but leave the sources ACTIVE — the admin archives them after
      // accepting (§11.1). No actor → the primitive does not archive the sources.
      return [
        mergeMemory(c.store, {
          replacement: buildCreateCall(
            c,
            op.replacement,
            op.source_memory_ids,
            opts,
            provenance("merge", op.rationale),
          ),
          sourceIds: op.source_memory_ids,
        }),
      ];
    case "split": {
      // Proposed split: spin the replacements out at requires_approval (status
      // proposed) but leave the source ACTIVE — the admin archives it after
      // accepting (§11.1). No actor → the primitive does not archive the source.
      const prov = provenance("split", op.rationale);
      return splitMemory(c.store, {
        sourceId: op.source_memory_id,
        replacements: op.replacements.map((r) =>
          buildCreateCall(c, r, [op.source_memory_id], opts, prov),
        ),
      });
    }
    case "update": {
      // Reconstruct from the AUTHORITATIVE store record (not the redacted/truncated
      // evidence), so a patch that omits a field proposes the real existing value.
      const existing = c.store.getMemory(op.source_memory_id);
      if (!existing) throw new Error("update source missing from store");
      return [
        createMemory(
          c,
          correctedMemory(existing, op.patch),
          [op.source_memory_id],
          opts,
          provenance("update", op.rationale),
        ).id,
      ];
    }
    case "archive": {
      // A proposed archive has no replacement doc to file, so it rides the
      // flag-review queue (D13 / D4: the flag queue IS the human checkpoint):
      // each source is flagged (soft-demoted + routed to review) with the
      // redacted rationale, and the admin archives it on acceptance. Live
      // sources are never mutated here. Idempotent per source (review F2): a
      // source the curator actor already has an OPEN flag on is skipped —
      // re-grooming an unchanged slice must not stack duplicate flags. An
      // admin-resolved flag is REMOVED from the doc (resolveFlags empties the
      // list), so it does not count as open and a later groom may flag afresh.
      const flagged: string[] = [];
      for (const id of op.source_memory_ids) {
        const existing = c.store.getMemory(id);
        if (existing?.flags?.some((flag) => flag.agent_id === c.actorId)) continue;
        c.store.flagMemory(
          id,
          `curator proposes archive: ${redactSecrets(op.rationale).redacted}`,
          c.actorId,
        );
        flagged.push(id);
      }
      return flagged;
    }
    case "noop":
      // decideApplication routes noop → skip, never propose — fail loud.
      throw new Error("noop is not proposable");
  }
}

// Self-describing provenance stamped on a PROPOSED grooming proposal's
// curator_note (spec 2026-06-20 proposal-review-ux, D2). Mirrors what intake
// already writes (`intake/apply.ts`): `source:"grooming"`, the op type as
// `proposed_action`, and a redacted rationale — giving the dashboard ONE read
// path for the action badge / source chip / rationale, and letting approve tell
// a split (don't auto-archive) from an update (do). The rationale is the model's
// untrusted prose persisted into the vault + git history, so it is redacted here
// (defence-in-depth, same as the audit row). Auto-apply paths pass none of this,
// so their curator_note shape is unchanged.
type ProposedAction = "create" | "update" | "merge" | "split";
interface Provenance {
  proposed_action: ProposedAction;
  rationale: string;
}
function provenance(action: ProposedAction, rationale: string): Provenance {
  return { proposed_action: action, rationale: redactSecrets(rationale).redacted };
}

// Build the createMemory `{ input, options }` for one memory the curator writes
// (a create, a merge replacement, or a split replacement) WITHOUT executing it —
// so the split primitive can sequence the writes. Owner + curator_note (run_id +
// supersedes, plus self-describing provenance on the propose path) + the optional
// requires_approval gate are baked in here.
function buildCreateCall(
  c: ExecContext,
  memory: Record<string, unknown>,
  supersedes: string[],
  options: { requiresApproval?: boolean } = {},
  prov?: Provenance,
): SplitReplacement {
  const curatorNote: Record<string, unknown> = { run_id: c.runId };
  if (supersedes.length > 0) {
    curatorNote.supersedes = supersedes;
    // Spec 072 T3: fingerprint each source AS DRAFTED, so review can tell later
    // whether the memory moved underneath the proposal. Proposals only — an
    // auto-applied write has no queue wait in which to go stale. Digest the
    // AUTHORITATIVE store record, never the evidence projection: evidence is
    // redacted and body-truncated, so its digest could never match a recompute.
    if (options.requiresApproval === true) {
      const digests: Record<string, string> = {};
      for (const sourceId of supersedes) {
        const source = c.store.getMemory(sourceId);
        if (source) digests[sourceId] = memoryContentDigest(source);
      }
      if (Object.keys(digests).length > 0) curatorNote.source_digests = digests;
    }
  }
  // Self-describing provenance on the PROPOSE path only — auto-apply callers
  // omit `prov`, so their curator_note keeps its existing { run_id, supersedes? }
  // shape (no source/proposed_action/rationale).
  if (prov) {
    curatorNote.source = "grooming";
    curatorNote.proposed_action = prov.proposed_action;
    curatorNote.rationale = prov.rationale;
  }
  // Section 4d.3 — the curator emits requires_approval=true on
  // protected creates so the store can drop the legacy
  // category-based gate. Auto-apply paths (non-protected ops) leave
  // this unset and land at the conservative defaults
  // (requires_approval=false, is_global=false).
  const isProposal = options.requiresApproval === true;
  const storeOptions: Record<string, unknown> = { curator_note: curatorNote };
  if (isProposal) storeOptions.requires_approval = true;
  return { input: { ...memory, agent_id: c.owner }, options: storeOptions };
}

function createMemory(
  c: ExecContext,
  memory: Record<string, unknown>,
  supersedes: string[],
  options: { requiresApproval?: boolean } = {},
  prov?: Provenance,
): { id: string } {
  const call = buildCreateCall(c, memory, supersedes, options, prov);
  return c.store.createMemory(call.input, call.options).memory;
}

// Reconstruct the corrected memory for a protected update proposal: the patch
// merged over the AUTHORITATIVE stored memory. Every non-boundary field falls
// back to the existing value so an omitted patch field is preserved, not
// dropped. (The retired category/visibility/scope passthroughs are gone —
// rethink T12 / S1: the store drops those fields on write.)
function correctedMemory(
  existing: StoredMemory,
  patch: GroomingMemoryPatch,
): Record<string, unknown> {
  return {
    title: patch.title ?? existing.title,
    body: patch.body ?? existing.body,
    applies_to: patch.applies_to ?? existing.applies_to,
    confidence: patch.confidence ?? existing.confidence,
    tags: patch.tags ?? existing.tags,
    ...(existing.project_keys !== undefined ? { project_keys: existing.project_keys } : {}),
  };
}

function record(
  deps: ApplyDeps,
  op: GroomingOperation,
  status: RecordCurationOperationInput["status"],
  rationale: string,
  targets: string[],
  proposedPayload: Record<string, unknown>,
): void {
  deps.store.recordCurationOperation({
    run_id: deps.runId,
    operation_type: op.type,
    status,
    confidence: op.confidence,
    rationale: redactSecrets(rationale).redacted,
    proposed_payload: proposedPayload,
    source_memory_ids: sourceMemoryIds(op),
    target_memory_ids: targets,
  });
}

// The operation's content for the audit record — EXCLUDES the raw rationale
// (recorded separately, redacted) since an accepted op's rationale prose could
// still carry a model-hallucinated secret; the content fields here passed the
// §10.5 secret guard.
function operationPayload(op: GroomingOperation): Record<string, unknown> {
  switch (op.type) {
    case "noop":
      return { source_memory_ids: op.source_memory_ids };
    case "archive":
      return { source_memory_ids: op.source_memory_ids };
    case "update":
      return { source_memory_id: op.source_memory_id, patch: op.patch };
    case "merge":
      return { source_memory_ids: op.source_memory_ids, replacement: op.replacement };
    case "split":
      return { source_memory_id: op.source_memory_id, replacements: op.replacements };
    case "create":
      return { memory: op.memory };
  }
}

function sourceMemoryIds(op: GroomingOperation): string[] {
  switch (op.type) {
    case "noop":
    case "archive":
    case "merge":
      return op.source_memory_ids;
    case "update":
    case "split":
      return [op.source_memory_id];
    case "create":
      return [];
  }
}
