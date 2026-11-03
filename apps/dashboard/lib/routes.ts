// Canonical dashboard route table — the single source of truth for the route
// data that was, until spec 063, enumerated in six overlapping places:
//
//   • `TABS`            (site-nav.tsx)      — the primary nav strip + mobile drawer
//   • `SETTINGS_ITEMS`  (site-nav.tsx)      — the Settings dropdown + drawer section
//   • `isChromeFree`    (site-nav.tsx)      — routes that render their own chrome
//   • `NAV_ITEMS`       (keyboard-host.tsx) — the command-palette nav targets
//   • the `g`-jumps     (keyboard-host.tsx) — g v / g m / g h keyboard navigation
//   • `ROUTE_DOCS_SLUG` (lib/docs-map.ts)   — dashboard → docs deep-link map
//
// plus two render sites that re-mapped the same data (the mobile drawer and the
// Settings dropdown) and one predicate that had been *copied* out of `TABS[0]`
// (the `SHORTCUTS` surface rules in keyboard-host.tsx). Each of those now derives
// from `ROUTES` below; this module is the only place a route's shape is written.
//
// The refactor is provably inert (spec 063 SC 3): every derived enumeration is
// byte-identical to what it replaced, pinned by tests. The active-match rule is
// deliberately a *disjunction of paths* — the Vault tab is active on both `/` and
// `/activity`, which a single `path` field could not express.

/** How a pathname is matched to a route. `paths` is plural because the Vault tab
 *  matches two exact paths (`/` and `/activity`); a scalar field would silently
 *  break the Vault tab's active state on the activity page. */
export type MatchRule = {
  kind: "exact" | "prefix";
  paths: readonly string[];
};

/** Which nav surface a route belongs to. `null` = reachable route that is not a
 *  nav entry itself (`/activity`, the chrome-free routes). */
export type RouteGroup = "primary" | "settings" | null;

export interface Route {
  /** The route's canonical pathname / link href. */
  href: string;
  /** The command-palette `CommandItem.id` (e.g. `nav-vault`). Not derivable from
   *  the href, so it is carried explicitly. Present only for palette targets. */
  id?: string;
  /** The nav label ("Vault", "Auth"). Absent for non-nav routes. */
  label?: string;
  /** Which nav surface this route belongs to. */
  group: RouteGroup;
  /** Active-state / membership rule (also serves `isChromeFree` and the shortcut
   *  surface predicates). */
  match: MatchRule;
  /** Routes that render their own full-screen chrome and hide the nav. */
  chromeFree?: true;
  /** The command-palette label ("Go to Vault", "Settings → Auth"). */
  paletteLabel?: string;
  /** The command-palette hint column ("G V"); "" when there is no shortcut. */
  hint?: string;
  /** The `g`-prefix jump key (`v` / `m` / `h`). */
  jumpKey?: string;
  /** Whether this route appears as a command-palette nav target. */
  inPalette?: true;
  /** The docs-site slug this route deep-links to. */
  docsSlug?: string;
}

