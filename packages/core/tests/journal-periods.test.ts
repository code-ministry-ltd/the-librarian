// Journal period arithmetic (spec 077 §4.1/§4.3): paths, ISO weeks, and the tier
// boundaries compaction runs on. Pure — no store.

import {
  addDays,
  dayPeriod,
  isMonthClosedForRollup,
  isPastDayTier,
  isWeekClosedForRollup,
  isWeekPastWeekTier,
  isoWeekOf,
  monthOfWeek,
  monthPeriod,
  parseLocalDate,
  periodFromPath,
  weekPeriod,
} from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("journal periods — paths", () => {
  it("parses the three canonical path shapes back into periods", () => {
    expect(periodFromPath("days/2026-11-02.md")).toMatchObject({
      tier: "day",
      first: "2026-11-02",
      last: "2026-11-02",
    });
    expect(periodFromPath("weeks/2026-W44.md")).toMatchObject({
      tier: "week",
      first: "2026-10-26",
      last: "2026-11-01",
    });
    expect(periodFromPath("months/2026-02.md")).toMatchObject({
      tier: "month",
      first: "2026-02-01",
      last: "2026-02-28",
    });
  });

  it("ignores anything that is not exactly a canonical journal path", () => {
    for (const bad of [
      "days/2026-13-01.md",
      "days/2026-02-31.md",
      "days/notes.md",
      "weeks/2026-W54.md",
      "months/2026-1.md",
      "2026-11-02.md",
      "days/2026-11-02.txt",
      "days/sub/2026-11-02.md",
    ]) {
      expect(periodFromPath(bad), bad).toBeNull();
    }
  });

  it("explains a malformed date instead of rolling it over", () => {
    expect(() => parseLocalDate("2026-13-99")).toThrow(
      "Expected a date as YYYY-MM-DD, got '2026-13-99'",
    );
    expect(() => parseLocalDate("2026-02-30")).toThrow("real calendar date");
  });
});

describe("journal periods — ISO weeks and months", () => {
  it("labels ISO weeks across a year boundary", () => {
    expect(isoWeekOf("2026-01-01")).toBe("2026-W01");
    expect(isoWeekOf("2027-01-01")).toBe("2026-W53");
    expect(weekPeriod("2026-W53").last).toBe("2027-01-03");
  });

  it("assigns a week straddling two months to the month of its Thursday", () => {
    // 2026-W44 runs Mon 26 Oct – Sun 1 Nov; Thursday 29 Oct is in October.
    expect(monthOfWeek("2026-W44")).toBe("2026-10");
    // 2026-W27 runs Mon 29 Jun – Sun 5 Jul; Thursday 2 Jul is in July.
    expect(monthOfWeek("2026-W27")).toBe("2026-07");
  });

  it("builds month bounds for a leap February", () => {
    expect(monthPeriod("2028-02").last).toBe("2028-02-29");
  });
});

describe("journal periods — tier boundaries", () => {
  const today = "2026-11-02";

  it("keeps the last 14 days in the day tier", () => {
    expect(isPastDayTier(addDays(today, -13), today)).toBe(false);
    expect(isPastDayTier(addDays(today, -14), today)).toBe(true);
  });

  it("rolls a week only once its Sunday has left the day tier", () => {
    // 2026-W42 ends Sun 18 Oct = today − 15 → closed. 2026-W43 ends Sun 25 Oct = today − 8 → open.
    expect(isWeekClosedForRollup("2026-W42", today)).toBe(true);
    expect(isWeekClosedForRollup("2026-W43", today)).toBe(false);
  });

  it("moves weeks to the month tier after 90 days, and months only once all their weeks have", () => {
    expect(isWeekPastWeekTier("2026-W31", today)).toBe(true); // ends 2 Aug
    expect(isWeekPastWeekTier("2026-W32", today)).toBe(false); // ends 9 Aug (today − 85)
    // July ends 31 Jul; its last week (W31, Thu 30 Jul) ends 2 Aug = today − 92.
    expect(isMonthClosedForRollup("2026-07", today)).toBe(true);
    expect(isMonthClosedForRollup("2026-08", today)).toBe(false);
  });

  it("exposes day paths for the store seam", () => {
    expect(dayPeriod("2026-11-02").path).toBe("days/2026-11-02.md");
  });
});
