// Intake — apply step (spec 035 §F5 + rethink D13). Routes a parsed judgment
// through the ONE curator apply rule (curator-apply-policy.ts) and executes the
// verdict against the store: the only intake layer that mutates live memory.
// All mutation flows through the store methods (createMemory / updateMemory /
// archiveMemory) — never raw writes — so the markdown vault + git history stay
// authoritative.
//
// The decision is made HERE (not in the judge step) because two of its inputs
// only exist at apply time: the target memory's requires_approval flag and the
// submission's forceProposal hint. The no-clobber guard (preservesOriginal)
// gates the augment write; a store rejection (e.g. a protected target) is
// caught and returned as `rejected`, never thrown, so one bad item can't abort
// a batch.

import {
  type CuratorOperationType,
  DEFAULT_APPLY_CONFIDENCE_THRESHOLD,
  decideApplication,
} from "../curator-apply-policy.js";
import { redactSecrets } from "../grooming-redaction.js";
import type { InboxSubmissionHints } from "../store/corpus/inbox.js";
import { type SplitReplacement, splitMemory } from "../store/split-memory.js";
import { augmentBody, preservesOriginal } from "./edit.js";
import type { IntakeJudgment } from "./judge.js";

/** The minimal stored memory the apply layer reads (authoritative, from the store). */
export interface IntakeStoredMemory {
  title: string;
  body: string;
  /** D13: a requires_approval target routes any operation to a proposal. */
  requires_approval?: boolean;
  /**
   * Open review flags (spec 047 / ADR 0006) — read to keep archive proposals
   * idempotent: one open curator flag per target, never a stack (review F3).
   */
  flags?: { agent_id: string }[];
  project_keys?: string[];
}

