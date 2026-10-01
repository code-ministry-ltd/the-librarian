import { FlaggedView } from "@/components/memories/flagged-view";

export const dynamic = "force-dynamic";

export default function FlaggedPage() {
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
      <FlaggedView />
    </main>
  );
}
