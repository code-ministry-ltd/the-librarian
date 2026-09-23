import type { IntakeOperation, IntakeRun } from "@librarian/core";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { IntakeConfigForm } from "@/components/curator/intake-config-form";
import { IntakeRunsTable } from "@/components/curator/intake-runs-table";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

function run(over: Partial<IntakeRun> = {}): IntakeRun {
  return {
    id: "crun_1",
    status: "completed",
    trigger: "manual",
    consolidated: 2,
    judge_errors: 0,
    errored: 0,
    reclaimed: 0,
    summary: "consolidated 2",
    error: null,
    created_at: "2026-05-24T00:00:00.000Z",
    started_at: "2026-05-24T00:00:00.000Z",
    completed_at: "2026-05-24T00:01:00.000Z",
    ...over,
  };
}

function op(over: Partial<IntakeOperation> = {}): IntakeOperation {
  return {
    id: "cop_1",
    run_id: "crun_1",
    action: "augment",
    outcome: "applied",
    confidence: 0.88,
    rationale: "extends existing doc",
    source_id: "inbox/item-1",
    target_id: "mem_42",
    ...over,
  };
}

describe("IntakeConfigForm", () => {
  it("reflects the current enabled state and saves a toggle", async () => {
    const onSave = vi.fn(async (_input: { enabled?: boolean; intervalMinutes?: number }) => ({
      ok: true as const,
    }));
    render(
      <IntakeConfigForm
        enabled={false}
        intervalMinutes={5}
        applyConfidenceThreshold={0.8}
        onSave={onSave}
      />,
    );

    const toggle = screen.getByRole("checkbox");
    expect((toggle as HTMLInputElement).checked).toBe(false);
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    // An unchanged threshold must not overwrite a newer value from the other tab.
    expect(onSave.mock.calls[0]![0]).toEqual({ enabled: true, intervalMinutes: 5 });
    expect(await screen.findByText("Saved.")).toBeTruthy();
  });

  it("shows the shared threshold in Intake and saves the chosen stop with the schedule", async () => {
    const onSave = vi.fn(async () => ({ ok: true as const }));
    render(
      <IntakeConfigForm
        enabled={true}
        intervalMinutes={5}
        applyConfidenceThreshold={0.75}
        onSave={onSave}
      />,
    );
    const slider = screen.getByRole("slider", { name: "Auto-apply threshold" });
    expect(slider).toHaveValue("0.8");
    expect(slider).toHaveAttribute("aria-valuetext", "0.8 — Often raises proposals");
    expect(screen.getByText(/shared with grooming/i)).toBeTruthy();
    expect(screen.getByText(/protected memories and forced submissions/i)).toBeTruthy();

    fireEvent.change(slider, { target: { value: "0" } });
    expect(slider).toHaveValue("0");
    expect(slider).toHaveStyle({ "--threshold-fill": "0%" });
    expect(slider).toHaveAttribute("aria-valuetext", "0.0 — Never raises proposals");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith({
      enabled: true,
      intervalMinutes: 5,
      applyConfidenceThreshold: 0,
    });
  });

  it("does not overwrite a newer shared threshold when only the intake schedule changes", async () => {
    const onSave = vi.fn(async () => ({ ok: true as const }));
    render(
      <IntakeConfigForm
        enabled={true}
        intervalMinutes={5}
        applyConfidenceThreshold={0.8}
        onSave={onSave}
      />,
    );
    await userEvent.clear(screen.getByLabelText(/run every \(minutes\)/i));
    await userEvent.type(screen.getByLabelText(/run every \(minutes\)/i), "15");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(onSave).toHaveBeenCalledWith({ enabled: true, intervalMinutes: 15 });
  });

  it("snaps an old off-grid threshold when intake settings are saved", async () => {
    const onSave = vi.fn(async () => ({ ok: true as const }));
    render(
      <IntakeConfigForm
        enabled={true}
        intervalMinutes={5}
        applyConfidenceThreshold={0.75}
        onSave={onSave}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(onSave).toHaveBeenCalledWith({
      enabled: true,
      intervalMinutes: 5,
      applyConfidenceThreshold: 0.8,
    });
  });

  it("surfaces a save error", async () => {
    const onSave = vi.fn(async () => ({ ok: false as const, error: "boom" }));
    render(
      <IntakeConfigForm
        enabled={true}
        intervalMinutes={5}
        applyConfidenceThreshold={0.8}
        onSave={onSave}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});

describe("IntakeRunsTable", () => {
  it("renders an empty state with no runs", () => {
    render(<IntakeRunsTable runs={[]} onLoadOperations={vi.fn()} />);
    expect(screen.getByText(/no intake runs/i)).toBeTruthy();
  });

  it("renders a run row with its summary and consolidated count", () => {
    render(<IntakeRunsTable runs={[run()]} onLoadOperations={vi.fn()} />);
    expect(screen.getByText("consolidated 2")).toBeTruthy();
    // The trigger label sits inside the expand toggle (alongside its ▸ marker).
    expect(screen.getByRole("button", { name: /show decisions for run crun_1/i })).toBeTruthy();
  });

  it("lazily loads and shows the C1 decisions when a run is expanded", async () => {
    const onLoadOperations = vi.fn(async (_runId: string) => ({
      ok: true as const,
      operations: [op()],
    }));
    render(<IntakeRunsTable runs={[run()]} onLoadOperations={onLoadOperations} />);

    // Not loaded until expanded.
    expect(onLoadOperations).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /show decisions/i }));
    expect(onLoadOperations).toHaveBeenCalledWith("crun_1");

    // The decision detail is visible: action / outcome / confidence / rationale.
    expect(await screen.findByText("augment")).toBeTruthy();
    expect(screen.getByText("applied")).toBeTruthy();
    expect(screen.getByText("0.88")).toBeTruthy();
    expect(screen.getByText("extends existing doc")).toBeTruthy();
  });

  it("surfaces an operations load error", async () => {
    const onLoadOperations = vi.fn(async () => ({ ok: false as const, error: "nope" }));
    render(<IntakeRunsTable runs={[run()]} onLoadOperations={onLoadOperations} />);
    await userEvent.click(screen.getByRole("button", { name: /show decisions/i }));
    expect(await screen.findByText(/Error: nope/)).toBeTruthy();
  });
});
