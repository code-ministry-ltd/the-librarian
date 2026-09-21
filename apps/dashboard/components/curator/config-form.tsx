"use client";

// Grooming job-level config — enable, schedule, and the single auto-apply
// threshold knob (D13). Editorial rebuild: no card chrome, SectionLabel
// field labels, ui-v2 primitives, accent checkbox. The auto-apply threshold
// lives in its own labelled sub-section under the schedule.

import type { GroomingConfig, GroomingConfigPatch } from "@librarian/core";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { SaveConfigResult } from "@/app/curator/actions";
import { Button } from "@/components/ui-v2/button";
import { Hairline } from "@/components/ui-v2/hairline";
import { Input } from "@/components/ui-v2/input";
import { SectionLabel } from "@/components/ui-v2/section-label";

/** The threshold slider's stops: 0 → 1 in 0.1 steps (10 steps, 11 stops). */
const THRESHOLD_STEPS = 10;
/**
 * Fallback for a non-finite config value only. Mirrors core's
 * `DEFAULT_APPLY_CONFIDENCE_THRESHOLD`; it is not imported because that is a
 * runtime value from a server-side package, and only types cross into this
 * client component (the server already normalises the stored setting).
 */
const DEFAULT_THRESHOLD = 0.8;

/**
 * Clamp a stored threshold onto a slider stop. The setting predates this control
 * and accepted finer values (the old number input stepped 0.05), so a legacy
 * 0.75 must not leave the thumb between stops: round to the nearest 0.1.
 */
function snapToStop(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_THRESHOLD;
  return Math.round(Math.min(1, Math.max(0, value)) * THRESHOLD_STEPS) / THRESHOLD_STEPS;
}

/**
 * What a threshold stop means for the review queue, in the operator's words.
 * Mirrors the D13 rule (`curator-apply-policy.ts`): create/update/merge
 * auto-apply at or above the threshold, so raising it means MORE proposals and
 * lowering it means fewer — the opposite of the instinct that a higher bar is
 * "safer". Archive and split are outside this scale entirely: they always
 * propose, which is why the form carries a standing caveat line.
 */
function proposalFrequencyFor(value: number): string {
  if (value <= 0) return "Never raises proposals";
  if (value <= 0.5) return "Sometimes raises proposals";
  if (value <= 0.9) return "Often raises proposals";
  return "Always raises proposals";
}

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
  const [threshold, setThreshold] = useState(snapToStop(initial.applyConfidenceThreshold));
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
        applyConfidenceThreshold: threshold,
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

      {/* The ONE apply rule's single knob (D13): create/update/merge auto-apply
          at/above this threshold; archive/split always propose. The scale stops
          short of the whole rule, so the caveat line below names what it cannot
          silence. */}
      <div className="flex flex-col gap-3">
        <header className="flex flex-col gap-1">
          <SectionLabel as="label" htmlFor="grooming-auto-apply-threshold">
            Auto-apply threshold
          </SectionLabel>
          <p id="grooming-auto-apply-threshold-help" className="text-xs text-foreground/60">
            How confident should the curator be before it auto-applies?
          </p>
        </header>
        <div className="flex flex-col gap-2">
          <input
            id="grooming-auto-apply-threshold"
            type="range"
            min="0"
            max="1"
            step="0.1"
            value={threshold}
            aria-describedby="grooming-auto-apply-threshold-help grooming-auto-apply-threshold-caveat"
            aria-valuetext={`${threshold.toFixed(1)} — ${proposalFrequencyFor(threshold)}`}
            onChange={(e) => {
              setThreshold(Number(e.target.value));
              clearStatus();
            }}
            className="w-full max-w-xs cursor-pointer accent-ink-accent"
          />
          {/* The value readout rides WITH the frequency phrase: a range thumb
              alone doesn't tell the operator which stop it is on. The phrase is
              mirrored into aria-valuetext, so AT gets it without double-speak. */}
          <p className="text-xs text-foreground/60">
            <span className="font-mono tabular-nums text-foreground">{threshold.toFixed(1)}</span>
            {" — "}
            {proposalFrequencyFor(threshold)}
          </p>
          <p id="grooming-auto-apply-threshold-caveat" className="text-xs text-foreground/40">
            Archive and split proposals always come to you for review, whatever this is set to.
          </p>
        </div>
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
        {pending ? "Saving…" : "Save schedule"}
      </Button>
    </form>
  );
}
