// Spec 078 — the Pi journal injection + project label.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createJournalSource,
  deriveProject,
  fitJournal,
  JOURNAL_MAX_CHARS,
  journalUrl,
  registerJournalHook,
} from "../extensions/librarian/journal.js";

const ENDPOINT = "https://lib.example/mcp";
const WINDOW = "# Journal\n\n## 2026-11-02 10:00 · pi · x\n- did a thing\n";

function fakeFetch({ health = { journal: "enabled" } as unknown, window = WINDOW } = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/healthz")) {
      return new Response(JSON.stringify(health), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(window, {
      status: window ? 200 : 404,
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

let tmp = "";
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-journal-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("journalUrl", () => {
  it("asks the server root for the Claude-sized window", () => {
    expect(journalUrl(ENDPOINT)).toBe("https://lib.example/journal.md?max_chars=9500");
    expect(JOURNAL_MAX_CHARS).toBe(9_500);
    expect(journalUrl("not a url")).toBeNull();
    expect(journalUrl("ftp://lib.example/mcp")).toBeNull();
  });
});

describe("fitJournal", () => {
  it("drops the oldest entries to fit and points at the journal tool", () => {
    const blocks = Array.from({ length: 10 }, (_, i) => `## day ${i}\n${"x".repeat(2_000)}`);
    const text = `# Journal\n\n${blocks.join("\n\n")}\n`;
    const out = fitJournal(text);
    expect(out.length).toBeLessThanOrEqual(JOURNAL_MAX_CHARS);
    expect(out).toContain("## day 9");
    expect(out).not.toContain("## day 0");
    expect(out).toContain("call the `journal` tool to read further back");
    expect(fitJournal("short")).toBe("short");
  });
});

describe("deriveProject", () => {
  it("names the git repository containing cwd, else the folder", () => {
    const repo = path.join(tmp, "my-repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "src"));
    expect(deriveProject(path.join(repo, "src"))).toBe("my-repo");
    const loose = path.join(tmp, "loose");
    fs.mkdirSync(loose);
    // tmp lives under the OS temp dir, outside any repo.
    expect(deriveProject(loose)).toBe("loose");
    expect(deriveProject(undefined)).toBeNull();
    expect(deriveProject("relative/path")).toBeNull();
  });
});

describe("createJournalSource", () => {
  it("fetches once per session with the token in the Authorization header only", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const source = createJournalSource({ endpoint: ENDPOINT, token: "tok", env: {}, fetchImpl });
    expect(await source.windowFor("s1")).toBe(WINDOW);
    expect(await source.windowFor("s1")).toBe(WINDOW);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).not.toContain("tok");
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(calls[0]?.init?.redirect).toBe("error");
    await source.windowFor("s2");
    expect(calls).toHaveLength(2);
  });

  it("returns '' when switched off, without a session, or on any failure", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const off = createJournalSource({
      endpoint: ENDPOINT,
      token: "tok",
      env: { LIBRARIAN_JOURNAL: "off" },
      fetchImpl,
    });
    expect(await off.windowFor("s1")).toBe("");
    const on = createJournalSource({ endpoint: ENDPOINT, token: "tok", env: {}, fetchImpl });
    expect(await on.windowFor("")).toBe("");
    expect(calls).toHaveLength(0);

    const failing = createJournalSource({
      endpoint: ENDPOINT,
      token: "tok",
      env: {},
      fetchImpl: (async () => {
        throw new Error("down");
      }) as typeof fetch,
    });
    expect(await failing.windowFor("s1")).toBe("");
    const notFound = fakeFetch({ window: "" });
    const empty = createJournalSource({
      endpoint: ENDPOINT,
      token: "tok",
      env: {},
      fetchImpl: notFound.fetchImpl,
    });
    expect(await empty.windowFor("s1")).toBe("");
  });

  it("labels the project only for a server that accepts it, probing once", async () => {
    const repo = path.join(tmp, "pi-repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    const { fetchImpl, calls } = fakeFetch();
    const source = createJournalSource({ endpoint: ENDPOINT, token: "tok", env: {}, fetchImpl });
    expect(await source.projectFor(repo)).toBe("pi-repo");
    expect(await source.projectFor(repo)).toBe("pi-repo");
    expect(calls.filter((c) => c.url.endsWith("/healthz"))).toHaveLength(1);
    expect(JSON.stringify(calls[0]?.init ?? {})).not.toContain("tok");

    const older = fakeFetch({ health: { ok: true } });
    const olderSource = createJournalSource({
      endpoint: ENDPOINT,
      token: "tok",
      env: {},
      fetchImpl: older.fetchImpl,
    });
    expect(await olderSource.projectFor(repo)).toBeNull();
  });
});

describe("registerJournalHook", () => {
  type Hook = (event: BeforeAgentStartEvent, ctx: unknown) => Promise<unknown>;

  function hookFor(windowFor: (id: string) => Promise<string>): Hook {
    let captured: Hook | undefined;
    const pi = {
      on: (name: string, handler: Hook) => {
        if (name === "before_agent_start") captured = handler;
      },
    } as unknown as ExtensionAPI;
    registerJournalHook(pi, { windowFor, projectFor: async () => null });
    if (!captured) throw new Error("before_agent_start was not registered");
    return captured;
  }

  const event = {
    type: "before_agent_start",
    prompt: "hi",
    systemPrompt: "BASE + PRIMER",
    systemPromptOptions: {} as BeforeAgentStartEvent["systemPromptOptions"],
  } as BeforeAgentStartEvent;
  const ctx = { sessionManager: { getSessionId: () => "s1" } };

  it("appends the session's window after the prompt it is handed", async () => {
    const seen: string[] = [];
    const hook = hookFor(async (id) => {
      seen.push(id);
      return WINDOW;
    });
    expect(await hook(event, ctx)).toEqual({ systemPrompt: `BASE + PRIMER\n\n${WINDOW}` });
    expect(seen).toEqual(["s1"]);
  });

  it("leaves the prompt alone when there is no window, or the source throws", async () => {
    expect(await hookFor(async () => "")(event, ctx)).toBeUndefined();
    const throwing = hookFor(async () => {
      throw new Error("boom");
    });
    expect(await throwing(event, ctx)).toBeUndefined();
  });
});
