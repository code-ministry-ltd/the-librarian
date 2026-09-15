"use client";

// Handoff detail view. Claim is an MCP-only agent op (sessions-rethink
// §6.7) — there is no claim button here. The one dashboard write path is
// the permanent delete (metadata-rail button → shared confirm dialog →
// handoffs.purge); on success it returns to the list. Renders the
// handoff's markdown document as a proper editorial transcript (the 5
// required schema headings — Start & intent / Journey / Current state /
// What's left / Open questions — typeset as h2s instead of literal
// `## ...`) and pins the provenance + status in a right-rail.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { MemoryOrb } from "@/components/brand/memory-orb";
import { HandoffDeleteDialog } from "@/components/handoffs/delete-dialog";
import { Button } from "@/components/ui-v2/button";
import { Pill } from "@/components/ui-v2/pill";
import { SectionLabel } from "@/components/ui-v2/section-label";
import { MarkdownContent } from "@/components/vault/markdown-content";
import { trpc } from "@/lib/trpc-client";

export function HandoffDetailView({ handoffId }: { handoffId: string }) {
  const router = useRouter();
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Esc returns to the list. The shortcut only fires when nothing is focused
  // (mirrors the global "no field-stealing" rule on keyboard-host), and never
  // while a dialog is open — Radix closes the dialog on Escape, and this
  // handler must not also navigate away from an "I meant cancel" keystroke.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (deleteOpen) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      router.push("/handoffs");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, deleteOpen]);

  const result = trpc.handoffs.byId.useQuery({ handoff_id: handoffId });

  if (result.isLoading) {
    return (
      <DetailShell handoffId={handoffId}>
        <div className="flex items-center gap-3 text-sm text-foreground/70" aria-live="polite">
          <MemoryOrb size={12} pulse />
          <span>Loading handoff…</span>
        </div>
      </DetailShell>
    );
  }

  if (result.error) {
    return (
      <DetailShell handoffId={handoffId}>
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          Failed to load handoff: {result.error.message}
        </p>
      </DetailShell>
    );
  }

  const handoff = result.data;
  if (!handoff) {
    return (
      <DetailShell handoffId={handoffId}>
        <div className="flex flex-col gap-2 text-sm text-foreground/70">
          <p>Handoff not found.</p>
          <p className="text-xs text-foreground/55">
            It may have been purged. Return to{" "}
            <Link href="/handoffs" className="text-ink-accent underline-offset-2 hover:underline">
              the handoffs list
            </Link>
            .
          </p>
        </div>
      </DetailShell>
    );
  }

  const created = formatStamp(handoff.created_at);
  const claimed = handoff.claimed_at ? formatStamp(handoff.claimed_at) : null;
  const subtitleBits = [
    handoff.created_by_agent_id ? `by ${handoff.created_by_agent_id}` : null,
    handoff.created_in_harness ? `in ${handoff.created_in_harness}` : null,
    created.relative,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <Link
          href="/handoffs"
          className="inline-flex w-fit items-center gap-1.5 text-xs text-foreground/60 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
        >
          <BackArrow />
          Handoffs
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1
            className="min-w-0 flex-1 truncate font-display text-xl text-foreground"
            title={handoff.title}
          >
            {handoff.title}
          </h1>
          {handoff.claimed_at ? (
            <Pill variant="muted">claimed</Pill>
          ) : (
            <Pill variant="accent">unclaimed</Pill>
          )}
        </div>
        {subtitleBits.length > 0 ? (
          <p className="text-sm text-foreground/60">
            Created {subtitleBits.join(" · ")}
            {handoff.project_key ? ` · project ${handoff.project_key}` : ""}.
          </p>
        ) : null}
      </header>

      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
        <article className="min-w-0">
          <MarkdownContent body={handoff.document_md} links={[]} />
        </article>
        <aside
          className="flex flex-col gap-4 border border-ink-hairline bg-ink-surface p-5 text-sm"
          aria-label="Handoff metadata"
        >
          <MetaRow label="Handoff ID" value={handoff.handoff_id} mono copyable />
          {handoff.project_key ? (
            <MetaRow label="Project" value={handoff.project_key} mono />
          ) : null}
          {handoff.created_by_agent_id ? (
            <MetaRow label="Created by" value={handoff.created_by_agent_id} mono />
          ) : null}
          {handoff.created_in_harness ? (
            <MetaRow label="Created in" value={handoff.created_in_harness} mono />
          ) : null}
          <MetaRow label="Created" value={created.absolute} mono />
          {handoff.cwd ? <MetaRow label="Working directory" value={handoff.cwd} mono /> : null}
          <MetaRow
            label="Status"
            value={claimed ? `claimed ${claimed.relative} · ${claimed.absolute}` : "unclaimed"}
          />
          {handoff.tags.length > 0 ? (
            <MetaRow label="Tags" value={handoff.tags.join(", ")} />
          ) : null}
          <Button
            variant="outline"
            className="border-destructive/50 text-destructive hover:bg-destructive/10"
            onClick={() => setDeleteOpen(true)}
          >
            Delete handoff
          </Button>
        </aside>
      </div>
      <HandoffDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        handoff={{ id: handoff.handoff_id, title: handoff.title }}
        onDeleted={() => router.push("/handoffs")}
      />
    </div>
  );
}

function DetailShell({ handoffId, children }: { handoffId: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <Link
          href="/handoffs"
          className="inline-flex w-fit items-center gap-1.5 text-xs text-foreground/60 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
        >
          <BackArrow />
          Handoffs
        </Link>
        <h1 className="font-display text-xl text-foreground">Handoff</h1>
        <p className="font-mono text-xs text-foreground/55">{handoffId}</p>
      </header>
      {children}
    </div>
  );
}

function MetaRow({
  label,
  value,
  mono,
  copyable,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copyable?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel as="div">{label}</SectionLabel>
      <div className="flex items-start gap-2">
        <span
          className={`min-w-0 flex-1 break-all text-foreground ${
            mono ? "font-mono text-xs text-foreground/85" : "text-sm"
          }`}
        >
          {value}
        </span>
        {copyable ? <CopyButton value={value} /> : null}
      </div>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(id);
  }, [copied]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Silently no-op on permission errors; manual selection still works.
    }
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? "Copied" : "Copy to clipboard"}
      className="shrink-0 text-foreground/55 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function BackArrow() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 3 4 6l3 3" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 14 14"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="4" width="8" height="8" />
      <path d="M2 9V2h7" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 14 14"
      className="h-3.5 w-3.5 text-ink-accent"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m2.5 7 3 3 6-6" />
    </svg>
  );
}

// Formatting helpers — kept here (rather than a shared util) until a second
// surface needs the same relative-time treatment.

function formatStamp(iso: string): { absolute: string; relative: string } {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return { absolute: iso, relative: iso };
  }
  return { absolute: date.toLocaleString(), relative: relativeFromNow(date) };
}

function relativeFromNow(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const past = diffMs < 0;
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 365 * 24 * 60 * 60 * 1000],
    ["month", 30 * 24 * 60 * 60 * 1000],
    ["day", 24 * 60 * 60 * 1000],
    ["hour", 60 * 60 * 1000],
    ["minute", 60 * 1000],
  ];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, ms] of units) {
    if (abs >= ms) {
      const value = Math.round(diffMs / ms);
      return rtf.format(value, unit);
    }
  }
  return past ? "just now" : "in a moment";
}
