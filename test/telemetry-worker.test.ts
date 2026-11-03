// The usage-stats receiver (services/telemetry-worker, spec 085): it accepts exactly what the
// server sends and nothing else, and stores one row per install per week.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLibrarianStore } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { buildPayload } from "../packages/mcp-server/dist/telemetry.js";
import { isoWeek, parsePing, toRow } from "../services/telemetry-worker/src/ping.js";

const valid = {
  schema: 1,
  installId: "0f8f2a4e-1111-4222-8333-944455556666",
  version: "1.49.0",
  os: "linux",
  arch: "x64",
  runtime: "docker",
  harnesses: ["claude", "codex"],
  memories: "<1k",
  features: { capture: true, intake: true, grooming: false },
};

describe("parsePing", () => {
  it("accepts what a real server builds (the contract)", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-tw-"));
    const store = createLibrarianStore({ dataDir });
    try {
      expect(parsePing(JSON.parse(JSON.stringify(buildPayload(store))))).not.toBeNull();
    } finally {
      store.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("accepts a valid ping", () => {
    expect(parsePing(valid)).toEqual(valid);
  });

  it.each([
    ["an extra field", { ...valid, hostname: "box" }],
    ["a missing field", { ...valid, os: undefined }],
    ["a non-UUID id", { ...valid, installId: "jim" }],
    ["free text in os", { ...valid, os: "Jim's MacBook" }],
    ["an unknown harness", { ...valid, harnesses: ["claude", "secret-bot"] }],
    ["a duplicate harness", { ...valid, harnesses: ["claude", "claude"] }],
    ["an exact count", { ...valid, memories: 523 }],
    ["an extra feature", { ...valid, features: { ...valid.features, journal: true } }],
    ["a wrong schema", { ...valid, schema: 2 }],
    ["an array", [valid]],
  ])("rejects %s", (_label, raw) => {
    expect(parsePing(raw)).toBeNull();
  });
});

describe("storage", () => {
  it("keys rows by install and ISO week, with nothing about the request", () => {
    const row = toRow(parsePing(valid)!, new Date("2026-11-04T12:00:00Z"));
    expect(row).toEqual({
      install_id: valid.installId,
      week: "2026-W45",
      version: "1.49.0",
      os: "linux",
      arch: "x64",
      runtime: "docker",
      harnesses: "claude,codex",
      memories: "<1k",
      capture: 1,
      intake: 1,
      grooming: 0,
    });
  });

  it.each([
    ["2026-01-01T00:00:00Z", "2026-W01"],
    ["2027-01-01T00:00:00Z", "2026-W53"],
    ["2024-12-30T00:00:00Z", "2025-W01"],
  ])("isoWeek(%s) = %s", (iso, week) => {
    expect(isoWeek(new Date(iso))).toBe(week);
  });
});
