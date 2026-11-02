// The capture gate (isCaptureEnabled): conversations are captured while curator
// intake OR the journal is on, and the journal no longer depends on intake.

import { describe, expect, it } from "vitest";
import {
  INTAKE_ENABLED_KEY,
  JOURNAL_ENABLED_KEY,
  isCaptureEnabled,
  isJournalActive,
} from "@librarian/core";

function store(settings: Record<string, string>) {
  return { getSetting: (key: string) => settings[key] ?? null };
}

describe("isCaptureEnabled", () => {
  it.each([
    [false, false, false],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ])("intake=%s journal=%s → capture %s", (intake, journal, expected) => {
    const s = store({
      [INTAKE_ENABLED_KEY]: String(intake),
      [JOURNAL_ENABLED_KEY]: String(journal),
    });
    expect(isCaptureEnabled(s as never)).toBe(expected);
  });

  it("reads a settings failure as off", () => {
    const broken = {
      getSetting: () => {
        throw new Error("db locked");
      },
    };
    expect(isCaptureEnabled(broken as never)).toBe(false);
  });
});

describe("isJournalActive", () => {
  it("follows only the journal's own switch, whatever intake is", () => {
    expect(isJournalActive(store({ [JOURNAL_ENABLED_KEY]: "true" }) as never)).toBe(true);
    expect(
      isJournalActive(
        store({ [JOURNAL_ENABLED_KEY]: "true", [INTAKE_ENABLED_KEY]: "false" }) as never,
      ),
    ).toBe(true);
    expect(isJournalActive(store({ [INTAKE_ENABLED_KEY]: "true" }) as never)).toBe(false);
  });
});
