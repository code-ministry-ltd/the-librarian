"use client";

// Grooming job-level config — enable, schedule, and the shared auto-apply
// threshold (D13). Editorial rebuild: no card chrome, SectionLabel labels,
// ui-v2 primitives, accent checkbox.

import type { GroomingConfig, GroomingConfigPatch } from "@librarian/core";
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

export function GroomingConfigForm({
  initial,
  onSave,
}: {
  initial: GroomingConfig;
  onSave: (patch: GroomingConfigPatch) => Promise<SaveConfigResult>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [enabled, setEnabled] = useState(initial.enabled);
  const [threshold, setThreshold] = useState(snapThresholdToStop(initial.applyConfidenceThreshold));
  const [intervalDays, setIntervalDays] = useState(String(initial.intervalDays));
  const [scheduleTime, setScheduleTime] = useState(initial.scheduleTime);

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
    const days = Number(intervalDays);
    if (!Number.isInteger(days) || days < 1) {
      setError("Run interval must be a whole number of at least 1 day.");
      return;
    }
    startTransition(async () => {
      const patch: GroomingConfigPatch = {
        enabled,
        // Avoid clobbering a newer Intake edit when only schedule changed.
        // An off-grid legacy value (e.g. 0.75) still normalises on save.
        ...(threshold !== initial.applyConfidenceThreshold
          ? { applyConfidenceThreshold: threshold }
          : {}),
        intervalDays: days,
        scheduleTime,
      };
      const result = await onSave(patch);
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
      aria-label="Curator configuration form"
      noValidate
    >
      <label className="inline-flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            clearStatus();
          }}
          className="h-4 w-4 accent-ink-accent"
        />
        Enable scheduled curation
      </label>

      <div className="flex flex-col gap-1.5">
        <SectionLabel as="label" htmlFor="grooming-interval">
          Run every
        </SectionLabel>
        <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
          <Input
            id="grooming-interval"
            aria-label="Run every (days)"
            type="number"
            min="1"
            step="1"
            className="w-20"
            value={intervalDays}
            onChange={(e) => {
              setIntervalDays(e.target.value);
              clearStatus();
            }}
            onInvalid={(e) => {
              e.preventDefault();
              setError("Run interval must be a whole number of at least 1 day.");
            }}
          />
          <span className="text-foreground/70">days at</span>
          <Input
            aria-label="at (HH:MM)"
            type="time"
            className="w-28"
            value={scheduleTime}
            onChange={(e) => {
              setScheduleTime(e.target.value);
              clearStatus();
            }}
          />
        </div>
        <p className="text-xs text-foreground/60">1 = nightly · 7 = weekly · 30 ≈ monthly</p>
      </div>

      <Hairline />

      <AutoApplyThresholdField
        id="grooming-auto-apply-threshold"
        value={threshold}
        sharedWith="Intake"
        onChange={(value) => {
          setThreshold(value);
          clearStatus();
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
