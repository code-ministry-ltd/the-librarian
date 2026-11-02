// The journal in every harness (spec 078): the shared journal lib's copies, the
// Codex SessionStart hook + `project` on capture, and the OpenCode system-prompt
// injector + `project`. Pure modules are imported directly; the Codex hook entry is
// also spawned exactly as Codex runs it, against a live server. (Pi and Hermes have
// their own suites under integrations/pi/tests and integrations/hermes/tests.)

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SHELF,
  INTAKE_ENABLED_KEY,
  JOURNAL_ENABLED_KEY,
  appendEpisode,
  createLibrarianStore,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "./helpers.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTEGRATIONS = path.join(REPO_ROOT, "integrations");
const CLAUDE_LIB = path.join(INTEGRATIONS, "claude", "scripts", "lib", "journal.mjs");
const CODEX_SCRIPTS = path.join(INTEGRATIONS, "codex", "scripts");
const CODEX_LIB = path.join(CODEX_SCRIPTS, "lib", "journal.mjs");
const OPENCODE_LIB_DIR = path.join(INTEGRATIONS, "opencode", "plugin", "lib");
const OPENCODE_LIB = path.join(OPENCODE_LIB_DIR, "journal.mjs");

const journal = await import(CLAUDE_LIB);
const codexStart = await import(path.join(CODEX_SCRIPTS, "lib", "session-start.mjs"));
const codexCapture = await import(path.join(CODEX_SCRIPTS, "lib", "capture.mjs"));
const codexTranscript = await import(path.join(CODEX_SCRIPTS, "lib", "transcript.mjs"));
const codexJournal = await import(CODEX_LIB);
const injector = await import(path.join(OPENCODE_LIB_DIR, "journal-inject.mjs"));
const opencodeCapture = await import(path.join(OPENCODE_LIB_DIR, "capture.mjs"));
const opencodeCursor = await import(path.join(OPENCODE_LIB_DIR, "cursor.mjs"));

const ENV = { LIBRARIAN_MCP_URL: "https://lib.example/mcp", LIBRARIAN_AGENT_TOKEN: "agent-token" };
const WINDOW = "# Journal\n\n## 2026-11-02 10:00 · codex · x\n- did a thing\n";

/** A fetch fake: /healthz answers `health`, /journal.md answers `WINDOW`. Counts calls. */
function fakeServer({ health = { journal: "enabled" } as unknown, window = WINDOW } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/healthz")) {
      return new Response(JSON.stringify(health), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(window, {
      status: window ? 200 : 404,
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  };
  return { fetch, calls };
}

let tmp = "";
beforeEach(() => {
  tmp = makeTempDir();
});
afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
  tmp = "";
});

describe("the shared journal lib", () => {
  it("ships byte-identical copies in the Codex and OpenCode integrations", () => {
    const source = fs.readFileSync(CLAUDE_LIB, "utf8");
    for (const copy of [CODEX_LIB, OPENCODE_LIB]) {
      expect(
        fs.readFileSync(copy, "utf8"),
        `${path.relative(REPO_ROOT, copy)} has drifted from the Claude lib — copy it over again`,
      ).toBe(source);
    }
  });

  it("asks every harness for the same window size (Pi and Hermes pin the same constant)", () => {
    const pi = fs.readFileSync(
      path.join(INTEGRATIONS, "pi", "extensions", "librarian", "journal.ts"),
      "utf8",
    );
    const hermes = fs.readFileSync(
      path.join(INTEGRATIONS, "hermes", "librarian", "journal.py"),
      "utf8",
    );
    expect(journal.JOURNAL_MAX_CHARS).toBe(9_500);
    expect(pi).toContain("export const JOURNAL_MAX_CHARS = 9_500;");
    expect(hermes).toContain("JOURNAL_MAX_CHARS = 9_500");
  });

  describe("probeJournalSupport", () => {
    it("is true when /healthz carries a `journal` key, enabled or not", async () => {
      for (const value of ["enabled", "disabled"]) {
        const { fetch } = fakeServer({ health: { ok: true, journal: value } });
        expect(await journal.probeJournalSupport(ENV, { fetch })).toBe(true);
      }
    });

    it("is false for an older server, a failure, or no config — and never sends the token", async () => {
      const { fetch, calls } = fakeServer({ health: { ok: true } });
      expect(await journal.probeJournalSupport(ENV, { fetch })).toBe(false);
      expect(JSON.stringify(calls[0]?.init ?? {})).not.toContain("agent-token");
      expect(calls[0]?.init.redirect).toBe("error");
      const failing = async () => {
        throw new Error("down");
      };
      expect(await journal.probeJournalSupport(ENV, { fetch: failing })).toBe(false);
      expect(await journal.probeJournalSupport({}, { fetch: failing })).toBe(false);
      const { fetch: arrayFetch } = fakeServer({ health: ["journal"] });
      expect(await journal.probeJournalSupport(ENV, { fetch: arrayFetch })).toBe(false);
    });
  });
});

