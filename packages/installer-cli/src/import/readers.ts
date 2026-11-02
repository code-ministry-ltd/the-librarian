// Transcript readers for `librarian import` (spec 079 §4). One per harness, each reading
// the harness's own history on THIS machine and producing the same turns, conversation
// id and project label its live capture hook would have sent — so the server's ledger
// recognises a conversation whichever way it arrived.
//
// Every reader is fail-soft: an unreadable file or database is reported and skipped,
// never fatal. What is never imported, mirroring live capture:
//   - tool calls, tool output and the model's reasoning (prose only);
//   - subagent / sidechain conversations;
//   - compaction recaps (Claude `isCompactSummary`, OpenCode `summary: true`, Hermes
//     `_compressed_summary`) — they only repeat what was said;
//   - anything inside a `[librarian:private=on]` … `[librarian:private=off]` span.

import fs from "node:fs";
import path from "node:path";

/** The environment variables the readers honour (XDG_DATA_HOME, HERMES_HOME). */
export type Env = Record<string, string | undefined>;

export type HarnessId = "claude" | "codex" | "opencode" | "pi" | "hermes";
export const IMPORT_HARNESSES: readonly HarnessId[] = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "hermes",
];

export interface Turn {
  role: "user" | "assistant";
  text: string;
  ts: string;
}

export interface Conversation {
  harness: HarnessId;
  convId: string;
  /** ISO-8601 time of the last turn. */
  endedAt: string;
  project?: string;
  turns: Turn[];
}

export interface ReadResult {
  conversations: Conversation[];
  /** Files or databases that couldn't be read, with why. */
  problems: string[];
  /** Where this harness keeps its history (for the summary), or null if absent. */
  source: string | null;
}

const PRIVATE_ON = "[librarian:private=on]";
const PRIVATE_OFF = "[librarian:private=off]";

/** Drop private spans exactly as the live adapters do (marker turns included). */
export function filterPrivate(turns: Turn[]): Turn[] {
  let priv = false;
  const kept: Turn[] = [];
  for (const turn of turns) {
    const hasOn = turn.text.includes(PRIVATE_ON);
    const hasOff = turn.text.includes(PRIVATE_OFF);
    if (hasOn || hasOff) {
      const onAt = hasOn ? turn.text.lastIndexOf(PRIVATE_ON) : -1;
      const offAt = hasOff ? turn.text.lastIndexOf(PRIVATE_OFF) : -1;
      priv = onAt > offAt;
      continue;
    }
    if (!priv) kept.push(turn);
  }
  return kept;
}

