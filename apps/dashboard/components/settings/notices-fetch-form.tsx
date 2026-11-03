"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { SaveReadLogResult } from "@/app/settings/dashboard/actions";

/**
 * The remote-notices switch (spec 084). Saves on change, like the read-log switch. The text says
 * exactly what the fetch sends, because it is a network call this server makes on its own.
 */
export function NoticesFetchForm({
  enabled: initialEnabled,
  forcedOff,
  onSave,
}: {
  enabled: boolean;
  forcedOff: boolean;
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
          checked={enabled && !forcedOff}
          disabled={pending || forcedOff}
          onChange={(event) => toggle(event.target.checked)}
          className="h-4 w-4 accent-ink-accent"
        />
        Fetch notices from GitHub
      </label>
      <p className="max-w-3xl text-xs text-foreground/60">
        When you open the dashboard, the server fetches the project&apos;s{" "}
        <code className="font-mono">notices.json</code> from GitHub, at most every six hours, and
        picks out the ones meant for this install and version itself. The request carries nothing
        about this install: no version, no id, no query. GitHub sees the server&apos;s IP address,
        as it does for the update check. Notices this server raises about itself always show.
      </p>
      {forcedOff ? (
        <p className="text-xs text-foreground/60">
          Turned off for this server by <code className="font-mono">LIBRARIAN_DISABLE_NOTICES</code>
          .
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
