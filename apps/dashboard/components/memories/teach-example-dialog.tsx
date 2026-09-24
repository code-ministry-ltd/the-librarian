// "Reject & make an example" (proposal-review rework 2026-07-01, F4).
//
// The teach flow, scenario C ordering: optional admin note → distill (the
// curator returns the updated WHOLE examples document — pure, nothing
// written) → diff preview → explicit confirm commits the document THEN
// rejects the proposal. Cancel at any point changes nothing. A distill/teach
// failure teaches inside the dialog and never blocks the card's plain Reject.
//
// Reading Room: hairline dialog chrome (ui-v2 Dialog), DiffView for the
// preview, destructive styling reserved for the one irreversible step.

"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { distillExampleAction, teachExampleAction } from "@/app/(memories)/actions";
import { Button } from "@/components/ui-v2/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui-v2/dialog";
import { SectionLabel } from "@/components/ui-v2/section-label";
import { DiffView } from "@/components/vault/diff-view";

interface Preview {
  candidate: string;
  diff: string;
}

export function TeachExampleDialog({
  proposalId,
  proposalShelfId,
  proposalTitle,
}: {
  proposalId: string;
  proposalShelfId: string;
  proposalTitle: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const reset = () => {
    setNote("");
    setPreview(null);
    setError(null);
  };

  const distill = () =>
    startTransition(async () => {
      setError(null);
      try {
        const result = await distillExampleAction(proposalId, note.trim() || undefined);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setPreview({ candidate: result.candidate, diff: result.diff });
      } catch {
        setError("Distilling failed — try again, or use plain Reject.");
      }
    });

  const confirm = () =>
    startTransition(async () => {
      if (!preview) return;
      setError(null);
      try {
        const result = await teachExampleAction(proposalId, proposalShelfId, preview.candidate);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setOpen(false);
        reset();
        router.refresh();
      } catch {
        setError("Teaching failed — the proposal was not rejected. Try again.");
      }
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset(); // cancel/close is a no-op: nothing was committed
      }}
    >
      <DialogTrigger asChild>
        <Button variant="destructive">Reject &amp; make an example</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Reject &amp; make an example</DialogTitle>
          <DialogDescription>
            The curator distills &ldquo;{proposalTitle}&rdquo; into its rejected-submission
            examples, so it stops extracting things like this. Nothing is committed until you
            confirm.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p
            role="alert"
            className="border border-destructive/40 bg-destructive/[0.04] p-2 text-sm leading-relaxed text-destructive"
          >
            {error}
          </p>
        ) : null}

        {preview ? (
          <div className="flex max-h-[50vh] flex-col gap-1.5 overflow-y-auto">
            <SectionLabel>Examples document — proposed change</SectionLabel>
            <DiffView diff={preview.diff} />
          </div>
        ) : (
          <label className="flex flex-col gap-1.5">
            <SectionLabel>Note for the curator (optional)</SectionLabel>
            <textarea
              aria-label="Note for the curator"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              placeholder="Why is this not worth remembering?"
              className="w-full border border-ink-hairline bg-ink-surface p-2 font-sans text-sm leading-relaxed text-foreground placeholder:text-foreground/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
            />
          </label>
        )}

        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          {preview ? (
            <Button variant="destructive" disabled={pending} onClick={confirm}>
              Teach &amp; reject
            </Button>
          ) : (
            <Button variant="primary" disabled={pending} onClick={distill}>
              {pending ? "Distilling…" : "Distill example"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
