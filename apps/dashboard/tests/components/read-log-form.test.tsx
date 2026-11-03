import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Spec 081: the read-log switch saves on change and rolls back if the save is refused.

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { ReadLogForm } = await import("@/components/settings/read-log-form");

describe("ReadLogForm", () => {
  it("saves the new value as soon as it is ticked", async () => {
    const onSave = vi.fn(async () => ({ ok: true as const }));
    render(<ReadLogForm enabled={false} recording={false} onSave={onSave} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Record what agents read" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(true));
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("puts the box back and says why when the save fails", async () => {
    const onSave = vi.fn(async () => ({ ok: false as const, error: "Not allowed" }));
    render(<ReadLogForm enabled={true} recording={true} onSave={onSave} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Not allowed");
    expect(screen.getByRole("checkbox")).toBeChecked();
  });
});