// Order is load-bearing: the palette (`PALETTE_ITEMS`) and the nav strips (`TABS`,
// `SETTINGS_ITEMS`) all read this array top-to-bottom, so it is written in the
// order those surfaces render. `/activity` sits after the tabs (its palette
// position) and the chrome-free routes come last. The docs map is a key lookup,
// so its key order is not observable.
export const ROUTES: readonly Route[] = [
  // Primary nav tabs — also command-palette targets.
  {
    href: "/",
    group: "primary",
    label: "Vault",
    match: { kind: "exact", paths: ["/", "/activity"] },
    id: "nav-vault",
    paletteLabel: "Go to Vault",
    hint: "G V",
    jumpKey: "v",
    inPalette: true,
    docsSlug: "dashboard/vault",
  },
  {
    href: "/curator",
    group: "primary",
    label: "Curator",
    match: { kind: "exact", paths: ["/curator"] },
    id: "nav-curator",
    paletteLabel: "Go to Curator",
    hint: "",
    inPalette: true,
    docsSlug: "dashboard/curator",
  },
  {
    href: "/memories",
    group: "primary",
    label: "Memories",
    match: { kind: "exact", paths: ["/memories"] },
    id: "nav-memories",
    paletteLabel: "Go to Memories",
    hint: "G M",
    jumpKey: "m",
    inPalette: true,
    docsSlug: "dashboard/memories",
  },
  {
    href: "/journal",
    group: "primary",
    label: "Journal",
    match: { kind: "exact", paths: ["/journal"] },
    id: "nav-journal",
    paletteLabel: "Go to Journal",
    // No g-jump: `j` is "next" on the journal (and the vault), so `g j` would also step.
    hint: "",
    inPalette: true,
    docsSlug: "guides/journal",
  },
  {
    href: "/handoffs",
    group: "primary",
    label: "Handoffs",
    match: { kind: "prefix", paths: ["/handoffs"] },
    id: "nav-handoffs",
    paletteLabel: "Go to Handoffs",
    hint: "G H",
    jumpKey: "h",
    inPalette: true,
    docsSlug: "dashboard/handoffs",
  },
  {
    href: "/analytics",
    group: "primary",
    label: "Analytics",
    match: { kind: "exact", paths: ["/analytics"] },
    id: "nav-analytics",
    paletteLabel: "Go to Analytics",
    hint: "",
    inPalette: true,
    docsSlug: "dashboard/analytics",
  },
  {
    href: "/proposals",
    group: "primary",
    label: "Proposals",
    match: { kind: "exact", paths: ["/proposals"] },
    id: "nav-proposals",
    paletteLabel: "Go to Proposals",
    hint: "",
    inPalette: true,
    docsSlug: "dashboard/proposals",
  },
  {
    href: "/flagged",
    group: "primary",
    label: "Flagged",
    match: { kind: "exact", paths: ["/flagged"] },
    id: "nav-flagged",
    paletteLabel: "Go to Flagged",
    hint: "",
    inPalette: true,
    docsSlug: "dashboard/flagged",
  },
  {
    href: "/archive",
    group: "primary",
    label: "Archive",
    match: { kind: "exact", paths: ["/archive"] },
    id: "nav-archive",
    paletteLabel: "Go to Archive",
    hint: "",
    inPalette: true,
    docsSlug: "dashboard/archive",
  },
  {
    href: "/logs",
    group: "primary",
    label: "Logs",
    match: { kind: "exact", paths: ["/logs"] },
    id: "nav-logs",
    paletteLabel: "Go to Logs",
    hint: "",
    inPalette: true,
    docsSlug: "dashboard/logs",
  },
  // Activity — not a nav tab (its active state belongs to Vault, above), but a
  // command-palette target and a docs page in its own right.
  {
    href: "/activity",
    group: null,
    match: { kind: "exact", paths: ["/activity"] },
    id: "nav-activity",
    paletteLabel: "Go to Activity",
    hint: "",
    inPalette: true,
    docsSlug: "dashboard/activity",
  },
  // Settings group. Dashboard (instance settings) first, then the setup flow.
  // Only a subset appear in the palette (auth, primer, curator, tokens, backups).
  {
    href: "/settings/dashboard",
    group: "settings",
    label: "Dashboard",
    match: { kind: "prefix", paths: ["/settings/dashboard"] },
    docsSlug: "dashboard/settings",
  },
  {
    href: "/settings/auth",
    group: "settings",
    label: "Auth",
    match: { kind: "prefix", paths: ["/settings/auth"] },
    id: "nav-settings-auth",
    paletteLabel: "Settings → Auth",
    hint: "",
    inPalette: true,
    docsSlug: "dashboard/settings",
  },
  {
    href: "/settings/primer",
    group: "settings",
    label: "Primer",
    match: { kind: "prefix", paths: ["/settings/primer"] },
    id: "nav-settings-primer",
    paletteLabel: "Settings → Primer",
    hint: "",
    inPalette: true,
    docsSlug: "dashboard/settings",
  },
  {
    href: "/settings/curator",
    group: "settings",
    label: "Curator",
    match: { kind: "prefix", paths: ["/settings/curator"] },
    id: "nav-settings-curator",
    paletteLabel: "Settings → Curator",
    hint: "",
    inPalette: true,
    docsSlug: "dashboard/settings",
  },
  {
    href: "/settings/tokens",
    group: "settings",
    label: "Tokens",
    match: { kind: "prefix", paths: ["/settings/tokens"] },
    id: "nav-settings-tokens",
    paletteLabel: "Settings → Tokens",
    hint: "",
    inPalette: true,
    docsSlug: "dashboard/settings",
  },
  {
    href: "/settings/connect",
    group: "settings",
    label: "Connect",
    match: { kind: "prefix", paths: ["/settings/connect"] },
    docsSlug: "dashboard/settings",
  },
  {
    href: "/settings/ingest",
    group: "settings",
    label: "Captures",
    match: { kind: "prefix", paths: ["/settings/ingest"] },
    docsSlug: "dashboard/settings",
  },
  {
    href: "/settings/backups",
    group: "settings",
    label: "Backups",
    match: { kind: "prefix", paths: ["/settings/backups"] },
    id: "nav-settings-backups",
    paletteLabel: "Settings → Backups",
    hint: "",
    inPalette: true,
    docsSlug: "dashboard/settings",
  },
  {
    href: "/settings/telemetry",
    group: "settings",
    label: "Telemetry",
    match: { kind: "prefix", paths: ["/settings/telemetry"] },
    docsSlug: "dashboard/settings",
  },
  // Chrome-free / non-nav routes. `/health` still deep-links to docs; `/login`,
  // `/claim`, and `/settings/auth/reset` render their own first-run chrome.
  {
    href: "/health",
    group: null,
    match: { kind: "exact", paths: ["/health"] },
    chromeFree: true,
    docsSlug: "dashboard/health",
  },
  {
    href: "/login",
    group: null,
    match: { kind: "prefix", paths: ["/login"] },
    chromeFree: true,
  },
  {
    href: "/claim",
    group: null,
    match: { kind: "prefix", paths: ["/claim"] },
    chromeFree: true,
  },
  {
    href: "/settings/auth/reset",
    group: null,
    match: { kind: "prefix", paths: ["/settings/auth/reset"] },
    chromeFree: true,
  },
];

