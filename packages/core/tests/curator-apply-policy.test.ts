// The ONE curator apply rule (rethink D13, spec §5.3, amended by ADR 0014) — the
// single decision function both consumers (intake apply + grooming apply) route
// through:
//
//   - noop never mutates anything → skip;
//   - every other operation — archive and split included — applies at
//     confidence ≥ threshold, else proposes. No operation type is exempt.
//
// The full matrix is pinned here: every operation type × confidence
// below/at/above the threshold.

import {
  APPLY_CONFIDENCE_THRESHOLD_KEY,
  type ApplyDecision,
  type CuratorOperationType,
  DEFAULT_APPLY_CONFIDENCE_THRESHOLD,
  decideApplication,
  readApplyConfidenceThreshold,
  writeApplyConfidenceThreshold,
} from "@librarian/core";
import { describe, expect, it } from "vitest";

const OPERATIONS: CuratorOperationType[] = [
  "create",
  "update",
  "merge",
  "split",
  "archive",
  "noop",
];
const THRESHOLD = 0.8;
const BANDS = [
  { label: "below", confidence: 0.79 },
  { label: "at", confidence: 0.8 },
  { label: "above", confidence: 0.95 },
] as const;

// The expected verdict, restated from ADR 0014 (NOT derived from the
// implementation): noop is inert; everything else gates on the threshold.
function expected(operation: CuratorOperationType, confidence: number): ApplyDecision {
  if (operation === "noop") return "skip";
  return confidence >= THRESHOLD ? "apply" : "propose";
}

describe("decideApplication — the D13 matrix (op × confidence band)", () => {
  for (const operation of OPERATIONS) {
    for (const band of BANDS) {
      const want = expected(operation, band.confidence);
      it(`${operation} / confidence ${band.label} threshold → ${want}`, () => {
        expect(
          decideApplication({ operation, confidence: band.confidence, threshold: THRESHOLD }),
        ).toBe(want);
      });
    }
  }

  it("a zero threshold applies every archive and split, whatever the confidence (ADR 0014)", () => {
    for (const operation of ["archive", "split"] as const) {
      expect(decideApplication({ operation, confidence: 0, threshold: 0 })).toBe("apply");
    }
  });

  it("a confident archive or split still proposes when the threshold is above it", () => {
    for (const operation of ["archive", "split"] as const) {
      expect(decideApplication({ operation, confidence: 0.99, threshold: 1 })).toBe("propose");
    }
  });

  it("noop skips even at a zero threshold", () => {
    expect(decideApplication({ operation: "noop", confidence: 1, threshold: 0 })).toBe("skip");
  });
});

// ── The single settings knob: curator.apply.confidence_threshold ────────────

function fakeSettings(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getSetting: (key: string) => map.get(key) ?? null,
    listSettings: () => [],
    setSetting: (key: string, value: string) => void map.set(key, value),
    deleteSetting: (key: string) => void map.delete(key),
    map,
  };
}

describe("curator.apply.confidence_threshold — the single knob", () => {
  it("defaults to 0.8 (spec §15.3) when nothing is set", () => {
    expect(readApplyConfidenceThreshold(fakeSettings())).toBe(0.8);
    expect(DEFAULT_APPLY_CONFIDENCE_THRESHOLD).toBe(0.8);
  });

  it("reads the new shared key when set", () => {
    const store = fakeSettings({ [APPLY_CONFIDENCE_THRESHOLD_KEY]: "0.92" });
    expect(readApplyConfidenceThreshold(store)).toBe(0.92);
  });

  // Spec §15.3 behaviour reset (owner-confirmed): the pre-rethink grooming /
  // umbrella threshold keys are NOT migrated-on-read any more — an instance
  // carrying only legacy keys resets to the 0.8 default. T26's migrate-data-dir
  // reports the stale keys; the v1.0.0-rc.1 CHANGELOG calls the reset out.
  it("ignores the legacy threshold keys — only curator.apply.confidence_threshold is read (spec §15.3 reset)", () => {
    const store = fakeSettings({
      "curator.grooming.auto_apply_confidence": "0.7",
      "curator.auto_apply_confidence": "0.65",
    });
    expect(readApplyConfidenceThreshold(store)).toBe(0.8);
  });

  it("a corrupt or out-of-range stored value falls back to the 0.8 default", () => {
    expect(
      readApplyConfidenceThreshold(fakeSettings({ [APPLY_CONFIDENCE_THRESHOLD_KEY]: "nope" })),
    ).toBe(0.8);
    expect(
      readApplyConfidenceThreshold(fakeSettings({ [APPLY_CONFIDENCE_THRESHOLD_KEY]: "1.5" })),
    ).toBe(0.8);
    expect(
      readApplyConfidenceThreshold(fakeSettings({ [APPLY_CONFIDENCE_THRESHOLD_KEY]: "-1" })),
    ).toBe(0.8);
  });

  it("writeApplyConfidenceThreshold persists a valid value and rejects out-of-range with a teaching error", () => {
    const store = fakeSettings();
    writeApplyConfidenceThreshold(store, 0.75);
    expect(store.map.get(APPLY_CONFIDENCE_THRESHOLD_KEY)).toBe("0.75");
    expect(() => writeApplyConfidenceThreshold(store, 1.2)).toThrow(/between 0 and 1/);
    expect(() => writeApplyConfidenceThreshold(store, Number.NaN)).toThrow(/between 0 and 1/);
  });
});
