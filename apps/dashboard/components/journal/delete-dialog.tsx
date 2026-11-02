"use client";

// Confirm a permanent journal delete (spec 077 §4.11): one entry, a whole day, or a
// week/month summary. Names exactly what goes, and says where a copy survives.

import { useState, useTransition } from "react";
import { type JournalDeleteTarget, deleteJournalAction } from "@/app/journal/actions";
import { Button } from "@/components/ui-v2/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui-v2/dialog";

export interface PendingDelete {
  target: JournalDeleteTarget;
  /** "the 10:00–11:40 entry on Monday 2 November", "Week 44", … */
  what: string;
}

interface Props {
  pending: PendingDelete | null;
  onClose: () => void;
  onDeleted: () => void;
}

export function JournalDeleteDialog({ pending, onClose, onDeleted }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  const submit = () => {
    if (!pending) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteJournalAction(pending.target);
      if (result.ok) {
        onDeleted();
        onClose();
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) {
          setError(null);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {pending?.what ?? "this"} from the journal?</DialogTitle>
          <DialogDescription>
            Agents will no longer see it, in the session-start window or through the{" "}
            <code className="font-mono text-foreground/80">journal</code> tool. You can&apos;t undo
            this from the dashboard; the vault&apos;s git history keeps a copy.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="outline"
            className="border-destructive/50 text-destructive hover:bg-destructive/10"
            onClick={submit}
            disabled={busy}
          >
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