/** Does `pathname` satisfy `route`'s match rule? */
function matchRoute(route: Route, pathname: string): boolean {
  const { kind, paths } = route.match;
  return kind === "exact"
    ? paths.some((p) => pathname === p)
    : paths.some((p) => pathname.startsWith(p));
}

/** A standalone matcher for a route by href — used by the keyboard-host shortcut
 *  surface predicates, which used to re-encode `TABS[0]`'s two-path disjunction
 *  by hand. Returns `() => false` for an unknown href. */
export function routeMatcher(href: string): (pathname: string) => boolean {
  const route = ROUTES.find((r) => r.href === href);
  if (!route) return () => false;
  return (pathname: string) => matchRoute(route, pathname);
}

/** Routes that render their own full-screen chrome and should hide the nav. */
export function isChromeFree(pathname: string): boolean {
  return ROUTES.some((r) => r.chromeFree && matchRoute(r, pathname));
}

/** The primary nav tabs, in render order, each carrying an active-state matcher. */
export const TABS: ReadonlyArray<{
  href: string;
  label: string;
  match: (pathname: string) => boolean;
}> = ROUTES.filter((r) => r.group === "primary").map((r) => ({
  href: r.href,
  label: r.label as string,
  match: (pathname: string) => matchRoute(r, pathname),
}));

/** The Settings dropdown / drawer items, in render order. */
export const SETTINGS_ITEMS: ReadonlyArray<{ href: string; label: string }> = ROUTES.filter(
  (r) => r.group === "settings",
).map((r) => ({ href: r.href, label: r.label as string }));

/** The command-palette nav targets, in palette order (14 items). */
export const PALETTE_ITEMS: ReadonlyArray<{
  id: string;
  label: string;
  href: string;
  hint: string;
}> = ROUTES.filter((r) => r.inPalette).map((r) => ({
  id: r.id as string,
  label: r.paletteLabel as string,
  href: r.href,
  hint: r.hint ?? "",
}));

/** The `g`-prefix jump map: `{ v: "/", m: "/memories", h: "/handoffs" }`. */
export const JUMP_TARGETS: Readonly<Record<string, string>> = Object.fromEntries(
  ROUTES.filter((r) => r.jumpKey).map((r) => [r.jumpKey as string, r.href]),
);
