// The Journal page (spec 077 PR D): the dated history of your conversations with your
// agents — recent days entry by entry, older weeks and months summarised — with a
// timeline that follows you through it, the agents' own search, and owner deletes.

import { JournalView } from "@/components/journal/journal-view";

export const dynamic = "force-dynamic";

export default function JournalPage() {
  return (
    <main className="p-6">
      <JournalView
        intro={
          <header className="flex max-w-3xl flex-col gap-1.5">
            <h1 className="font-display text-xl text-foreground">Journal</h1>
            <p className="text-sm text-foreground/70">
              What you and your agents talked about, written from captured conversations. Agents
              start each session with the recent part and can search the rest with the{" "}
              <code className="font-mono text-foreground/80">journal</code> tool.
            </p>
          </header>
        }
      />
    </main>
  );
}
