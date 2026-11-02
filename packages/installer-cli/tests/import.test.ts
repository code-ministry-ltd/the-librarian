// `librarian import` (spec 079 §4): the five harness readers produce what live capture
// would have sent (same ids, prose only, no subagents, no compaction recaps, no private
// spans), and the command asks the server before it reads or sends anything.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runImport } from "../src/import/command.js";
import { readClaude, readCodex, readHermes, readOpenCode, readPi } from "../src/import/readers.js";

let home = "";
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-import-cli-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const T1 = "2026-09-01T10:00:00.000Z";
const T2 = "2026-09-01T10:05:00.000Z";
const T3 = "2026-09-01T10:09:00.000Z";

function write(file: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

function repo(name: string): string {
  const dir = path.join(home, "code", name, "sub");
  fs.mkdirSync(path.join(home, "code", name, ".git"), { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("readClaude", () => {
  it("reads prose turns with the session id, and skips recaps, sidechains, tool plumbing and private spans", () => {
    const cwd = repo("alpha");
    write(path.join(home, ".claude", "projects", "-x", "sess-1.jsonl"), [
      {
        type: "user",
        timestamp: T1,
        cwd,
        message: { role: "user", content: "How do I run tests?" },
      },
      {
        type: "user",
        timestamp: T1,
        isCompactSummary: true,
        message: { role: "user", content: "Summary of everything" },
      },
      {
        type: "assistant",
        timestamp: T2,
        isSidechain: true,
        message: { role: "assistant", content: [{ type: "text", text: "subagent" }] },
      },
      {
        type: "user",
        timestamp: T2,
        message: { role: "user", content: [{ type: "tool_result", content: "out" }] },
      },
      {
        type: "assistant",
        timestamp: T2,
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "Use pnpm test." },
          ],
        },
      },
      {
        type: "user",
        timestamp: T3,
        message: { role: "user", content: "[librarian:private=on] secret" },
      },
      {
        type: "assistant",
        timestamp: T3,
        message: { role: "assistant", content: [{ type: "text", text: "private reply" }] },
      },
    ]);
    const { conversations } = readClaude(home);
    expect(conversations).toEqual([
      {
        harness: "claude",
        convId: "sess-1",
        endedAt: T2,
        project: "alpha",
        turns: [
          { role: "user", text: "How do I run tests?", ts: T1 },
          { role: "assistant", text: "Use pnpm test.", ts: T2 },
        ],
      },
    ]);
  });

  it("drops a conversation with no reply", () => {
    write(path.join(home, ".claude", "projects", "-x", "lone.jsonl"), [
      { type: "user", timestamp: T1, message: { role: "user", content: "hello?" } },
    ]);
    expect(readClaude(home).conversations).toEqual([]);
  });
});

describe("readCodex", () => {
  it("uses the rollout's session id and the canonical user/assistant records, skipping subagents", () => {
    const dir = path.join(home, ".codex", "sessions", "2026", "09", "01");
    write(path.join(dir, "rollout-a.jsonl"), [
      { type: "session_meta", payload: { id: "codex-1", cwd: repo("beta") } },
      {
        type: "event_msg",
        timestamp: T1,
        payload: { type: "user_message", message: "Fix the CI job" },
      },
      {
        type: "response_item",
        timestamp: T1,
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "dup copy" }],
        },
      },
      {
        type: "response_item",
        timestamp: T2,
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Fixed." }],
        },
      },
    ]);
    write(path.join(dir, "rollout-b.jsonl"), [
      { type: "session_meta", payload: { id: "codex-sub", source: { subagent: "review" } } },
      { type: "event_msg", timestamp: T1, payload: { type: "user_message", message: "x" } },
      {
        type: "response_item",
        timestamp: T2,
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "y" }],
        },
      },
    ]);
    const { conversations } = readCodex(home);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({ convId: "codex-1", project: "beta", endedAt: T2 });
    expect(conversations[0]?.turns.map((t) => t.text)).toEqual(["Fix the CI job", "Fixed."]);
  });
});

describe("readPi", () => {
  it("uses the session header id and skips compaction summaries", () => {
    write(path.join(home, ".pi", "agent", "sessions", "--x--", "2026_pi-1.jsonl"), [
      { type: "session", id: "pi-1", cwd: repo("gamma") },
      {
        type: "message",
        message: { role: "user", content: "Plan the release", timestamp: Date.parse(T1) },
      },
      {
        type: "message",
        message: { role: "compactionSummary", summary: "recap", timestamp: Date.parse(T2) },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Ship Friday." }],
          timestamp: Date.parse(T2),
        },
      },
    ]);
    const [c] = readPi(home).conversations;
    expect(c).toMatchObject({ convId: "pi-1", project: "gamma", endedAt: T2 });
    expect(c?.turns.map((t) => t.text)).toEqual(["Plan the release", "Ship Friday."]);
  });
});

