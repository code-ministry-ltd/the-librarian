import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CorrectionHistory } from "@/components/memories/correction-history";
import type { CorrectionHistoryRow } from "@/components/memories/types";

const recentCorrection: CorrectionHistoryRow = {
  source_memory_id: "mem_source",
  title: "Mixed facts",
  shelf_id: "main",
  shelf_label: "Main shelf",
  applied_at: "2026-06-20T14:30:00.000Z",
  outcome: "proposal_approved",
  proposal_id: "mem_correction",
};

describe("CorrectionHistory", () => {
  it("shows a clear empty state for the rolling 30-day window", () => {
    render(<CorrectionHistory rows={[]} error={null} />);

    expect(screen.getByRole("status")).toHaveTextContent("No corrections in the past 30 days.");
  });

  it("names the corrected memory, shelf, outcome, and timestamp", () => {
    const { container } = render(<CorrectionHistory rows={[recentCorrection]} error={null} />);

    expect(screen.getByText(/Approved correction/)).toBeInTheDocument();
    expect(screen.getByText("Mixed facts")).toBeInTheDocument();
    expect(screen.getByText(/Main shelf/)).toBeInTheDocument();
    expect(
      container.querySelector('time[datetime="2026-06-20T14:30:00.000Z"]'),
    ).toBeInTheDocument();
  });

  it("fails soft when history cannot be loaded", () => {
    render(<CorrectionHistory rows={[]} error="service unavailable" />);

    expect(screen.getByRole("alert")).toHaveTextContent("Failed to load correction history");
    expect(screen.getByRole("alert")).toHaveTextContent("service unavailable");
  });
});