/** The store surface the apply layer needs — all mutation flows through these. */
export interface IntakeApplyStore {
  createMemory: (
    input: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => { memory: { id: string } };
  updateMemory: (id: string, patch?: Record<string, unknown>, agent_id?: string) => unknown;
  archiveMemory: (id: string, agent_id?: string) => unknown;
  // An archive judgment rides the flag-review queue (review F3, mirroring
  // grooming): the target is flagged, never archived, until a human acts.
  flagMemory: (id: string, reason: string, agent_id?: string) => unknown;
  getMemory: (id: string) => IntakeStoredMemory | null;
}

export interface ApplyIntakeDeps {
  store: IntakeApplyStore;
  /** The raw submission text — the doc source for every proposal. */
  submissionText: string;
  /** Actor id that owns a consolidated memory when the submission carries no agent hint. */
  actorId: string;
  /**
   * The single curator.apply.confidence_threshold knob (D13), shared with
   * grooming. Defaults to 0.8 (spec §15.3).
   */
  confidenceThreshold?: number;
  /**
   * The original submission's filing/ownership hints. NEW memories (create /
   * propose) inherit the submitter's agent_id so a consolidated memory keeps its
   * ownership; existing-doc edits (augment / supersede) keep the target's own
   * ownership and ignore these.
   */
  submissionHints?: InboxSubmissionHints;
  /**
   * Force-proposal routing (ADR 0004). When true, this submission must terminate
   * as a PROPOSAL, never an auto-apply — the upstream override the D13 decision
   * function honours regardless of confidence (only a noop still skips).
   */
  forceProposal?: boolean;
  /** Optional sink for a swallowed store error, so a real bug stays observable. */
  onError?: (error: unknown) => void;
}

export type IntakeOutcome =
  | { kind: "created"; id: string }
  | { kind: "augmented"; id: string }
  | { kind: "superseded"; id: string }
  | { kind: "proposed"; id: string }
  // An archive judgment's honest outcome (review F3): the TARGET was flagged
  // into the review queue — no doc was filed, nothing was archived. The
  // decision log maps it to its "proposed" verdict bucket.
  | { kind: "flagged_for_archive"; id: string }
  | { kind: "skipped" }
  | { kind: "rejected"; reason: string };

const MAX_TITLE = 80;

/**
 * The unified curator operation vocabulary (D6): intake's judge actions map
 * onto it — augment/supersede are both an `update` of an existing doc.
 * Exported so the intake eval routes judgments with the same mapping.
 */
export const INTAKE_OPERATION_OF: Record<IntakeJudgment["action"], CuratorOperationType> = {
  create: "create",
  augment: "update",
  supersede: "update",
  archive: "archive",
  split: "split",
  noop: "noop",
};

/** Derive a doc title from a submission: its first non-empty line, truncated. */
function deriveTitle(text: string): string {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return "Untitled note";
  return firstLine.length > MAX_TITLE ? `${firstLine.slice(0, MAX_TITLE - 1)}…` : firstLine;
}

export function applyIntakeJudgment(
  judgment: IntakeJudgment,
  deps: ApplyIntakeDeps,
): IntakeOutcome {
  const { store, submissionText, actorId } = deps;
  const hints = deps.submissionHints;
  // A consolidated memory is owned by the submitter (so recall scopes it), falling
  // back to the system actor when the submission carried no agent hint.
  const owner = hints?.agentId ?? actorId;
  const scope = (base: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...base, agent_id: owner };
    // applies_to is a caller-asserted targeting signal the judge can't re-derive
    // from text, so carry it onto the new memory (the judge never sets it).
    if (hints?.appliesTo !== undefined) out.applies_to = hints.appliesTo;
    if (hints?.projectKeys !== undefined) out.project_keys = hints.projectKeys;
    return out;
  };
  // The model's rationale is untrusted (could carry a hallucinated secret) and is
  // persisted into the vault + git history — redact it, like the curator does.
  const note = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    curator_note: {
      source: "intake",
      rationale: redactSecrets(judgment.rationale).redacted,
      ...extra,
    },
  });

  // The judge's PLAN, persisted onto the proposal (proposal-review rework
  // 2026-07-01, D1/D10): what it wanted to do, verbatim enough to execute later
  // (applyProposalPlan) or render on the card. NEW additive curator_note keys —
  // never `supersedes`, so a guessed target can't trigger the authoritative
  // badge or plain-approve's archive-on-approve. Planned text is untrusted
  // model output persisted to the vault → redacted like the rationale.
  const planOf = (): Record<string, unknown> => {
    switch (judgment.action) {
      case "augment":
        return {
          guessed_target_id: judgment.target_id,
          planned_addition: redactSecrets(judgment.addition).redacted,
          confidence: judgment.confidence,
        };
      case "supersede":
        return {
          guessed_target_id: judgment.target_id,
          planned_title: redactSecrets(judgment.title).redacted,
          planned_body: redactSecrets(judgment.body).redacted,
          confidence: judgment.confidence,
        };
      case "create":
        return {
          planned_title: redactSecrets(judgment.title).redacted,
          planned_body: redactSecrets(judgment.body).redacted,
          planned_tags: judgment.tags.map((tag) => redactSecrets(tag).redacted),
          confidence: judgment.confidence,
        };
      default:
        // split/archive never reach proposeSubmission; noop never proposes.
        return {};
    }
  };

  // File the raw SUBMISSION as a PROPOSED doc (requires_approval → status
  // proposed, awaiting review) carrying the judge's intended action AND its
  // persisted plan (D1). The raw submission stays the doc's title/body — a
  // human decides filing, but now they can see (and execute) what the curator
  // wanted instead of guessing from "guessed augment".
  const proposeSubmission = (proposedAction: string): IntakeOutcome => {
    const options = note({ proposed_action: proposedAction, ...planOf() });
    options.requires_approval = true;
    const input = scope({ title: deriveTitle(submissionText), body: submissionText });
    if (hints?.tags) input.tags = hints.tags; // the raw submission's tags (no judge tags here)
    const { memory } = store.createMemory(input, options);
    return { kind: "proposed", id: memory.id };
  };

  try {
    // The ONE apply rule (D13). The target's requires_approval flag is read from
    // the authoritative store; a missing target reads as not-protected and is
    // rejected by the apply lane below (propose lanes never need the target).
    const target = "target_id" in judgment ? store.getMemory(judgment.target_id) : null;
    const decision = decideApplication({
      operation: INTAKE_OPERATION_OF[judgment.action],
      confidence: judgment.confidence,
      threshold: deps.confidenceThreshold ?? DEFAULT_APPLY_CONFIDENCE_THRESHOLD,
      targetRequiresApproval: target?.requires_approval === true,
      forceProposal: deps.forceProposal === true,
    });

    if (decision === "skip") return { kind: "skipped" };

    if (decision === "propose") {
      // Split (spec 043 D-B + D13) — ALWAYS a proposal, never auto-applied. We
      // spin the judge's focused replacements out as PROPOSED docs
      // (requires_approval) that supersede the overloaded source candidate, and
      // leave the source ACTIVE — the admin archives it on accept. The shared
      // `splitMemory` primitive (the same one grooming uses) sequences the
      // writes; omitting an archive actor is what keeps it propose-only.
      if (judgment.action === "split") {
        // The split target MUST be an existing candidate (the honest guard for
        // intake's thinner context — no fabricated/navigated target).
        if (!target) return { kind: "rejected", reason: "split target missing" };
        const replacements: SplitReplacement[] = judgment.replacements.map((r) => ({
          input: scope({ title: r.title, body: r.body, tags: r.tags }),
          options: {
            ...note({ proposed_action: "split", supersedes: [judgment.target_id] }),
            requires_approval: true,
          },
        }));
        // No archive actor → the source stays active (a PROPOSED split). The new
        // proposal ids are the replacements; the outcome carries the SOURCE id so
        // the decision log records the split's target candidate.
        splitMemory(store, { sourceId: judgment.target_id, replacements });
        return { kind: "proposed", id: judgment.target_id };
      }
      // Archive (never auto-applies under D13) rides the flag-review queue,
      // mirroring grooming (review F3): flag the judged TARGET with the redacted
      // rationale so the admin sees an actionable review item — filing the raw
      // submission as a proposed doc would point at nothing. Idempotent: an open
      // flag from this curator actor already queues the proposal, so don't stack
      // another (an admin-resolved flag is removed from the doc and no longer
      // counts as open — a later judgment may flag afresh).
      if (judgment.action === "archive") {
        if (!target) return { kind: "rejected", reason: "archive target missing" };
        if (target.flags?.some((flag) => flag.agent_id === actorId)) return { kind: "skipped" };
        store.flagMemory(
          judgment.target_id,
          `curator proposes archive: ${redactSecrets(judgment.rationale).redacted}`,
          actorId,
        );
        return { kind: "flagged_for_archive", id: judgment.target_id };
      }
      // Everything else files the SUBMISSION as a proposed doc awaiting human review.
      return proposeSubmission(judgment.action);
    }

    // apply — execute the judged action directly.
    switch (judgment.action) {
      case "create": {
        // The judge curated title/body/tags; the submitter's scope still applies.
        const { memory } = store.createMemory(
          scope({ title: judgment.title, body: judgment.body, tags: judgment.tags }),
          note(),
        );
        return { kind: "created", id: memory.id };
      }
      case "augment": {
        if (!target) return { kind: "rejected", reason: "augment target missing" };
        const body = augmentBody(target.body, judgment.addition);
        // No-clobber guard (G5): augmentBody preserves by construction, but verify
        // before writing so a future non-append edit can't slip a clobber through.
        if (!preservesOriginal(target.body, body)) {
          return { kind: "rejected", reason: "augment would clobber existing content" };
        }
        store.updateMemory(judgment.target_id, { body }, actorId);
        return { kind: "augmented", id: judgment.target_id };
      }
      case "supersede": {
        if (!target) return { kind: "rejected", reason: "supersede target missing" };
        // A deliberate replacement (git history holds the prior content); no-clobber
        // does not apply — the submission contradicts/updates the target.
        store.updateMemory(
          judgment.target_id,
          { title: judgment.title, body: judgment.body },
          actorId,
        );
        return { kind: "superseded", id: judgment.target_id };
      }
      case "archive":
      case "split":
      case "noop":
        // decideApplication routes these to propose/skip, never apply — a
        // mis-route lands as a value-free skip rather than a silent mutation.
        return { kind: "skipped" };
    }
  } catch (error) {
    // A store rejection (e.g. updating a protected memory) must not abort the
    // batch — surface it as a value-free rejection. The optional sink keeps a
    // genuine programming bug observable rather than silently flattened.
    deps.onError?.(error);
    return { kind: "rejected", reason: error instanceof Error ? error.message : "store error" };
  }
}
