// Claude journal adapter (spec 077 PR C): the SessionStart journal hook and the Stop
// hook's `project` field. Pure modules are imported directly; the hook entry is
// spawned exactly as Claude Code runs it, against a live server.

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
const SCRIPTS = path.join(REPO_ROOT, "integrations", "claude", "scripts");
const journal = await import(path.join(SCRIPTS, "lib", "journal.mjs"));
const banner = await import(path.join(SCRIPTS, "lib", "banner.mjs"));
const capture = await import(path.join(SCRIPTS, "lib", "capture.mjs"));

const ENV = { LIBRARIAN_MCP_URL: "https://lib.example/mcp", LIBRARIAN_AGENT_TOKEN: "agent-token" };

function markdown(body: string, status = 200, type = "text/markdown; charset=utf-8") {
  return new Response(body, { status, headers: { "content-type": type } });
}

let tmp = "";
beforeEach(() => {
  tmp = makeTempDir();
});
afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
  tmp = "";
});

describe("deriveJournalUrl", () => {
  it("asks the same origin as /mcp for a window under Claude Code's 10,000-character cap", () => {
    expect(journal.deriveJournalUrl("https://lib.example:8443/mcp?x=1")).toBe(
      "https://lib.example:8443/journal.md?max_chars=9500",
    );
    expect(journal.JOURNAL_MAX_CHARS).toBeLessThan(journal.CLAUDE_HOOK_OUTPUT_CAP);
  });

  it("returns null for an unusable URL", () => {
    expect(journal.deriveJournalUrl(undefined)).toBeNull();
    expect(journal.deriveJournalUrl("not a url")).toBeNull();
    expect(journal.deriveJournalUrl("ftp://lib.example/mcp")).toBeNull();
  });
});

describe("fetchJournal — fail-soft", () => {
  it("returns the window, sending the token only in the Authorization header", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const text = await journal.fetchJournal(ENV, {
      fetch: async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return markdown("# Journal\n\n## 2026-11-02 10:00 · claude · x\n- did a thing\n");
      },
    });
    expect(text).toContain("did a thing");
    expect(seen[0]?.url).not.toContain("agent-token");
    expect((seen[0]?.init.headers as Record<string, string>).authorization).toBe(
      "Bearer agent-token",
    );
    expect(seen[0]?.init.redirect).toBe("error");
  });

  it("returns null without calling out when not configured or switched off", async () => {
    const fetch = async () => {
      throw new Error("must not be called");
    };
    expect(await journal.fetchJournal({}, { fetch })).toBeNull();
    expect(await journal.fetchJournal({ ...ENV, LIBRARIAN_JOURNAL: "off" }, { fetch })).toBeNull();
    expect(
      await journal.fetchJournal({ ...ENV, LIBRARIAN_JOURNAL: "FALSE" }, { fetch }),
    ).toBeNull();
  });

  it("returns null for a 404 (journal off or empty), a non-markdown body, or a network error", async () => {
    expect(
      await journal.fetchJournal(ENV, { fetch: async () => markdown("off", 404, "text/plain") }),
    ).toBeNull();
    expect(
      await journal.fetchJournal(ENV, { fetch: async () => markdown("<html>", 200, "text/html") }),
    ).toBeNull();
    expect(
      await journal.fetchJournal(ENV, {
        fetch: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    ).toBeNull();
  });

  it("trims an oversized window client-side, keeping the newest entries", async () => {
    const blocks = Array.from(
      { length: 20 },
      (_, i) =>
        `## 2026-10-${String(i + 1).padStart(2, "0")} 10:00 · claude · x\n- ${`e${i} `.repeat(200)}`,
    );
    const text = await journal.fetchJournal(ENV, {
      fetch: async () => markdown(`# Journal — header\n\n${blocks.join("\n\n")}\n`),
    });
    expect(text.length).toBeLessThanOrEqual(journal.JOURNAL_MAX_CHARS);
    expect(text).toContain("e19 e19");
    expect(text).not.toContain("e0 e0");
    expect(text).toContain("call the `journal` tool to read further back");
  });
});

describe("deriveProject", () => {
  it("names the git repository containing the working directory", () => {
    const repo = path.join(tmp, "the-librarian");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "packages", "core"), { recursive: true });
    expect(journal.deriveProject(path.join(repo, "packages", "core"))).toBe("the-librarian");
  });

  it("treats a .git file (a worktree) as a repository root too", () => {
    const repo = path.join(tmp, "wt");
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, ".git"), "gitdir: /elsewhere\n");
    expect(journal.deriveProject(repo)).toBe("wt");
  });

  it("falls back to the folder name outside a repository, and null for unusable input", () => {
    const plain = path.join(tmp, "notes");
    fs.mkdirSync(plain);
    expect(journal.deriveProject(plain)).toBe("notes");
    expect(journal.deriveProject(undefined)).toBeNull();
    expect(journal.deriveProject("relative/path")).toBeNull();
  });
});

