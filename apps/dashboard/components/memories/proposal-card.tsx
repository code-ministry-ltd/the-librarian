// The proposal-aware review card (spec 2026-06-20 proposal-review-ux, T4).
//
// Replaces the bare MemoryCard in the /proposals queue. Driven by one enriched
// row from memories.proposalsForReview, it states what the curator proposes so
// the operator can decide in seconds:
//   - an action badge (D5: authoritative Update/Replace/Merge/Split only when a
//     target resolved; an honest "New — needs filing" for a target-less intake
//     submission, the guess kept as muted text);
//   - a source chip (intake / grooming) + the curator's rationale;
//   - a per-action body: single-target → old then DiffView then proposed new;
//     merge → the N source memories then the merged replacement (no line diff);
//     intake no-target → submission body + a "review and file" note;
//   - an Approve button whose label states the archival consequence (D4).
//
// Reading Room system: hairline edges, sharp corners, paper-surface fill, no
// shadows, the rubric accent held to the single primary action (Approve) +
// focus ring. DiffView is already on-palette. Fail-soft: an action failure is
// swallowed (logged), never thrown out of the card.

"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  applyProposalPlanAction,
  approveProposalAction,
  rejectProposalAction,
} from "@/app/(memories)/actions";
import { DiscussProposalButton } from "@/components/curator/discuss-proposal-button";
import { MemoryTags } from "@/components/memories/memory-tags";
import { approveConsequenceLabel, proposalBadge } from "@/components/memories/proposal-action";
import { TeachExampleDialog } from "@/components/memories/teach-example-dialog";
import type { ProposalReviewRow } from "@/components/memories/types";
import { Button } from "@/components/ui-v2/button";
import { Pill } from "@/components/ui-v2/pill";
import { SectionLabel } from "@/components/ui-v2/section-label";
import { DiffView } from "@/components/vault/diff-view";

