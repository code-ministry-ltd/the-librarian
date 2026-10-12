// Grooming (job 2) configuration (memory-curator spec §7.1) over the settings store.
//
// Operator-managed NON-LLM config: enable flag, the shared D13 apply-confidence
// knob, schedule.
// The prompt addendum left this config in spec 044 D-1 (it's a committed vault
// file now; see curator-addendum.test.ts). The LLM connection no longer lives
// here either — providers are
// named + dashboard-managed and each consumer picks its own (see
// curator-consumers.test.ts). `readGroomingConfig` reads plain settings only, so
// it always works without the master key. (The intake job's config is tested in
// intake-config.test.ts.)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  createLibrarianStore,
  findLegacyScheduleKeys,
  migrateGroomingSchedule,
  readGroomingConfig,
  writeGroomingConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Scope {
  store: LibrarianStore;
  dataDir: string;
}

function open(dataDir: string): LibrarianStore {
  return createLibrarianStore({ dataDir });
}

function scope(): Scope {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-curator-cfg-"));
  return { store: open(dataDir), dataDir };
}

function teardown(s: Scope | null): void {
  if (!s) return;
  try {
    s.store.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(s.dataDir, { recursive: true, force: true });
}

describe("curator config", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  it("returns safe defaults when nothing is configured", () => {
    const cfg = readGroomingConfig(s!.store);
    expect(cfg.enabled).toBe(false);
    // The single D13 knob ships at 0.8 (spec §15.3).
    expect(cfg.applyConfidenceThreshold).toBeCloseTo(0.8);
    // Post-intake trigger defaults (spec 043 D-A): a 20-op threshold + a 60-min
    // debounce floor (the repurposed interval default).
    expect(cfg.triggerThreshold).toBe(20);
    expect(cfg.debounceMinutes).toBe(60);
    // Bounded grooming runs (ADR 0005): default cap preserves prior behaviour.
    expect(cfg.maxMemoriesPerRun).toBe(200);
  });

  it("round-trips max_memories and rejects out-of-range values (ADR 0005)", () => {
    const { store } = s!;
    writeGroomingConfig(store, { maxMemoriesPerRun: 40 });
    expect(readGroomingConfig(store).maxMemoriesPerRun).toBe(40);
    expect(() => writeGroomingConfig(store, { maxMemoriesPerRun: 0 })).toThrow(/max_memories/i);
    expect(() => writeGroomingConfig(store, { maxMemoriesPerRun: -1 })).toThrow(/max_memories/i);
    expect(() => writeGroomingConfig(store, { maxMemoriesPerRun: 2.5 })).toThrow(/max_memories/i);
    expect(() => writeGroomingConfig(store, { maxMemoriesPerRun: 100000 })).toThrow(
      /max_memories/i,
    );
  });

  it("defaults repair on with 3 splits and 5 recoveries per run (spec 075 §5)", () => {
    const cfg = readGroomingConfig(s!.store);
    expect(cfg.repairEnabled).toBe(true);
    expect(cfg.repairSplitPerRun).toBe(3);
    expect(cfg.repairRecoverPerRun).toBe(5);
  });

  it("round-trips the repair settings and rejects out-of-range counts", () => {
    const { store } = s!;
    writeGroomingConfig(store, {
      repairEnabled: false,
      repairSplitPerRun: 0,
      repairRecoverPerRun: 50,
    });
    expect(readGroomingConfig(store)).toMatchObject({
      repairEnabled: false,
      repairSplitPerRun: 0,
      repairRecoverPerRun: 50,
    });
    expect(() => writeGroomingConfig(store, { repairSplitPerRun: 21 })).toThrow(
      /repair_split_per_run/,
    );
    expect(() => writeGroomingConfig(store, { repairSplitPerRun: 1.5 })).toThrow(
      /repair_split_per_run/,
    );
    expect(() => writeGroomingConfig(store, { repairRecoverPerRun: -1 })).toThrow(
      /repair_recover_per_run/,
    );
  });

  it("round-trips trigger_threshold and rejects invalid values (≥ 1 integer)", () => {
    const { store } = s!;
    writeGroomingConfig(store, { triggerThreshold: 5 });
    expect(readGroomingConfig(store).triggerThreshold).toBe(5);
    expect(() => writeGroomingConfig(store, { triggerThreshold: 0 })).toThrow(/threshold/i);
    expect(() => writeGroomingConfig(store, { triggerThreshold: -1 })).toThrow(/threshold/i);
    expect(() => writeGroomingConfig(store, { triggerThreshold: 2.5 })).toThrow(/threshold/i);
  });

  it("round-trips debounce_minutes and clamps invalid values (1..one week)", () => {
    const { store } = s!;
    writeGroomingConfig(store, { debounceMinutes: 30 });
    expect(readGroomingConfig(store).debounceMinutes).toBe(30);
    expect(() => writeGroomingConfig(store, { debounceMinutes: 0 })).toThrow(/debounce/i);
    expect(() => writeGroomingConfig(store, { debounceMinutes: 10 * 24 * 60 })).toThrow(
      /debounce/i,
    );
    expect(() => writeGroomingConfig(store, { debounceMinutes: 1.5 })).toThrow(/debounce/i);
  });

  it("round-trips the non-LLM curator config", () => {
    const { store } = s!;
    writeGroomingConfig(store, {
      enabled: true,
      applyConfidenceThreshold: 0.75,
    });
    const cfg = readGroomingConfig(store);
    expect(cfg.enabled).toBe(true);
    expect(cfg.applyConfidenceThreshold).toBeCloseTo(0.75);
  });

  it("reads the config WITHOUT the master key (cockpit render path)", () => {
    const { store, dataDir } = s!;
    writeGroomingConfig(store, { enabled: true });
    store.close();
    const noKey = open(dataDir);
    s!.store = noKey;
    const cfg = readGroomingConfig(noKey); // plain settings only — must not need the key
    expect(cfg.enabled).toBe(true);
  });

  it("findLegacyScheduleKeys reports each legacy schedule key still in settings", () => {
    const { store } = s!;
    expect(findLegacyScheduleKeys(store)).toEqual([]);
    store.setSetting("curator.schedule.interval_days", "1");
    store.setSetting("curator.schedule.time", "03:00");
    store.setSetting("curator.schedule.min_sessions_since_run", "10");
    expect(findLegacyScheduleKeys(store)).toEqual([
      "curator.schedule.interval_days",
      "curator.schedule.time",
      "curator.schedule.min_sessions_since_run",
    ]);
  });

  it("validates the apply-confidence threshold bounds", () => {
    const { store } = s!;
    expect(() => writeGroomingConfig(store, { applyConfidenceThreshold: 1.5 })).toThrow(
      /confidence/i,
    );
    expect(() => writeGroomingConfig(store, { applyConfidenceThreshold: -0.1 })).toThrow(
      /confidence/i,
    );
  });

  // ── Grooming schedule pair (spec 045 D-3): every N days at HH:MM ─────────────

  it("defaults the grooming schedule to every 1 day at 03:00 (nightly)", () => {
    const cfg = readGroomingConfig(s!.store);
    expect(cfg.intervalDays).toBe(1);
    expect(cfg.scheduleTime).toBe("03:00");
  });

  it("round-trips interval_days and rejects non-positive / non-integer values", () => {
    const { store } = s!;
    writeGroomingConfig(store, { intervalDays: 7 }); // weekly
    expect(readGroomingConfig(store).intervalDays).toBe(7);
    expect(() => writeGroomingConfig(store, { intervalDays: 0 })).toThrow(/interval_days/i);
    expect(() => writeGroomingConfig(store, { intervalDays: -1 })).toThrow(/interval_days/i);
    expect(() => writeGroomingConfig(store, { intervalDays: 2.5 })).toThrow(/interval_days/i);
  });

  it("round-trips schedule_time and rejects values that are not HH:MM (00:00–23:59)", () => {
    const { store } = s!;
    writeGroomingConfig(store, { scheduleTime: "23:30" });
    expect(readGroomingConfig(store).scheduleTime).toBe("23:30");
    writeGroomingConfig(store, { scheduleTime: "00:00" });
    expect(readGroomingConfig(store).scheduleTime).toBe("00:00");
    expect(() => writeGroomingConfig(store, { scheduleTime: "24:00" })).toThrow(/schedule_time/i);
    expect(() => writeGroomingConfig(store, { scheduleTime: "3:00" })).toThrow(/schedule_time/i);
    expect(() => writeGroomingConfig(store, { scheduleTime: "03:60" })).toThrow(/schedule_time/i);
    expect(() => writeGroomingConfig(store, { scheduleTime: "0300" })).toThrow(/schedule_time/i);
    expect(() => writeGroomingConfig(store, { scheduleTime: "noon" })).toThrow(/schedule_time/i);
  });

  // ── The shared D13 knob (curator.apply.confidence_threshold) ─────────────────

  it("reads ONLY the shared apply key — legacy threshold keys are ignored (spec §15.3 reset)", () => {
    const { store } = s!;
    // The pre-rethink grooming-namespace threshold is deliberately NOT migrated:
    // shipping 0.8 regardless of the prior setting is the owner-confirmed
    // behaviour reset (T26's migrate-data-dir reports the stale key).
    store.setSetting("curator.grooming.auto_apply_confidence", "0.75");
    expect(readGroomingConfig(store).applyConfidenceThreshold).toBeCloseTo(0.8);
    // The shared key is the one knob.
    store.setSetting("curator.apply.confidence_threshold", "0.85");
    expect(readGroomingConfig(store).applyConfidenceThreshold).toBeCloseTo(0.85);
  });

  it("writeGroomingConfig persists the threshold into the SHARED curator.apply key", () => {
    const { store } = s!;
    writeGroomingConfig(store, { applyConfidenceThreshold: 0.8 });
    expect(store.getSetting("curator.apply.confidence_threshold")).toBe("0.8");
    // The retired grooming-namespace policy keys are never written anymore.
    expect(store.getSetting("curator.grooming.default_auto_apply")).toBeNull();
    expect(store.getSetting("curator.grooming.auto_apply_confidence")).toBeNull();
  });

  it("the per-slice interval gate is retired — GroomingConfig has no intervalMinutes (plan 046 T4)", () => {
    const { store } = s!;
    // A legacy curator.interval_minutes value no longer influences the grooming
    // config at all (the per-slice interval gate is gone; idempotency is the sole
    // gate now, spec 045 D-3a). The field no longer exists on the read config.
    store.setSetting("curator.interval_minutes", "15");
    const cfg = readGroomingConfig(store);
    expect((cfg as Record<string, unknown>).intervalMinutes).toBeUndefined();
    // The legacy key is still read by migrateJobEnablement as the debounce
    // seed (see curator-enablement.test.ts) — that migration is intentionally kept.
  });
});

