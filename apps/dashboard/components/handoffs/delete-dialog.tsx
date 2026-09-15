"use client";

// Confirmation dialog for permanently deleting a handoff.
//
// Permanent delete is irreversible from the app (it hard-deletes the vault
// document; the deletion is a git commit, so only vault history could
// recover it). This dialog names the handoff and gates the destructive
// action behind one deliberate confirmation click — the same friction level
// as ArchiveDeleteModal.

import { useState, useTransition } from "react";
import { deleteHandoffAction } from "@/app/handoffs/actions";
import { Button } from "@/components/ui-v2/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui-v2/dialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  handoff: { id: string; title: string };
  onDeleted: () => void;
}

export function HandoffDeleteDialog({ open, onOpenChange, handoff, onDeleted }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await deleteHandoffAction(handoff.id);
      if (result.ok) {
        onDeleted();
        onOpenChange(false);
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Permanently delete this handoff?</DialogTitle>
          <DialogDescription>
            <span className="block truncate" title={handoff.title}>
              {handoff.title}
            </span>
            <span className="mt-1 block">
              This permanently deletes the handoff and can&apos;t be undone from the app.
            </span>
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="outline"
            className="border-destructive/50 text-destructive hover:bg-destructive/10"
            onClick={submit}
            disabled={pending}
          >
            {pending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