export function ProposalCard({
  row,
  grouped = false,
}: {
  row: ProposalReviewRow;
  /** True when this card is one replacement inside a split group — the shared
   *  source is shown once by the group block, so the card shows only the
   *  proposed memory (no source panel, no diff, no "needs filing" note) and
   *  drops the badge/source header the group already carries. */
  grouped?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // A guard failure from apply-the-plan is a teaching error the operator must
  // see (F3) — rendered on the card, never thrown.
  const [error, setError] = useState<string | null>(null);
  const { proposal, action, source, rationale, targets, diff } = row;
  // The judge's persisted plan (proposal-review rework F2) — null on legacy
  // rows and on grooming proposals. Read defensively: rows serialized before
  // the rework may lack the key entirely.
  const plan = row.plan ?? null;
  const move = row.move ?? null;
  const actorDisplay = row.actorDisplay;
  // Drift (spec 072 SC 7): a memory this proposal supersedes changed while the
  // proposal waited, so approving it would archive the newer text and drop that
  // edit from the active corpus. Read defensively — rows serialized before 072
  // lack the key, and `unknown` (nothing recorded to compare) must never block.
  const driftedMemories = (row.drift?.sources ?? []).filter((s) => s.drifted);
  const isDrifted = row.drift?.status === "drifted";
  const isCorrection = source === "flagged_correction" || row.correctionReview !== undefined;
  const shelfId = proposal.shelfId ?? "";
  const shelfCanWrite = Boolean(shelfId) && proposal.shelfWritable !== false;
  /** No correction activation without a current exact-shelf baseline; Reject remains available. */
  const approvalBlocked =
    pending ||
    isDrifted ||
    !shelfCanWrite ||
    (isCorrection && row.correctionReview?.status !== "ready");

  const badge = proposalBadge({ action, targetCount: targets.length });
  const approveLabel = isCorrection
    ? "Approve correction"
    : approveConsequenceLabel({ action, targetCount: targets.length });

  const run = (fn: () => Promise<unknown>) =>
    startTransition(async () => {
      try {
        const result = await fn();
        if (result && typeof result === "object" && "ok" in result && result.ok === false) {
          setError(
            "error" in result && typeof result.error === "string" ? result.error : "Action failed.",
          );
          return;
        }
        setError(null);
        router.refresh();
      } catch {
        // Fail-soft (AGENTS.md): a Librarian/network failure must never throw
        // out of the UI. The server action already returns {ok:false} rather
        // than throwing, but a rejected promise here is swallowed too so the
        // card stays interactive.
      }
    });

  const isMerge = targets.length >= 2;
  const isSingleTarget = targets.length === 1;
  const isSplit = action === "split";
  const isMove = action === "move";
  const executableMove =
    isMove &&
    move?.failure_reason === null &&
    move.target !== null &&
    move.source_shelf !== null &&
    move.destination_shelf !== null;

  // Apply-the-plan affordance (F3): only an augment/supersede plan is
  // executable — create rides the patch-approve path (D11). The label names
  // the target so the consequence is explicit; an unresolvable/archived target
  // disables the button (the plan panel above explains why) but never hides
  // it — the operator should see what WOULD have been possible.
  const executablePlan =
    plan && (plan.action === "augment" || plan.action === "supersede")
      ? {
          label:
            plan.action === "augment"
              ? `Approve as augment of ${plan.guessed_target?.title ?? "(missing target)"}`
              : `Approve — replaces ${plan.guessed_target?.title ?? "(missing target)"}`,
          disabled: plan.guessed_target_reason !== null || plan.guessed_target === null,
        }
      : null;

  // Create-plan approve-with-patch (D11): the default Approve applies the
  // judge's curated version through the approve mutation's `patch` parameter;
  // "Approve raw submission" preserves today's path (no patch). Only fields
  // the plan actually carries ride the patch — never empty overwrites.
  const createPatch =
    plan && plan.action === "create" && (plan.planned_title || plan.planned_body)
      ? {
          ...(plan.planned_title ? { title: plan.planned_title } : {}),
          ...(plan.planned_body ? { body: plan.planned_body } : {}),
          ...(plan.planned_tags ? { tags: plan.planned_tags } : {}),
        }
      : null;

  const applyPlan = () =>
    startTransition(async () => {
      try {
        const result = await applyProposalPlanAction(proposal.id);
        if (result && !result.ok) {
          setError(result.error);
          return;
        }
        setError(null);
        router.refresh();
      } catch {
        // Fail-soft: a rejected promise never escapes the card.
        setError(
          isMove
            ? "Applying the move failed — try again, or Reject."
            : "Applying the plan failed — try again, or use Approve as new / Reject.",
        );
      }
    });

  return (
    <article
      aria-label={`Proposal: ${proposal.title || "(untitled)"}`}
      className={
        grouped
          ? "flex flex-col gap-3 border border-ink-hairline bg-foreground/[0.02] p-3"
          : "flex flex-col gap-3 border border-ink-hairline bg-ink-surface p-4"
      }
    >
      {/* Header: badge + source chip, then rationale. Suppressed when grouped —
          the split block already carries the badge + source above. */}
      {!grouped ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {/* The One Pen Rule: the rubric accent is reserved for the single
                primary action (Approve) + focus. The action badge is a neutral
                chip — its text carries the meaning; a target-less "needs filing"
                badge wears the sage state hue (secondary/attention), distinct
                from the rubric, to flag that it needs the operator's judgement. */}
            <Pill
              variant={badge.authoritative ? "default" : "muted"}
              aria-label={`Action: ${badge.label}`}
            >
              {badge.label}
            </Pill>
            {source ? (
              <Pill aria-label={`Source: ${source}`} className="uppercase tracking-[0.08em]">
                {source}
              </Pill>
            ) : null}
            {/* The curator's guessed action, kept as muted description for a
                target-less proposal — never as an authoritative badge (D5).
                Suppressed when a persisted plan renders below: the plan panel
                states the intent properly, so the hint would be noise. */}
            {!badge.authoritative && badge.guessedAction && !plan ? (
              <span className="font-mono text-[11px] text-foreground/55">
                curator guessed: {badge.guessedAction}
              </span>
            ) : null}
          </div>
          {/* The proposed memory's title is rendered (labelled) inside the
              per-action body below — keep it out of the header so a merge's
              "Merged into" panel isn't shadowed by a redundant heading. */}
          {rationale ? (
            <p className="text-sm italic leading-relaxed text-foreground/70">
              &ldquo;{rationale}&rdquo;
            </p>
          ) : null}
        </div>
      ) : null}

      <MemoryTags tags={proposal.tags} />

      {isCorrection ? (
        <section
          aria-label="Flagged correction review"
          className="flex flex-col gap-2 border border-ink-hairline bg-foreground/[0.02] p-3"
        >
          <SectionLabel>Flagged correction</SectionLabel>
          <p className="text-sm leading-relaxed text-foreground/75">
            This proposal removes only the claims identified for correction. Approval activates the
            corrected copy and archives the flagged source; rejection keeps the source active and
            flagged for manual review.
          </p>
          {targets[0]?.flags?.length ? (
            <ul className="flex flex-col gap-1.5">
              {targets[0].flags.map((flag, index) => (
                <li
                  key={`${flag.agent_id}-${flag.created_at}-${index}`}
                  className="border border-destructive/40 bg-destructive/[0.06] px-2.5 py-1.5 text-xs leading-relaxed"
                >
                  <span className="text-destructive">&ldquo;{flag.reason}&rdquo;</span>
                  <span className="text-foreground/60"> — flagged by {flag.agent_id}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-foreground/60">No open flags remain on the source.</p>
          )}
          {row.correctionReview?.status !== "ready" ? (
            <p role="alert" className="text-sm text-destructive">
              The source, flags, or proposal changed after this correction was prepared. Reject this
              proposal or review the flagged source manually.
            </p>
          ) : null}
          {!shelfCanWrite ? (
            <p role="status" className="text-sm text-foreground/60">
              This shelf is not writable by the current administrator.
            </p>
          ) : null}
        </section>
      ) : null}

      {/* Per-action body. Order matters: split first (1 target, no diff, but
          NOT an intake submission), then single-target diff, then merge, then
          the intake no-target fallback. */}
      {grouped ? (
        <MemoryPanel
          label="Replacement"
          title={proposal.title}
          body={proposal.body}
          tone="proposed"
        />
      ) : isMove ? (
        <MoveBody move={move} />
      ) : isSplit ? (
        <SplitBody source={targets[0]} proposal={proposal} />
      ) : isSingleTarget ? (
        // Gate on the target alone, not on a truthy diff: a real update whose
        // body didn't change yields diff === "" (server returns "" for
        // identical). DiffView renders "" as "No changes — versions are
        // identical", so the single-target Current/Proposed layout still
        // applies — falling through to the intake "needs filing" copy would be
        // misleading. `diff ?? ""` covers the null case defensively.
        <SingleTargetBody target={targets[0]!} proposal={proposal} diff={diff ?? ""} />
      ) : isMerge ? (
        <MergeBody sources={targets} proposal={proposal} />
      ) : (
        <IntakeBody proposal={proposal} plan={plan} />
      )}

      {/* Drift (spec 072 SC 7 / D3). The block is stated, not merely styled:
          the operator has to know WHICH memory moved, and — the part that must
          never be dropped — that rejecting costs nothing, because the curator
          re-reads it next sweep. Without that sentence a refusal reads as
          losing the curator's work, and the operator goes hunting for a way
          round a gate that deliberately has none. */}
      {isDrifted ? (
        <section
          role="alert"
          aria-label="This proposal is out of date"
          className="relative flex flex-col gap-2 border border-ink-hairline bg-foreground/[0.02] p-3 pl-[14px] before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-destructive before:content-['']"
        >
          <SectionLabel>Out of date</SectionLabel>
          <p className="text-sm leading-relaxed text-foreground/80">
            {driftedMemories.length === 1 ? (
              <>
                <strong>
                  {driftedMemories[0]!.title
                    ? `“${driftedMemories[0]!.title}”`
                    : driftedMemories[0]!.id}
                </strong>{" "}
                has changed
              </>
            ) : (
              <>
                <strong>{driftedMemories.length} of the memories</strong> this proposal replaces
                have changed
              </>
            )}{" "}
            since the curator drafted this. Approving it would discard{" "}
            {driftedMemories.length === 1 ? "that edit" : "those edits"}, so it can no longer be
            applied.
          </p>
          <p className="text-sm leading-relaxed text-foreground/60">
            Rejecting costs nothing: the curator re-reads{" "}
            {driftedMemories.length === 1 ? "this memory" : "these memories"} on its next grooming
            run, and may well propose a similar change against your current version.
          </p>
        </section>
      ) : null}

      {/* A guard failure from apply-the-plan teaches here (F3) — the plan
          couldn't be executed, the other resolutions remain. */}
      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.04] p-2 text-sm leading-relaxed text-destructive"
        >
          {error}
        </p>
      ) : null}

      {/* Actions. With an executable plan (F3): apply-the-plan is the primary
          (consequence-named) action, plain approve steps back to "Approve as
          new". Without one: today's Approve/Reject pair, unchanged. */}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-ink-hairline pt-3">
        <span className="mr-auto font-mono text-[11px] text-foreground/45">
          {proposal.agent_id ? (
            actorDisplay ? (
              <>
                <span title={proposal.agent_id}>{actorDisplay}</span>
                {" · "}
              </>
            ) : (
              `${proposal.agent_id} · `
            )
          ) : (
            ""
          )}
          {new Date(proposal.updated_at).toLocaleDateString()}
        </span>
        {/* Every path that ACTIVATES this proposal is disabled while it is
            drifted — there is deliberately no "approve anyway" (D3). Reject,
            Discuss and Teach below stay live: they are how a stale proposal
            leaves the queue. The server refuses too; this is the honest UI of
            that refusal, not the enforcement. */}
        {isMove ? (
          executableMove ? (
            <Button variant="primary" disabled={approvalBlocked} onClick={applyPlan}>
              Apply move
            </Button>
          ) : null
        ) : executablePlan ? (
          <>
            <Button
              variant="primary"
              disabled={approvalBlocked || executablePlan.disabled}
              onClick={applyPlan}
            >
              {executablePlan.label}
            </Button>
            <Button
              disabled={approvalBlocked}
              onClick={() => run(() => approveProposalAction(proposal.id, shelfId))}
            >
              Approve as new
            </Button>
          </>
        ) : createPatch ? (
          <>
            <Button
              variant="primary"
              disabled={approvalBlocked}
              onClick={() => run(() => approveProposalAction(proposal.id, shelfId, createPatch))}
            >
              Approve curated version
            </Button>
            <Button
              disabled={approvalBlocked}
              onClick={() => run(() => approveProposalAction(proposal.id, shelfId))}
            >
              Approve raw submission
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            disabled={approvalBlocked}
            onClick={() => run(() => approveProposalAction(proposal.id, shelfId))}
          >
            {approveLabel}
          </Button>
        )}
        {/* Proposal-scoped chat (F5/D4) is unavailable for flagged-correction
            proposals, which have a dedicated exact-shelf review path. */}
        {!isCorrection ? (
          <DiscussProposalButton proposalId={proposal.id} proposalTitle={proposal.title} />
        ) : null}
        {/* Teach loop entry point (F4): intake-sourced only in v1 (scenario F —
            grooming rejections don't teach yet). Plain Reject stays untouched
            beside it — teaching is the explicit affordance, never a side
            effect of rejection (D5). */}
        {source === "intake" ? (
          <TeachExampleDialog
            proposalId={proposal.id}
            proposalShelfId={shelfId}
            proposalTitle={proposal.title}
          />
        ) : null}
        <Button
          variant="destructive"
          disabled={pending || !shelfCanWrite}
          onClick={() => run(() => rejectProposalAction(proposal.id, shelfId))}
        >
          Reject
        </Button>
      </div>
    </article>
  );
}

