// The read log over HTTP (spec 080): a served journal window appends one `journal` row when the
// server runs with the dashboard's read-log switch on, and nothing when it is off.

import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_SHELF,
  INTAKE_ENABLED_KEY,
  JOURNAL_ENABLED_KEY,
  READ_LOG_ENABLED_KEY,
  READ_LOG_FILE,
  appendEpisode,
  createLibrarianStore,
} from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

const AGENT = { authorization: "Bearer agent-token" };
function seed(dataDir: string, readLog: boolean): void {
  const store = createLibrarianStore({ dataDir });
  try {
    store.setSetting(READ_LOG_ENABLED_KEY, readLog ? "true" : "false");
    store.setSetting(INTAKE_ENABLED_KEY, "true");
    store.setSetting(JOURNAL_ENABLED_KEY, "true");
    appendEpisode(store.systemJournal(DEFAULT_SHELF), "2026-11-03", {
      key: "conv#s1",
      time: "10:00–11:00",
      harness: "claude",
      project: "the-librarian",
      bullets: ["Added the read log."],
    });
  } finally {
    store.close();
  }
}

function readRows(dataDir: string): Record<string, unknown>[] {
  const file = path.join(dataDir, READ_LOG_FILE);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The append is fire-and-forget in a spawned server; wait for the row, generously under load. */
async function waitForJournalRows(dataDir: string): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = readRows(dataDir).filter((row) => row.kind === "journal");
    if (rows.length > 0 || Date.now() > deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("read log: GET /journal.md", () => {
  it("appends a journal row with the served size and requested cap when the log is on", async () => {
    const dataDir = makeTempDir();
    seed(dataDir, true);
    const server = await startHttpServer({ dataDir });
    try {
      const res = await fetch(`${server.url}/journal.md?max_chars=9500`, { headers: AGENT });
      expect(res.status).toBe(200);
      const text = await res.text();
      const rows = await waitForJournalRows(dataDir);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ v: 1, resultChars: text.length, maxChars: 9500 });
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("writes no file when the log is off", async () => {
    const dataDir = makeTempDir();
    seed(dataDir, false);
    const server = await startHttpServer({ dataDir });
    try {
      expect((await fetch(`${server.url}/journal.md`, { headers: AGENT })).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fs.existsSync(path.join(dataDir, READ_LOG_FILE))).toBe(false);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