async function sqlite(file: string, sql: string): Promise<void> {
  const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
    DatabaseSync: new (p: string) => { exec(s: string): void; close(): void };
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(sql);
  db.close();
}

describe("readOpenCode", () => {
  it("reads text parts per message, skipping subagent sessions, synthetic parts and the compaction recap", async () => {
    const cwd = repo("delta");
    const j = (v: unknown) => JSON.stringify(v).replaceAll("'", "''");
    await sqlite(
      path.join(home, ".local", "share", "opencode", "opencode.db"),
      `CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, time_created INTEGER);
       CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
       CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
       INSERT INTO session VALUES ('ses_1', NULL, '${cwd}', 1), ('ses_sub', 'ses_1', '${cwd}', 1);
       INSERT INTO message VALUES
         ('m1', 'ses_1', 1, '${j({ role: "user", time: { created: Date.parse(T1) } })}'),
         ('m2', 'ses_1', 2, '${j({ role: "assistant", summary: true, time: { created: Date.parse(T2) } })}'),
         ('m3', 'ses_1', 3, '${j({ role: "assistant", time: { created: Date.parse(T3) } })}'),
         ('s1', 'ses_sub', 1, '${j({ role: "user", time: { created: Date.parse(T1) } })}');
       INSERT INTO part VALUES
         ('p1', 'm1', 'ses_1', 1, '${j({ type: "text", text: "Add a favicon" })}'),
         ('p2', 'm1', 'ses_1', 1, '${j({ type: "text", text: "injected", synthetic: true })}'),
         ('p3', 'm2', 'ses_1', 2, '${j({ type: "text", text: "Summary so far" })}'),
         ('p4', 'm3', 'ses_1', 3, '${j({ type: "reasoning", text: "thinking" })}'),
         ('p5', 'm3', 'ses_1', 3, '${j({ type: "text", text: "Added." })}'),
         ('p6', 's1', 'ses_sub', 1, '${j({ type: "text", text: "sub" })}');`,
    );
    const { conversations } = await readOpenCode(home);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({ convId: "ses_1", project: "delta", endedAt: T3 });
    expect(conversations[0]?.turns.map((t) => t.text)).toEqual(["Add a favicon", "Added."]);
  });
});

describe("readHermes", () => {
  it("reads user/assistant messages, skips compression summaries, and labels a project only from a git repo", async () => {
    const s = (iso: string) => Date.parse(iso) / 1000;
    await sqlite(
      path.join(home, ".hermes", "state.db"),
      `CREATE TABLE sessions (id TEXT PRIMARY KEY, git_repo_root TEXT, started_at REAL);
       CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL, _compressed_summary INTEGER DEFAULT 0);
       INSERT INTO sessions VALUES ('h1', '/home/x/code/epsilon', 0), ('h2', NULL, 0);
       INSERT INTO messages (session_id, role, content, timestamp, _compressed_summary) VALUES
         ('h1', 'user', 'Book the venue', ${s(T1)}, 0),
         ('h1', 'assistant', 'Recap of earlier', ${s(T2)}, 1),
         ('h1', 'tool', 'tool output', ${s(T2)}, 0),
         ('h1', 'assistant', 'Booked.', ${s(T3)}, 0),
         ('h2', 'user', 'Hi', ${s(T1)}, 0),
         ('h2', 'assistant', 'Hello', ${s(T2)}, 0);`,
    );
    const { conversations } = await readHermes(home);
    const h1 = conversations.find((c) => c.convId === "h1");
    expect(h1).toMatchObject({ project: "epsilon", endedAt: T3 });
    expect(h1?.turns.map((t) => t.text)).toEqual(["Book the venue", "Booked."]);
    expect(conversations.find((c) => c.convId === "h2")?.project).toBeUndefined();
  });
});