describe("Codex — SessionStart journal hook", () => {
  const env = () => ({ ...ENV, CODEX_PLUGIN_DATA: tmp });

  it("returns the window as SessionStart additionalContext and records server support", async () => {
    const { fetch } = fakeServer();
    const line = await codexStart.runSessionStart({ source: "startup" }, env(), { fetch });
    expect(JSON.parse(line)).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: WINDOW },
    });
    expect(codexJournal.serverSupportsJournal(tmp)).toBe(true);
  });

  it("injects nothing for a subagent, and nothing when switched off", async () => {
    const { fetch, calls } = fakeServer();
    expect(await codexStart.runSessionStart({ agent_id: "sub-1" }, env(), { fetch })).toBeNull();
    expect(calls).toHaveLength(0);
    const off = { ...env(), LIBRARIAN_JOURNAL: "off" };
    expect(await codexStart.runSessionStart({}, off, { fetch })).toBeNull();
    // Switched off still probes, so capture can keep labelling projects.
    expect(codexJournal.serverSupportsJournal(tmp)).toBe(true);
  });

  it("records an older server as not accepting `project`, and injects nothing when it 404s", async () => {
    codexJournal.writeServerFeatures(tmp, { journalSupported: true });
    const { fetch } = fakeServer({ health: { ok: true }, window: "" });
    expect(await codexStart.runSessionStart({}, env(), { fetch })).toBeNull();
    expect(codexJournal.serverSupportsJournal(tmp)).toBe(false);
  });

  it("registers the hook for every SessionStart source, raising Codex's spill threshold", () => {
    const template = JSON.parse(
      fs.readFileSync(path.join(INTEGRATIONS, "codex", "hooks", "codex-hooks.json"), "utf8"),
    );
    const entries = template.hooks.SessionStart;
    expect(entries).toHaveLength(1);
    expect(entries[0].matcher).toBeUndefined(); // startup, resume, clear, fork AND compact
    const handler = entries[0].hooks[0];
    expect(handler.command).toContain("/scripts/on-session-start.mjs");
    expect(handler.command).toContain("# the-librarian-codex"); // installer ownership marker
    // ~9,500 characters is ~2,400–3,200 tokens: over Codex's 2,500 default.
    expect(handler.additionalContextLimit).toBeGreaterThanOrEqual(4_000);
    expect(fs.existsSync(path.join(CODEX_SCRIPTS, "on-session-start.mjs"))).toBe(true);
  });
});

