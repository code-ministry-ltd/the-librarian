// Settings → Primer (spec 083). The default is shown, not editable; the addendum is the only
// field; the preview shows default + addendum live; a review notice appears after migration.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { AwarenessPrimerForm } = await import("@/components/settings/awareness-primer-form");

const DEFAULT = "You are connected to The Librarian.\n";

function renderForm(overrides: Partial<Parameters<typeof AwarenessPrimerForm>[0]> = {}) {
  const props = {
    defaultPrimer: DEFAULT,
    initialAddendum: "",
    addendumMaxBytes: 1000,
    reviewPending: false,
    onSave: vi.fn().mockResolvedValue({ ok: true }),
    onDismissReview: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
  render(<AwarenessPrimerForm {...props} />);
  return props;
}

describe("AwarenessPrimerForm", () => {
  afterEach(() => vi.clearAllMocks());

  it("pre-fills the addendum and shows the complete primer", () => {
    renderForm({ initialAddendum: "Be brief." });
    expect(screen.getByLabelText("Addendum")).toHaveValue("Be brief.");
    expect(screen.getByTestId("primer-preview").textContent).toBe(
      "You are connected to The Librarian.\n\nBe brief.\n",
    );
  });

  it("explains the default is fixed, the addendum is added, and both are public", () => {
    renderForm();
    expect(screen.getByText(/updates when you upgrade/i)).toBeInTheDocument();
    expect(screen.getByText(/keep secrets out of it/i)).toBeInTheDocument();
    expect(screen.getByText(/Added after the default/i)).toBeInTheDocument();
  });

  it("previews live and sends the addendum to onSave", async () => {
    const { onSave } = renderForm();
    await userEvent.type(screen.getByLabelText("Addendum"), "New line");
    expect(screen.getByTestId("primer-preview").textContent).toContain("New line");
    await userEvent.click(screen.getByRole("button", { name: "Save addendum" }));
    expect(onSave).toHaveBeenCalledWith("New line");
    await vi.waitFor(() => expect(screen.getByText("Saved.")).toBeInTheDocument());
  });

  it("an empty addendum previews the default alone", () => {
    renderForm();
    expect(screen.getByTestId("primer-preview").textContent).toBe(DEFAULT);
  });

  it("blocks saving past the addendum limit and says so", () => {
    renderForm({ initialAddendum: "x".repeat(1001) });
    expect(screen.getByText(/too long/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save addendum" })).toBeDisabled();
  });

  it("shows the migration review notice and dismisses it", async () => {
    const { onDismissReview } = renderForm({ reviewPending: true, initialAddendum: "Old." });
    expect(screen.getByText(/moved into the addendum/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismissReview).toHaveBeenCalledTimes(1);
  });

  it("surfaces the error from a failed save", async () => {
    renderForm({ onSave: vi.fn().mockResolvedValue({ ok: false, error: "boom" }) });
    await userEvent.click(screen.getByRole("button", { name: "Save addendum" }));
    await vi.waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("boom"));
  });
});
