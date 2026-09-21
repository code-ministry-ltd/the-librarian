import type { GroomingConfig, GroomingConfigPatch } from "@librarian/core";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GroomingConfigForm } from "@/components/curator/config-form";
import {
  RunNowButton,
  renderGroomingResult,
  renderIntakeResult,
} from "@/components/curator/run-now-button";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const summary = {
  due: 2,
  ran: 2,
  skippedLocked: 0,
  skippedIdempotent: 0,
  reclaimedStaleLocks: 0,
  errored: 0,
};

describe("RunNowButton", () => {
  it("reports the run summary on success", async () => {
    const onRun = vi.fn(async () => ({
      ok: true as const,
      result: { ran: true as const, summary },
    }));
    render(<RunNowButton onRun={onRun} renderResult={renderGroomingResult} />);
    await userEvent.click(screen.getByRole("button", { name: /run now/i }));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Ran — 2 of 2 due/)).toBeTruthy();
  });

  it("reports a skip reason when nothing ran", async () => {
    const onRun = vi.fn(async () => ({
      ok: true as const,
      result: { ran: false as const, reason: "disabled" as const },
    }));
    render(<RunNowButton onRun={onRun} renderResult={renderGroomingResult} />);
    await userEvent.click(screen.getByRole("button", { name: /run now/i }));
    // The reason code is mapped to friendly copy (plan 046 T11) rather than echoed raw.
    expect(screen.getByText(/automatic runs are disabled/i)).toBeTruthy();
  });

  it("surfaces an error", async () => {
    const onRun = vi.fn(async () => ({ ok: false as const, error: "nope" }));
    render(<RunNowButton onRun={onRun} renderResult={renderGroomingResult} />);
    await userEvent.click(screen.getByRole("button", { name: /run now/i }));
    expect(screen.getByText(/Error: nope/)).toBeTruthy();
  });

  it("renders an intake sweep result with a custom label and renderer", async () => {
    const onRun = vi.fn(async () => ({
      ok: true as const,
      result: {
        ran: true as const,
        summary: {
          reclaimed: 0,
          consolidated: 3,
          judgeErrors: 0,
          claimedByOther: 0,
          errored: 0,
        },
      },
    }));
    render(<RunNowButton onRun={onRun} renderResult={renderIntakeResult} label="Run intake now" />);
    await userEvent.click(screen.getByRole("button", { name: /run intake now/i }));
    expect(screen.getByText(/Ran — 3 item\(s\) consolidated/)).toBeTruthy();
  });

  it("surfaces an intake disabled skip (not swallowed)", async () => {
    const onRun = vi.fn(async () => ({
      ok: true as const,
      result: { ran: false as const, reason: "disabled" as const },
    }));
    render(<RunNowButton onRun={onRun} renderResult={renderIntakeResult} label="Run intake now" />);
    await userEvent.click(screen.getByRole("button", { name: /run intake now/i }));
    expect(screen.getByText(/automatic runs are disabled/i)).toBeTruthy();
  });
});

const config: GroomingConfig = {
  enabled: false,
  applyConfidenceThreshold: 0.8,
  intervalDays: 1,
  scheduleTime: "03:00",
  triggerThreshold: 20,
  debounceMinutes: 60,
  maxMemoriesPerRun: 200,
};

describe("GroomingConfigForm", () => {
  it("pre-fills from the current NON-LLM config and saves a patch (no LLM fields)", async () => {
    const onSave = vi.fn(async (_patch: GroomingConfigPatch) => ({ ok: true as const }));
    render(<GroomingConfigForm initial={config} onSave={onSave} />);

    const slider = screen.getByLabelText("Auto-apply threshold") as HTMLInputElement;
    expect(slider.value).toBe("0.8");
    // The phrase is mirrored to assistive tech via aria-valuetext, so a screen
    // reader hears the band rather than an unmoored decimal.
    expect(slider.getAttribute("aria-valuetext")).toBe("0.8 — Often raises proposals");

    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const patch = onSave.mock.calls[0]![0];
    expect(patch).toMatchObject({
      enabled: false,
      applyConfidenceThreshold: 0.8,
    });
    // The per-slice interval control is retired (plan 046 T4); the form no longer
    // carries an intervalMinutes patch field.
    expect("intervalMinutes" in patch).toBe(false);
    // The LLM connection moved out of this form (provider manager + per-consumer
    // selectors own it now) — the patch must carry no LLM/token keys.
    expect("llm" in patch).toBe(false);
    expect("token" in patch).toBe(false);
    // The prompt addendum left this form too (spec 044 D-1 — it's a committed
    // vault file now; its dashboard editor is D7), so the patch must not set it.
    expect("promptAddendum" in patch).toBe(false);
    expect(screen.getByText("Saved.")).toBeTruthy();
  });

  it("names the proposal frequency at every threshold stop, in the honest direction", () => {
    const onSave = vi.fn(async (_patch: GroomingConfigPatch) => ({ ok: true as const }));
    render(<GroomingConfigForm initial={config} onSave={onSave} />);
    const slider = screen.getByLabelText("Auto-apply threshold") as HTMLInputElement;

    // Raising the threshold narrows the auto-apply band, so it RAISES the number of
    // proposals. The previous copy implied the reverse; this pins the direction.
    const stops: Array<[number, string]> = [
      [0, "Never raises proposals"],
      [0.1, "Sometimes raises proposals"],
      [0.5, "Sometimes raises proposals"],
      [0.6, "Often raises proposals"],
      [0.9, "Often raises proposals"],
      [1, "Always raises proposals"],
    ];
    for (const [stop, phrase] of stops) {
      fireEvent.change(slider, { target: { value: String(stop) } });
      expect(slider.getAttribute("aria-valuetext")).toBe(`${stop.toFixed(1)} — ${phrase}`);
    }
  });

  it("states that archive and split proposals are outside the threshold's reach", () => {
    // The slider's stops describe create/update/merge only (D13). Without this
    // line, stop 0 reads as "never raises proposals" — which the archive and split
    // paths always contradict.
    render(<GroomingConfigForm initial={config} onSave={vi.fn()} />);
    expect(screen.getByText(/archive and split proposals always come to you/i)).toBeTruthy();
  });

  it("snaps a legacy off-stop threshold onto the slider grid and saves the snapped value", async () => {
    // The control this replaced was a number input stepping 0.05, so 0.75 is a real
    // stored value; the slider has no such stop and normalises it to 0.8.
    const onSave = vi.fn(async (_patch: GroomingConfigPatch) => ({ ok: true as const }));
    render(
      <GroomingConfigForm
        initial={{ ...config, applyConfidenceThreshold: 0.75 }}
        onSave={onSave}
      />,
    );
    expect((screen.getByLabelText("Auto-apply threshold") as HTMLInputElement).value).toBe("0.8");

    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave.mock.calls[0]![0]).toMatchObject({ applyConfidenceThreshold: 0.8 });
  });
});