// ── Seed-once / no-clobber migration of the grooming schedule + moved keys ─────
// Mirrors migrateJobEnablement: read old, seed new only when unset, never
// clobber, idempotent on re-run.
describe("migrateGroomingSchedule (spec 045 D-8)", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  it("maps the legacy schedule keys 1:1 into the grooming namespace", () => {
    const { store } = s!;
    store.setSetting("curator.schedule.time", "04:15");
    store.setSetting("curator.schedule.interval_days", "7");

    migrateGroomingSchedule(store);

    expect(store.getSetting("curator.grooming.schedule_time")).toBe("04:15");
    expect(store.getSetting("curator.grooming.interval_days")).toBe("7");
    // The retired auto-apply LEVEL keys are NOT migrated (D13 deleted the levels).
    expect(store.getSetting("curator.grooming.default_auto_apply")).toBeNull();

    const cfg = readGroomingConfig(store);
    expect(cfg.scheduleTime).toBe("04:15");
    expect(cfg.intervalDays).toBe(7);
  });

  it("never clobbers an explicit grooming value already set", () => {
    const { store } = s!;
    store.setSetting("curator.grooming.interval_days", "3"); // user-set
    store.setSetting("curator.grooming.schedule_time", "06:00"); // user-set
    // Legacy keys say something different — must be ignored.
    store.setSetting("curator.schedule.interval_days", "7");
    store.setSetting("curator.schedule.time", "04:15");

    migrateGroomingSchedule(store);

    expect(store.getSetting("curator.grooming.interval_days")).toBe("3");
    expect(store.getSetting("curator.grooming.schedule_time")).toBe("06:00");
  });

  it("is idempotent: re-running yields the same settings (no drift)", () => {
    const { store } = s!;
    store.setSetting("curator.schedule.time", "04:15");
    store.setSetting("curator.schedule.interval_days", "7");

    migrateGroomingSchedule(store);
    const after1 = {
      time: store.getSetting("curator.grooming.schedule_time"),
      days: store.getSetting("curator.grooming.interval_days"),
    };
    migrateGroomingSchedule(store);
    const after2 = {
      time: store.getSetting("curator.grooming.schedule_time"),
      days: store.getSetting("curator.grooming.interval_days"),
    };

    expect(after2).toEqual(after1);
    expect(after2).toEqual({ time: "04:15", days: "7" });
  });

  it("leaves the new keys unset on a fresh install (no legacy sources) → defaults", () => {
    const { store } = s!;
    migrateGroomingSchedule(store);
    expect(store.getSetting("curator.grooming.interval_days")).toBeNull();
    expect(store.getSetting("curator.grooming.schedule_time")).toBeNull();
    const cfg = readGroomingConfig(store);
    expect(cfg.intervalDays).toBe(1);
    expect(cfg.scheduleTime).toBe("03:00");
    expect(cfg.applyConfidenceThreshold).toBeCloseTo(0.8);
  });
});
