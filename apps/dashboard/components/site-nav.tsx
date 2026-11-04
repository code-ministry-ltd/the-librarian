"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { DocsLink } from "@/components/docs-link";
import { OPEN_SHORTCUTS_EVENT } from "@/components/keyboard-host";
import { SignOutButton } from "@/components/sign-out-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { SectionLabel } from "@/components/ui-v2/section-label";
import { NoticesButton } from "@/components/notices-button";
import { VersionBadge } from "@/components/version-badge";
import { isChromeFree, SETTINGS_ITEMS, TABS } from "@/lib/routes";

// The dashboard's single persistent navigation. Mounted once in the root
// layout (app/layout.tsx) so every surface is reachable without the command
// palette.
//
// Top-level: the operational surfaces (Memories, Handoffs, etc.) + a
// "Settings" dropdown that holds the configuration sub-surfaces. There's no
// /settings route — the trigger only opens the menu; the children own the
// actual pages. On mobile (hamburger drawer), Settings appears as a section
// heading with its 5 children listed underneath.
//
// Active state: desktop uses a verdigris bottom-underline (matches the Tabs
// primitive vocabulary used inside pages — /memories Browse/Recall,
// /settings/auth, /settings/curator); mobile drawer rows use a verdigris
// wash (matches the dropdown's child-active treatment). Both reach the same
// rubric without inventing a third active style.

// `TABS`, `SETTINGS_ITEMS` and `isChromeFree` all derive from the canonical route
// table in `@/lib/routes` (spec 063) — the single source of truth this file used
// to duplicate. The desktop underline / mobile-wash active treatments and the
// Settings-group prefix below stay here; they are presentation, not route data.

function isSettingsActive(p: string): boolean {
  return p.startsWith("/settings/");
}

const DESKTOP_TAB_BASE =
  "-mb-px inline-flex h-9 items-center border-b-2 px-2 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent";

function desktopTabClasses(active: boolean): string {
  return `${DESKTOP_TAB_BASE} ${
    active
      ? "border-ink-accent text-foreground"
      : "border-transparent text-foreground/60 hover:text-foreground"
  }`;
}

function mobileRowClasses(active: boolean): string {
  return `block px-3 py-2 text-sm transition-colors ${
    active
      ? "bg-ink-accent/[0.06] text-foreground"
      : "text-foreground/70 hover:bg-foreground/[0.04] hover:text-foreground"
  }`;
}

export function SiteNav({ signedIn = false }: { signedIn?: boolean }) {
  const pathname = usePathname() ?? "";
  const [open, setOpen] = useState(false);

  // Auto-close the mobile menu on route change so a navigation gesture leaves
  // the next page in its default chrome state.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  if (isChromeFree(pathname)) return null;

  return (
    <nav className="border-b border-ink-hairline bg-ink-surface text-sm">
      <div className="flex items-center gap-2 px-4 py-2">
        <button
          type="button"
          aria-label={open ? "Close navigation menu" : "Open navigation menu"}
          aria-expanded={open}
          aria-controls="site-nav-mobile-menu"
          onClick={() => setOpen((v) => !v)}
          className="-ml-1 mr-1 p-1.5 text-foreground/60 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent min-[930px]:hidden"
        >
          {open ? (
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M6 18L18 6" />
            </svg>
          ) : (
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          )}
        </button>
        <div className="hidden flex-wrap items-center gap-4 min-[930px]:flex">
          {TABS.map((tab) => {
            const active = tab.match(pathname);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={desktopTabClasses(active)}
              >
                {tab.label}
              </Link>
            );
          })}
          <SettingsMenu pathname={pathname} />
        </div>
        <span className="ml-auto flex items-center gap-1.5">
          <VersionBadge />
          {/* Not gated on signedIn: a dashboard without enforced sign-in has no session but
              still makes admin calls. The bell hides itself until the list loads. */}
          <NoticesButton />
          <DocsLink />
          <button
            type="button"
            aria-label="Show keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            onClick={() => window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT))}
            className="px-2 py-1 font-mono text-sm text-foreground/60 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-accent"
          >
            ?
          </button>
          <ThemeToggle />
          {signedIn ? <SignOutButton /> : null}
        </span>
      </div>
      {open ? (
        <div
          id="site-nav-mobile-menu"
          className="border-t border-ink-hairline bg-ink-surface min-[930px]:hidden"
        >
          <ul className="flex flex-col py-2">
            {TABS.map((tab) => {
              const active = tab.match(pathname);
              return (
                <li key={tab.href}>
                  <Link
                    href={tab.href}
                    aria-current={active ? "page" : undefined}
                    className={mobileRowClasses(active)}
                  >
                    {tab.label}
                  </Link>
                </li>
              );
            })}
            <li className="mt-3 border-t border-ink-hairline px-3 pb-1 pt-3">
              <SectionLabel as="div">Settings</SectionLabel>
            </li>
            {SETTINGS_ITEMS.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={mobileRowClasses(active)}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </nav>
  );
}

function SettingsMenu({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const active = isSettingsActive(pathname);

  // Close when the route changes (a child link click navigates away).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Close on outside click + Escape — same pattern as the FilterChips popover.
  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent | TouchEvent) {
      const node = wrapperRef.current;
      if (!node) return;
      if (event.target instanceof Node && node.contains(event.target)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-current={active ? "page" : undefined}
        onClick={() => setOpen((v) => !v)}
        className={`${desktopTabClasses(active)} gap-1`}
      >
        Settings
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className={`h-2.5 w-2.5 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 4.5 6 7.5 9 4.5" />
        </svg>
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Settings"
          className="absolute left-0 top-full z-30 mt-px min-w-[10rem] border border-ink-hairline bg-ink-surface"
        >
          <ul className="flex flex-col py-1">
            {SETTINGS_ITEMS.map((item) => {
              const childActive = pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    role="menuitem"
                    aria-current={childActive ? "page" : undefined}
                    className={`block px-3 py-1.5 text-sm transition-colors ${
                      childActive
                        ? "bg-ink-accent/[0.06] text-foreground"
                        : "text-foreground/70 hover:bg-foreground/[0.04] hover:text-foreground"
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
