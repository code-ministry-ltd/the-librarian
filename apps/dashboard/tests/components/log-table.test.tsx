import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LogTable } from "@/components/logs/log-table";

// Spec 081: every log renders through one table. Tone is shown in words, never colour alone,
// and the stored record is one click away.

describe("LogTable", () => {
  it("shows the time, the tone in words, the title, the detail and the full record", () => {
    render(
      <LogTable
        rows={[
          {
            id: "r1",
            at: "2026-11-03T14:00:00.000Z",
            title: "Recall “gpu pinning”: 0 results",
            detail: "claude-code · 12 ms",
            tone: "warn",
            raw: { kind: "recall", query: "gpu pinning" },
          },
          {
            id: "r2",
            at: "2026-11-03T13:00:00.000Z",
            title: "bearer-invalid (401) on the public surface",
            detail: null,
            tone: "error",
            raw: { kind: "bearer-invalid" },
          },
        ]}
      />,
    );
    expect(screen.getByText("Recall “gpu pinning”: 0 results")).toBeInTheDocument();
    expect(screen.getByText("claude-code · 12 ms")).toBeInTheDocument();
    expect(screen.getByText("Note")).toBeInTheDocument();
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getAllByText("Full record")).toHaveLength(2);
    expect(screen.getByText(/"query": "gpu pinning"/)).toBeInTheDocument();
    const times = document.querySelectorAll("time");
    expect(times[0]?.getAttribute("dateTime")).toBe("2026-11-03T14:00:00.000Z");
  });
});
