// Journal timeline geometry (spec 077 PR D): the log-scaled rail, its ticks, the
// "you are here" readout text and the fractional reading position.

import { describe, expect, it } from "vitest";
import {
  daysAgoAt,
  daysBetween,
  periodHeading,
  railPosition,
  railSpan,
  railTicks,
  readingDaysAgo,
  relativeAge,
} from "@/components/journal/timeline";

describe("journal timeline scale", () => {
  it("puts today at the top and the oldest entry at the bottom", () => {
    expect(railPosition(0, 365)).toBe(0);
    expect(railPosition(365, 365)).toBe(1);
    expect(railPosition(-3, 365)).toBe(0);
    expect(railPosition(900, 365)).toBe(1);
  });

  it("gives the detailed fortnight a generous share of a year-long rail", () => {
    // Linear would be 14/365 ≈ 4%; the log scale gives it nearly half.
    expect(railPosition(14, 365)).toBeGreaterThan(0.4);
  });

  it("inverts cleanly, so clicking the rail lands where the marker would sit", () => {
    for (const d of [0, 1, 6.5, 14, 90, 300]) {
      expect(daysAgoAt(railPosition(d, 365), 365)).toBeCloseTo(d, 6);
    }
  });

  it("never squeezes a young journal into a sliver", () => {
    expect(railSpan(2)).toBe(30);
    expect(railSpan(400)).toBe(401);
  });

  it("shows only the ticks inside the span, marking the journal's own tier boundaries", () => {
    const ticks = railTicks(100);
    expect(ticks.map((t) => t.label)).toEqual(["Today", "1 wk", "2 wk", "1 mo", "3 mo"]);
    expect(ticks.filter((t) => t.boundary).map((t) => t.daysAgo)).toEqual([14, 90]);
  });
});

describe("journal timeline readout", () => {
  it("names a day, a week and a month the way a reader would", () => {
    expect(
      periodHeading({ tier: "day", label: "2026-11-02", first: "2026-11-02", last: "2026-11-02" }),
    ).toEqual({
      title: "Monday 2 November",
      detail: "2026",
    });
    expect(
      periodHeading({ tier: "week", label: "2026-W44", first: "2026-10-26", last: "2026-11-01" }),
    ).toEqual({ title: "Week 44", detail: "26 Oct – 1 Nov 2026" });
    expect(
      periodHeading({ tier: "month", label: "2026-10", first: "2026-10-01", last: "2026-10-31" }),
    ).toEqual({ title: "October", detail: "2026" });
  });

  it("phrases how long ago in words", () => {
    expect([0, 1, 5, 20, 100, 400].map(relativeAge)).toEqual([
      "Today",
      "Yesterday",
      "5 days ago",
      "3 weeks ago",
      "3 months ago",
      "1 year ago",
    ]);
  });

  it("moves continuously through a period as you scroll it", () => {
    const week = {
      tier: "week" as const,
      label: "2026-W43",
      first: "2026-10-19",
      last: "2026-10-25",
    };
    expect(daysBetween("2026-10-25", "2026-11-02")).toBe(8);
    expect(readingDaysAgo(week, 0, "2026-11-02")).toBe(8);
    expect(readingDaysAgo(week, 0.5, "2026-11-02")).toBe(11);
    expect(readingDaysAgo(week, 1, "2026-11-02")).toBe(14);
  });
});
