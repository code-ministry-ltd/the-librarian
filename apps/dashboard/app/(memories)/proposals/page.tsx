import { ProposalsView } from "@/components/memories/proposals-view";
import { ThresholdZeroNotice } from "@/components/memories/threshold-zero-notice";
import type { ProposalReviewRow } from "@/components/memories/types";
import { readApplyThreshold } from "@/lib/apply-threshold";
import { serverTRPC } from "@/lib/trpc-server";

export const dynamic = "force-dynamic";

export default async function ProposalsPage() {
  // The enriched review endpoint (T3): per proposal, its self-describing
  // provenance (action/source/rationale), the memories it supersedes, and a
  // server-rendered old→new diff for a single-target replacement. The card
  // badges the action, shows the rationale, and renders the diff with DiffView.
  let rows: ProposalReviewRow[] = [];
  let error: string | null = null;
  const threshold = await readApplyThreshold();
  try {
    rows = (await serverTRPC.memories.proposalsForReview.query()) as ProposalReviewRow[];
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return (
    <main className="flex flex-col gap-5 p-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-xl text-foreground">Proposals</h1>
        <p className="text-sm text-foreground/60">
          Memories the resident curator wants to save. Each card states what it changes — approve to
          apply it, or reject to discard it.
        </p>
      </header>
      <ThresholdZeroNotice threshold={threshold} page="proposals" />
      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          Failed to load proposals: {error}
        </p>
      ) : null}
      <ProposalsView rows={rows} />
    </main>
  );
}
