"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { TelemetryActionResult } from "@/app/settings/telemetry/actions";
import { Button } from "@/components/ui-v2/button";
import { SectionLabel } from "@/components/ui-v2/section-label";

// Settings → Telemetry (spec 085). Shows the switch, why nothing would go right now, exactly
// what the next ping would send (and what the last one did send), when, and where.

interface Payload {
  schema: number;
  installId: string;
  version: string;
  os: string;
  arch: string;
  runtime: string;
  harnesses: string[];
  memories: string;
  features: { capture: boolean; intake: boolean; grooming: boolean };
}

type Blocker =
  | { kind: "forced_off"; by: string }
  | { kind: "switched_off" }
  | { kind: "not_disclosed" }
  | { kind: "waiting"; until: string };

export interface TelemetryStatusView {
  enabled: boolean;
  forcedOff: string | null;
  blocker: Blocker | null;
  nextDueAt: string | null;
  lastSentAt: string | null;
  lastPayload: Payload | null;
  preview: Payload;
  url: string;
  intervalDays: number;
}

const FIELDS: { key: keyof Payload; what: string }[] = [
  {
    key: "installId",
    what: "A random id made on this server, so a weekly ping counts once. Not derived from the machine; reset it below.",
  },
  { key: "version", what: "The Librarian version." },
  { key: "os", what: "Operating system family, such as linux." },
  { key: "arch", what: "Processor architecture, such as x64." },
  { key: "runtime", what: "Whether it runs in Docker or directly on Node." },
  {
    key: "harnesses",
    what: "Which known harness families have written memories. Names only; any other agent name is left out.",
  },
  { key: "memories", what: "A rough size: under 100, under 1,000, under 10,000, or more." },
  { key: "features", what: "Whether capture, intake and grooming are switched on." },
  { key: "schema", what: "The payload format version." },
];

export function formatWhen(iso: string | null): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function statusLine(status: TelemetryStatusView): string {
  const b = status.blocker;
  if (!b) return "On. A ping is due now and goes on the next hourly check.";
  switch (b.kind) {
    case "forced_off":
      return `Off for this server: ${b.by} is set in its environment.`;
    case "switched_off":
      return "Off. Nothing is sent.";
    case "not_disclosed":
      return "On, but nothing has been sent: the notice about it hasn't been shown in the dashboard yet.";
    case "waiting":
      return `On. The next ping goes after ${formatWhen(b.until)}.`;
  }
}

export function TelemetryPanel({
  status,
  onToggle,
  onResetId,
}: {
  status: TelemetryStatusView;
  onToggle: (enabled: boolean) => Promise<TelemetryActionResult>;
  onResetId: () => Promise<TelemetryActionResult>;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(status.enabled);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const forced = status.forcedOff !== null;

  const run = (action: () => Promise<TelemetryActionResult>, rollback?: () => void) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) router.refresh();
      else {
        rollback?.();
        setError(result.error);
      }
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2" aria-label="Switch">
        <label className="inline-flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={enabled && !forced}
            disabled={pending || forced}
            onChange={(event) => {
              const next = event.target.checked;
              setEnabled(next);
              run(
                () => onToggle(next),
                () => setEnabled(!next),
              );
            }}
            className="h-4 w-4 accent-ink-accent"
          />
          Send anonymous usage stats
        </label>
        <p className="text-sm text-foreground" data-testid="telemetry-status">
          {statusLine(status)}
        </p>
        <p className="max-w-3xl text-xs text-foreground/60">
          At most once every {status.intervalDays} days, as a single HTTPS request to{" "}
          <code className="font-mono">{status.url}</code>, which the project runs itself. No IP
          address is stored, though the network sees it in transit. Setting{" "}
          <code className="font-mono">DO_NOT_TRACK=1</code> or{" "}
          <code className="font-mono">LIBRARIAN_TELEMETRY=off</code> turns it off for the whole
          server. Last sent: {formatWhen(status.lastSentAt)}.
        </p>
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="telemetry-fields">
        <SectionLabel as="h2" id="telemetry-fields">
          What is sent
        </SectionLabel>
        <dl className="grid max-w-3xl grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
          {FIELDS.map((f) => (
            <div key={f.key} className="contents">
              <dt className="font-mono text-xs text-foreground/80">{f.key}</dt>
              <dd className="text-foreground/70">{f.what}</dd>
            </div>
          ))}
        </dl>
        <p className="max-w-3xl text-xs text-foreground/60">
          Never sent: memories, titles, names, file paths, hostnames, exact counts, settings or
          tokens.
        </p>
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="telemetry-next">
        <SectionLabel as="h2" id="telemetry-next">
          The next ping, exactly
        </SectionLabel>
        <pre
          data-testid="telemetry-preview"
          className="max-w-3xl overflow-auto border border-ink-hairline bg-foreground/[0.03] p-3 font-mono text-xs text-foreground/80"
        >
          {JSON.stringify(status.preview, null, 2)}
        </pre>
      </section>

      {status.lastPayload ? (
        <section className="flex flex-col gap-2" aria-labelledby="telemetry-last">
          <SectionLabel as="h2" id="telemetry-last">
            The last ping, as sent on {formatWhen(status.lastSentAt)}
          </SectionLabel>
          <pre
            data-testid="telemetry-last"
            className="max-w-3xl overflow-auto border border-ink-hairline bg-foreground/[0.03] p-3 font-mono text-xs text-foreground/80"
          >
            {JSON.stringify(status.lastPayload, null, 2)}
          </pre>
        </section>
      ) : null}

      <section className="flex flex-col gap-2" aria-label="Install id">
        <Button
          type="button"
          variant="outline"
          className="self-start"
          disabled={pending}
          onClick={() => run(onResetId)}
        >
          Reset install id
        </Button>
        <p className="max-w-3xl text-xs text-foreground/60">
          Makes a new random id. Earlier pings can no longer be linked to later ones.
        </p>
      </section>

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
