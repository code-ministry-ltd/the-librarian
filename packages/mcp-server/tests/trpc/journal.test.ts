// Journal tRPC procedures (spec 077 PR D): the Journal page's structured view, its
// search (the same engine as the `journal` MCP tool), and owner deletes — over the
// real HTTP bin's internal listener.

import { spawnSync } from "node:child_process";
import {
  DEFAULT_SHELF,
  INTAKE_ENABLED_KEY,
  JOURNAL_ENABLED_KEY,
  type JournalSearchHit,
  type JournalViewPeriod,
  appendEpisode,
  createLibrarianStore,
  localDate,
  renderRollup,
  weekPeriod,
} from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

interface ServerHandle {
  url: string;
  token: string;
  trpcUrl: string;
  stop: () => Promise<void>;
}

async function trpcRaw(
  server: ServerHandle,
  proc: string,
  input: unknown,
  method: "GET" | "POST",
): Promise<{ status: number; json: { result?: { data: unknown }; error?: { message?: string } } }> {
  const query = method === "GET" ? `?input=${encodeURIComponent(JSON.stringify(input))}` : "";
  const response = await fetch(`${server.trpcUrl}/trpc/${proc}${query}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
    ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
  });
  return { status: response.status, json: (await response.json()) as never };
}

async function call<T>(
  server: ServerHandle,
  proc: string,
  input: unknown,
  method: "GET" | "POST",
): Promise<T> {
  const { status, json } = await trpcRaw(server, proc, input, method);
  if (status >= 400 || json.error) throw new Error(`${proc}: ${JSON.stringify(json)}`);
  return json.result!.data as T;
}

const today = localDate(new Date());

function seed(dataDir: string): void {
  const store = createLibrarianStore({ dataDir });
  try {
    store.setSetting(INTAKE_ENABLED_KEY, "true");
    store.setSetting(JOURNAL_ENABLED_KEY, "true");
    const files = store.systemJournal(DEFAULT_SHELF);
    appendEpisode(files, today, {
      key: "a#s1",
      time: "09:00",
      harness: "claude",
      project: "alpha",
      bullets: ["Chose BM25 for journal search; <html> stays text."],
    });
    appendEpisode(files, today, {
      key: "b#s1",
      time: "15:00",
      harness: "codex",
      project: "beta",
      bullets: ["Fixed the flaky CI job."],
    });
    files.write(
      "weeks/2026-W30.md",
      renderRollup(weekPeriod("2026-W30"), {
        sources: [],
        body: "- **alpha**: shipped the importer.",
      }),
      "t",
    );
  } finally {
    store.close();
  }
}

function gitSubjects(dataDir: string): string[] {
  return spawnSync("git", ["-C", `${dataDir}/vault`, "log", "--format=%s"], { encoding: "utf8" })
    .stdout.split("\n")
    .filter(Boolean);
}

describe("tRPC journal.entries", () => {
  it("returns every period newest first, entries decoded for display", async () => {
    const dataDir = makeTempDir();
    seed(dataDir);
    const server = await startHttpServer({ dataDir });
    try {
      const view = await call<{ active: boolean; periods: JournalViewPeriod[] }>(
        server,
        "journal.entries",
        undefined,
        "GET",
      );
      expect(view.active).toBe(true);
      expect(view.periods.map((p) => p.path)).toEqual([`days/${today}.md`, "weeks/2026-W30.md"]);
      const [day, week] = view.periods;
      expect(day!.episodes.map((e) => e.key)).toEqual(["a#s1", "b#s1"]);
      expect(day!.episodes[0]!.bullets[0]).toBe(
        "Chose BM25 for journal search; <html> stays text.",
      );
      expect(week!.body).toContain("shipped the importer");
      expect(week!.episodes).toEqual([]);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});

describe("tRPC journal.search — the agents' engine", () => {
  it("ranks matches and honours the same filters as the journal tool", async () => {
    const dataDir = makeTempDir();
    seed(dataDir);
    const server = await startHttpServer({ dataDir });
    try {
      const found = await call<{ hits: JournalSearchHit[] }>(
        server,
        "journal.search",
        { query: "flaky CI" },
        "GET",
      );
      expect(found.hits[0]).toMatchObject({
        episodeKey: "b#s1",
        harness: "codex",
        project: "beta",
      });

      const filtered = await call<{ hits: JournalSearchHit[] }>(
        server,
        "journal.search",
        { query: "importer search", project: "alpha", from: "2026-01-01" },
        "GET",
      );
      const week = filtered.hits.find((h) => h.tier === "week");
      expect(week?.matchedByText).toBe(true);
      expect(filtered.hits.every((h) => h.project === null || h.project === "alpha")).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("returns the tool's teaching message for a bad range", async () => {
    const dataDir = makeTempDir();
    seed(dataDir);
    const server = await startHttpServer({ dataDir });
    try {
      const { status, json } = await trpcRaw(
        server,
        "journal.search",
        { query: "x", from: "2026-13-01" },
        "GET",
      );
      expect(status).toBe(400);
      expect(json.error?.message).toContain("Expected `from` as YYYY-MM-DD, got '2026-13-01'");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});

describe("tRPC journal deletes", () => {
  it("deletes one entry, then a whole period, each as a commit", async () => {
    const dataDir = makeTempDir();
    seed(dataDir);
    const server = await startHttpServer({ dataDir });
    try {
      await call(server, "journal.deleteEpisode", { date: today, key: "a#s1" }, "POST");
      let view = await call<{ periods: JournalViewPeriod[] }>(
        server,
        "journal.entries",
        undefined,
        "GET",
      );
      expect(view.periods[0]!.episodes.map((e) => e.key)).toEqual(["b#s1"]);
      expect(gitSubjects(dataDir)[0]).toBe(`journal: delete days/${today}.md#a#s1`);

      await call(server, "journal.deletePeriod", { path: "weeks/2026-W30.md" }, "POST");
      view = await call<{ periods: JournalViewPeriod[] }>(
        server,
        "journal.entries",
        undefined,
        "GET",
      );
      expect(view.periods.map((p) => p.path)).toEqual([`days/${today}.md`]);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("says plainly when the target is already gone, and refuses a path outside the journal", async () => {
    const dataDir = makeTempDir();
    seed(dataDir);
    const server = await startHttpServer({ dataDir });
    try {
      const gone = await trpcRaw(
        server,
        "journal.deleteEpisode",
        { date: today, key: "zz#s9" },
        "POST",
      );
      expect(gone.status).toBe(404);
      expect(gone.json.error?.message).toContain("it may already be deleted");
      const escape = await trpcRaw(
        server,
        "journal.deletePeriod",
        { path: "../memories/x.md" },
        "POST",
      );
      expect(escape.status).toBe(400);
      expect(escape.json.error?.message).toContain(
        "Expected a journal path like days/2026-11-02.md",
      );
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
