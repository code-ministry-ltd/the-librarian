// Spec 063 — the Vault tab's /activity active-state pin.
//
// The Vault tab is active on both `/` and `/activity` (a two-path disjunction).
// Nothing tested the /activity case before, so a canonical route table that used
// a single scalar `path` field would have silently broken the Vault tab's active
// state on the activity page. This pins it.

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockPathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => mockPathname }));
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }),
}));
vi.mock("@/auth", () => ({ signOut: vi.fn(), auth: vi.fn() }));
vi.mock("@/lib/trpc-client", () => ({
  trpc: {
    health: {
      info: {
        useQuery: () => ({
          data: { version: "0.0.0-test", latest: { kind: "no_release", cachedAt: "" } },
          isLoading: false,
        }),
      },
    },
  },
}));

// The notices bell has its own test (notices-button.test.tsx).
vi.mock("@/components/notices-button", () => ({ NoticesButton: () => null }));

const { SiteNav } = await import("@/components/site-nav");

beforeEach(() => {
  mockPathname = "/";
});

describe("SiteNav — Vault tab active on /activity", () => {
  it("marks the Vault tab active on / (baseline)", () => {
    mockPathname = "/";
    render(<SiteNav />);
    expect(screen.getByRole("link", { name: "Vault" })).toHaveAttribute("aria-current", "page");
  });

  it("marks the Vault tab active on /activity (the second matched path)", () => {
    mockPathname = "/activity";
    render(<SiteNav />);
    // A single scalar `path: "/"` would leave Vault inactive here.
    expect(screen.getByRole("link", { name: "Vault" })).toHaveAttribute("aria-current", "page");
    // And no other tab claims the active state.
    expect(screen.getByRole("link", { name: "Memories" })).not.toHaveAttribute("aria-current");
  });
});
