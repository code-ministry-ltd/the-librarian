// Settings → Telemetry (spec 085): says why nothing goes, shows exactly what would, and the
// switch and id reset call their actions.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { TelemetryPanel, statusLine } = await import("@/components/settings/telemetry-panel");

const preview = {
  schema: 1,
  installId: "0f8f2a4e-1111-4222-8333-944455556666",
  version: "1.49.0",
  os: "linux",
  arch: "x64",
  runtime: "docker",
  harnesses: ["claude"],
  memories: "<1k",
  features: { capture: true, intake: true, grooming: false },
};

const base = {
  enabled: true,
  forcedOff: null,
  blocker: { kind: "waiting" as const, until: "2026-11-05T09:00:00.000Z" },
  nextDueAt: "2026-11-05T09:00:00.000Z",
  lastSentAt: null,
  lastPayload: null,
  preview,
  url: "https://librarian-telemetry.codeministry.net/v1/ping",
  intervalDays: 7,
};

describe("TelemetryPanel", () => {
  it("shows the exact next payload, every field explained, and where it goes", () => {
    render(<TelemetryPanel status={base} onToggle={vi.fn()} onResetId={vi.fn()} />);
    expect(JSON.parse(screen.getByTestId("telemetry-preview").textContent!)).toEqual(preview);
    for (const key of Object.keys(preview)) expect(screen.getByText(key)).toBeInTheDocument();
    expect(screen.getByText(base.url)).toBeInTheDocument();
    expect(screen.getByText(/once every 7 days/)).toBeInTheDocument();
    expect(screen.queryByTestId("telemetry-last")).not.toBeInTheDocument();
  });

  it("shows the last payload as sent", () => {
    render(
      <TelemetryPanel
        status={{ ...base, lastSentAt: "2026-11-01T10:00:00.000Z", lastPayload: preview }}
        onToggle={vi.fn()}
        onResetId={vi.fn()}
      />,
    );
    expect(JSON.parse(screen.getByTestId("telemetry-last").textContent!)).toEqual(preview);
  });

  it("switches off through its action", () => {
    const onToggle = vi.fn().mockResolvedValue({ ok: true });
    render(<TelemetryPanel status={base} onToggle={onToggle} onResetId={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Send anonymous usage stats"));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("resets the install id through its action", () => {
    const onResetId = vi.fn().mockResolvedValue({ ok: true });
    render(<TelemetryPanel status={base} onToggle={vi.fn()} onResetId={onResetId} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset install id" }));
    expect(onResetId).toHaveBeenCalledTimes(1);
  });

  it("disables the switch when the environment forces it off", () => {
    render(
      <TelemetryPanel
        status={{
          ...base,
          forcedOff: "DO_NOT_TRACK",
          blocker: { kind: "forced_off", by: "DO_NOT_TRACK" },
        }}
        onToggle={vi.fn()}
        onResetId={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Send anonymous usage stats")).toBeDisabled();
    expect(screen.getByTestId("telemetry-status")).toHaveTextContent("DO_NOT_TRACK");
  });

  it("explains each reason nothing goes", () => {
    expect(statusLine({ ...base, blocker: { kind: "switched_off" } })).toMatch(/^Off/);
    expect(statusLine({ ...base, blocker: { kind: "not_disclosed" } })).toMatch(
      /hasn't been shown/,
    );
    expect(statusLine({ ...base, blocker: null })).toMatch(/due now/);
  });
});
