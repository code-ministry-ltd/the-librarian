// The read log (spec 080): an opt-in, bounded NDJSON record of what agents read.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  READ_LOG_ENABLED_KEY,
  READ_LOG_FILE,
  ReadRecordSchema,
  createLibrarianStore,
} from "@librarian/core";
import { buildReadRecord, createReadLog } from "@librarian/core/store-internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-read-log-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const recallRead = {
  kind: "recall",
  mode: "search",
  query: "marvin gpu uuid",
  returnedIds: ["mem_a", "mem_b"],
  returnedCount: 2,
  excerpts: true,
  resultChars: 420,
  actorId: "claude-code",
} as const;

describe("read log switch", () => {
  it("follows the dashboard setting at once, with no restart", async () => {
    const store = createLibrarianStore({ dataDir, readLog: { armed: true } });
    try {
      expect(store.readLogActive).toBe(false);
      store.setSetting(READ_LOG_ENABLED_KEY, "true");
      expect(store.readLogActive).toBe(true);
      await store.recordRead(recallRead);
      store.setSetting(READ_LOG_ENABLED_KEY, "false");
      expect(store.readLogActive).toBe(false);
      await store.recordRead(recallRead);
      store.setSetting(READ_LOG_ENABLED_KEY, "true");
      store.deleteSetting(READ_LOG_ENABLED_KEY);
      expect(store.readLogActive).toBe(false);
      expect((await store.readReads()).total).toBe(1);
    } finally {
      store.close();
    }
  });

  it("writes nothing and creates no file when armed but switched off", async () => {
    const store = createLibrarianStore({ dataDir, readLog: { armed: true } });
    try {
      expect(store.readLogActive).toBe(false);
      await store.recordRead(recallRead);
      await store.flushReads();
      expect(fs.existsSync(path.join(dataDir, READ_LOG_FILE))).toBe(false);
    } finally {
      store.close();
    }
  });

  it("writes nothing from an unarmed store even when switched on", async () => {
    const store = createLibrarianStore({ dataDir });
    try {
      store.setSetting(READ_LOG_ENABLED_KEY, "true");
      expect(store.readLogActive).toBe(false);
      await store.recordRead(recallRead);
      expect(fs.existsSync(path.join(dataDir, READ_LOG_FILE))).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe("read log rows", () => {
  it("round-trips every kind newest-first, with 0600 permissions", async () => {
    const store = createLibrarianStore({ dataDir, readLog: { armed: true } });
    try {
      store.setSetting(READ_LOG_ENABLED_KEY, "true");
      expect(store.readLogActive).toBe(true);
      await store.recordRead(recallRead);
      await store.recordRead({
        kind: "search_references",
        query: "deploy",
        returnedPaths: ["references/deploy.md"],
        returnedCount: 1,
        resultChars: 90,
      });
      await store.recordRead({ kind: "primer", resultChars: 3000, primerHash: "0123456789ab" });
      await store.recordRead({ kind: "journal", resultChars: 8000, maxChars: 9500 });
      const { rows, total } = await store.readReads();
      expect(total).toBe(4);
      expect(rows.map((row) => row.kind)).toEqual([
        "journal",
        "primer",
        "search_references",
        "recall",
      ]);
      expect(rows[3]).toMatchObject({ v: 1, ...recallRead });
      expect((await store.readReads({ kind: "primer" })).rows).toHaveLength(1);
      const exported = await store.exportReads();
      expect(exported.map((row) => row.kind)).toEqual([
        "recall",
        "search_references",
        "primer",
        "journal",
      ]);
      const mode = fs.statSync(path.join(dataDir, READ_LOG_FILE)).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      store.close();
    }
  });

  it("redacts secret-shaped text, strips control characters and caps long queries", () => {
    const secret = ["super", "secret", "value", "123"].join("-");
    const keyword = "password";
    const row = buildReadRecord(
      {
        ...recallRead,
        query: `why does ${keyword} = "${secret}" fail\u0007 ${"x".repeat(2_000)}`,
      },
      "2026-11-03T12:00:00.000Z",
    );
    expect(row).toBeDefined();
    if (row?.kind !== "recall") throw new Error("expected a recall row");
    expect(row.query).not.toContain(secret);
    expect(row.query).not.toContain("\u0007");
    expect(row.query?.length).toBe(1_000);
    expect(ReadRecordSchema.safeParse(row).success).toBe(true);
  });

  it("rejects unknown fields rather than writing them", () => {
    const parsed = ReadRecordSchema.safeParse({
      v: 1,
      ts: "2026-11-03T12:00:00.000Z",
      ...recallRead,
      body: "memory text must never be logged",
    });
    expect(parsed.success).toBe(false);
  });

  it("rotates at the size bound and keeps exactly one previous generation", async () => {
    const filePath = path.join(dataDir, READ_LOG_FILE);
    const log = createReadLog({ filePath, armed: true, enabled: true, maxBytes: 600 });
    for (let i = 0; i < 12; i += 1) await log.record({ ...recallRead, query: `query ${i}` });
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.existsSync(`${filePath}.1`)).toBe(true);
    expect(fs.existsSync(`${filePath}.2`)).toBe(false);
    expect(fs.statSync(filePath).size).toBeLessThanOrEqual(600);
    const { rows } = await log.read();
    expect(rows[0]).toMatchObject({ query: "query 11" });
  });

  it("always resolves when the disk write fails, and reports the first error once", async () => {
    const blocker = path.join(dataDir, "not-a-dir");
    fs.writeFileSync(blocker, "");
    const onError = vi.fn();
    const log = createReadLog({
      filePath: path.join(blocker, READ_LOG_FILE),
      armed: true,
      enabled: true,
      onError,
    });
    await expect(log.record(recallRead)).resolves.toBeUndefined();
    await expect(log.record(recallRead)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
