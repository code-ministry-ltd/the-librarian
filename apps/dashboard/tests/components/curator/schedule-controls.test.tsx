import type { GroomingConfig, GroomingConfigPatch } from "@librarian/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GroomingConfigForm } from "@/components/curator/config-form";
import { IntakeConfigForm } from "@/components/curator/intake-config-form";
import {
  RunNowButton,
  renderGroomingResult,
  renderIntakeResult,
} from "@/components/curator/run-now-button";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const config: GroomingConfig = {
  enabled: true,
  applyConfidenceThreshold: 0.8,
  intervalDays: 1,
  scheduleTime: "03:00",
  triggerThreshold: 20,
  debounceMinutes: 60,
  maxMemoriesPerRun: 200,
};

// --- Intake: "Run every [N] minutes" ------------------------------------------

describe("IntakeConfigForm — sweep cadence", () => {
  it("renders the current interval and saves it via setConfig({intervalMinutes})", async () => {
    const onSave = vi.fn(
      async (_input: {
        enabled?: boolean;
        intervalMinutes?: number;
        applyConfidenceThreshold?: number;
      }) => ({
        ok: true as const,
      }),
    );
    render(
      <IntakeConfigForm
        enabled={true}
        intervalMinutes={5}
        applyConfidenceThreshold={0.8}
        onSave={onSave}
      />,
    );

    const minutes = screen.getByLabelText(/run every \(minutes\)/i) as HTMLInputElement;
    expect(minutes.value).toBe("5");

    await userEvent.clear(minutes);
    await userEvent.type(minutes, "15");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toEqual({ enabled: true, intervalMinutes: 15 });
    expect(screen.getByText("Saved.")).toBeTruthy();
  });

  it("rejects a non-positive interval client-side without calling onSave", async () => {
    const onSave = vi.fn(async () => ({ ok: true as const }));
    render(
      <IntakeConfigForm
        enabled={true}
        intervalMinutes={5}
        applyConfidenceThreshold={0.8}
        onSave={onSave}
      />,
    );

    const minutes = screen.getByLabelText(/run every \(minutes\)/i);
    await userEvent.clear(minutes);
    await userEvent.type(minutes, "0");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/at least 1 minute/i)).toBeTruthy();
  });

  it("surfaces a server BAD_REQUEST inline", async () => {
    const onSave = vi.fn(async () => ({
      ok: false as const,
      error: "intervalMinutes must be an integer ≥ 1",
    }));
    render(
      <IntakeConfigForm
        enabled={true}
        intervalMinutes={5}
        applyConfidenceThreshold={0.8}
        onSave={onSave}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(screen.getByText(/Error: intervalMinutes must be an integer ≥ 1/)).toBeTruthy();
  });
});

// --- Grooming: "Run every [N] days at [HH:MM]" --------------------------------

describe("GroomingConfigForm — grooming schedule", () => {
  it("renders the current schedule and saves intervalDays + scheduleTime", async () => {
    const onSave = vi.fn(async (_patch: GroomingConfigPatch) => ({ ok: true as const }));
    render(<GroomingConfigForm initial={config} onSave={onSave} />);

    const days = screen.getByLabelText(/run every \(days\)/i) as HTMLInputElement;
    const time = screen.getByLabelText(/at \(HH:MM\)/i) as HTMLInputElement;
    expect(days.value).toBe("1");
    expect(time.value).toBe("03:00");

    await userEvent.clear(days);
    await userEvent.type(days, "7");
    await userEvent.clear(time);
    await userEvent.type(time, "04:30");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toMatchObject({ intervalDays: 7, scheduleTime: "04:30" });
  });

  it("shows the cadence hint (1 = nightly · 7 = weekly · 30 ≈ monthly)", () => {
    render(<GroomingConfigForm initial={config} onSave={vi.fn()} />);
    expect(screen.getByText(/1 = nightly/i)).toBeTruthy();
    expect(screen.getByText(/7 = weekly/i)).toBeTruthy();
    expect(screen.getByText(/30 ≈ monthly/i)).toBeTruthy();
  });

  it("rejects a non-positive intervalDays client-side without calling onSave", async () => {
    const onSave = vi.fn(async () => ({ ok: true as const }));
    render(<GroomingConfigForm initial={config} onSave={onSave} />);
    const days = screen.getByLabelText(/run every \(days\)/i);
    await userEvent.clear(days);
    await userEvent.type(days, "0");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/at least 1 day/i)).toBeTruthy();
  });

  it("surfaces a server BAD_REQUEST inline", async () => {
    const onSave = vi.fn(async () => ({
      ok: false as const,
      error: "scheduleTime must be HH:MM",
    }));
    render(<GroomingConfigForm initial={config} onSave={onSave} />);
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(screen.getByText(/Error: scheduleTime must be HH:MM/)).toBeTruthy();
  });
});

// --- Run-now reasons: friendly copy per reason code ---------------------------

describe("run-now result reasons", () => {
  it("maps incomplete_config to 'no model configured'", async () => {
    const onRun = vi.fn(async () => ({
      ok: true as const,
      result: { ran: false as const, reason: "incomplete_config" as const },
    }));
    render(<RunNowButton onRun={onRun} renderResult={renderGroomingResult} />);
    await userEvent.click(screen.getByRole("button", { name: /run now/i }));
    expect(screen.getByText(/no model configured/i)).toBeTruthy();
  });

  it("maps no_token to a missing-token message", async () => {
    const onRun = vi.fn(async () => ({
      ok: true as const,
      result: { ran: false as const, reason: "no_token" as const },
    }));
    render(<RunNowButton onRun={onRun} renderResult={renderIntakeResult} label="Run intake now" />);
    await userEvent.click(screen.getByRole("button", { name: /run intake now/i }));
    expect(screen.getByText(/no LLM token configured/i)).toBeTruthy();
  });

  it("maps disabled to a clear 'automatic runs disabled' message", async () => {
    const onRun = vi.fn(async () => ({
      ok: true as const,
      result: { ran: false as const, reason: "disabled" as const },
    }));
    render(<RunNowButton onRun={onRun} renderResult={renderGroomingResult} />);
    await userEvent.click(screen.getByRole("button", { name: /run now/i }));
    expect(screen.getByText(/disabled/i)).toBeTruthy();
  });

  it("maps not_due to 'nothing to do'", async () => {
    // `not_due` is a SCHEDULED-tick skip, not a run-now result (run-now bypasses the
    // due-check), so it's outside GroomingTickResult's reason union — the renderer maps
    // it defensively so no reason code is ever left raw. Render it directly.
    expect(renderGroomingResult({ ran: false, reason: "not_due" } as never)).toMatch(
      /nothing to do/i,
    );
  });
});
