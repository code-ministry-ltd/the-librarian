"use client";

// Run-now controls (rc.17). Inline editorial button + a result line that
// auto-clears after 5s. Section-scoped (lives in the runs section header
// of each job's tab); the per-job result renderers below translate
// {ran:false,reason} skip states into plain English so the operator sees
// *why* nothing ran rather than a silent no-op (spec 045 / plan 046 T11).

import type { ChronicleTickResult, GroomingTickResult, IntakeTickResult } from "@librarian/core";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui-v2/button";

const REASON_COPY: Record<string, string> = {
  disabled: "automatic runs are disabled (Run now still works)",
  incomplete_config: "no model configured",
  no_token: "no LLM token configured",
  not_due: "nothing to do",
  paused: "a vault restore is in progress — retry once it finishes",
  no_writable_shelves: "there are no writable system shelves",
  already_running: "a sweep is already running — its results will show when it finishes",
};

const skipLabel = (reason: string) =>
  `Skipped — ${REASON_COPY[reason] ?? reason.replace(/_/g, " ")}.`;

/** Grooming tick: N of M due slice(s) curated, or a skip reason. */
export function renderGroomingResult(result: GroomingTickResult): string {
  return result.ran
    ? `Ran — ${result.summary.ran} of ${result.summary.due} due slice(s) curated.`
    : skipLabel(result.reason);
}

/** Intake sweep: items consolidated this sweep, or a skip reason. */
export function renderIntakeResult(
  result: IntakeTickResult | { ran: false; reason: "disabled" },
): string {
  if (!result.ran) return skipLabel(result.reason);
  const { consolidated, parked, stoppedEarly } = result.summary;
  const parkedNote = parked
    ? ` ${parked} item(s) failed three times and were set aside in inbox/.failed.`
    : "";
  const stoppedNote = stoppedEarly
    ? " Stopped early: the model timed out or was unavailable, so the rest wait for the next run."
    : "";
  return `Ran — ${consolidated} item(s) consolidated.${parkedNote}${stoppedNote}`;
}

/** Chronicle pass: one digest per writable system shelf, optionally narrated. */
export function renderChronicleResult(result: ChronicleTickResult): string {
  if (!result.ran) return skipLabel(result.reason);
  const failures = result.failed > 0 ? `, ${result.failed} failed` : "";
  return `Ran — ${result.completed} of ${result.attempted} shelves written — ${result.generated} narrated, ${result.digestOnly} digest only${failures}.`;
}

export type RunActionResult<R> = { ok: true; result: R } | { ok: false; error: string };

const defaultLabel = "Run now";

export function RunNowButton<R>({
  onRun,
  renderResult,
  label = defaultLabel,
  ariaLabel,
}: {
  onRun: () => Promise<RunActionResult<R>>;
  renderResult: (result: R) => string;
  label?: string;
  ariaLabel?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [errored, setErrored] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (!message) return;
    const id = window.setTimeout(() => {
      setMessage(null);
      setErrored(false);
    }, 5000);
    return () => window.clearTimeout(id);
  }, [message]);

  const run = () =>
    startTransition(async () => {
      const res = await onRun();
      if (!res.ok) {
        setMessage(res.error);
        setErrored(true);
        return;
      }
      setMessage(renderResult(res.result));
      setErrored(false);
      router.refresh();
    });

  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      {message ? (
        <p
          role={errored ? "alert" : "status"}
          className={
            errored
              ? "border border-destructive/40 bg-destructive/[0.06] px-3 py-1.5 text-sm text-destructive"
              : "text-sm text-foreground/70"
          }
        >
          {errored ? `Error: ${message}` : message}
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        onClick={run}
        disabled={pending}
        aria-label={ariaLabel ?? label}
      >
        {pending ? "Running…" : label}
      </Button>
    </div>
  );
}
