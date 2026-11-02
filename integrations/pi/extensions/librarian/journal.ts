// Journal injection + project label (spec 078) — the Pi port of
// integrations/claude/scripts/lib/journal.mjs.
//
//   - The recent window of the conversation journal (`GET /journal.md`) is appended
//     to the system prompt via `before_agent_start`, after the primer. It is fetched
//     ONCE per Pi session and then served from memory: the prompt stays
//     byte-identical every turn (prompt caching stays warm) and the server is asked
//     once. Keyed by session id, not process — one Pi process can outlive several
//     sessions, and each new session gets a fresh window.
//   - The project label for /transcript (git repo name, else folder name), offered
//     only after a `/healthz` probe shows the server accepts it — an older server
//     rejects the unknown key and capture would stall. Probed once per process.
//
// Same rules as the Claude adapter: `max_chars=9500` (every harness gets the
// Claude-sized window), `LIBRARIAN_JOURNAL=off` skips the fetch, the token rides the
// Authorization header only, redirects are refused, and every failure resolves to
// "" / null — never a throw into Pi's turn.

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readSessionId } from "./capture.js";

/** The window size every harness asks for — Claude Code's, under its 10,000-char cap. */
export const JOURNAL_MAX_CHARS = 9_500;

const TRIMMED_NOTE =
  "Older entries were left out to fit — call the `journal` tool to read further back.";

const DEFAULT_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 2_000;
/** Sessions remembered at once; the oldest is forgotten first. */
const MAX_SESSIONS = 200;

type FetchLike = typeof fetch;

/** `<origin>/journal.md?max_chars=N`, or null when the endpoint is unusable. */
export function journalUrl(endpoint: string, maxChars = JOURNAL_MAX_CHARS): string | null {
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.origin}/journal.md?max_chars=${maxChars}`;
  } catch {
    return null;
  }
}

/** Is the journal injection switched off locally (`LIBRARIAN_JOURNAL=off|false|0|no`)? */
export function isJournalInjectionOff(env: Record<string, string | undefined>): boolean {
  const raw = env.LIBRARIAN_JOURNAL ?? "";
  return ["off", "false", "0", "no"].includes(raw.trim().toLowerCase());
}

/**
 * Keep the window under `limit` characters by dropping the OLDEST `## ` blocks (the
 * window is oldest-first). A server that honours `max_chars` never needs this.
 */
export function fitJournal(text: string, limit = JOURNAL_MAX_CHARS): string {
  if (text.length <= limit) return text;
  const parts = text.split(/\n(?=## )/);
  const header = parts.shift() ?? "";
  const blocks = parts.filter((b) => !b.startsWith(TRIMMED_NOTE)).map((b) => b.trimEnd());
  const render = (kept: string[]): string =>
    `${header.trimEnd()}\n\n${kept.join("\n\n")}\n\n${TRIMMED_NOTE}\n`;
  let start = 0;
  while (start < blocks.length - 1 && render(blocks.slice(start)).length > limit) start += 1;
  const out = render(blocks.slice(start));
  return out.length <= limit ? out : out.slice(0, limit);
}

/**
 * The project label: the name of the git repository containing `cwd` (the nearest
 * ancestor holding a `.git` entry), else the name of `cwd`. Null when unusable.
 */
export function deriveProject(cwd: string | undefined): string | null {
  if (!cwd || !path.isAbsolute(cwd)) return null;
  try {
    let dir = path.resolve(cwd);
    let name: string | null = null;
    for (;;) {
      if (fs.existsSync(path.join(dir, ".git"))) {
        name = path.basename(dir);
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    const label = (name ?? path.basename(path.resolve(cwd))).trim().slice(0, 200);
    return label || null;
  } catch {
    return null;
  }
}

export interface JournalSourceConfig {
  endpoint: string;
  token: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface JournalSource {
  /** The window for this session ("" when there is none), fetched once per session. */
  windowFor(sessionId: string): Promise<string>;
  /** The project label for `cwd`, or null when the server can't take it. */
  projectFor(cwd: string | undefined): Promise<string | null>;
}

export function createJournalSource(config: JournalSourceConfig): JournalSource {
  const env = config.env ?? process.env;
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const windows = new Map<string, Promise<string>>();
  let supported: Promise<boolean> | null = null;

  async function fetchWindow(): Promise<string> {
    if (isJournalInjectionOff(env)) return "";
    const url = journalUrl(config.endpoint);
    if (!url) return "";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${config.token}` },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) return "";
      if (!(response.headers.get("content-type") ?? "").includes("text/markdown")) return "";
      const text = await response.text();
      return text.trim() ? fitJournal(text) : "";
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
    }
  }

  async function probe(): Promise<boolean> {
    let url: string;
    try {
      const parsed = new URL(config.endpoint);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
      url = `${parsed.origin}/healthz`;
    } catch {
      return false;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      // /healthz is unauthenticated, so no token is sent.
      const response = await fetchImpl(url, { redirect: "error", signal: controller.signal });
      if (!response.ok) return false;
      const json: unknown = await response.json();
      return (
        typeof json === "object" &&
        json !== null &&
        !Array.isArray(json) &&
        Object.prototype.hasOwnProperty.call(json, "journal")
      );
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async windowFor(sessionId) {
      if (!sessionId) return "";
      let pending = windows.get(sessionId);
      if (!pending) {
        pending = fetchWindow().catch(() => "");
        windows.set(sessionId, pending);
        if (windows.size > MAX_SESSIONS) {
          const oldest = windows.keys().next().value;
          if (oldest !== undefined) windows.delete(oldest);
        }
      }
      return pending;
    },
    async projectFor(cwd) {
      try {
        supported ??= probe().catch(() => false);
        return (await supported) ? deriveProject(cwd) : null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Append the session's journal window to Pi's system prompt. Registered AFTER the
 * primer hook, so the SDK's chained `systemPrompt` returns put it after the primer.
 * Empty window → no return value → Pi leaves the prompt untouched.
 */
export function registerJournalHook(pi: ExtensionAPI, source: JournalSource): void {
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const window = await source.windowFor(readSessionId(ctx));
      if (!window.trim()) return;
      return { systemPrompt: `${event.systemPrompt}\n\n${window}` };
    } catch {
      // Defensive net — a top-level throw must never break the user's turn.
      return;
    }
  });
}
