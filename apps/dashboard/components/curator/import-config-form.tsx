"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { SaveConfigResult } from "@/app/curator/actions";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";
import { SectionLabel } from "@/components/ui-v2/section-label";

// Mirrors the server bounds (core import/policy.ts). The server is the authoritative validator.
const MAX_AGE_DAYS = 3_650;
const MAX_ALLOWANCE = 100_000;

export interface ImportSettings {
  maxAgeDays: number;
  allowanceRemaining: number;
  memoriesCutoff: string | null;
  journalCutoff: string | null;
  conversationsRecorded: number;
}

function formatCutoff(iso: string | null): string {
  if (!iso) return "Not set yet — this step has never run, so all past conversations qualify.";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * The limits on `librarian import` (spec 079 §5): how far back it may reach and how many
 * conversations it may send through the model. The two cutoffs are shown, never edited:
 * the server freezes them so a second import, or a second machine, sees the same rule.
 */
export function ImportConfigForm({
  initial,
  onSave,
}: {
  initial: ImportSettings;
  onSave: (patch: { maxAgeDays: number; allowanceRemaining: number }) => Promise<SaveConfigResult>;
}) {
  const router = useRouter();
  const [maxAge, setMaxAge] = useState(String(initial.maxAgeDays));
  const [allowance, setAllowance] = useState(String(initial.allowanceRemaining));
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
    const days = Number(maxAge);
    const count = Number(allowance);
    if (!Number.isInteger(days) || days < 1 || days > MAX_AGE_DAYS) {
      setError(
        `Enter the maximum age as a whole number of days from 1 to ${MAX_AGE_DAYS.toLocaleString("en-GB")}.`,
      );
      return;
    }
    if (!Number.isInteger(count) || count < 0 || count > MAX_ALLOWANCE) {
      setError(
        `Enter the allowance as a whole number of conversations from 0 to ${MAX_ALLOWANCE.toLocaleString("en-GB")}.`,
      );
      return;
    }
    startTransition(async () => {
      const result = await onSave({ maxAgeDays: days, allowanceRemaining: count });
      if (result.ok) {
        setSaved(true);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-5" aria-label="Import settings" noValidate>
      <dl className="grid max-w-3xl grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-foreground/60">Memories cutoff</dt>
        <dd className="text-foreground">{formatCutoff(initial.memoriesCutoff)}</dd>
        <dt className="text-foreground/60">Journal cutoff</dt>
        <dd className="text-foreground">{formatCutoff(initial.journalCutoff)}</dd>
        <dt className="text-foreground/60">Conversations recorded</dt>
        <dd className="text-foreground">{initial.conversationsRecorded.toLocaleString("en-GB")}</dd>
      </dl>
      <p className="max-w-3xl text-xs text-foreground/60">
        An imported conversation goes through a step only if it ended before that step&apos;s cutoff
        — after it, live capture already has it. Each cutoff is set once, from when the step first
        ran, and never moves.
      </p>

      <div className="flex flex-col gap-1.5">
        <SectionLabel as="label" htmlFor="import-max-age">
          Maximum age (days)
        </SectionLabel>
        <Input
          id="import-max-age"
          inputMode="numeric"
          className="w-40"
          value={maxAge}
          aria-describedby="import-max-age-help"
          onChange={(event) => {
            setMaxAge(event.target.value);
            clearStatus();
          }}
        />
        <p id="import-max-age-help" className="max-w-3xl text-xs text-foreground/60">
          Conversations older than this are never imported.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <SectionLabel as="label" htmlFor="import-allowance">
          Allowance (conversations left)
        </SectionLabel>
        <Input
          id="import-allowance"
          inputMode="numeric"
          className="w-40"
          value={allowance}
          aria-describedby="import-allowance-help"
          onChange={(event) => {
            setAllowance(event.target.value);
            clearStatus();
          }}
        />
        <p id="import-allowance-help" className="max-w-3xl text-xs text-foreground/60">
          Each imported conversation uses one and costs the same model calls as a live one. When it
          reaches 0, imports stop until you raise it.
        </p>
      </div>

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
        {pending ? "Saving…" : "Save import settings"}
      </Button>
    </form>
  );
}
