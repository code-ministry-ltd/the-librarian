// AutoUpdateConfigForm component tests (spec 2026-06-16-server-autoupdate T4).
//
// The form is presentational: it takes the current settings (enabled, cadence,
// lastRunAt) + the version/latest pair the badge reads, plus an `onSave`
// callback (the server action, mocked here exactly as the IntakeConfigForm test
// mocks its `onSave`). We assert: the current settings render; toggling
// `enabled` saves with the right arg; changing cadence saves with the right
// arg; the update-available badge appears only when version !== latest; the
// host hint (SC6) always renders.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, type Mock } from "vitest";
import { AutoUpdateConfigForm } from "@/components/curator/autoupdate-config-form";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

// A `kind: "ok"` latest-release status whose tag is the running version → the
// server reports itself up to date.
function latestOk(tag: string) {
  return {
    kind: "ok" as const,
    release: {
      tag,
      htmlUrl: `https://github.com/code-ministry-ltd/the-librarian/releases/tag/${tag}`,
      publishedAt: "2026-06-01T00:00:00Z",
      bodyExcerpt: null,
    },
    cachedAt: "2026-06-01T00:00:00Z",
  };
}

type OnSave = React.ComponentProps<typeof AutoUpdateConfigForm>["onSave"];

function setup(
  over: Partial<React.ComponentProps<typeof AutoUpdateConfigForm>> = {},
  onSave: Mock<OnSave> = vi.fn(async () => ({ ok: true as const })),
) {
  const props: React.ComponentProps<typeof AutoUpdateConfigForm> = {
    enabled: false,
    cadence: "daily",
    lastRunAt: null,
    version: "1.0.0",
    latest: latestOk("v1.0.0"),
    onSave,
    ...over,
  };
  return { onSave, ...render(<AutoUpdateConfigForm {...props} />) };
}

describe("AutoUpdateConfigForm", () => {
  it("reflects the current enabled state and saves a toggle", async () => {
    const { onSave } = setup({ enabled: false });

    const toggle = screen.getByRole("checkbox", { name: /enable/i });
    expect((toggle as HTMLInputElement).checked).toBe(false);

    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toEqual({ enabled: true, cadence: "daily" });
    expect(await screen.findByText("Saved.")).toBeTruthy();
  });

  it("saves the chosen cadence", async () => {
    const { onSave } = setup({ enabled: true, cadence: "daily" });

    await userEvent.selectOptions(screen.getByRole("combobox", { name: /cadence/i }), "weekly");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toEqual({ enabled: true, cadence: "weekly" });
  });

  it("renders the cadence select reflecting the current value", () => {
    setup({ cadence: "weekly" });
    const select = screen.getByRole("combobox", { name: /cadence/i }) as HTMLSelectElement;
    expect(select.value).toBe("weekly");
  });

  it("shows 'never' when there has been no auto-update", () => {
    setup({ lastRunAt: null });
    const status = screen.getByTestId("autoupdate-last-run");
    expect(status.textContent?.toLowerCase()).toContain("never");
  });

  it("shows the last auto-update time when present", () => {
    setup({ lastRunAt: "2026-06-10T08:30:00.000Z" });
    const status = screen.getByTestId("autoupdate-last-run");
    expect(status.textContent?.toLowerCase()).not.toContain("never");
    expect(status.textContent).toContain("2026");
  });

  it("shows an up-to-date badge when the running version matches latest", () => {
    setup({ version: "1.0.0", latest: latestOk("v1.0.0") });
    const badge = screen.getByTestId("autoupdate-version-badge");
    expect(badge).toHaveAttribute("data-status", "up_to_date");
  });

  it("shows an update-available badge when version !== latest", () => {
    setup({ version: "1.0.0", latest: latestOk("v1.1.0") });
    const badge = screen.getByTestId("autoupdate-version-badge");
    expect(badge).toHaveAttribute("data-status", "behind");
    expect(badge.textContent?.toLowerCase()).toMatch(/update available/);
  });

  it("shows update-available across prereleases of the same core version (rc.29 → rc.33)", () => {
    setup({ version: "1.0.0-rc.29", latest: latestOk("v1.0.0-rc.33") });
    const badge = screen.getByTestId("autoupdate-version-badge");
    expect(badge).toHaveAttribute("data-status", "behind");
  });

  it("renders the host hint with the enable command (SC6)", () => {
    setup();
    const hint = screen.getByTestId("autoupdate-host-hint");
    expect(within(hint).getByText(/librarian server autoupdate enable/)).toBeTruthy();
  });

  it("surfaces a save error", async () => {
    const onSave = vi.fn(async () => ({ ok: false as const, error: "boom" }));
    setup({ enabled: true }, onSave);
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});