/** The live adapters' project rule: nearest `.git` ancestor's folder name, else the folder. */
export function deriveProject(cwd: string | undefined): string | undefined {
  if (!cwd || !path.isAbsolute(cwd)) return undefined;
  try {
    let dir = path.resolve(cwd);
    for (;;) {
      if (fs.existsSync(path.join(dir, ".git")))
        return path.basename(dir).slice(0, 200) || undefined;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return path.basename(path.resolve(cwd)).slice(0, 200) || undefined;
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function textBlocks(content: unknown, type: string): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { text: string } => isRecord(b) && b.type === type && typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function toIso(value: unknown): string | null {
  if (typeof value === "string" && Number.isFinite(Date.parse(value)))
    return new Date(value).toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    // Seconds (Hermes) vs milliseconds (Pi, OpenCode).
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  return null;
}

function jsonLines(file: string): unknown[] {
  const out: unknown[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a torn last line (the harness was mid-write) is skipped
    }
  }
  return out;
}

function listFiles(dir: string, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && match(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/** Turn a reader's raw turns into a Conversation, or null when there's no exchange. */
function finish(
  harness: HarnessId,
  convId: string,
  raw: Turn[],
  project: string | undefined,
): Conversation | null {
  const turns = filterPrivate(raw);
  if (!turns.some((t) => t.role === "user") || !turns.some((t) => t.role === "assistant"))
    return null;
  const endedAt = turns.reduce((max, t) => (t.ts > max ? t.ts : max), turns[0]!.ts);
  return { harness, convId, endedAt, ...(project ? { project } : {}), turns };
}

// ── Claude Code: ~/.claude/projects/<folder>/<session_id>.jsonl ────────────────

export function readClaude(home: string): ReadResult {
  const root = path.join(home, ".claude", "projects");
  if (!fs.existsSync(root)) return { conversations: [], problems: [], source: null };
  const conversations: Conversation[] = [];
  const problems: string[] = [];
  for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const dir = path.join(root, dirent.name);
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue; // top-level sessions only (subagents live deeper)
      const file = path.join(dir, name);
      try {
        const turns: Turn[] = [];
        let cwd: string | undefined;
        for (const e of jsonLines(file)) {
          if (!isRecord(e)) continue;
          if (e.isSidechain === true || e.isMeta === true || e.isCompactSummary === true) continue;
          if (e.type !== "user" && e.type !== "assistant") continue;
          const message = e.message;
          if (!isRecord(message)) continue;
          if (typeof e.cwd === "string" && !cwd) cwd = e.cwd;
          const ts = toIso(e.timestamp);
          if (!ts) continue;
          if (message.role === "user") {
            // A string is the prompt; an array is tool plumbing.
            const text = typeof message.content === "string" ? message.content.trim() : "";
            if (text) turns.push({ role: "user", text, ts });
          } else if (message.role === "assistant") {
            const text = textBlocks(message.content, "text");
            if (text) turns.push({ role: "assistant", text, ts });
          }
        }
        const c = finish("claude", name.slice(0, -".jsonl".length), turns, deriveProject(cwd));
        if (c) conversations.push(c);
      } catch (error) {
        problems.push(`${file}: ${(error as Error).message}`);
      }
    }
  }
  return { conversations, problems, source: root };
}

// ── Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl ────────────────────────

export function readCodex(home: string): ReadResult {
  const root = path.join(home, ".codex", "sessions");
  if (!fs.existsSync(root)) return { conversations: [], problems: [], source: null };
  const conversations: Conversation[] = [];
  const problems: string[] = [];
  for (const file of listFiles(root, (n) => n.startsWith("rollout-") && n.endsWith(".jsonl"))) {
    try {
      let convId: string | undefined;
      let cwd: string | undefined;
      let subagent = false;
      const turns: Turn[] = [];
      for (const e of jsonLines(file)) {
        if (!isRecord(e) || !isRecord(e.payload)) continue;
        const p = e.payload;
        if (e.type === "session_meta") {
          if (typeof p.id === "string") convId ??= p.id;
          if (typeof p.cwd === "string") cwd ??= p.cwd;
          if (isRecord(p.source) && "subagent" in p.source) subagent = true;
          continue;
        }
        const ts = toIso(e.timestamp);
        if (!ts) continue;
        if (e.type === "event_msg" && p.type === "user_message" && typeof p.message === "string") {
          const text = p.message.trim();
          if (text) turns.push({ role: "user", text, ts });
        } else if (e.type === "response_item" && p.type === "message" && p.role === "assistant") {
          const text = textBlocks(p.content, "output_text");
          if (text) turns.push({ role: "assistant", text, ts });
        }
      }
      if (subagent || !convId) continue;
      const c = finish("codex", convId, turns, deriveProject(cwd));
      if (c) conversations.push(c);
    } catch (error) {
      problems.push(`${file}: ${(error as Error).message}`);
    }
  }
  return { conversations, problems, source: root };
}

// ── Pi: ~/.pi/agent/sessions/<folder>/<ts>_<id>.jsonl ──────────────────────────

export function readPi(home: string): ReadResult {
  const root = path.join(home, ".pi", "agent", "sessions");
  if (!fs.existsSync(root)) return { conversations: [], problems: [], source: null };
  const conversations: Conversation[] = [];
  const problems: string[] = [];
  for (const file of listFiles(root, (n) => n.endsWith(".jsonl"))) {
    try {
      let convId: string | undefined;
      let cwd: string | undefined;
      const turns: Turn[] = [];
      for (const e of jsonLines(file)) {
        if (!isRecord(e)) continue;
        if (e.type === "session") {
          if (typeof e.id === "string") convId ??= e.id;
          if (typeof e.cwd === "string") cwd ??= e.cwd;
          continue;
        }
        if (e.type !== "message" || !isRecord(e.message)) continue;
        const m = e.message;
        // compactionSummary / branchSummary / toolResult roles are not conversation.
        if (m.role !== "user" && m.role !== "assistant") continue;
        const ts = toIso(m.timestamp) ?? toIso(e.timestamp);
        if (!ts) continue;
        const text = textBlocks(m.content, "text");
        if (text) turns.push({ role: m.role, text, ts });
      }
      if (!convId) continue;
      const c = finish("pi", convId, turns, deriveProject(cwd));
      if (c) conversations.push(c);
    } catch (error) {
      problems.push(`${file}: ${(error as Error).message}`);
    }
  }
  return { conversations, problems, source: root };
}

// ── SQLite (OpenCode, Hermes): node:sqlite, read-only ──────────────────────────

interface SqliteDb {
  prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] };
  close(): void;
}

