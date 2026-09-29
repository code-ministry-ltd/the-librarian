// Flagged review queue: list every memory an agent has flagged for review,
// surfacing its text, flag details, and correction-work status. Safe targeted
// corrections run asynchronously; admins can dismiss flags, explicitly archive
// the whole memory, or re-assess once earlier correction work has finished.

"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { canReassessCorrection, describeCorrectionReason } from "./correction-reasons";
import { MemoryCard } from "./memory-card";
import type { MemoryRow } from "./types";
import { reassessFlagAction, resolveFlagAction } from "@/app/(memories)/actions";
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

type CorrectionWork = NonNullable<MemoryRow["correction_work"]>[number];
type CorrectionWorkStatus = CorrectionWork["status"];

const IN_FLIGHT: ReadonlySet<CorrectionWorkStatus> = new Set([
  "pending",
  "processing",
  "proposal_pending",
]);

const CORRECTION_STATUS_MESSAGES: Partial<Record<CorrectionWorkStatus, string>> = {
  pending: "Correction review is queued.",
  processing: "Correction review is in progress.",
  manual_review: "Automatic correction could not be applied; manual review is needed.",
  applied: "A correction was applied, but this open flag still needs review.",
  cancelled: "Correction work was cancelled; this flag still needs a human decision.",
};

function CorrectionWorkNotice({
  work,
  hasProposal,
}: {
  work: CorrectionWork | undefined;
  hasProposal: boolean;
}) {
  const status = work?.status;
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
  const reason = status === "manual_review" ? describeCorrectionReason(work?.reason_code) : null;
  return message ? (
    <p role="status" className="mt-2 text-sm text-foreground/70">
      {message}
      {reason ? ` ${reason}` : null}
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
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});

  const resolve = (memory: FlaggedRow, action: "dismiss" | "archive") =>
    startTransition(async () => {
      if (!memory.shelfId) return;
      await resolveFlagAction(memory.id, memory.shelfId, action);
      await listQuery.refetch();
    });

  const reassess = (memory: FlaggedRow) =>
    startTransition(async () => {
      if (!memory.shelfId) return;
      const result = await reassessFlagAction(memory.id, memory.shelfId);
      setActionErrors(({ [memory.id]: _cleared, ...rest }) =>
        result.ok ? rest : { ...rest, [memory.id]: result.error },
      );
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
        const correctionWork = memory.correction_work
          ?.filter((work) => work.shelf_id === memory.shelfId)
          .at(-1);
        const hasProposal = Boolean(memory.correction_proposal);
        const canReassess =
          !hasProposal &&
          !(correctionWork && IN_FLIGHT.has(correctionWork.status)) &&
          canReassessCorrection(correctionWork?.reason_code);
        const actionError = actionErrors[memory.id];
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
                  {canReassess ? (
                    <Button
                      variant="outline"
                      disabled={pending || !memory.shelfId || memory.shelfWritable === false}
                      onClick={() => reassess(memory)}
                    >
                      Re-assess
                    </Button>
                  ) : null}
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
              <CorrectionWorkNotice work={correctionWork} hasProposal={hasProposal} />
              {actionError ? (
                <p role="alert" className="mt-2 text-sm text-destructive">
                  {actionError}
                </p>
              ) : null}
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
