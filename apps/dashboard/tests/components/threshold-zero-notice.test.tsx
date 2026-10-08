import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ThresholdZeroNotice } from "@/components/memories/threshold-zero-notice";

// At threshold 0 every curator change applies itself (ADR 0014), so the review
// queues tell the operator nothing new will arrive and link to the setting.

describe("ThresholdZeroNotice", () => {
  it("tells the operator no new proposals will appear at threshold 0", () => {
    render(<ThresholdZeroNotice threshold={0} page="proposals" />);
    expect(screen.getByRole("note")).toHaveTextContent(
      /No new proposals will appear here unless you raise the threshold/,
    );
    expect(screen.getByRole("link", { name: /change the threshold/i })).toHaveAttribute(
      "href",
      "/settings/curator",
    );
  });

  it("tells the operator the curator sends nothing to Flagged at threshold 0", () => {
    render(<ThresholdZeroNotice threshold={0} page="flagged" />);
    expect(screen.getByRole("note")).toHaveTextContent(
      /will not send anything here for review unless you raise the threshold/,
    );
  });

  it("shows nothing when the threshold is above 0", () => {
    const { container } = render(<ThresholdZeroNotice threshold={0.1} page="proposals" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows nothing when the threshold could not be read", () => {
    const { container } = render(<ThresholdZeroNotice threshold={null} page="flagged" />);
    expect(container).toBeEmptyDOMElement();
  });
});
