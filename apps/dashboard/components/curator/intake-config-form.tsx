"use client";

// Intake job-level config (spec 043 C5b + spec 045 D-3). Enable, cadence,
// and the shared D13 auto-apply threshold. Editorial, no card chrome.

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { SaveConfigResult } from "@/app/curator/actions";
import {
  AutoApplyThresholdField,
  snapThresholdToStop,
} from "@/components/curator/auto-apply-threshold-field";
import { Button } from "@/components/ui-v2/button";
import { Hairline } from "@/components/ui-v2/hairline";
import { Input } from "@/components/ui-v2/input";
import { SectionLabel } from "@/components/ui-v2/section-label";

export function IntakeConfigForm({
  enabled: initialEnabled,
  intervalMinutes: initialIntervalMinutes,
  applyConfidenceThreshold: initialThreshold,
  onSave,
}: {
  enabled: boolean;
  intervalMinutes: number;
  applyConfidenceThreshold: number;
  onSave: (input: {
    enabled?: boolean;
    intervalMinutes?: number;
    applyConfidenceThreshold?: number;
  }) => Promise<SaveConfigResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [intervalMinutes, setIntervalMinutes] = useState(String(initialIntervalMinutes));
  const [threshold, setThreshold] = useState(snapThresholdToStop(initialThreshold));

  useEffect(() => {
    if (!saved) return;
    const id = window.setTimeout(() => setSaved(false), 5000);
    return () => window.clearTimeout(id);
  }, [saved]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaved(false);
    const minutes = Number(intervalMinutes);
    if (!Number.isInteger(minutes) || minutes < 1) {
      setError("Run interval must be a whole number of at least 1 minute.");
      return;
    }
    startTransition(async () => {
      const result = await onSave({
        enabled,
        intervalMinutes: minutes,
        // The value is shared with Grooming. Do not overwrite another tab's
        // newer edit when this form only changed cadence or enablement.
        ...(threshold !== initialThreshold ? { applyConfidenceThreshold: threshold } : {}),
      });
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
      className="flex flex-col gap-4"
      aria-label="Intake configuration form"
      noValidate
    >
      <label className="inline-flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            setSaved(false);
            setError(null);
          }}
          className="h-4 w-4 accent-ink-accent"
        />
        Enable inbox intake
      </label>

      <div className="flex flex-col gap-1.5">
        <SectionLabel as="label" htmlFor="intake-interval">
          Run every (minutes)
        </SectionLabel>
        <div className="flex items-center gap-2 text-sm text-foreground">
          <Input
            id="intake-interval"
            aria-label="Run every (minutes)"
            type="number"
            min="1"
            step="1"
            className="w-20"
            value={intervalMinutes}
            onChange={(e) => {
              setIntervalMinutes(e.target.value);
              setSaved(false);
              setError(null);
            }}
            onInvalid={(e) => {
              e.preventDefault();
              setError("Run interval must be a whole number of at least 1 minute.");
            }}
          />
          <span className="text-foreground/70">minutes</span>
        </div>
        <p className="text-xs text-foreground/60">
          15 = quarter-hourly · 60 = hourly · 240 = every four hours
        </p>
      </div>

      <Hairline />

      <AutoApplyThresholdField
        id="intake-auto-apply-threshold"
        value={threshold}
        sharedWith="Grooming"
        onChange={(value) => {
          setThreshold(value);
          setSaved(false);
          setError(null);
        }}
      />

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
        {pending ? "Saving…" : "Save settings"}
      </Button>
    </form>
  );
}