function MoveBody({ move }: { move: ProposalReviewRow["move"] | null }) {
  const reason =
    move?.failure_reason === "target_not_found"
      ? "The target memory no longer resolves."
      : move?.failure_reason === "target_not_active"
        ? "The target memory is no longer active."
        : move?.failure_reason === "destination_not_found"
          ? "The destination shelf no longer resolves."
          : move === null
            ? "The move details are unavailable."
            : null;

  if (
    !move ||
    reason ||
    move.target === null ||
    move.source_shelf === null ||
    move.destination_shelf === null
  ) {
    return (
      <p className="border border-ink-hairline bg-foreground/[0.02] p-3 text-sm leading-relaxed text-foreground/60">
        {reason ?? "The move details no longer resolve."} Reject this request to clear the queue.
      </p>
    );
  }

  const target = move.target;
  const source = move.source_shelf;
  const destination = move.destination_shelf;
  return (
    <div className="flex flex-col gap-2">
      <section className="flex flex-col gap-1.5 border border-ink-hairline bg-foreground/[0.02] p-3">
        <SectionLabel>Target memory</SectionLabel>
        <h4 className="text-sm font-medium text-foreground">{target.title}</h4>
        <span className="font-mono text-[11px] text-foreground/50">{target.id}</span>
      </section>
      <section className="flex flex-col gap-1.5 border border-ink-hairline bg-foreground/[0.02] p-3">
        <SectionLabel>Move between shelves</SectionLabel>
        <p className="flex flex-wrap items-center gap-2 text-sm text-foreground/75">
          <span title={source.id}>{source.label ?? source.id}</span>
          <span aria-hidden="true">→</span>
          <span title={destination.id}>{destination.label ?? destination.id}</span>
        </p>
      </section>
    </div>
  );
}

