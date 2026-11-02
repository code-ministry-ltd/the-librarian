import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ImportConfigForm } from "@/components/curator/import-config-form";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const initial = {
  maxAgeDays: 90,
  allowanceRemaining: 200,
  memoriesCutoff: "2026-03-04T09:00:00.000Z",
  journalCutoff: null,
  conversationsRecorded: 1234,
};

describe("ImportConfigForm", () => {
  it("shows the frozen cutoffs read-only and explains an unset one", () => {
    render(<ImportConfigForm initial={initial} onSave={vi.fn()} />);
    expect(screen.getByText("4 March 2026")).toBeTruthy();
    expect(screen.getByText(/has never run, so all past conversations qualify/)).toBeTruthy();
    expect(screen.getByText("1,234")).toBeTruthy();
    expect(screen.queryByLabelText(/cutoff/i)).toBeNull(); // not an editable field
  });

  it("saves the maximum age and allowance", async () => {
    const onSave = vi.fn(async () => ({ ok: true as const }));
    render(<ImportConfigForm initial={initial} onSave={onSave} />);
    await userEvent.clear(screen.getByLabelText(/maximum age/i));
    await userEvent.type(screen.getByLabelText(/maximum age/i), "365");
    await userEvent.clear(screen.getByLabelText(/allowance/i));
    await userEvent.type(screen.getByLabelText(/allowance/i), "50");
    await userEvent.click(screen.getByRole("button", { name: "Save import settings" }));
    expect(onSave).toHaveBeenCalledWith({ maxAgeDays: 365, allowanceRemaining: 50 });
    expect(await screen.findByText("Saved.")).toBeTruthy();
  });

  it("refuses an out-of-range value before saving, with a teaching message", async () => {
    const onSave = vi.fn();
    render(<ImportConfigForm initial={initial} onSave={onSave} />);
    await userEvent.clear(screen.getByLabelText(/maximum age/i));
    await userEvent.type(screen.getByLabelText(/maximum age/i), "0");
    await userEvent.click(screen.getByRole("button", { name: "Save import settings" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter the maximum age as a whole number of days from 1 to 3,650.",
    );
  });
});
