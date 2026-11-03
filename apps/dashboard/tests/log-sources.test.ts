// Spec 081: the Logs page's source table and the download's file format.

import { describe, expect, it } from "vitest";
import {
  LOG_SOURCES,
  LOG_SOURCE_IDS,
  downloadFileName,
  isLogSourceId,
  toNdjson,
} from "@/lib/log-sources";

describe("log sources", () => {
  it("describes every source once, in tab order", () => {
    expect(LOG_SOURCES.map((source) => source.id)).toEqual([...LOG_SOURCE_IDS]);
  });

  it("accepts only known source ids", () => {
    expect(isLogSourceId("reads")).toBe(true);
    expect(isLogSourceId("vault")).toBe(true);
    for (const value of ["", "Reads", "../settings", null, undefined, 3]) {
      expect(isLogSourceId(value)).toBe(false);
    }
  });

  it("names the download after the log and the day", () => {
    expect(downloadFileName("reads", new Date("2026-11-03T14:00:00Z"))).toBe(
      "librarian-reads-2026-11-03.ndjson",
    );
  });

  it("writes one JSON object per line, newline-terminated, and nothing for an empty log", () => {
    expect(toNdjson([])).toBe("");
    const text = toNdjson([{ a: 1 }, { b: "line\nbreak" }]);
    expect(text).toBe('{"a":1}\n{"b":"line\\nbreak"}\n');
    expect(
      text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual([{ a: 1 }, { b: "line\nbreak" }]);
  });
});
