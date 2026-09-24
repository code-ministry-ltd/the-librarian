// Flagged review queue: list every memory an agent has flagged for review,
// surfacing its text, flag details, and correction-work status. Safe targeted
// corrections run asynchronously; admins can dismiss flags or explicitly archive
// the whole memory when human review is needed.

"use client";

import Link from "next/link";
import { useTransition } from "react";
import { MemoryCard } from "./memory-card";
import type { MemoryRow } from "./types";
import { resolveFlagAction } from "@/app/(memories)/actions";
import { Button } from "@/components/ui-v2/button";
import { trpc } from "@/lib/trpc-client";

interface MemoryFlag {
  agent_id: string;
  reason: string;
  created_at: string;
}

type FlaggedRow = MemoryRow & {
  flags?: MemoryFlag[];
  shelfWritable?: boolean;
  correction_proposal?: { id: string } | null;
};

type CorrectionWorkStatus = NonNullable<MemoryRow["correction_work"]>[number]["status"];

const CORRECTION_STATUS_MESSAGES: Partial<Record<CorrectionWorkStatus, string>> = {
  pending: "Correction review is queued.",
  processing: "Correction review is in progress.",
  manual_review: "Automatic correction could not be applied; manual review is needed.",
  applied: "A correction was applied, but this open flag still needs review.",
  cancelled: "Correction work was cancelled; this flag still needs a human decision.",
};

function CorrectionWorkNotice({
  status,
  hasProposal,
}: {
  status: CorrectionWorkStatus | undefined;
  hasProposal: boolean;
}) {
  if (hasProposal) {
    return (
      <p role="status" className="mt-2 text-sm text-foreground/70">
        A partial correction is waiting for approval; these flags remain open until then.{" "}
        <Link href="/proposals" className="underline underline-offset-2">
          Review proposal
        </Link>
      </p>
    );
  }

  if (status === "proposal_pending") {
    return (
      <p role="status" className="mt-2 text-sm text-foreground/70">
        The correction proposal is being recovered; no review action is available yet.
      </p>
    );
  }

  if (!status) return null;
  const message = CORRECTION_STATUS_MESSAGES[status];
  return message ? (
    <p role="status" className="mt-2 text-sm text-foreground/70">
      {message}
    </p>
  ) : null;
}

export function FlaggedView() {
  const listQuery = trpc.memories.listFlagged.useQuery(undefined, {
    refetchOnWindowFocus: false,
    refetchInterval: 10_000,
  });
  const memories = (listQuery.data?.memories ?? []) as FlaggedRow[];
  const [pending, startTransition] = useTransition();

  const resolve = (memory: FlaggedRow, action: "dismiss" | "archive") =>
    startTransition(async () => {
      if (!memory.shelfId) return;
      await resolveFlagAction(memory.id, memory.shelfId, action);
      await listQuery.refetch();
    });

  if (listQuery.isLoading) {
    return <p className="text-sm text-foreground/60">Loading flagged memories…</p>;
  }
  if (listQuery.isError) {
    return (
      <p
        role="alert"
        className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
      >
        Failed to load flagged memories: {listQuery.error?.message ?? "unknown error"}
      </p>
    );
  }
  if (memories.length === 0) {
    return <p className="text-sm text-foreground/60">No flagged memories.</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {memories.map((memory) => {
        const flags = memory.flags ?? [];
        const correctionStatus = memory.correction_work
          ?.filter((work) => work.shelf_id === memory.shelfId)
          .at(-1)?.status;
        return (
          <li key={memory.id}>
            <MemoryCard
              title={memory.title}
              body={memory.body}
              tags={memory.tags}
              bodyMode="prose"
              meta={[
                memory.agent_id ? <span>{memory.agent_id}</span> : null,
                memory.shelfLabel ? <span>Shelf: {memory.shelfLabel}</span> : null,
                <span>{new Date(memory.updated_at).toLocaleDateString()}</span>,
              ]}
              actions={
                <>
                  <Button
                    variant="outline"
                    disabled={pending || !memory.shelfId || memory.shelfWritable === false}
                    onClick={() => resolve(memory, "dismiss")}
                  >
                    Dismiss
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={pending || !memory.shelfId || memory.shelfWritable === false}
                    onClick={() => resolve(memory, "archive")}
                  >
                    Archive
                  </Button>
                </>
              }
            >
              <CorrectionWorkNotice
                status={correctionStatus}
                hasProposal={Boolean(memory.correction_proposal)}
              />
              {memory.shelfWritable === false ? (
                <p role="status" className="mt-2 text-sm text-foreground/60">
                  This shelf is read-only here. Ask an administrator with write access to resolve
                  these flags.
                </p>
              ) : null}
              <ul className="mt-2 flex flex-col gap-1.5">
                {flags.map((flag, i) => (
                  <li
                    key={`${flag.agent_id}-${flag.created_at}-${i}`}
                    className="border border-destructive/40 bg-destructive/[0.06] px-2.5 py-1.5 text-xs leading-relaxed"
                  >
                    <span className="text-destructive">&ldquo;{flag.reason}&rdquo;</span>
                    <span className="text-foreground/60">
                      {" "}
                      — flagged by{" "}
                      <span className="font-mono text-foreground/75">
                        {flag.agent_id}
                      </span> &middot; {new Date(flag.created_at).toLocaleDateString()}
                    </span>
                  </li>
                ))}
              </ul>
            </MemoryCard>
          </li>
        );
      })}
    </ul>
  );
}