// A panel framing one memory's title + body inside the card — the shared shape
// for "old memory", "proposed new", and each merge source.
function MemoryPanel({
  label,
  title,
  body,
  tone = "neutral",
}: {
  label: string;
  title: string;
  body: string;
  /** `proposed` marks the panel as the outcome with a copper structural
   *  left-marker (the manuscript-hardware accent — never state, so it doesn't
   *  spend the rubric, which stays on Approve); everything else is plain paper. */
  tone?: "neutral" | "proposed";
}) {
  return (
    <section
      className={`relative flex flex-col gap-1.5 border border-ink-hairline bg-foreground/[0.02] p-3 ${
        tone === "proposed"
          ? "pl-[14px] before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-ink-copper before:content-['']"
          : ""
      }`}
    >
      <SectionLabel>{label}</SectionLabel>
      <h4 className="text-sm font-medium text-foreground">
        {title || <span className="italic text-foreground/55">(untitled)</span>}
      </h4>
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/70">
        {body}
      </p>
    </section>
  );
}

// Single-target replacement (update/supersede): old memory, the diff, the new.
function SingleTargetBody({
  target,
  proposal,
  diff,
}: {
  target: ProposalReviewRow["targets"][number];
  proposal: ProposalReviewRow["proposal"];
  diff: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <MemoryPanel label="Current memory" title={target.title} body={target.body} />
      <div className="flex flex-col gap-1.5">
        <SectionLabel>Changes</SectionLabel>
        <DiffView diff={diff} />
      </div>
      <MemoryPanel label="Proposed" title={proposal.title} body={proposal.body} tone="proposed" />
    </div>
  );
}