async function openReadOnly(file: string): Promise<SqliteDb> {
  // node:sqlite is built in from Node 22.13 / 23.4. Loaded lazily so the rest of the CLI
  // never depends on it.
  const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
    DatabaseSync: new (p: string, o: { readOnly: boolean }) => SqliteDb;
  };
  return new DatabaseSync(file, { readOnly: true });
}

function columns(db: SqliteDb, table: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((r) => String(r.name)),
  );
}

// ── OpenCode: ~/.local/share/opencode/opencode.db ──────────────────────────────
// Tables (v1.x): session(id, parent_id, directory, …), message(id, session_id,
// time_created, data JSON), part(id, message_id, session_id, time_created, data JSON).

export async function readOpenCode(home: string, env: Env = {}): Promise<ReadResult> {
  const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const file = path.join(dataHome, "opencode", "opencode.db");
  if (!fs.existsSync(file)) return { conversations: [], problems: [], source: null };
  const conversations: Conversation[] = [];
  const problems: string[] = [];
  let db: SqliteDb;
  try {
    db = await openReadOnly(file);
  } catch (error) {
    return { conversations, problems: [`${file}: ${(error as Error).message}`], source: file };
  }
  try {
    const sessionCols = columns(db, "session");
    if (
      !sessionCols.has("id") ||
      !columns(db, "message").has("data") ||
      !columns(db, "part").has("data")
    ) {
      return {
        conversations,
        problems: [`${file}: this OpenCode version's database layout isn't one the importer knows`],
        source: file,
      };
    }
    const sessions = db
      .prepare(
        `SELECT id, ${sessionCols.has("directory") ? "directory" : "NULL AS directory"}, ${sessionCols.has("parent_id") ? "parent_id" : "NULL AS parent_id"} FROM session`,
      )
      .all();
    const messages = db.prepare(
      "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created, id",
    );
    const parts = db.prepare(
      "SELECT message_id, data FROM part WHERE session_id = ? ORDER BY message_id, id",
    );
    for (const s of sessions) {
      if (s.parent_id) continue; // a subagent's session
      const id = String(s.id);
      try {
        const textByMessage = new Map<string, string[]>();
        for (const p of parts.all(id)) {
          const data = JSON.parse(String(p.data)) as unknown;
          if (
            !isRecord(data) ||
            data.type !== "text" ||
            data.synthetic === true ||
            typeof data.text !== "string"
          )
            continue;
          const list = textByMessage.get(String(p.message_id)) ?? [];
          list.push(data.text);
          textByMessage.set(String(p.message_id), list);
        }
        const turns: Turn[] = [];
        for (const m of messages.all(id)) {
          const info = JSON.parse(String(m.data)) as unknown;
          if (!isRecord(info)) continue;
          if (info.role !== "user" && info.role !== "assistant") continue;
          if (info.summary === true) continue; // the compaction recap
          const created = isRecord(info.time) ? info.time.created : m.time_created;
          const ts = toIso(created);
          const text = (textByMessage.get(String(m.id)) ?? []).join("\n").trim();
          if (ts && text) turns.push({ role: info.role, text, ts });
        }
        const c = finish(
          "opencode",
          id,
          turns,
          deriveProject(typeof s.directory === "string" ? s.directory : undefined),
        );
        if (c) conversations.push(c);
      } catch (error) {
        problems.push(`OpenCode session ${id}: ${(error as Error).message}`);
      }
    }
  } finally {
    db.close();
  }
  return { conversations, problems, source: file };
}

