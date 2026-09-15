import { HandoffsListView } from "@/components/handoffs/list-view";

export const dynamic = "force-dynamic";

export default function HandoffsPage() {
  return (
    <main className="flex flex-col gap-5 p-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-xl text-foreground">Handoffs</h1>
        <p className="text-sm text-foreground/60">
          Cross-harness narrative handoffs. Claim them from a coding agent with{" "}
          <code className="font-mono text-foreground/80">/takeover</code>, or delete the ones you no
          longer need.
        </p>
      </header>
      <HandoffsListView />
    </main>
  );
}
