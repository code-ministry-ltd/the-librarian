import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The "Reject & make an example" teach dialog (proposal-review rework F4,
// scenario C): note → distill (curator returns the updated whole doc) → diff
// preview → explicit confirm commits the doc THEN rejects the proposal.
// Cancel at any point is a no-op; a distill failure teaches in the dialog and
// never blocks the card's plain Reject (which lives outside this component).

const distillExampleAction = vi.fn();
const teachExampleAction = vi.fn();
const refresh = vi.fn();

vi.mock("@/app/(memories)/actions", () => ({
  distillExampleAction: (id: string, note?: string) => distillExampleAction(id, note),
  teachExampleAction: (id: string, shelfId: string, candidate: string) =>
    teachExampleAction(id, shelfId, candidate),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

const { TeachExampleDialog } = await import("@/components/memories/teach-example-dialog");

beforeEach(() => {
  distillExampleAction.mockReset().mockResolvedValue({
    ok: true,
    current: "- Existing example.",
    candidate: "- Existing example.\n- One-off task reminders.",
    diff: "--- a\n+++ b\n@@ -1 +1,2 @@\n - Existing example.\n+- One-off task reminders.",
  });
  teachExampleAction.mockReset().mockResolvedValue({ ok: true });
  refresh.mockReset();
});

function openDialog() {
  render(
    <TeachExampleDialog
      proposalId="mem_p"
      proposalShelfId="shelf-1"
      proposalTitle="TODO fix flaky test"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Reject & make an example" }));
}

describe("TeachExampleDialog", () => {
  it("opens with a note field and a Distill action", () => {
    openDialog();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /note/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Distill/ })).toBeInTheDocument();
  });

  it("distills with the admin note and shows the diff preview", async () => {
    openDialog();
    fireEvent.change(screen.getByRole("textbox", { name: /note/i }), {
      target: { value: "one-off task noise" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Distill/ }));
    await waitFor(() =>
      expect(distillExampleAction).toHaveBeenCalledWith("mem_p", "one-off task noise"),
    );
    await waitFor(() => expect(screen.getByLabelText("Unified diff")).toBeInTheDocument());
    // Nothing committed yet.
    expect(teachExampleAction).not.toHaveBeenCalled();
  });

  it("confirm commits the candidate then rejects, and refreshes", async () => {
    openDialog();
    fireEvent.click(screen.getByRole("button", { name: /Distill/ }));
    await waitFor(() => expect(screen.getByLabelText("Unified diff")).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Teach & reject/ })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Teach & reject/ }));
    await waitFor(() =>
      expect(teachExampleAction).toHaveBeenCalledWith(
        "mem_p",
        "shelf-1",
        "- Existing example.\n- One-off task reminders.",
      ),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("cancel after preview commits nothing", async () => {
    openDialog();
    fireEvent.click(screen.getByRole("button", { name: /Distill/ }));
    await waitFor(() => expect(screen.getByLabelText("Unified diff")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(teachExampleAction).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a distill failure shows a teaching error and offers no confirm", async () => {
    distillExampleAction.mockResolvedValueOnce({
      ok: false,
      error: "The chat LLM is not configured.",
    });
    openDialog();
    fireEvent.click(screen.getByRole("button", { name: /Distill/ }));
    await waitFor(() => expect(screen.getByText(/not configured/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Teach & reject/ })).not.toBeInTheDocument();
  });

  it("a teach failure surfaces its error without closing", async () => {
    teachExampleAction.mockResolvedValueOnce({ ok: false, error: "reject failed downstream" });
    openDialog();
    fireEvent.click(screen.getByRole("button", { name: /Distill/ }));
    await waitFor(() => expect(screen.getByLabelText("Unified diff")).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Teach & reject/ })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Teach & reject/ }));
    await waitFor(() => expect(screen.getByText(/reject failed downstream/)).toBeInTheDocument());
    expect(refresh).not.toHaveBeenCalled();
  });
});