// Merge (>= 2 sources): the N sources, then the merged replacement. No line
// diff — a merge collapses several memories, which a two-file diff can't show.
function MergeBody({
  sources,
  proposal,
}: {
  sources: ProposalReviewRow["targets"];
  proposal: ProposalReviewRow["proposal"];
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2">
        {sources.map((source, i) => (
          <MemoryPanel
            key={source.id}
            label={`Source ${i + 1} of ${sources.length}`}
            title={source.title}
            body={source.body}
          />
        ))}
      </div>
      <MemoryPanel
        label="Merged into"
        title={proposal.title}
        body={proposal.body}
        tone="proposed"
      />
    </div>
  );
}

// Standalone split (one replacement seen alone — its siblings aren't in this
// queue). Show the source it came from, then the proposed replacement. No line
// diff (a split fans one memory into several, which a two-file diff can't show).
function SplitBody({
  source,
  proposal,
}: {
  source: ProposalReviewRow["targets"][number] | undefined;
  proposal: ProposalReviewRow["proposal"];
}) {
  return (
    <div className="flex flex-col gap-2">
      {source ? <MemoryPanel label="Split from" title={source.title} body={source.body} /> : null}
      <MemoryPanel
        label="Replacement"
        title={proposal.title}
        body={proposal.body}
        tone="proposed"
      />
    </div>
  );
}

