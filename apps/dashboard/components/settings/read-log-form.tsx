"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { SaveReadLogResult } from "@/app/settings/dashboard/actions";

/**
 * The read-log switch (spec 080/081). Saves on change: there is one setting and nothing to
 * validate, so a separate Save button would only add a step.
 */
export function ReadLogForm({
  enabled: initialEnabled,
  recording,
  onSave,
}: {
  enabled: boolean;
  recording: boolean;
  onSave: (enabled: boolean) => Promise<SaveReadLogResult>;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const toggle = (next: boolean) => {
    setEnabled(next);
    setError(null);
    startTransition(async () => {
      const result = await onSave(next);
      if (result.ok) {
        router.refresh();
      } else {
        setEnabled(!next);
        setError(result.error);
      }
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <label className="inline-flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={enabled}
          disabled={pending}
          onChange={(event) => toggle(event.target.checked)}
          className="h-4 w-4 accent-ink-accent"
        />
        Record what agents read
      </label>
      <p className="max-w-3xl text-xs text-foreground/60">
        Logs every recall and reference search (the query, and which memories or references came
        back), and the size of the primer and journal each new session receives. Queries can be as
        sensitive as your memories, so this is off until you turn it on. The log stays in the
        server&apos;s data folder, capped at about 40 MB, and private mode does not pause it. See it
        on the{" "}
        <Link
          href="/logs?source=reads"
          className="text-ink-accent underline underline-offset-2 hover:no-underline"
        >
          Logs
        </Link>{" "}
        page.
      </p>
      {enabled && !recording && !pending ? (
        <p className="text-xs text-foreground/60">
          Switched on, but this server process doesn&apos;t record reads. Only the HTTP server does.
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
