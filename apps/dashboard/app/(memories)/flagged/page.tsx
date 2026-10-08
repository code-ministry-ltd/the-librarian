import { FlaggedView } from "@/components/memories/flagged-view";
import { ThresholdZeroNotice } from "@/components/memories/threshold-zero-notice";
import { readApplyThreshold } from "@/lib/apply-threshold";

export const dynamic = "force-dynamic";

export default async function FlaggedPage() {
  const threshold = await readApplyThreshold();
  return (
    <main className="flex flex-col gap-5 p-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-xl text-foreground">Flagged</h1>
        <p className="text-sm text-foreground/60">
          Memories an agent has flagged as wrong or outdated. The curator reviews each one about 10
          minutes after it is flagged: it corrects the memory, proposes a correction for you to
          approve, or leaves it here with its reason. You can also edit the memory yourself, dismiss
          the flag, or archive the whole memory.
        </p>
      </header>
      <ThresholdZeroNotice threshold={threshold} page="flagged" />
      <FlaggedView />
    </main>
  );
}