describe("server features", () => {
  it("defaults to unsupported, and remembers what the probe saw", () => {
    expect(journal.serverSupportsJournal(tmp)).toBe(false);
    journal.writeServerFeatures(tmp, { journalSupported: true });
    expect(journal.serverSupportsJournal(tmp)).toBe(true);
    journal.writeServerFeatures(tmp, { journalSupported: false });
    expect(journal.serverSupportsJournal(tmp)).toBe(false);
  });

  it("probeStatus reports journal support from the presence of the healthz key", async () => {
    const withKey = await banner.probeStatus(ENV, {
      fetch: async () => Response.json({ capture: "enabled", journal: "disabled" }),
    });
    expect(withKey.journalSupported).toBe(true);
    const without = await banner.probeStatus(ENV, {
      fetch: async () => Response.json({ capture: "enabled" }),
    });
    expect(without.journalSupported).toBe(false);
  });
});

describe("Stop hook — project on the delta (SC8)", () => {
  function transcript(): string {
    const p = path.join(tmp, "sess-1.jsonl");
    const line = (role: "user" | "assistant", text: string) =>
      `${JSON.stringify({
        type: role,
        isSidechain: false,
        timestamp: "2026-11-02T10:00:00.000Z",
        sessionId: "sess-1",
        message:
          role === "user" ? { role, content: text } : { role, content: [{ type: "text", text }] },
      })}\n`;
    fs.writeFileSync(p, line("user", "hi") + line("assistant", "hello"));
    return p;
  }

  async function shipOnce(): Promise<Record<string, unknown>> {
    const repo = path.join(tmp, "my-repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    const calls: Record<string, unknown>[] = [];
    await capture.runCapture(
      { transcript_path: transcript(), session_id: "sess-1", cwd: repo },
      { ...ENV, CLAUDE_PLUGIN_DATA: tmp },
      {
        post: async (_u: string, payload: Record<string, unknown>) => {
          calls.push(payload);
          return { ok: true, status: 200 };
        },
      },
    );
    return calls[0] ?? {};
  }

  it("leaves project out when the server has not advertised the journal", async () => {
    expect(await shipOnce()).not.toHaveProperty("project");
  });

  it("sends the repository name once the server is known to accept it", async () => {
    journal.writeServerFeatures(tmp, { journalSupported: true });
    expect((await shipOnce()).project).toBe("my-repo");
  });
});

describe("on-session-start-journal.mjs — the real hook process", () => {
  function run(env: Record<string, string>): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(SCRIPTS, "on-session-start-journal.mjs")], {
        env: { PATH: process.env.PATH ?? "", HOME: tmp, CLAUDE_PLUGIN_DATA: tmp, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.on("close", (code) => resolve({ code, stdout }));
    });
  }

  it("prints nothing and exits 0 when not configured", async () => {
    expect(await run({})).toEqual({ code: 0, stdout: "" });
  });

  it("prints nothing and exits 0 when the server is unreachable", async () => {
    const result = await run({
      LIBRARIAN_MCP_URL: "http://127.0.0.1:9/mcp",
      LIBRARIAN_AGENT_TOKEN: "agent-token",
    });
    expect(result).toEqual({ code: 0, stdout: "" });
  });

  it("prints a window under Claude Code's cap from a live server with a long journal", async () => {
    const dataDir = makeTempDir();
    const store = createLibrarianStore({ dataDir });
    try {
      store.setSetting(INTAKE_ENABLED_KEY, "true");
      store.setSetting(JOURNAL_ENABLED_KEY, "true");
      for (let i = 1; i <= 12; i += 1) {
        appendEpisode(store.systemJournal(DEFAULT_SHELF), `2026-10-${String(i + 10)}`, {
          key: `c${i}#s1`,
          time: "10:00",
          harness: "claude",
          project: "p",
          bullets: [`entry ${i} `.repeat(110)],
        });
      }
    } finally {
      store.close();
    }
    const server = await startHttpServer({ dataDir });
    try {
      const result = await run({
        LIBRARIAN_MCP_URL: `${server.url}/mcp`,
        LIBRARIAN_AGENT_TOKEN: "agent-token",
      });
      expect(result.code).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(1_000);
      expect(result.stdout.length).toBeLessThan(journal.CLAUDE_HOOK_OUTPUT_CAP);
      expect(result.stdout).toContain("entry 12 entry 12");
      expect(result.stdout).toContain("call the `journal` tool to read further back");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
