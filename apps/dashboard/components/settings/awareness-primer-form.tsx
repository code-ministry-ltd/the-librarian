"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { SavePrimerResult } from "@/app/settings/primer/actions";
import { Button } from "@/components/ui-v2/button";
import { SectionLabel } from "@/components/ui-v2/section-label";
import { composePrimer, utf8Bytes } from "@/lib/compose-primer";

// Primer settings (spec 083). The primer agents receive is the shipped default, which every
// install sends and nobody can edit or disable, followed by this install's optional addendum
// (vault/primer.md, ≤2 KB, git-committed). The form edits the addendum and previews the complete
// primer live. Over-2KB is refused server-side and the teaching error renders inline.
//
// The form lives chromeless: it's the only setting on the page, so the page is the container.

export function AwarenessPrimerForm({
  defaultPrimer,
  initialAddendum,
  addendumMaxBytes,
  reviewPending,
  onSave,
  onDismissReview,
}: {
  defaultPrimer: string;
  initialAddendum: string;
  /** The longest addendum that keeps the whole primer within 2 KB (harnesses truncate there). */
  addendumMaxBytes: number;
  reviewPending: boolean;
  onSave: (addendum: string) => Promise<SavePrimerResult>;
  onDismissReview: () => Promise<SavePrimerResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [addendum, setAddendum] = useState(initialAddendum);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Five-second auto-dismiss matches the archive-view inline toast pattern.
  useEffect(() => {
    if (!saved) return;
    const id = window.setTimeout(() => setSaved(false), 5000);
    return () => window.clearTimeout(id);
  }, [saved]);

  const run = (action: () => Promise<SavePrimerResult>, onOk?: () => void) => {
    startTransition(async () => {
      setError(null);
      setSaved(false);
      const result = await action();
      if (result.ok) {
        onOk?.();
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    run(
      () => onSave(addendum),
      () => setSaved(true),
    );
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setAddendum(e.target.value);
    // A stale status from a prior save lies once the operator starts editing.
    if (saved) setSaved(false);
    if (error) setError(null);
  };

  const bytes = utf8Bytes(addendum.trim());
  const over = bytes > addendumMaxBytes;
  const complete = composePrimer(defaultPrimer, addendum);

  return (
    <form onSubmit={submit} className="flex flex-col gap-6" aria-label="Primer addendum form">
      <header className="flex flex-col gap-1.5">
        <h2 className="font-display text-lg text-foreground">Primer</h2>
        <p id="primer-hint" className="max-w-3xl text-sm leading-relaxed text-foreground/60">
          Every agent receives the primer when it connects, through the MCP{" "}
          <code>instructions</code> field and the public{" "}
          <code className="font-mono text-foreground/80">/primer.md</code> endpoint. It is the
          default below, which ships with the Librarian and updates when you upgrade, followed by
          your addendum. The addendum is public like the rest of the primer, so keep secrets out of
          it.
        </p>
      </header>

      {reviewPending ? (
        <div
          role="status"
          className="flex max-w-3xl flex-col gap-2 border border-ink-accent/40 bg-ink-accent/[0.06] p-3 text-sm text-foreground"
        >
          <p>
            Your primer used to replace the default. It has been moved into the addendum, so agents
            now get the default followed by your old text, which probably repeats some of it. Trim
            the addendum to what the default doesn&apos;t say, then save.
          </p>
          <Button
            type="button"
            variant="outline"
            className="self-start"
            disabled={pending}
            onClick={() => run(onDismissReview)}
          >
            Dismiss
          </Button>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <SectionLabel as="label" htmlFor="primer-addendum">
          Addendum
        </SectionLabel>
        <p id="primer-addendum-hint" className="text-xs text-foreground/60">
          Optional. Added after the default. Leave it empty to send the default alone. The whole
          primer must fit in 2 KB, because some harnesses cut it off there.{" "}
          <span className={over ? "text-destructive" : undefined}>
            {bytes.toLocaleString("en-GB")} of {addendumMaxBytes.toLocaleString("en-GB")} bytes
            {over ? " (too long)" : ""}
          </span>
        </p>
        <textarea
          id="primer-addendum"
          aria-describedby="primer-hint primer-addendum-hint"
          className="min-h-36 border border-ink-hairline bg-ink-mono-fill p-3 font-mono text-xs leading-relaxed text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-accent"
          value={addendum}
          onChange={onChange}
        />
      </div>

      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {saved ? (
        <p
          role="status"
          className="border border-ink-accent/40 bg-ink-accent/[0.06] p-3 text-sm text-foreground"
        >
          Saved.
        </p>
      ) : null}

      <Button type="submit" variant="primary" className="self-start" disabled={pending || over}>
        {pending ? "Saving…" : "Save addendum"}
      </Button>

      <section className="flex flex-col gap-1.5" aria-labelledby="primer-preview-label">
        <SectionLabel as="h3" id="primer-preview-label">
          What agents receive
        </SectionLabel>
        <p className="text-xs text-foreground/60">
          The default, then your addendum. Updates as you type; agents get it once you save.
        </p>
        <pre
          data-testid="primer-preview"
          className="max-h-[32rem] overflow-auto whitespace-pre-wrap border border-ink-hairline bg-foreground/[0.03] p-3 font-mono text-xs leading-relaxed text-foreground/80"
        >
          {complete}
        </pre>
      </section>
    </form>
  );
}
