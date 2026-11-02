import type { JournalConfig } from "@librarian/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { JournalConfigForm } from "@/components/curator/journal-config-form";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const config: JournalConfig = { enabled: false, injectBudgetTokens: 20_000 };

describe("JournalConfigForm (spec 077)", () => {
  it("saves the switch and the session-start budget", async () => {
    const onSave = vi.fn(async () => ({ ok: true as const }));
    render(<JournalConfigForm initial={config} intakeEnabled onSave={onSave} />);

    await userEvent.click(screen.getByRole("checkbox", { name: /keep a journal/i }));
    const budget = screen.getByLabelText(/session-start budget/i);
    await userEvent.clear(budget);
    await userEvent.type(budget, "30000");
    await userEvent.click(screen.getByRole("button", { name: /save journal settings/i }));

    expect(onSave).toHaveBeenCalledWith({ enabled: true, injectBudgetTokens: 30_000 });
    expect(await screen.findByRole("status")).toHaveTextContent("Saved.");
  });

  it("explains an out-of-range budget instead of saving it", async () => {
    const onSave = vi.fn(async () => ({ ok: true as const }));
    render(<JournalConfigForm initial={config} intakeEnabled onSave={onSave} />);

    const budget = screen.getByLabelText(/session-start budget/i);
    await userEvent.clear(budget);
    await userEvent.type(budget, "500");
    await userEvent.click(screen.getByRole("button", { name: /save journal settings/i }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("from 2,000 to 100,000");
  });

  it("warns that the journal needs intake when intake is off", async () => {
    render(
      <JournalConfigForm
        initial={{ ...config, enabled: true }}
        intakeEnabled={false}
        onSave={vi.fn(async () => ({ ok: true as const }))}
      />,
    );
    expect(screen.getByText(/only runs while intake is enabled/i)).toBeInTheDocument();
  });

  it("shows the server's error when saving fails", async () => {
    const onSave = vi.fn(async () => ({ ok: false as const, error: "settings store unavailable" }));
    render(<JournalConfigForm initial={config} intakeEnabled onSave={onSave} />);
    await userEvent.click(screen.getByRole("button", { name: /save journal settings/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("settings store unavailable");
  });
});