// Intake no-target (create/augment/supersede with nothing recorded): the raw
// submission body, then either the judge's persisted plan (F2 — what the
// curator wanted to do, with a preview) or the honest pre-rework note that it
// couldn't place the submission. No authoritative diff either way.
function IntakeBody({
  proposal,
  plan,
}: {
  proposal: ProposalReviewRow["proposal"];
  plan: ProposalReviewRow["plan"] | null;
}) {
  return (
    <div className="flex flex-col gap-2">
      <MemoryPanel label="Submission" title={proposal.title} body={proposal.body} />
      {plan ? (
        <PlanPanel plan={plan} />
      ) : (
        <p className="border border-ink-hairline bg-foreground/[0.02] p-3 text-sm leading-relaxed text-foreground/60">
          The curator wasn&rsquo;t sure where this belongs — review and file it.
        </p>
      )}
    </div>
  );
}

// The judge's persisted plan (proposal-review rework F2): the intent line
// ("Wanted to augment ‹target› with: …"), the planned content, a preview diff
// of executing it, and the judgment confidence. Display-only — executing the
// plan is the card's affordance layer, not this panel's.
function PlanPanel({ plan }: { plan: NonNullable<ProposalReviewRow["plan"]> }) {
  const targetTitle = plan.guessed_target?.title ?? null;
  // A machine-readable reason means the plan can't be applied as-is: the
  // guessed target is gone or archived. Teach, don't hide.
  const targetNote =
    plan.guessed_target_reason === "not_found" ? (
      <p className="text-sm leading-relaxed text-foreground/60">
        The memory the curator wanted to touch no longer exists — review and file the submission
        instead.
      </p>
    ) : plan.guessed_target_reason ? (
      <p className="text-sm leading-relaxed text-foreground/60">
        The memory the curator wanted to touch{targetTitle ? ` (“${targetTitle}”)` : ""} has since
        been {plan.guessed_target_reason} — review and file the submission instead.
      </p>
    ) : null;

  return (
    <section className="relative flex flex-col gap-2 border border-ink-hairline bg-foreground/[0.02] p-3 pl-[14px] before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-ink-copper before:content-['']">
      <SectionLabel>Curator&rsquo;s plan</SectionLabel>
      <p className="text-sm leading-relaxed text-foreground/80">
        {plan.action === "augment" ? (
          <>
            Wanted to <em>augment</em>{" "}
            <strong>{targetTitle ?? plan.guessed_target?.id ?? "(unknown)"}</strong> with:
          </>
        ) : plan.action === "supersede" ? (
          <>
            Wanted to <em>replace</em>{" "}
            <strong>{targetTitle ?? plan.guessed_target?.id ?? "(unknown)"}</strong> with:
          </>
        ) : (
          <>
            Wanted to <em>file a new memory</em>:
          </>
        )}
      </p>
      {plan.planned_addition ? (
        <p className="whitespace-pre-wrap break-words border border-ink-hairline bg-ink-surface p-2 text-sm leading-relaxed text-foreground/70">
          {plan.planned_addition}
        </p>
      ) : null}
      {plan.planned_title || plan.planned_body ? (
        <div className="flex flex-col gap-1 border border-ink-hairline bg-ink-surface p-2">
          {plan.planned_title ? (
            <h5 className="text-sm font-medium text-foreground">{plan.planned_title}</h5>
          ) : null}
          {plan.planned_body ? (
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/70">
              {plan.planned_body}
            </p>
          ) : null}
          {plan.planned_tags && plan.planned_tags.length > 0 ? (
            <p className="font-mono text-[11px] text-foreground/55">
              tags: {plan.planned_tags.join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}
      {targetNote}
      {plan.preview_diff ? (
        <div className="flex flex-col gap-1.5">
          <SectionLabel>If applied</SectionLabel>
          <DiffView diff={plan.preview_diff} />
        </div>
      ) : null}
      {typeof plan.confidence === "number" ? (
        <span className="font-mono text-[11px] text-foreground/45">
          confidence {plan.confidence.toFixed(2)}
        </span>
      ) : null}
    </section>
  );
}
