// Spec 063 — inertness pins for the canonical route table.
//
// These assert that the six enumerations the module now feeds still derive to
// the exact shapes they had when each was hand-written. Two of them (the palette
// snapshot and the `isChromeFree` table) are new pins the refactor could not be
// falsified without: nothing tested the palette *contents* or the chrome-free
// set before, so a derivation bug would have gone unseen.

import { describe, expect, it } from "vitest";
import {
  isChromeFree,
  JUMP_TARGETS,
  PALETTE_ITEMS,
  routeMatcher,
  SETTINGS_ITEMS,
  TABS,
} from "@/lib/routes";

describe("routes — command palette contents", () => {
  // The full palette nav-target set, ids + labels + hrefs + hints, in order.
  // Byte-identical to the hand-written `NAV_ITEMS` this replaced.
  it("derives all 16 palette items with exact ids, labels and hints", () => {
    expect(PALETTE_ITEMS).toEqual([
      { id: "nav-vault", label: "Go to Vault", href: "/", hint: "G V" },
      { id: "nav-curator", label: "Go to Curator", href: "/curator", hint: "" },
      { id: "nav-memories", label: "Go to Memories", href: "/memories", hint: "G M" },
      { id: "nav-journal", label: "Go to Journal", href: "/journal", hint: "" },
      { id: "nav-handoffs", label: "Go to Handoffs", href: "/handoffs", hint: "G H" },
      { id: "nav-analytics", label: "Go to Analytics", href: "/analytics", hint: "" },
      { id: "nav-proposals", label: "Go to Proposals", href: "/proposals", hint: "" },
      { id: "nav-flagged", label: "Go to Flagged", href: "/flagged", hint: "" },
      { id: "nav-archive", label: "Go to Archive", href: "/archive", hint: "" },
      { id: "nav-logs", label: "Go to Logs", href: "/logs", hint: "" },
      { id: "nav-activity", label: "Go to Activity", href: "/activity", hint: "" },
      { id: "nav-settings-auth", label: "Settings → Auth", href: "/settings/auth", hint: "" },
      { id: "nav-settings-primer", label: "Settings → Primer", href: "/settings/primer", hint: "" },
      {
        id: "nav-settings-curator",
        label: "Settings → Curator",
        href: "/settings/curator",
        hint: "",
      },
      { id: "nav-settings-tokens", label: "Settings → Tokens", href: "/settings/tokens", hint: "" },
      {
        id: "nav-settings-backups",
        label: "Settings → Backups",
        href: "/settings/backups",
        hint: "",
      },
    ]);
  });
});

describe("routes — isChromeFree table", () => {
  // Every chrome-free route, matched by its own kind (exact for /health, prefix
  // for the other two). A prefix route must also match its sub-paths.
  it.each([
    ["/health", true],
    ["/login", true],
    ["/login/anything", true],
    ["/claim", true],
    ["/claim/anything", true],
    ["/settings/auth/reset", true],
    ["/settings/auth/reset/token-abc", true],
    ["/", false],
    ["/memories", false],
    ["/settings/auth", false],
    ["/health/sub", false], // exact, so a sub-path is NOT chrome-free
  ])("isChromeFree(%s) === %s", (pathname, expected) => {
    expect(isChromeFree(pathname as string)).toBe(expected);
  });
});

describe("routes — nav strip derivation", () => {
  it("derives the ten primary tabs in order", () => {
    expect(TABS.map((t) => [t.label, t.href])).toEqual([
      ["Vault", "/"],
      ["Curator", "/curator"],
      ["Memories", "/memories"],
      ["Journal", "/journal"],
      ["Handoffs", "/handoffs"],
      ["Analytics", "/analytics"],
      ["Proposals", "/proposals"],
      ["Flagged", "/flagged"],
      ["Archive", "/archive"],
      ["Logs", "/logs"],
    ]);
  });

  it("Vault's active rule is the two-path disjunction (/ and /activity)", () => {
    const vault = TABS[0]!;
    expect(vault.href).toBe("/");
    expect(vault.match("/")).toBe(true);
    expect(vault.match("/activity")).toBe(true); // a single `path` field would fail here
    expect(vault.match("/memories")).toBe(false);
  });

  it("Handoffs matches its detail sub-routes (prefix)", () => {
    const handoffs = TABS.find((t) => t.href === "/handoffs")!;
    expect(handoffs.match("/handoffs")).toBe(true);
    expect(handoffs.match("/handoffs/hof_abc")).toBe(true);
    expect(handoffs.match("/handful")).toBe(false);
  });

  it("derives the nine settings items in order", () => {
    expect(SETTINGS_ITEMS).toEqual([
      { href: "/settings/dashboard", label: "Dashboard" },
      { href: "/settings/auth", label: "Auth" },
      { href: "/settings/primer", label: "Primer" },
      { href: "/settings/curator", label: "Curator" },
      { href: "/settings/tokens", label: "Tokens" },
      { href: "/settings/connect", label: "Connect" },
      { href: "/settings/ingest", label: "Captures" },
      { href: "/settings/backups", label: "Backups" },
      { href: "/settings/telemetry", label: "Telemetry" },
    ]);
  });
});

describe("routes — keyboard navigation derivation", () => {
  it("derives the g-jump map (v/m/h → routes)", () => {
    expect(JUMP_TARGETS).toEqual({ v: "/", m: "/memories", h: "/handoffs" });
  });

  it("the shortcut surface matchers re-use the tab match rules", () => {
    const onVault = routeMatcher("/");
    const onMemories = routeMatcher("/memories");
    // Vault surface shows on / and /activity — the copied-out TABS[0] rule.
    expect(onVault("/")).toBe(true);
    expect(onVault("/activity")).toBe(true);
    expect(onVault("/memories")).toBe(false);
    expect(onMemories("/memories")).toBe(true);
    expect(onMemories("/")).toBe(false);
    // An unknown href never matches.
    expect(routeMatcher("/nope")("/nope")).toBe(false);
  });
});