describe("runImport", () => {
  type Call = {
    method: string;
    path: string;
    body: unknown;
    headers: Record<string, string>;
    redirect?: string;
  };

  function fakeServer(opts: {
    policy?: Record<string, unknown>;
    plan?: (c: { conv_id: string }) => { memories: string; journal: string };
    accept?: (body: { conv_id: string }) => Record<string, unknown>;
    status?: number;
  }) {
    const calls: Call[] = [];
    const fetchImpl = (async (url: URL, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({
        method: String(init.method),
        path: new URL(url).pathname,
        body,
        headers: init.headers as Record<string, string>,
        redirect: init.redirect as string,
      });
      const reply = (json: unknown, status = 200) =>
        new Response(JSON.stringify(json), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (opts.status) return reply({}, opts.status);
      const p = new URL(url).pathname;
      if (p === "/import/policy") {
        return reply({
          intake: "enabled",
          journal: "enabled",
          memoriesCutoff: null,
          journalCutoff: "2026-10-01T00:00:00.000Z",
          maxAgeDays: 90,
          allowanceRemaining: 200,
          ...opts.policy,
        });
      }
      if (p === "/import/plan") {
        const plans = (body.conversations as { conv_id: string; harness: string }[]).map((c) => ({
          ...c,
          ...(opts.plan?.(c) ?? { memories: "queued", journal: "queued" }),
        }));
        return reply({ plans });
      }
      return reply(opts.accept?.(body) ?? { accepted: true });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  function seedClaude(id: string, endedAt: string): void {
    write(path.join(home, ".claude", "projects", "-x", `${id}.jsonl`), [
      { type: "user", timestamp: endedAt, message: { role: "user", content: `question ${id}` } },
      {
        type: "assistant",
        timestamp: endedAt,
        message: { role: "assistant", content: [{ type: "text", text: `answer ${id}` }] },
      },
    ]);
  }

  const base = { serverUrl: "https://lib.example", token: "dummy-token", home: "" };

  it("stops before reading anything when both steps are off on the server", async () => {
    seedClaude("a", T1);
    const server = fakeServer({ policy: { intake: "disabled", journal: "disabled" } });
    const outcome = await runImport({ ...base, home, fetchImpl: server.fetchImpl, yes: true });
    expect(outcome.output).toContain("Nothing to import into");
    expect(server.calls.map((c) => c.path)).toEqual(["/import/policy"]);
  });

  it("dry run: shows the server's plan with grouped reasons and sends no text", async () => {
    seedClaude("a", T1);
    seedClaude("b", T2);
    const server = fakeServer({
      plan: (c) =>
        c.conv_id === "b"
          ? {
              memories: "queued",
              journal:
                "ended 2026-09-01, after the journal cutoff 2026-08-01; live capture covers it",
            }
          : { memories: "queued", journal: "queued" },
    });
    const outcome = await runImport({
      ...base,
      home,
      fetchImpl: server.fetchImpl,
      dryRun: true,
      harnesses: ["claude"],
    });
    expect(outcome.output).toContain("memories: 2 to import");
    expect(outcome.output).toContain("journal: 1 to import");
    expect(outcome.output).toContain(
      "1 × ended after the journal cutoff 2026-08-01; live capture covers it",
    );
    expect(outcome.output).toContain("Dry run: nothing was sent.");
    expect(server.calls.some((c) => c.path === "/import")).toBe(false);
    const planBody = server.calls.find((c) => c.path === "/import/plan")?.body as {
      conversations: object[];
    };
    expect(JSON.stringify(planBody)).not.toContain("question"); // ids and times only
  });

  it("sends queued conversations oldest first, with the token in the header only and redirects refused", async () => {
    seedClaude("newer", T3);
    seedClaude("older", T1);
    const server = fakeServer({});
    const outcome = await runImport({
      ...base,
      home,
      fetchImpl: server.fetchImpl,
      yes: true,
      harnesses: ["claude"],
    });
    const sends = server.calls.filter((c) => c.path === "/import");
    expect(sends.map((c) => (c.body as { conv_id: string }).conv_id)).toEqual(["older", "newer"]);
    expect(sends[0]?.headers.authorization).toBe("Bearer dummy-token");
    expect(server.calls.every((c) => c.redirect === "error")).toBe(true);
    expect(JSON.stringify(sends[0]?.body)).not.toContain("dummy-token");
    expect(outcome.output).toContain("Done: 2 conversation(s) queued on the server.");
  });

  it("stops cleanly when the server's allowance runs out", async () => {
    seedClaude("a", T1);
    seedClaude("b", T2);
    const server = fakeServer({
      accept: (b) =>
        b.conv_id === "a"
          ? { accepted: true }
          : {
              accepted: false,
              steps: {
                memories: "the server's import allowance is used up; raise it",
                journal: "x",
              },
            },
    });
    const outcome = await runImport({
      ...base,
      home,
      fetchImpl: server.fetchImpl,
      yes: true,
      harnesses: ["claude"],
    });
    expect(outcome.output).toContain(
      "Stopped after 1 conversation(s): the server's import allowance is used up.",
    );
  });

  it("asks before sending, and sends nothing on no", async () => {
    seedClaude("a", T1);
    const server = fakeServer({});
    const prompter = {
      promptText: async () => "n",
      selectHarnesses: async () => [],
      close: () => {},
    };
    const outcome = await runImport({
      ...base,
      home,
      fetchImpl: server.fetchImpl,
      prompter,
      harnesses: ["claude"],
    });
    expect(outcome.output).toContain("Cancelled: nothing was sent.");
    expect(server.calls.some((c) => c.path === "/import")).toBe(false);
  });

  it("explains an older server that doesn't support import", async () => {
    const server = fakeServer({ status: 404 });
    const outcome = await runImport({ ...base, home, fetchImpl: server.fetchImpl, yes: true });
    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain(
      "doesn't support import yet — update the server to 1.42.0 or later",
    );
  });
});