describe("Codex — `project` on /transcript", () => {
  it("buildPayload carries `project` only when given one", () => {
    const base = { convId: "c", seq: 1, turns: [] };
    expect(codexTranscript.buildPayload(base)).not.toHaveProperty("project");
    expect(codexTranscript.buildPayload({ ...base, project: "repo" }).project).toBe("repo");
  });

  async function shipOnce(): Promise<Record<string, unknown>> {
    const repo = path.join(tmp, "my-repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "src"));
    const transcript = path.join(tmp, "rollout.jsonl");
    const lines = [
      { type: "event_msg", payload: { type: "user_message", message: "hello there" } },
      { type: "event_msg", payload: { type: "agent_message", message: "hi, how can I help?" } },
    ];
    fs.writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const posted: Record<string, unknown>[] = [];
    const result = await codexCapture.runCapture(
      {
        session_id: "s-1",
        transcript_path: transcript,
        cwd: path.join(repo, "src"),
        hook_event_name: "Stop",
      },
      { ...ENV, CODEX_PLUGIN_DATA: tmp },
      {
        post: async (_url: string, payload: Record<string, unknown>) => {
          posted.push(payload);
          return { ok: true, status: 202 };
        },
      },
    );
    expect(result.posted, JSON.stringify(result)).toBe(true);
    return posted[0] ?? {};
  }

  it("leaves `project` out until a SessionStart probe has seen a server that accepts it", async () => {
    expect(await shipOnce()).not.toHaveProperty("project");
  });

  it("sends the repository name once the server is known to accept it", async () => {
    codexJournal.writeServerFeatures(tmp, { journalSupported: true });
    expect((await shipOnce()).project).toBe("my-repo");
  });
});

describe("Codex — on-session-start.mjs, the real hook process", () => {
  function run(
    env: Record<string, string>,
    stdin: string,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(CODEX_SCRIPTS, "on-session-start.mjs")], {
        env: { PATH: process.env.PATH ?? "", HOME: tmp, CODEX_PLUGIN_DATA: tmp, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(stdin);
    });
  }

  it("prints nothing and exits 0 when not configured, or given malformed input", async () => {
    expect(await run({}, '{"source":"startup"}')).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await run({}, "{not json")).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("prints nothing and exits 0 when the server is unreachable", async () => {
    const result = await run(
      { LIBRARIAN_MCP_URL: "http://127.0.0.1:9/mcp", LIBRARIAN_AGENT_TOKEN: "agent-token" },
      '{"source":"startup"}',
    );
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("prints a Claude-sized window as additionalContext from a live server", async () => {
    const dataDir = makeTempDir();
    const store = createLibrarianStore({ dataDir });
    try {
      store.setSetting(INTAKE_ENABLED_KEY, "true");
      store.setSetting(JOURNAL_ENABLED_KEY, "true");
      for (let i = 1; i <= 12; i += 1) {
        appendEpisode(store.systemJournal(DEFAULT_SHELF), `2026-10-${String(i + 10)}`, {
          key: `c${i}#s1`,
          time: "10:00",
          harness: "codex",
          project: "p",
          bullets: [`entry ${i} `.repeat(110)],
        });
      }
    } finally {
      store.close();
    }
    const server = await startHttpServer({ dataDir });
    try {
      const result = await run(
        { LIBRARIAN_MCP_URL: `${server.url}/mcp`, LIBRARIAN_AGENT_TOKEN: "agent-token" },
        '{"source":"compact","session_id":"s-1"}',
      );
      expect(result.code).toBe(0);
      const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
      expect(context.length).toBeGreaterThan(1_000);
      expect(context.length).toBeLessThanOrEqual(journal.JOURNAL_MAX_CHARS);
      expect(context).toContain("entry 12 entry 12");
      expect(context).toContain("call the `journal` tool to read further back");
      expect(codexJournal.serverSupportsJournal(tmp)).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});

describe("OpenCode — journal injector", () => {
  it("fetches the window once per session and serves the same bytes after", async () => {
    const { fetch, calls } = fakeServer();
    const inject = injector.makeJournalInjector({ env: ENV, fetch });
    expect(await inject.systemFor("ses-1")).toBe(WINDOW);
    expect(await inject.systemFor("ses-1")).toBe(WINDOW);
    expect(calls.filter((c) => c.url.includes("/journal.md"))).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://lib.example/journal.md?max_chars=9500");
    await inject.systemFor("ses-2");
    expect(calls.filter((c) => c.url.includes("/journal.md"))).toHaveLength(2);
  });

  it("keeps a session's first answer, so a server coming back mid-session can't change the prompt", async () => {
    let up = false;
    const fetch = async () => {
      if (!up) throw new Error("down");
      return new Response(WINDOW, { headers: { "content-type": "text/markdown" } });
    };
    const inject = injector.makeJournalInjector({ env: ENV, fetch });
    expect(await inject.systemFor("ses-1")).toBeNull();
    up = true;
    expect(await inject.systemFor("ses-1")).toBeNull();
    expect(await inject.systemFor("ses-2")).toBe(WINDOW);
  });

  it("adds nothing without a session id, or when switched off", async () => {
    const { fetch, calls } = fakeServer();
    const inject = injector.makeJournalInjector({ env: ENV, fetch });
    expect(await inject.systemFor(undefined)).toBeNull();
    expect(await inject.systemFor("")).toBeNull();
    const off = injector.makeJournalInjector({ env: { ...ENV, LIBRARIAN_JOURNAL: "off" }, fetch });
    expect(await off.systemFor("ses-1")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("labels the project only for a server that accepts it, probing once", async () => {
    const repo = path.join(tmp, "oc-repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    const { fetch, calls } = fakeServer();
    const inject = injector.makeJournalInjector({ env: ENV, fetch });
    expect(await inject.projectFor(repo)).toBe("oc-repo");
    expect(await inject.projectFor(repo)).toBe("oc-repo");
    expect(calls.filter((c) => c.url.endsWith("/healthz"))).toHaveLength(1);

    const older = fakeServer({ health: { ok: true } });
    const olderInject = injector.makeJournalInjector({ env: ENV, fetch: older.fetch });
    expect(await olderInject.projectFor(repo)).toBeNull();
  });

  it("runCapture sends the `project` it is given, and none when it isn't", async () => {
    const posted: Record<string, unknown>[] = [];
    const deps = () => ({
      store: opencodeCursor.makeCursorStore(),
      post: async (_url: string, payload: Record<string, unknown>) => {
        posted.push(payload);
        return { ok: true, status: 202 };
      },
    });
    const messages = [
      { info: { role: "user", id: "m1" }, parts: [{ type: "text", text: "hello there" }] },
      { info: { role: "assistant", id: "m2" }, parts: [{ type: "text", text: "hi, what's up?" }] },
    ];
    await opencodeCapture.runCapture(
      { sessionID: "ses-1", messages, env: ENV, project: "oc-repo" },
      deps(),
    );
    await opencodeCapture.runCapture({ sessionID: "ses-2", messages, env: ENV }, deps());
    expect(posted).toHaveLength(2);
    expect(posted[0]?.project).toBe("oc-repo");
    expect(posted[1]).not.toHaveProperty("project");
  });
});
