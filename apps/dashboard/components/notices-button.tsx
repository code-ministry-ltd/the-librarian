"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { trpc } from "@/lib/trpc-client";

// The notices icon beside the version number (spec 084). It shows whether there are unread
// notices, and opens a popover listing them newest first. Opening the popover marks what it
// shows as read; "New" labels stay until it closes, so the operator can see which were new.
// Unread state is shown with a count and words for screen readers, never colour alone.

type Severity = "info" | "important" | "security";

const SEVERITY_LABEL: Record<Severity, string> = {
  info: "Info",
  important: "Important",
  security: "Security",
};

export function NoticesButton() {
  const utils = trpc.useUtils();
  const list = trpc.notices.list.useQuery(undefined, {
    refetchInterval: 60 * 60 * 1000,
    staleTime: 10 * 60 * 1000,
  });
  const markRead = trpc.notices.markRead.useMutation({
    onSuccess: () => utils.notices.list.invalidate(),
  });
  const [open, setOpen] = useState(false);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const panelId = useId();
  const wrapper = useRef<HTMLDivElement>(null);

  const notices = list.data?.notices ?? [];
  const unread = list.data?.unread ?? 0;
  const hasSecurity = notices.some((n) => !n.read && n.severity === "security");

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const unreadIds = notices.filter((n) => !n.read).map((n) => n.id);
    setNewIds(new Set(unreadIds));
    setOpen(true);
    if (unreadIds.length > 0) markRead.mutate({ ids: unreadIds });
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onClick = (event: MouseEvent) => {
      if (wrapper.current && !wrapper.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const label =
    unread === 0
      ? "Notices: none unread"
      : `Notices: ${unread} unread${hasSecurity ? ", including a security notice" : ""}`;

  return (
    <div ref={wrapper} className="relative">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="notices-button"
        data-unread={unread}
        onClick={toggle}
        className="inline-flex h-9 items-center gap-1 px-2 font-mono text-xs text-foreground/60 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 ? (
          <span
            aria-hidden="true"
            className={`min-w-4 px-1 text-center text-[0.6875rem] leading-4 ${
              hasSecurity ? "bg-destructive text-background" : "bg-ink-copper text-background"
            }`}
          >
            {hasSecurity ? `!${unread}` : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="Notices"
          className="absolute right-0 z-50 mt-1 flex max-h-[70vh] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-auto border border-ink-hairline bg-background shadow-lg"
        >
          <header className="border-b border-ink-hairline px-4 py-2 font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-foreground/60">
            Notices
          </header>
          {notices.length === 0 ? (
            <p className="px-4 py-6 text-sm text-foreground/60">No notices.</p>
          ) : (
            <ul className="flex flex-col">
              {notices.map((n) => (
                <li
                  key={n.id}
                  className="flex flex-col gap-1 border-b border-ink-hairline px-4 py-3"
                >
                  <div className="flex flex-wrap items-baseline gap-2 font-mono text-[0.6875rem] text-foreground/60">
                    <span
                      className={
                        n.severity === "security"
                          ? "text-destructive"
                          : n.severity === "important"
                            ? "text-ink-copper"
                            : undefined
                      }
                    >
                      {SEVERITY_LABEL[n.severity as Severity]}
                    </span>
                    <time dateTime={n.created}>{formatDay(n.created)}</time>
                    {newIds.has(n.id) ? <span className="text-ink-accent">New</span> : null}
                  </div>
                  <p className="text-sm font-medium text-foreground">{n.title}</p>
                  <p className="whitespace-pre-line text-sm text-foreground/75">{n.body}</p>
                  {n.link ? (
                    n.source === "local" ? (
                      <Link
                        href={n.link.href}
                        onClick={() => setOpen(false)}
                        className="w-fit text-sm text-ink-accent underline underline-offset-2 hover:no-underline"
                      >
                        {n.link.label}
                      </Link>
                    ) : (
                      <a
                        href={n.link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-fit text-sm text-ink-accent underline underline-offset-2 hover:no-underline"
                      >
                        {n.link.label}
                      </a>
                    )
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <footer className="px-4 py-2 text-xs text-foreground/60">
            {footerText(list.data?.remote)}{" "}
            <Link
              href="/settings/dashboard#notices"
              onClick={() => setOpen(false)}
              className="text-ink-accent underline underline-offset-2 hover:no-underline"
            >
              Settings
            </Link>
          </footer>
        </div>
      ) : null}
    </div>
  );
}

function formatDay(day: string): string {
  const [y, m, d] = day.split("-");
  return y && m && d ? `${d}/${m}/${y}` : day;
}

function footerText(
  remote: { enabled: boolean; forcedOff: boolean; status: { kind: string } } | undefined,
): string {
  if (!remote) return "";
  if (remote.forcedOff) return "Fetching notices is turned off by LIBRARIAN_DISABLE_NOTICES.";
  if (!remote.enabled) return "Fetching notices from GitHub is off.";
  if (remote.status.kind === "unavailable") return "Couldn't reach GitHub for notices just now.";
  return "Notices come from GitHub and this server.";
}
