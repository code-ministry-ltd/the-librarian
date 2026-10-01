// Flagged review queue: every memory an agent has flagged as wrong or outdated,
// with its flags and what the curator did about them (ADR 0013). The curator
// corrects flagged memories as part of grooming; this page shows the outcome and
// gives the admin the manual fallbacks: edit the memory, ask the curator to look
// again, dismiss the flags, or archive the whole memory.

"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { EditForm } from "./memory-detail-content";
import { MemoryCard } from "./memory-card";
import type { MemoryRow } from "./types";
import {
  askCuratorAgainAction,
  resolveFlagAction,
  updateMemoryAction,
} from "@/app/(memories)/actions";
import { Button } from "@/components/ui-v2/button";
import { trpc } from "@/lib/trpc-client";

// The curator's own actor id: its flags are archive proposals, not agent flags.
const CURATOR_ACTOR = "system-memory-curator";

type FlagReviewOutcome = "proposed" | "no_change" | "declined" | "too_long";

interface MemoryFlag {
  agent_id: string;
  reason: string;
  created_at: string;
  review?: {
    outcome: FlagReviewOutcome;
    at: string;
    rationale?: string;
    proposal_id?: string;
  };
}

type FlaggedRow = MemoryRow & {
  flags?: MemoryFlag[];
  shelfWritable?: boolean;
};

type Status =
  | { kind: "waiting" }
  | { kind: "archive_proposed" }
  | { kind: FlagReviewOutcome; rationale?: string };

/**
 * One status for the memory, from its agent flags: while any flag is still
 * unreviewed the curator has work to do; otherwise the latest review decides.
 */
function statusOf(flags: MemoryFlag[]): Status {
  const agentFlags = flags.filter((flag) => flag.agent_id !== CURATOR_ACTOR);
  if (agentFlags.length === 0) return { kind: "archive_proposed" };
  if (agentFlags.some((flag) => !flag.review)) return { kind: "waiting" };
  const latest = agentFlags.map((flag) => flag.review!).reduce((a, b) => (a.at >= b.at ? a : b));
  return latest.rationale
    ? { kind: latest.outcome, rationale: latest.rationale }
    : { kind: latest.outcome };
}

function StatusNotice({ status }: { status: Status }) {
  const text = (() => {
    switch (status.kind) {
      case "waiting":
        return "Waiting for the curator. It reviews flagged memories about 10 minutes after a flag, while Grooming is turned on.";
      case "archive_proposed":
        return "The curator proposes archiving this whole memory.";
      case "proposed":
        return null; // rendered with a link below
      case "no_change":
        return status.rationale
          ? `The curator reviewed this and made no change: “${status.rationale}”`
          : "The curator reviewed this and made no change.";
      case "declined":
        return "You rejected the curator's correction. Edit the memory yourself, ask the curator again, dismiss the flags, or archive it.";
      case "too_long":
        return "This memory is too long for the curator to rewrite safely. Edit it yourself.";
    }
  })();
  if (status.kind === "proposed") {
    return (
      <p role="status" className="mt-2 text-sm text-foreground/70">
        The curator proposed a correction; the flags close when you approve it.{" "}
        <Link href="/proposals" className="underline underline-offset-2">
          Review proposal
        </Link>
      </p>
    );
  }
  return (
    <p role="status" className="mt-2 text-sm text-foreground/70">
      {text}
    </p>
  );
}

const CAN_ASK_AGAIN: ReadonlySet<Status["kind"]> = new Set(["no_change", "declined", "too_long"]);

export function FlaggedView() {
  const listQuery = trpc.memories.listFlagged.useQuery(undefined, {
    refetchOnWindowFocus: false,
    refetchInterval: 10_000,
  });
  const memories = (listQuery.data?.memories ?? []) as FlaggedRow[];
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});

  const settle = (id: string, result: { ok: true } | { ok: false; error: string }) =>
    setActionErrors(({ [id]: _cleared, ...rest }) =>
      result.ok ? rest : { ...rest, [id]: result.error },
    );

  const resolve = (memory: FlaggedRow, action: "dismiss" | "archive") =>
    startTransition(async () => {
      if (!memory.shelfId) return;
      settle(memory.id, await resolveFlagAction(memory.id, memory.shelfId, action));
      await listQuery.refetch();
    });

  const askAgain = (memory: FlaggedRow) =>
    startTransition(async () => {
      if (!memory.shelfId) return;
      settle(memory.id, await askCuratorAgainAction(memory.id, memory.shelfId));
      await listQuery.refetch();
    });

  const saveEdit = (memory: FlaggedRow, form: FormData) =>
    startTransition(async () => {
      const result = await updateMemoryAction(memory.id, form, { resolveFlags: true });
      settle(memory.id, result);
      if (result.ok) setEditing(null);
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
        const status = statusOf(flags);
        const readOnly = !memory.shelfId || memory.shelfWritable === false;
        const actionError = actionErrors[memory.id];
        if (editing === memory.id) {
          return (
            <li key={memory.id} className="border border-ink-hairline p-4">
              <p className="mb-3 text-sm text-foreground/70">
                Fix what the flags report. Saving closes the flags.
              </p>
              <EditForm
                memory={memory}
                pending={pending}
                error={actionError ?? null}
                submitLabel="Save and close flags"
                onCancel={() => setEditing(null)}
                onSubmit={(form) => saveEdit(memory, form)}
              />
            </li>
          );
        }
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
                    disabled={pending || readOnly}
                    onClick={() => setEditing(memory.id)}
                  >
                    Edit
                  </Button>
                  {CAN_ASK_AGAIN.has(status.kind) ? (
                    <Button
                      variant="outline"
                      disabled={pending || readOnly}
                      onClick={() => askAgain(memory)}
                    >
                      Ask the curator again
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    disabled={pending || readOnly}
                    onClick={() => resolve(memory, "dismiss")}
                  >
                    Dismiss
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={pending || readOnly}
                    onClick={() => resolve(memory, "archive")}
                  >
                    Archive
                  </Button>
                </>
              }
            >
              <StatusNotice status={status} />
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
