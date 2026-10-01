"use client";

// Shared memory-detail body for both desktop and mobile chrome.
// MemoryInspector wraps this in a right-rail aside; MemoryBottomSheet
// wraps it in a Radix Dialog with bottom-anchored Content. Same
// content either way — title / flag pills / body / tags / id / edit
// form / Discuss / Archive — so changes land in one place.
//
// Local state (editing toggle, error, pending) lives here because
// it's tied to the displayed memory, not to the wrapper chrome.

import { useEffect, useState, useTransition } from "react";
import type { MemoryRow } from "./types";
import { archiveMemoryAction, updateMemoryAction } from "@/app/(memories)/actions";
import { chatAction, confirmActionAction, setAddendumAction } from "@/app/curator/actions";
import { DiscussMemoryButton } from "@/components/curator/discuss-memory-button";
import { MoveMemoryDialog } from "@/components/memories/move-memory-dialog";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";
import { Pill } from "@/components/ui-v2/pill";
import { SectionLabel } from "@/components/ui-v2/section-label";
import { trpc } from "@/lib/trpc-client";

interface Props {
  memory: MemoryRow;
  onClose: () => void;
  onMutated: () => void;
}

export function MemoryDetailContent({ memory, onClose, onMutated }: Props) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const shelvesQuery = trpc.vault.shelves.useQuery();
  const moveAccessQuery = trpc.vault.moveAccess.useQuery();
  const moveDataReady =
    !shelvesQuery.isLoading &&
    !shelvesQuery.isError &&
    !moveAccessQuery.isLoading &&
    !moveAccessQuery.isError;

  // Reset local state when the selected memory changes so an
  // edit-in-progress on memory A doesn't bleed into memory B.
  useEffect(() => {
    setEditing(false);
    setError(null);
  }, [memory.id]);

  if (editing) {
    return (
      <EditForm
        memory={memory}
        pending={pending}
        error={error}
        onCancel={() => setEditing(false)}
        onSubmit={(form) =>
          startTransition(async () => {
            const result = await updateMemoryAction(memory.id, form);
            if (result.ok) {
              setEditing(false);
              setError(null);
              onMutated();
            } else {
              setError(result.error);
            }
          })
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-5 text-sm">
      <p className="whitespace-pre-wrap leading-relaxed text-foreground">{memory.body}</p>
      {memory.tags.length > 0 ? (
        <div className="flex flex-col gap-2">
          <SectionLabel>Tags</SectionLabel>
          <div className="flex flex-wrap gap-1">
            {memory.tags.map((tag) => (
              <Pill key={tag} variant="default">
                {tag}
              </Pill>
            ))}
          </div>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <SectionLabel>Id</SectionLabel>
        <code className="break-all font-mono text-xs text-foreground/70">{memory.id}</code>
      </div>
      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2 pt-2">
        <Button variant="outline" onClick={() => setEditing(true)}>
          Edit
        </Button>
        <DiscussMemoryButton
          memoryId={memory.id}
          {...(memory.title ? { memoryTitle: memory.title } : {})}
          onChat={chatAction}
          onConfirmAction={confirmActionAction}
          onSetAddendum={setAddendumAction}
        />
        <MoveMemoryDialog
          memory={memory}
          shelves={moveDataReady ? shelvesQuery.data : undefined}
          canDirectMove={moveDataReady ? moveAccessQuery.data?.canDirectMove : undefined}
          onSuccess={onMutated}
        />
        <Button
          variant="destructive"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              if (!confirm(`Archive "${memory.title || memory.id}"?`)) return;
              const result = await archiveMemoryAction(memory.id);
              if (result.ok) {
                setError(null);
                onClose();
                onMutated();
              } else {
                setError(result.error);
              }
            })
          }
        >
          Archive
        </Button>
      </div>
    </div>
  );
}

/** The memory edit form; also used by the Flagged page's Edit (ADR 0013). */
export function EditForm({
  memory,
  pending,
  error,
  onCancel,
  onSubmit,
  submitLabel = "Save",
}: {
  memory: Pick<MemoryRow, "title" | "body" | "tags">;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (form: FormData) => void;
  submitLabel?: string;
}) {
  return (
    <form action={onSubmit} className="flex flex-col gap-4 text-sm">
      <label className="flex flex-col gap-1.5">
        <SectionLabel as="span">Title</SectionLabel>
        <Input name="title" defaultValue={memory.title} />
      </label>
      <label className="flex flex-col gap-1.5">
        <SectionLabel as="span">Body</SectionLabel>
        <textarea
          name="body"
          defaultValue={memory.body}
          className="min-h-[140px] border border-ink-hairline bg-ink-mono-fill p-2 font-mono text-xs leading-relaxed text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink-accent"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <SectionLabel as="span">Tags</SectionLabel>
        <Input name="tags" defaultValue={memory.tags.join(", ")} placeholder="comma-separated" />
      </label>
      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
