// GET /journal.md (spec 077 §4.4, SC4/SC5) and the /healthz `journal` field (§4.7) over a
// spawned server. The journal is seeded through the store BEFORE boot — the spawned
// process opens the same data dir.

import {
  DEFAULT_SHELF,
  INTAKE_ENABLED_KEY,
  JOURNAL_ENABLED_KEY,
  RECENT_WINDOW_HEADER,
  appendEpisode,
  createLibrarianStore,
} from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

function seed(dataDir: string, opts: { journal: boolean; episodes: boolean }): void {
  const store = createLibrarianStore({ dataDir });
  try {
    store.setSetting(INTAKE_ENABLED_KEY, "true");
    store.setSetting(JOURNAL_ENABLED_KEY, opts.journal ? "true" : "false");
    if (opts.episodes) {
      appendEpisode(store.systemJournal(DEFAULT_SHELF), "2026-11-02", {
        key: "conv#s1",
        time: "10:00–11:00",
        harness: "claude",
        project: "the-librarian",
        bullets: ["Decided to add a journal."],
      });
    }
  } finally {
    store.close();
  }
}

const AGENT = { authorization: "Bearer agent-token" };

describe("GET /journal.md", () => {
  it("serves the recent window to an authenticated agent, without structural comments", async () => {
    const dataDir = makeTempDir();
    seed(dataDir, { journal: true, episodes: true });
    const server = await startHttpServer({ dataDir });
    try {
      const res = await fetch(`${server.url}/journal.md`, { headers: AGENT });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/markdown");
      expect(res.headers.get("cache-control")).toBe("no-store");
      const text = await res.text();
      expect(text.startsWith(RECENT_WINDOW_HEADER)).toBe(true);
      expect(text).toContain("## 2026-11-02 10:00–11:00 · claude · the-librarian");
      expect(text).toContain("- Decided to add a journal.");
      expect(text).not.toContain("<!--");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("refuses an unauthenticated caller, and anything but GET", async () => {
    const dataDir = makeTempDir();
    seed(dataDir, { journal: true, episodes: true });
    const server = await startHttpServer({ dataDir });
    try {
      expect((await fetch(`${server.url}/journal.md`)).status).toBe(401);
      const post = await fetch(`${server.url}/journal.md`, { method: "POST", headers: AGENT });
      expect(post.status).toBe(405);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("explains a 404 when the journal is off, and when it is on but still empty", async () => {
    const offDir = makeTempDir();
    seed(offDir, { journal: false, episodes: true });
    const off = await startHttpServer({ dataDir: offDir });
    try {
      const res = await fetch(`${off.url}/journal.md`, { headers: AGENT });
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("The journal is turned off on this server");
    } finally {
      await off.stop();
      cleanupTempDir(offDir);
    }

    const emptyDir = makeTempDir();
    seed(emptyDir, { journal: true, episodes: false });
    const empty = await startHttpServer({ dataDir: emptyDir });
    try {
      const res = await fetch(`${empty.url}/journal.md`, { headers: AGENT });
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("No journal entries yet");
    } finally {
      await empty.stop();
      cleanupTempDir(emptyDir);
    }
  });
});

describe("GET /healthz — journal field", () => {
  it("reports the journal gate, so adapters know the server accepts `project`", async () => {
    const dataDir = makeTempDir();
    seed(dataDir, { journal: true, episodes: false });
    const server = await startHttpServer({ dataDir });
    try {
      const body = (await (await fetch(`${server.url}/healthz`)).json()) as Record<string, unknown>;
      expect(body.journal).toBe("enabled");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("reports disabled on a fresh server", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const body = (await (await fetch(`${server.url}/healthz`)).json()) as Record<string, unknown>;
      expect(body.journal).toBe("disabled");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
