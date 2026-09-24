import { FlaggedView } from "@/components/memories/flagged-view";
import { CorrectionHistory } from "@/components/memories/correction-history";
import type { CorrectionHistoryRow } from "@/components/memories/types";
import { serverTRPC } from "@/lib/trpc-server";

export const dynamic = "force-dynamic";

export default async function FlaggedPage() {
  let corrections: CorrectionHistoryRow[] = [];
  let historyError: string | null = null;
  try {
    corrections = (await serverTRPC.memories.correctionHistory.query()).corrections;
  } catch (error) {
    historyError = error instanceof Error ? error.message : String(error);
  }
  return (
    <main className="flex flex-col gap-5 p-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-xl text-foreground">Flagged</h1>
        <p className="text-sm text-foreground/60">
          Claims an agent has flagged for review. Safe targeted corrections may apply
          asynchronously; if a proposal needs approval, the source stays flagged until you review
          it. Dismiss clears flags and keeps the memory, while Archive is an explicit whole-memory
          action.
        </p>
      </header>
      <FlaggedView />
      <CorrectionHistory rows={corrections} error={historyError} />
    </main>
  );
}