// ── Hermes: ~/.hermes/state.db ─────────────────────────────────────────────────
// Tables: sessions(id, parent_session_id, git_repo_root, …), messages(session_id,
// role, content, timestamp REAL seconds, _compressed_summary, …).

export async function readHermes(home: string, env: Env = {}): Promise<ReadResult> {
  const file = path.join(env.HERMES_HOME || path.join(home, ".hermes"), "state.db");
  if (!fs.existsSync(file)) return { conversations: [], problems: [], source: null };
  const conversations: Conversation[] = [];
  const problems: string[] = [];
  let db: SqliteDb;
  try {
    db = await openReadOnly(file);
  } catch (error) {
    return { conversations, problems: [`${file}: ${(error as Error).message}`], source: file };
  }
  try {
    const sessionCols = columns(db, "sessions");
    const messageCols = columns(db, "messages");
    if (!sessionCols.has("id") || !messageCols.has("content") || !messageCols.has("timestamp")) {
      return {
        conversations,
        problems: [`${file}: this Hermes version's database layout isn't one the importer knows`],
        source: file,
      };
    }
    const repo = sessionCols.has("git_repo_root") ? "git_repo_root" : "NULL AS git_repo_root";
    const sessions = db.prepare(`SELECT id, ${repo} FROM sessions`).all();
    const compressed = messageCols.has("_compressed_summary") ? "AND _compressed_summary = 0" : "";
    const messages = db.prepare(
      `SELECT role, content, timestamp FROM messages WHERE session_id = ? AND role IN ('user','assistant') ${compressed} ORDER BY timestamp, id`,
    );
    for (const s of sessions) {
      const id = String(s.id);
      try {
        const turns: Turn[] = [];
        for (const m of messages.all(id)) {
          const ts = toIso(m.timestamp);
          const text = typeof m.content === "string" ? m.content.trim() : "";
          if (ts && text && (m.role === "user" || m.role === "assistant")) {
            turns.push({ role: m.role, text, ts });
          }
        }
        // Hermes sends a project only inside a git repo (spec 078).
        const project =
          typeof s.git_repo_root === "string" && s.git_repo_root
            ? path.basename(s.git_repo_root)
            : undefined;
        const c = finish("hermes", id, turns, project);
        if (c) conversations.push(c);
      } catch (error) {
        problems.push(`Hermes session ${id}: ${(error as Error).message}`);
      }
    }
  } finally {
    db.close();
  }
  return { conversations, problems, source: file };
}

export async function readHarness(
  harness: HarnessId,
  home: string,
  env: Env = {},
): Promise<ReadResult> {
  switch (harness) {
    case "claude":
      return readClaude(home);
    case "codex":
      return readCodex(home);
    case "pi":
      return readPi(home);
    case "opencode":
      return readOpenCode(home, env);
    case "hermes":
      return readHermes(home, env);
  }
}
