import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// usePathname drives the active-link state; next-themes backs the ThemeToggle the
// nav renders. Both are mocked so this stays a fast component-only check.
let mockPathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => mockPathname }));
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }),
}));
// The sign-out control's server action imports @/auth (next-auth), an
// integration boundary that shouldn't load in a unit test — stub it.
vi.mock("@/auth", () => ({ signOut: vi.fn(), auth: vi.fn() }));
// VersionBadge calls trpc.health.info.useQuery; mock the trpc client so
// the nav test doesn't need a QueryClientProvider/TRPCProvider wrapper.
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

const SECTIONS = [
  ["Vault", "/"],
  ["Curator", "/curator"],
  ["Memories", "/memories"],
  ["Handoffs", "/handoffs"],
  ["Analytics", "/analytics"],
  ["Proposals", "/proposals"],
  ["Flagged", "/flagged"],
  ["Archive", "/archive"],
] as const;

beforeEach(() => {
  mockPathname = "/";
});

describe("SiteNav", () => {
  it("renders a link to every primary section, including Curator", () => {
    render(<SiteNav />);
    for (const [label, href] of SECTIONS) {
      const link = screen.getByRole("link", { name: label });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute("href", href);
    }
  });

  it("marks the section matching the current path with aria-current and not the others", () => {
    mockPathname = "/curator";
    render(<SiteNav />);
    expect(screen.getByRole("link", { name: "Curator" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Memories" })).not.toHaveAttribute("aria-current");
  });

  it("treats a handoff detail route as the active Handoffs section", () => {
    mockPathname = "/handoffs/hof_abc";
    render(<SiteNav />);
    expect(screen.getByRole("link", { name: "Handoffs" })).toHaveAttribute("aria-current", "page");
  });

  it("renders nothing on chrome-free routes (e.g. /health)", () => {
    mockPathname = "/health";
    const { container } = render(<SiteNav />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("shows a sign-out control only when signed in", () => {
    render(<SiteNav />);
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    render(<SiteNav signedIn />);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("groups the configuration surfaces under a Settings dropdown", () => {
    render(<SiteNav />);
    const trigger = screen.getByRole("button", { name: /Settings/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    // Dashboard (instance settings) first, then the setup-flow order.
    const items = screen.getAllByRole("menuitem");
    expect(items.map((el) => el.textContent)).toEqual([
      "Dashboard",
      "Auth",
      "Primer",
      "Curator",
      "Tokens",
      "Connect",
      "Captures",
      "Backups",
      "Telemetry",
    ]);
    expect(items[0]).toHaveAttribute("href", "/settings/dashboard");
    expect(items[items.length - 1]).toHaveAttribute("href", "/settings/telemetry");
  });

  it("marks the Settings trigger active for any /settings/* route", () => {
    mockPathname = "/settings/tokens";
    render(<SiteNav />);
    expect(screen.getByRole("button", { name: /Settings/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
