"use client";

import type { CSSProperties } from "react";
import { SectionLabel } from "@/components/ui-v2/section-label";

/** The existing setting accepted 0.05 steps; display/save the nearest of 11 stops. */
const THRESHOLD_STEPS = 10;
const DEFAULT_THRESHOLD = 0.8;

export function snapThresholdToStop(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_THRESHOLD;
  return Math.round(Math.min(1, Math.max(0, value)) * THRESHOLD_STEPS) / THRESHOLD_STEPS;
}

function proposalFrequencyFor(value: number): string {
  if (value <= 0) return "Never raises proposals";
  if (value <= 0.5) return "Sometimes raises proposals";
  if (value <= 0.9) return "Often raises proposals";
  return "Always raises proposals";
}

/** One shared D13 threshold, rendered on both jobs' tabs. Exceptions still propose at 0. */
export function AutoApplyThresholdField({
  id,
  value,
  onChange,
  sharedWith,
}: {
  id: string;
  value: number;
  onChange: (value: number) => void;
  sharedWith: "Intake" | "Grooming";
}) {
  const helpId = `${id}-help`;
  const caveatId = `${id}-caveat`;
  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <SectionLabel as="label" htmlFor={id}>
          Auto-apply threshold
        </SectionLabel>
        <p id={helpId} className="text-xs text-foreground/60">
          How confident should the curator be before it auto-applies? Shared with {sharedWith}.
        </p>
      </header>
      <div className="flex flex-col gap-2">
        <input
          id={id}
          type="range"
          min="0"
          max="1"
          step="0.1"
          value={value}
          aria-describedby={`${helpId} ${caveatId}`}
          aria-valuetext={`${value.toFixed(1)} — ${proposalFrequencyFor(value)}`}
          onChange={(event) => onChange(Number(event.target.value))}
          className="curator-threshold-slider w-full max-w-xs cursor-pointer"
          style={{ "--threshold-fill": `${value * 100}%` } as CSSProperties}
        />
        <p className="text-xs text-foreground/60">
          <span className="font-mono tabular-nums text-foreground">{value.toFixed(1)}</span>
          {" — "}
          {proposalFrequencyFor(value)}
        </p>
        <p id={caveatId} className="text-xs text-foreground/60">
          Archive and split proposals always come to you for review; protected memories and forced
          submissions do too, even at 0. Existing proposals remain until reviewed.
        </p>
      </div>
    </div>
  );
}
