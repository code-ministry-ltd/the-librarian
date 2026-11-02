"use client";

import type { JournalConfig, JournalConfigPatch } from "@librarian/core";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { SaveConfigResult } from "@/app/curator/actions";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";
import { SectionLabel } from "@/components/ui-v2/section-label";

// Mirrors the server bounds (core journal/config.ts). Kept local so the client bundle stays
// type-only against @librarian/core; the server remains the authoritative validator.
const MIN_BUDGET = 2_000;
const MAX_BUDGET = 100_000;

/**
 * The journal's two settings (spec 077 §4.7): on/off and the session-start injection budget.
 * It sits in the Intake tab because it reads the same captured conversations and uses the
 * intake model — but its switch is independent of intake's: either one turns capture on.
 */
export function JournalConfigForm({
  initial,
  onSave,
}: {
  initial: JournalConfig;
  onSave: (patch: JournalConfigPatch) => Promise<SaveConfigResult>;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [budget, setBudget] = useState(String(initial.injectBudgetTokens));
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!saved) return;
    const id = window.setTimeout(() => setSaved(false), 5000);
    return () => window.clearTimeout(id);
  }, [saved]);

  const clearStatus = () => {
    setSaved(false);
    setError(null);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    clearStatus();
    const n = Number(budget);
    if (!Number.isInteger(n) || n < MIN_BUDGET || n > MAX_BUDGET) {
      setError(
        `Enter a whole number of tokens from ${MIN_BUDGET.toLocaleString("en-GB")} to ` +
          `${MAX_BUDGET.toLocaleString("en-GB")}.`,
      );
      return;
    }
    startTransition(async () => {
      const result = await onSave({ enabled, injectBudgetTokens: n });
      if (result.ok) {
        setSaved(true);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-5"
      aria-label="Journal settings"
      noValidate
    >
      <label className="inline-flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            setEnabled(event.target.checked);
            clearStatus();
          }}
          className="h-4 w-4 accent-ink-accent"
        />
        Keep a journal of captured conversations
      </label>

      <div className="flex flex-col gap-1.5">
        <SectionLabel as="label" htmlFor="journal-budget">
          Session-start budget (tokens)
        </SectionLabel>
        <Input
          id="journal-budget"
          inputMode="numeric"
          className="w-40"
          value={budget}
          aria-describedby="journal-budget-help"
          onChange={(event) => {
            setBudget(event.target.value);
            clearStatus();
          }}
        />
        <p id="journal-budget-help" className="max-w-3xl text-xs text-foreground/60">
          How much of the recent journal is added to each new agent session. Older entries are
          dropped first when it is over budget.
        </p>
      </div>

      <p className="max-w-3xl text-xs text-foreground/60">
        Each settled conversation costs one call to the intake model (set above), whether or not
        intake itself is on. Entries are stored in the vault under{" "}
        <span className="font-mono">journal/</span>; recent days stay detailed and older ones are
        summarised by week and month every night.
      </p>

      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          Error: {error}
        </p>
      ) : null}
      {saved ? (
        <p
          role="status"
          className="border border-ink-accent/40 bg-ink-accent/[0.06] p-3 text-sm text-foreground"
        >
          Saved.
        </p>
      ) : null}

      <Button type="submit" variant="primary" className="self-start" disabled={pending}>
        {pending ? "Saving…" : "Save journal settings"}
      </Button>
    </form>
  );
}
