"use client";

import { useMemo, useState, useTransition } from "react";
import type { MemoryRow, RouterOutputs } from "./types";
import { moveMemoryAction, proposeMoveAction } from "@/app/(memories)/actions";
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
import { Select } from "@/components/ui-v2/select";

type Shelves = RouterOutputs["vault"]["shelves"];

interface Props {
  memory: MemoryRow;
  shelves: Shelves | undefined;
  canDirectMove: boolean | undefined;
  onSuccess: () => void;
}

export function MoveMemoryDialog({ memory, shelves, canDirectMove, onSuccess }: Props) {
  const [open, setOpen] = useState(false);
  const [shelfId, setShelfId] = useState("");
  const [rationale, setRationale] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const destinations = useMemo(
    () => shelves?.filter((shelf) => memory.shelfId === undefined || shelf.id !== memory.shelfId),
    [memory.shelfId, shelves],
  );
  if (!shelves || canDirectMove === undefined || shelves.length <= 1 || !destinations?.length) {
    return null;
  }

  const selected = destinations.find((shelf) => shelf.id === shelfId) ?? null;
  const direct = canDirectMove && selected?.writable === true;
  const hasDirectDestination = canDirectMove && destinations.some((shelf) => shelf.writable);

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setShelfId("");
      setRationale("");
      setError(null);
      setWarning(null);
    }
  };

  const submit = () => {
    if (!selected) {
      setError("Pick a destination shelf.");
      return;
    }
    setError(null);
    setWarning(null);
    startTransition(async () => {
      const result = direct
        ? await moveMemoryAction(memory.id, selected.id)
        : await proposeMoveAction(memory.id, selected.id, rationale);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.warning) {
        setWarning(result.warning);
        onSuccess();
        return;
      }
      changeOpen(false);
      onSuccess();
    });
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">{hasDirectDestination ? "Move…" : "Propose move…"}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{direct ? "Move memory" : "Propose a shelf move"}</DialogTitle>
          <DialogDescription>
            {warning
              ? `“${memory.title || memory.id}” was moved successfully.`
              : `Choose where “${memory.title || memory.id}” belongs. A proposal leaves the memory active until an admin applies it.`}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 text-sm">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-foreground/60">Destination shelf</span>
            <Select
              aria-label="Destination shelf"
              value={shelfId}
              onChange={(event) => {
                setShelfId(event.target.value);
                setError(null);
                setWarning(null);
              }}
            >
              <option value="">Choose a shelf…</option>
              {destinations.map((shelf) => (
                <option key={shelf.id} value={shelf.id} title={shelf.id}>
                  {shelf.label ?? shelf.id}
                </option>
              ))}
            </Select>
          </label>

          {!direct ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-foreground/60">Rationale (optional)</span>
              <textarea
                aria-label="Rationale (optional)"
                value={rationale}
                maxLength={2_000}
                onChange={(event) => setRationale(event.target.value)}
                className="min-h-24 border border-ink-hairline bg-ink-mono-fill p-2 text-sm leading-relaxed text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-accent"
              />
              <span className="font-mono text-[11px] text-foreground/45">
                {rationale.length.toLocaleString()} / 2,000
              </span>
            </label>
          ) : null}
        </div>

        {error ? (
          <p
            role="alert"
            aria-live="assertive"
            className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        {warning ? (
          <p
            role="status"
            aria-live="polite"
            className="border border-ink-accent/40 bg-ink-accent/[0.06] p-3 text-sm text-foreground"
          >
            {warning}
          </p>
        ) : null}

        <DialogFooter>
          {warning ? (
            <Button variant="primary" onClick={() => changeOpen(false)}>
              Close
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => changeOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button variant="primary" onClick={submit} disabled={pending || !selected}>
                {pending
                  ? direct
                    ? "Moving…"
                    : "Proposing…"
                  : direct
                    ? "Move memory"
                    : "Propose move"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
