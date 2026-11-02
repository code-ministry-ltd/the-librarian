// `librarian import`'s server side (spec 079 §5) over a spawned server: the policy, the
// text-free batch plan, and POST /import writing a settled buffer whose harness marker
// carries the step plan the server agreed to.

import fs from "node:fs";
import path from "node:path";
import {
  IMPORT_JOURNAL_CUTOFF_KEY,
  INTAKE_ENABLED_KEY,
  JOURNAL_ENABLED_KEY,
  createLibrarianStore,
  endedMarkerPath,
  transcriptBufferPath,
  transcriptHarnessMarkerPath,
} from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

const AGENT = { authorization: "Bearer agent-token", "content-type": "application/json" };
const DAY = 86_400_000;
const ago = (days: number): string => new Date(Date.now() - days * DAY).toISOString();

function seed(dataDir: string, settings: Record<string, string>): void {
  const store = createLibrarianStore({ dataDir });
  try {
    for (const [k, v] of Object.entries(settings)) store.setSetting(k, v);
  } finally {
    store.close();
  }
}

function conversation(conv_id: string, endedDaysAgo: number) {
  const ended = ago(endedDaysAgo);
  return {
    conv_id,
    harness: "claude",
    project: "the-librarian",
    ended_at: ended,
    turns: [
      { role: "user", text: "Should we keep raw transcripts?", ts: ended },
      { role: "assistant", text: "No — privacy first.", ts: ended },
      { role: "user", text: "[librarian:private=on] secret plan", ts: ended },
    ],
  };
}

describe("GET /import/policy", () => {
  it("tells an agent which steps are on, the cutoffs and the limits", async () => {
    const dataDir = makeTempDir();
    seed(dataDir, { [INTAKE_ENABLED_KEY]: "true", [JOURNAL_ENABLED_KEY]: "false" });
    const server = await startHttpServer({ dataDir });
    try {
      const res = await fetch(`${server.url}/import/policy`, { headers: AGENT });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        intake: "enabled",
        journal: "disabled",
        memoriesCutoff: null,
        maxAgeDays: 90,
        allowanceRemaining: 200,
      });
      const anon = await fetch(`${server.url}/import/policy`);
      expect(anon.status).toBe(401);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});

describe("POST /import/plan", () => {
  it("previews each conversation without any text, with a reason for every skip", async () => {
    const dataDir = makeTempDir();
    seed(dataDir, {
      [INTAKE_ENABLED_KEY]: "true",
      [JOURNAL_ENABLED_KEY]: "true",
      [IMPORT_JOURNAL_CUTOFF_KEY]: ago(20),
    });
    const server = await startHttpServer({ dataDir });
    try {
      const res = await fetch(`${server.url}/import/plan`, {
        method: "POST",
        headers: AGENT,
        body: JSON.stringify({
          conversations: [
            { conv_id: "old", harness: "claude", ended_at: ago(30) },
            { conv_id: "mid", harness: "claude", ended_at: ago(10) },
          ],
        }),
      });
      const body = (await res.json()) as { plans: Record<string, string>[] };
      expect(body.plans[0]).toMatchObject({
        conv_id: "old",
        memories: "queued",
        journal: "queued",
      });
      expect(body.plans[1]?.memories).toBe("queued");
      expect(body.plans[1]?.journal).toMatch(/after the journal cutoff/);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("teaches on a malformed request", async () => {
    const dataDir = makeTempDir();
    seed(dataDir, { [INTAKE_ENABLED_KEY]: "true" });
    const server = await startHttpServer({ dataDir });
    try {
      const res = await fetch(`${server.url}/import/plan`, {
        method: "POST",
        headers: AGENT,
        body: JSON.stringify({
          conversations: [{ conv_id: "x", harness: "Claude Code", ended_at: "yesterday" }],
        }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(
        'Malformed import plan request at "conversations.0.harness"',
      );
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});

describe("POST /import", () => {
  it("queues an eligible conversation as a settled buffer carrying its step plan, minus private turns", async () => {
    const dataDir = makeTempDir();
    seed(dataDir, {
      [INTAKE_ENABLED_KEY]: "true",
      [JOURNAL_ENABLED_KEY]: "true",
      [IMPORT_JOURNAL_CUTOFF_KEY]: ago(20),
    });
    const server = await startHttpServer({ dataDir });
    try {
      const res = await fetch(`${server.url}/import`, {
        method: "POST",
        headers: AGENT,
        body: JSON.stringify(conversation("conv-ok", 10)),
      });
      const body = (await res.json()) as {
        accepted: boolean;
        buffered: number;
        steps: Record<string, string>;
      };
      expect(body.accepted).toBe(true);
      expect(body.buffered).toBe(2);
      expect(body.steps.memories).toBe("queued");
      expect(body.steps.journal).toMatch(/after the journal cutoff/);

      const buffer = fs.readFileSync(transcriptBufferPath(dataDir, "conv-ok"), "utf8");
      expect(buffer).toContain("Should we keep raw transcripts?");
      expect(buffer).not.toContain("secret plan");
      expect(
        JSON.parse(fs.readFileSync(transcriptHarnessMarkerPath(dataDir, "conv-ok"), "utf8")),
      ).toEqual({
        harness: "claude",
        project: "the-librarian",
        import: { facts: true, journal: false },
      });
      expect(fs.existsSync(endedMarkerPath(dataDir, "conv-ok"))).toBe(true);

      const policy = (await (
        await fetch(`${server.url}/import/policy`, { headers: AGENT })
      ).json()) as {
        allowanceRemaining: number;
        memoriesCutoff: string | null;
      };
      expect(policy.allowanceRemaining).toBe(199);
      expect(policy.memoriesCutoff).not.toBeNull(); // intake had never run: frozen now
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("refuses a conversation with nothing to do, and one already being captured", async () => {
    const dataDir = makeTempDir();
    seed(dataDir, { [INTAKE_ENABLED_KEY]: "true", [JOURNAL_ENABLED_KEY]: "true" });
    const server = await startHttpServer({ dataDir });
    try {
      const recent = await fetch(`${server.url}/import`, {
        method: "POST",
        headers: AGENT,
        body: JSON.stringify(conversation("conv-new", 0)),
      });
      const recentBody = (await recent.json()) as {
        accepted: boolean;
        steps: Record<string, string>;
      };
      expect(recentBody.accepted).toBe(false);
      expect(recentBody.steps.memories).toMatch(/less than a day ago/);
      expect(fs.existsSync(transcriptBufferPath(dataDir, "conv-new"))).toBe(false);

      fs.mkdirSync(path.dirname(transcriptBufferPath(dataDir, "conv-live")), { recursive: true });
      fs.writeFileSync(transcriptBufferPath(dataDir, "conv-live"), "### user (seq=1)\n\nhi\n");
      const busy = await fetch(`${server.url}/import`, {
        method: "POST",
        headers: AGENT,
        body: JSON.stringify(conversation("conv-live", 10)),
      });
      expect(((await busy.json()) as { reason: string }).reason).toMatch(
        /being captured or imported right now/,
      );
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
