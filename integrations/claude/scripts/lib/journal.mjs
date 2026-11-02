// Claude journal adapter (spec 077 PR C) — pure, testable pieces behind the
// `SessionStart` journal hook and the `Stop` hook's `project` field.
//
//   - fetchJournal: GET /journal.md?max_chars=… — the recent window, sized for Claude
//     Code's hook cap. Claude Code moves ANY hook output over 10,000 characters to a
//     file and shows the model only a 2,000-character preview (and never asks it to
//     read the file), so the window must fit under the cap to be seen at all. The
//     server trims oldest-first, entry by entry, and ends with a note pointing at the
//     `journal` tool; we also trim client-side in case an older server ignores the
//     parameter.
//   - deriveProject: the conversation's project label (git repo name, else folder).
//   - server features: the SessionStart probe records whether /healthz advertises the
//     journal; the Stop hook sends `project` only then — an older server 400s on an
//     unknown /transcript key, which would stall capture.
//
// Node stdlib only. Every function is fail-soft: it returns null/false, never throws.
// The token goes in the Authorization header only, never a URL or a log.

import fs from "node:fs";
import path from "node:path";

/** Claude Code's hard cap on a hook's injected output (characters). */
export const CLAUDE_HOOK_OUTPUT_CAP = 10_000;
/** What we ask the server for: under the cap with room to spare. */
export const JOURNAL_MAX_CHARS = 9_500;

const TRIMMED_NOTE =
  "Older entries were left out to fit — call the `journal` tool to read further back.";

/**
 * `<origin>/journal.md?max_chars=N` from `LIBRARIAN_MCP_URL`, or null when unusable.
 *
 * @param {string|undefined} mcpUrl
 * @param {number} [maxChars]
 * @returns {string|null}
 */
export function deriveJournalUrl(mcpUrl, maxChars = JOURNAL_MAX_CHARS) {
  if (!mcpUrl || typeof mcpUrl !== "string") return null;
  let parsed;
  try {
    parsed = new URL(mcpUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return `${parsed.origin}/journal.md?max_chars=${maxChars}`;
}

/** Is the journal injection switched off locally (`LIBRARIAN_JOURNAL=off|false|0`)? */
export function isJournalInjectionOff(env) {
  const raw = (env && env.LIBRARIAN_JOURNAL) || "";
  return ["off", "false", "0", "no"].includes(raw.trim().toLowerCase());
}

/**
 * Keep the window under `limit` characters by dropping the OLDEST `## ` blocks (the
 * window is oldest-first), keeping the header and the newest entries. A server that
 * honours `max_chars` never needs this; it protects against one that doesn't.
 *
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
export function fitJournal(text, limit = JOURNAL_MAX_CHARS) {
  if (text.length <= limit) return text;
  const parts = text.split(/\n(?=## )/);
  const header = parts.shift() ?? "";
  const blocks = parts.filter((b) => !b.startsWith(TRIMMED_NOTE)).map((b) => b.trimEnd());
  const render = (kept) => `${header.trimEnd()}\n\n${kept.join("\n\n")}\n\n${TRIMMED_NOTE}\n`;
  let start = 0;
  while (start < blocks.length - 1 && render(blocks.slice(start)).length > limit) start += 1;
  const out = render(blocks.slice(start));
  return out.length <= limit ? out : out.slice(0, limit);
}

/**
 * Fetch the recent window. Resolves to the markdown, or null for every failure path
 * (not configured, switched off, server down, 404 — journal off or empty — timeout,
 * non-text body). Never throws.
 *
 * @param {Record<string,string|undefined>} env
 * @param {{fetch?: typeof globalThis.fetch, timeoutMs?: number}} [deps]
 * @returns {Promise<string|null>}
 */
export async function fetchJournal(env, deps = {}) {
  if (isJournalInjectionOff(env)) return null;
  const doFetch = deps.fetch ?? globalThis.fetch;
  const url = deriveJournalUrl(env && env.LIBRARIAN_MCP_URL);
  const token = env && env.LIBRARIAN_AGENT_TOKEN;
  if (!url || !token || typeof doFetch !== "function") return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 5_000);
  try {
    const response = await doFetch(url, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const type = response.headers?.get?.("content-type") ?? "";
    if (!type.includes("text/markdown")) return null;
    const text = await response.text();
    if (typeof text !== "string" || !text.trim()) return null;
    return fitJournal(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The conversation's project label: the name of the git repository containing `cwd`
 * (the nearest ancestor holding a `.git` entry), else the name of `cwd` itself. Null
 * when `cwd` is missing or unusable. Bounded to the server's 200-character limit.
 *
 * @param {string|undefined} cwd
 * @param {{fs?: typeof import("node:fs")}} [deps]
 * @returns {string|null}
 */
export function deriveProject(cwd, deps = {}) {
  const fsDep = deps.fs ?? fs;
  if (!cwd || typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  try {
    let dir = path.resolve(cwd);
    let name = null;
    for (;;) {
      if (fsDep.existsSync(path.join(dir, ".git"))) {
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

/** Where the SessionStart probe records what the server supports. */
export function serverFeaturesPath(dataDir) {
  return path.join(dataDir, "server-features.json");
}

/**
 * Record what /healthz advertised. Best-effort: a write failure only means the Stop
 * hook keeps leaving `project` out.
 *
 * @param {string} dataDir
 * @param {{journalSupported: boolean}} features
 */
export function writeServerFeatures(dataDir, features) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      serverFeaturesPath(dataDir),
      JSON.stringify({ journal_supported: features.journalSupported === true }),
      "utf8",
    );
  } catch {
    // fail-soft
  }
}

/**
 * Did the last SessionStart probe see a server that accepts `project`? False when the
 * file is missing or unreadable — the safe default.
 *
 * @param {string} dataDir
 * @returns {boolean}
 */
export function serverSupportsJournal(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(serverFeaturesPath(dataDir), "utf8"));
    return Boolean(parsed && parsed.journal_supported === true);
  } catch {
    return false;
  }
}
