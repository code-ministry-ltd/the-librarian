// Claude `Stop` acquisition adapter — pure-logic unit tests + a live-server
// integration test (spec 2026-06-16-harness-auto-capture, T3).
//
// The hook entry (integrations/claude/scripts/on-stop.mjs) is a THIN shell over
// the pure modules under integrations/claude/scripts/lib/*.mjs. Everything that
// can go wrong (cursor slicing, JSONL→turns parse, private-span filter, payload
// build, POST-URL derivation, fail-soft orchestration) lives in those modules and
// is asserted here. These tests live in the root `test/` dir so the root
// `vitest run` (vitest.config.ts `include: test/**/*.test.ts`) picks them up under
// `pnpm test` — `integrations/claude` is not its own workspace package.
//
// Coverage map (spec §2 success criteria):
//   - SC2  idempotent: cursor advances ONLY on a 2xx ack; a failed POST leaves
//          the cursor so the next run re-ships the same delta.
//   - SC4  private skip: turns inside `[private=on]…[private=off]` never reach
//          the payload; a private-then-public sequence never retroactively ships
//          the private turns (forward-only cursor).
//   - SC15 concurrency: two distinct session_ids → two distinct cursor files;
//          pruning is age-based (a fresh sibling cursor is untouched).
//   - SC10 fail-soft: unreachable endpoint / malformed transcript → the runner
//          resolves (never throws), the cursor is NOT advanced, nothing leaks.
//   - SC1  end-to-end: against a REAL spawned server (startHttpServer, intake on)
//          the adapter buffers exactly the expected non-private turns.
//   - subagent skip: an `agent_id`-present Stop is a no-op.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "./helpers.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = path.join(REPO_ROOT, "integrations", "claude", "scripts", "lib");

// The pure modules are plain ESM `.mjs` (Node stdlib only, no build step) so they
// import directly here.
const transcript = await import(path.join(LIB, "transcript.mjs"));
const cursor = await import(path.join(LIB, "cursor.mjs"));
const post = await import(path.join(LIB, "post.mjs"));
const capture = await import(path.join(LIB, "capture.mjs"));

// ── JSONL fixture helpers ──────────────────────────────────────────────────
// Build a Claude-shaped transcript line (the §6 live-confirmed shape: top-level
// `type`, `message.role` + `message.content`, per-entry `timestamp`/`cwd`/
// `gitBranch`/`isSidechain`/`sessionId`).

function userLine(text: string, over: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    type: "user",
    isSidechain: false,
    timestamp: "2026-06-16T10:00:00.000Z",
    sessionId: "sess-1",
    cwd: "/repo",
    gitBranch: "main",
    message: { role: "user", content: text },
    ...over,
  })}\n`;
}

function assistantLine(text: string, over: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    type: "assistant",
    isSidechain: false,
    timestamp: "2026-06-16T10:00:01.000Z",
    sessionId: "sess-1",
    cwd: "/repo",
    gitBranch: "main",
    message: { role: "assistant", content: [{ type: "text", text }] },
    ...over,
  })}\n`;
}

// ── parse: JSONL → turns ────────────────────────────────────────────────────

describe("parse: JSONL entries → user/assistant turns", () => {
  it("extracts user (string content) and assistant (text-block) turns, in order", () => {
    const jsonl = userLine("how do I run tests?") + assistantLine("use pnpm test");
    const turns = transcript.entriesToTurns(transcript.parseEntries(jsonl));
    expect(turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "how do I run tests?"],
      ["assistant", "use pnpm test"],
    ]);
  });

  it("ignores non-message entries (mode, system, file-history-snapshot)", () => {
    const jsonl =
      `${JSON.stringify({ type: "mode", sessionId: "sess-1" })}\n` +
      `${JSON.stringify({ type: "file-history-snapshot" })}\n` +
      `${JSON.stringify({ type: "system", message: { role: "system", content: "x" } })}\n` +
      userLine("real question");
    const turns = transcript.entriesToTurns(transcript.parseEntries(jsonl));
    expect(turns).toEqual([
      { role: "user", text: "real question", ts: "2026-06-16T10:00:00.000Z" },
    ]);
  });

  it("skips subagent/sidechain entries (isSidechain:true) — defense in depth", () => {
    const jsonl = userLine("main turn") + assistantLine("sidechain noise", { isSidechain: true });
    const turns = transcript.entriesToTurns(transcript.parseEntries(jsonl));
    expect(turns.map((t) => t.text)).toEqual(["main turn"]);
  });

  it("skips Claude Code's compaction summary (isCompactSummary:true) — it would re-feed the whole recap", () => {
    const jsonl =
      userLine("This session is being continued from a previous conversation…", {
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      }) +
      userLine("carry on") +
      assistantLine("on it");
    const turns = transcript.entriesToTurns(transcript.parseEntries(jsonl));
    expect(turns.map((t) => t.text)).toEqual(["carry on", "on it"]);
  });

  it("drops assistant tool_use / thinking blocks, keeps text only", () => {
    const line = `${JSON.stringify({
      type: "assistant",
      isSidechain: false,
      sessionId: "sess-1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret reasoning" },
          { type: "text", text: "the answer" },
          { type: "tool_use", id: "t1", name: "Bash", input: {} },
        ],
      },
    })}\n`;
    const turns = transcript.entriesToTurns(transcript.parseEntries(line));
    expect(turns).toEqual([{ role: "assistant", text: "the answer" }]);
  });

  it("drops user tool_result entries (not real user prose)", () => {
    const line = `${JSON.stringify({
      type: "user",
      isSidechain: false,
      sessionId: "sess-1",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    })}\n`;
    const turns = transcript.entriesToTurns(transcript.parseEntries(line));
    expect(turns).toEqual([]);
  });

  it("skips isMeta entries (local-command caveats)", () => {
    const jsonl = userLine("caveat", { isMeta: true }) + userLine("real");
    const turns = transcript.entriesToTurns(transcript.parseEntries(jsonl));
    expect(turns.map((t) => t.text)).toEqual(["real"]);
  });

  it("tolerates a partial trailing line (mid-write) without throwing", () => {
    const jsonl = userLine("complete") + '{"type":"assistant","message":{"rol';
    const entries = transcript.parseEntries(jsonl);
    const turns = transcript.entriesToTurns(entries);
    expect(turns.map((t) => t.text)).toEqual(["complete"]);
  });
});

// ── byte-accurate complete-line boundary (C1/I1) ────────────────────────────
// completeLineBytes finds one-past-the-last-`\n` in a window Buffer so the cursor
// advances to a precise line boundary (never mid-line) and is byte-exact under
// UTF-8 multibyte (string index ≠ byte offset).

describe("completeLineBytes: byte-accurate complete-line boundary", () => {
  it("returns one past the LAST newline (the complete-line prefix length)", () => {
    const buf = Buffer.from("alpha\nbeta\npartial-no-newline");
    // "alpha\nbeta\n" = 11 bytes; the trailing partial is excluded.
    expect(transcript.completeLineBytes(buf)).toBe(11);
  });

  it("returns 0 when the window holds no newline (one giant unterminated line)", () => {
    expect(transcript.completeLineBytes(Buffer.from("no-newline-here"))).toBe(0);
    expect(transcript.completeLineBytes(Buffer.alloc(0))).toBe(0);
  });

  it("is byte-exact across a multibyte (emoji) line, not a string index", () => {
    const line = `${JSON.stringify({ msg: "ship it 🚀 done" })}\n`;
    const buf = Buffer.from(line, "utf8");
    // The boundary is the BYTE length (emoji is 4 UTF-8 bytes), which is strictly
    // greater than the string `.length` — proving we measure bytes, not chars.
    expect(transcript.completeLineBytes(buf)).toBe(buf.length);
    expect(buf.length).toBeGreaterThan(line.length);
  });
});

// ── private-span filter (SC4) ───────────────────────────────────────────────

describe("private-span filter (SC4)", () => {
  it("skips every turn inside [private=on] … [private=off]", () => {
    const turns = [
      { role: "user", text: "public before" },
      { role: "user", text: "[librarian:private=on]" },
      { role: "assistant", text: "secret stuff inside the span" },
      { role: "user", text: "[librarian:private=off]" },
      { role: "assistant", text: "public after" },
    ];
    const { kept } = transcript.filterPrivateSpans(turns, { startPrivate: false });
    expect(kept.map((t) => t.text)).toEqual(["public before", "public after"]);
  });

  it("treats a turn that merely contains the on-marker as private too", () => {
    const turns = [
      { role: "user", text: "switching now [librarian:private=on] for the next bit" },
      { role: "assistant", text: "hidden" },
      { role: "user", text: "done [librarian:private=off]" },
      { role: "assistant", text: "visible" },
    ];
    const { kept } = transcript.filterPrivateSpans(turns, { startPrivate: false });
    expect(kept.map((t) => t.text)).toEqual(["visible"]);
  });

  it("carries private state across runs: an unterminated span stays private next run", () => {
    const run1 = transcript.filterPrivateSpans(
      [
        { role: "user", text: "[librarian:private=on]" },
        { role: "assistant", text: "still hidden when run1 ended" },
      ],
      { startPrivate: false },
    );
    expect(run1.kept).toEqual([]);
    expect(run1.endPrivate).toBe(true);

    // Next run begins still inside the span (carry-forward) — must stay private
    // until an explicit =off.
    const run2 = transcript.filterPrivateSpans(
      [
        { role: "assistant", text: "more hidden" },
        { role: "user", text: "[librarian:private=off]" },
        { role: "user", text: "now public" },
      ],
      { startPrivate: run1.endPrivate },
    );
    expect(run2.kept.map((t) => t.text)).toEqual(["now public"]);
    expect(run2.endPrivate).toBe(false);
  });
});

// ── payload build ───────────────────────────────────────────────────────────

describe("payload build", () => {
  it("builds the uniform contract delta (conv_id, harness, seq, turns, ended)", () => {
    const payload = transcript.buildPayload({
      sessionId: "sess-xyz",
      seq: 3,
      turns: [{ role: "user", text: "hi", ts: "2026-06-16T10:00:00.000Z" }],
      ended: true,
    });
    expect(payload.conv_id).toBe("sess-xyz");
    expect(payload.harness).toBe("claude");
    expect(payload.seq).toBe(3);
    expect(payload.turns).toEqual([{ role: "user", text: "hi", ts: "2026-06-16T10:00:00.000Z" }]);
    expect(payload.ended).toBe(true);
  });

  it("omits `ended` when not a session end", () => {
    const payload = transcript.buildPayload({ sessionId: "s", seq: 0, turns: [], ended: false });
    expect(payload.ended).toBeUndefined();
  });
});

// ── POST-URL derivation ─────────────────────────────────────────────────────

describe("transcript URL derivation from LIBRARIAN_MCP_URL", () => {
  it("rewrites the /mcp path to /transcript on the same origin", () => {
    expect(post.deriveTranscriptUrl("https://librarian.example.com/mcp")).toBe(
      "https://librarian.example.com/transcript",
    );
  });

  it("handles a bare-origin URL (no /mcp suffix)", () => {
    expect(post.deriveTranscriptUrl("https://librarian.example.com")).toBe(
      "https://librarian.example.com/transcript",
    );
  });

  it("preserves a port and ignores any query/hash", () => {
    expect(post.deriveTranscriptUrl("http://127.0.0.1:8080/mcp?x=1#f")).toBe(
      "http://127.0.0.1:8080/transcript",
    );
  });

  it("returns null for an unusable URL (fail-soft upstream)", () => {
    expect(post.deriveTranscriptUrl("")).toBeNull();
    expect(post.deriveTranscriptUrl("not a url")).toBeNull();
  });
});

// ── cursor (SC2 + SC15) ─────────────────────────────────────────────────────

describe("cursor file (SC2 advance-on-ack, SC15 per-session isolation)", () => {
  let dataDir = "";
  beforeEach(() => {
    dataDir = makeTempDir();
  });
  afterEach(() => {
    if (dataDir) cleanupTempDir(dataDir);
    dataDir = "";
  });

  it("a missing cursor reads as offset 0, seq 0, not private", () => {
    const c = cursor.readCursor(dataDir, "sess-1");
    expect(c).toEqual({ offset: 0, seq: 0, private: false });
  });

  it("round-trips offset/seq/private and is keyed by session_id", () => {
    cursor.writeCursor(dataDir, "sess-1", { offset: 42, seq: 7, private: true });
    expect(cursor.readCursor(dataDir, "sess-1")).toEqual({ offset: 42, seq: 7, private: true });
  });

  it("two distinct session_ids use two distinct cursor files (SC15)", () => {
    cursor.writeCursor(dataDir, "sess-A", { offset: 10, seq: 1, private: false });
    cursor.writeCursor(dataDir, "sess-B", { offset: 99, seq: 5, private: true });
    expect(cursor.readCursor(dataDir, "sess-A")).toEqual({ offset: 10, seq: 1, private: false });
    expect(cursor.readCursor(dataDir, "sess-B")).toEqual({ offset: 99, seq: 5, private: true });
    expect(cursor.cursorPath(dataDir, "sess-A")).not.toBe(cursor.cursorPath(dataDir, "sess-B"));
  });

  it("sanitizes a path-traversal session_id to a single safe segment", () => {
    const p = cursor.cursorPath(dataDir, "../../etc/passwd");
    expect(path.dirname(p)).toBe(path.join(dataDir, "cursors"));
    expect(p.includes("..")).toBe(false);
  });

  it("age-based pruning drops only stale cursors; a fresh sibling is untouched (SC15)", () => {
    cursor.writeCursor(dataDir, "stale", { offset: 1, seq: 1, private: false });
    cursor.writeCursor(dataDir, "fresh", { offset: 2, seq: 2, private: false });
    // Backdate the stale cursor 8 days.
    const stalePath = cursor.cursorPath(dataDir, "stale");
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.utimesSync(stalePath, eightDaysAgo / 1000, eightDaysAgo / 1000);

    cursor.pruneOldCursors(dataDir, 7 * 24 * 60 * 60 * 1000);

    expect(fs.existsSync(stalePath)).toBe(false);
    expect(fs.existsSync(cursor.cursorPath(dataDir, "fresh"))).toBe(true);
  });

  it("pruning never throws on a missing cursors dir", () => {
    expect(() => cursor.pruneOldCursors(path.join(dataDir, "nope"), 1000)).not.toThrow();
  });
});

// ── runner orchestration (SC2, SC4, SC10, subagent skip) ────────────────────

describe("runCapture orchestration", () => {
  let dataDir = "";
  let transcriptPath = "";

  beforeEach(() => {
    dataDir = makeTempDir();
    transcriptPath = path.join(dataDir, "sess-1.jsonl");
  });
  afterEach(() => {
    if (dataDir) cleanupTempDir(dataDir);
    dataDir = "";
  });

  // A fake POST that records calls and returns a configurable ack.
  function fakePoster(ack: { ok: boolean }) {
    const calls: unknown[] = [];
    return {
      calls,
      post: async (_url: string, payload: unknown, _token: string) => {
        calls.push(payload);
        return ack;
      },
    };
  }

  const baseEnv = {
    LIBRARIAN_MCP_URL: "https://librarian.example.com/mcp",
    LIBRARIAN_AGENT_TOKEN: "agent-token",
    CLAUDE_PLUGIN_DATA: "", // filled per-test to the temp dataDir
  };

  it("skips entirely when agent_id is present (subagent Stop is a no-op)", async () => {
    fs.writeFileSync(transcriptPath, userLine("x") + assistantLine("y"));
    const poster = fakePoster({ ok: true });
    const result = await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "sess-1", agent_id: "sub-7" },
      { ...baseEnv, CLAUDE_PLUGIN_DATA: dataDir },
      { post: poster.post },
    );
    expect(result.skipped).toBe("subagent");
    expect(poster.calls).toHaveLength(0);
    // No cursor file created.
    expect(fs.existsSync(cursor.cursorPath(dataDir, "sess-1"))).toBe(false);
  });

  it("ships the non-private delta and advances the cursor on a 2xx ack", async () => {
    fs.writeFileSync(transcriptPath, userLine("how do I run tests?") + assistantLine("pnpm test"));
    const poster = fakePoster({ ok: true });
    const result = await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "sess-1" },
      { ...baseEnv, CLAUDE_PLUGIN_DATA: dataDir },
      { post: poster.post },
    );
    expect(result.posted).toBe(true);
    expect(poster.calls).toHaveLength(1);
    const payload = poster.calls[0] as { turns: { text: string }[]; conv_id: string; seq: number };
    expect(payload.conv_id).toBe("sess-1");
    expect(payload.turns.map((t) => t.text)).toEqual(["how do I run tests?", "pnpm test"]);
    // Cursor advanced to EOF, seq bumped.
    const c = cursor.readCursor(dataDir, "sess-1");
    expect(c.offset).toBe(fs.statSync(transcriptPath).size);
    expect(c.seq).toBe(1);
  });

  it("does NOT advance the cursor on a failed POST; the next run re-ships (SC2)", async () => {
    fs.writeFileSync(transcriptPath, userLine("q1") + assistantLine("a1"));
    const failing = fakePoster({ ok: false });
    const failedRun = await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "sess-1" },
      { ...baseEnv, CLAUDE_PLUGIN_DATA: dataDir },
      { post: failing.post },
    );
    expect(failedRun.posted).toBe(false);
    // Cursor untouched (offset still 0).
    expect(cursor.readCursor(dataDir, "sess-1").offset).toBe(0);

    // Recovery run: the SAME delta is re-shipped (idempotent at the cursor level).
    const ok = fakePoster({ ok: true });
    const r2 = await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "sess-1" },
      { ...baseEnv, CLAUDE_PLUGIN_DATA: dataDir },
      { post: ok.post },
    );
    expect(r2.posted).toBe(true);
    const payload = ok.calls[0] as { turns: { text: string }[] };
    expect(payload.turns.map((t) => t.text)).toEqual(["q1", "a1"]);
    // Now advanced.
    expect(cursor.readCursor(dataDir, "sess-1").offset).toBe(fs.statSync(transcriptPath).size);
  });

  it("a successful run advances past shipped turns: the next run re-ships nothing (SC2)", async () => {
    fs.writeFileSync(transcriptPath, userLine("q1") + assistantLine("a1"));
    const ok = fakePoster({ ok: true });
    await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "sess-1" },
      { ...baseEnv, CLAUDE_PLUGIN_DATA: dataDir },
      { post: ok.post },
    );
    // Second run, no new bytes appended → nothing to ship, no POST.
    const r2 = await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "sess-1" },
      { ...baseEnv, CLAUDE_PLUGIN_DATA: dataDir },
      { post: ok.post },
    );
    expect(r2.posted).toBe(false);
    expect(r2.skipped).toBe("no-new-turns");
    expect(ok.calls).toHaveLength(1); // only the first run posted
  });

  it("forward-only private skip: a private span then public never re-ships the private turns (SC4)", async () => {
    // Run 1: open a private span; nothing public to ship → no POST, but the
    // cursor MUST advance past the private turns (skip-and-advance) and persist
    // the open private state.
    fs.writeFileSync(
      transcriptPath,
      userLine("[librarian:private=on]") + assistantLine("secret one"),
    );
    const ok = fakePoster({ ok: true });
    await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "sess-1" },
      { ...baseEnv, CLAUDE_PLUGIN_DATA: dataDir },
      { post: ok.post },
    );
    expect(ok.calls).toHaveLength(0); // nothing public
    const c1 = cursor.readCursor(dataDir, "sess-1");
    expect(c1.offset).toBe(fs.statSync(transcriptPath).size); // advanced past private
    expect(c1.private).toBe(true); // span still open

    // Run 2: close the span, then a public turn. Only the public turn ships; the
    // earlier private turns are behind the cursor and can NEVER be re-shipped.
    fs.appendFileSync(
      transcriptPath,
      userLine("[librarian:private=off]") + assistantLine("public answer"),
    );
    const r2 = await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "sess-1" },
      { ...baseEnv, CLAUDE_PLUGIN_DATA: dataDir },
      { post: ok.post },
    );
    expect(r2.posted).toBe(true);
    const payload = ok.calls[0] as { turns: { text: string }[] };
    expect(payload.turns.map((t) => t.text)).toEqual(["public answer"]);
    expect(payload.turns.some((t) => t.text.includes("secret"))).toBe(false);
  });

  // ── C1: a half-written trailing line is RECOVERED, never lost ──────────────
  it("recovers a partial trailing line: run1 ships complete lines + holds the partial; run2 ships it once complete (C1)", async () => {
    // The file ends MID-LINE (a `Stop` fired while Claude was still flushing the
    // assistant turn). parseEntries skips the partial — but the cursor must NOT
    // advance over it (the old EOF-advance bug LOST the completed line forever).
    const completeUser = userLine("how do I run tests?");
    const partialTail = '{"type":"assistant","message":{"role":"assist'; // no newline
    fs.writeFileSync(transcriptPath, completeUser + partialTail);

    const ok = fakePoster({ ok: true });
    const r1 = await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "sess-1" },
      { ...baseEnv, CLAUDE_PLUGIN_DATA: dataDir },
      { post: ok.post },
    );
    expect(r1.posted).toBe(true);
    // Only the COMPLETE line shipped; the partial is withheld.
    expect((ok.calls[0] as { turns: { text: string }[] }).turns.map((t) => t.text)).toEqual([
      "how do I run tests?",
    ]);
    // The cursor stopped at the complete-line boundary — NOT at raw EOF.
    const c1 = cursor.readCursor(dataDir, "sess-1");
    expect(c1.offset).toBe(Buffer.byteLength(completeUser, "utf8"));
    expect(c1.offset).toBeLessThan(fs.statSync(transcriptPath).size);

    // The harness finishes the line (overwrites the torn tail with the full,
    // newline-terminated record). run2 must now ship the previously-partial turn —
    // it was NEVER lost.
    fs.writeFileSync(transcriptPath, completeUser + assistantLine("use pnpm test"));
    const r2 = await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "sess-1" },
      { ...baseEnv, CLAUDE_PLUGIN_DATA: dataDir },
      { post: ok.post },
    );
    expect(r2.posted).toBe(true);
    expect((ok.calls[1] as { turns: { text: string }[] }).turns.map((t) => t.text)).toEqual([
      "use pnpm test",
    ]);
    // Cursor now at the (new) EOF; nothing left.
    expect(cursor.readCursor(dataDir, "sess-1").offset).toBe(fs.statSync(transcriptPath).size);
  });

  // ── I1: a delta larger than MAX_SHIP_BYTES drains in bounded chunks ────────
  it("drains a >MAX_SHIP_BYTES backlog in bounded chunks across runs; the cursor advances each run (I1, no 413 livelock)", async () => {
    // Build a transcript well over the 256 KiB client ship cap so a single POST
    // would exceed the server's 1 MiB body cap on a naive read-to-EOF. Each turn
    // is padded so just a handful of lines cross the window boundary.
    const PAD = "x".repeat(4000);
    const lineCount = 120; // ~120 * ~4KB ≈ 480 KB > 256 KiB window
    let body = "";
    for (let i = 0; i < lineCount; i += 1) body += userLine(`turn ${i} ${PAD}`);
    fs.writeFileSync(transcriptPath, body);
    const totalSize = fs.statSync(transcriptPath).size;
    expect(totalSize).toBeGreaterThan(256 * 1024);

    const ok = fakePoster({ ok: true });
    const offsets: number[] = [];
    let runs = 0;
    // Drive the orchestrator repeatedly (as successive `Stop`s would) until the
    // cursor reaches EOF — it MUST make monotonic, bounded progress each run.
    for (;;) {
      const r = await capture.runCapture(
        { transcript_path: transcriptPath, session_id: "sess-1" },
        { ...baseEnv, CLAUDE_PLUGIN_DATA: dataDir },
        { post: ok.post },
      );
      runs += 1;
      const off = cursor.readCursor(dataDir, "sess-1").offset;
      offsets.push(off);
      expect(r.posted).toBe(true); // every window had public turns to ship
      if (off >= totalSize) break;
      if (runs > 50) throw new Error("did not drain — possible livelock");
    }

    // It took MORE THAN ONE run (the backlog was chunked, not shipped whole).
    expect(runs).toBeGreaterThan(1);
    // No single shipped window exceeded the cap (each POST body stays under 256 KiB
    // of raw bytes → comfortably under the 1 MiB server cap).
    for (const call of ok.calls) {
      const bytes = Buffer.byteLength(JSON.stringify(call), "utf8");
      expect(bytes).toBeLessThan(256 * 1024);
    }
    // The cursor advanced monotonically and finished exactly at EOF.
    for (let i = 1; i < offsets.length; i += 1) expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
    expect(offsets[offsets.length - 1]).toBe(totalSize);
    // Every turn was shipped exactly once across the runs (none lost at a boundary).
    const shipped = ok.calls.flatMap((c) => (c as { turns: { text: string }[] }).turns);
    expect(shipped).toHaveLength(lineCount);
  });

  // ── C1/I1: byte-accurate advance under UTF-8 multibyte ─────────────────────
  it("advances the cursor by BYTES (not string length) across a multibyte/emoji turn (C1)", async () => {
    // An emoji is 4 UTF-8 bytes but contributes fewer to String.length / 1-2 UTF-16
    // code units — if the advance used a string index the cursor would land
    // mid-codepoint and corrupt the next read. Assert it lands on the byte EOF.
    fs.writeFileSync(
      transcriptPath,
      userLine("deploy 🚀 to prod 🎉") + assistantLine("done ✅ shipping 🔥"),
    );
    const byteSize = fs.statSync(transcriptPath).size;
    const ok = fakePoster({ ok: true });
    const r = await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "sess-1" },
      { ...baseEnv, CLAUDE_PLUGIN_DATA: dataDir },
      { post: ok.post },
    );
    expect(r.posted).toBe(true);
    expect((ok.calls[0] as { turns: { text: string }[] }).turns.map((t) => t.text)).toEqual([
      "deploy 🚀 to prod 🎉",
      "done ✅ shipping 🔥",
    ]);
    // The advance is the BYTE size of the file, not the (smaller) string length.
    const advanced = cursor.readCursor(dataDir, "sess-1").offset;
    expect(advanced).toBe(byteSize);

    // A clean next run finds nothing new (the byte offset was exact — no mid-line
    // re-read of a stray continuation byte).
    const r2 = await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "sess-1" },
      { ...baseEnv, CLAUDE_PLUGIN_DATA: dataDir },
      { post: ok.post },
    );
    expect(r2.skipped).toBe("no-new-turns");
    expect(ok.calls).toHaveLength(1);
  });

  // ── I1: a single line longer than the window must skip-and-advance, not livelock ──
  it("skip-and-advances past a single line that exceeds MAX_SHIP_BYTES (never livelocks)", async () => {
    // One pathological JSON line bigger than the 256 KiB window, then a normal
    // complete line after it. The giant line can never be shipped (it would exceed
    // the server cap) AND has no newline within the window — the orchestrator must
    // advance past the window so the cursor progresses, then drain the rest.
    const giant = `${JSON.stringify({
      type: "user",
      isSidechain: false,
      sessionId: "sess-1",
      message: { role: "user", content: `g${"X".repeat(400 * 1024)}` },
    })}\n`;
    const normal = userLine("after the giant line");
    fs.writeFileSync(transcriptPath, giant + normal);
    const totalSize = fs.statSync(transcriptPath).size;

    const ok = fakePoster({ ok: true });
    const offsets: number[] = [];
    let sawOversizedSkip = false;
    let runs = 0;
    for (;;) {
      const r = await capture.runCapture(
        { transcript_path: transcriptPath, session_id: "sess-1" },
        { ...baseEnv, CLAUDE_PLUGIN_DATA: dataDir },
        { post: ok.post },
      );
      runs += 1;
      if (r.skipped === "oversized-line") sawOversizedSkip = true;
      const off = cursor.readCursor(dataDir, "sess-1").offset;
      offsets.push(off);
      if (off >= totalSize) break;
      if (runs > 50) throw new Error("livelock: cursor never reached EOF");
    }
    // The pathological window was skipped (the cursor advanced past it).
    expect(sawOversizedSkip).toBe(true);
    // Monotonic progress to EOF — no livelock.
    for (let i = 1; i < offsets.length; i += 1) expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
    expect(offsets[offsets.length - 1]).toBe(totalSize);
    // The normal line AFTER the giant one still got shipped (drain continued).
    const shipped = ok.calls.flatMap((c) => (c as { turns: { text: string }[] }).turns);
    expect(shipped.map((t) => t.text)).toContain("after the giant line");
  });

  it("fail-soft: an unreachable endpoint resolves (no throw), cursor not advanced (SC10)", async () => {
    fs.writeFileSync(transcriptPath, userLine("q") + assistantLine("a"));
    const throwingPoster = {
      post: async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:1");
      },
    };
    let result: { posted: boolean } | undefined;
    await expect(
      (async () => {
        result = await capture.runCapture(
          { transcript_path: transcriptPath, session_id: "sess-1" },
          { ...baseEnv, CLAUDE_PLUGIN_DATA: dataDir },
          throwingPoster,
        );
      })(),
    ).resolves.not.toThrow();
    expect(result?.posted).toBe(false);
    expect(cursor.readCursor(dataDir, "sess-1").offset).toBe(0);
  });

  it("fail-soft: a missing transcript file is a clean no-op (SC10)", async () => {
    const ok = fakePoster({ ok: true });
    let result: { skipped?: string } | undefined;
    await expect(
      (async () => {
        result = await capture.runCapture(
          { transcript_path: path.join(dataDir, "does-not-exist.jsonl"), session_id: "sess-1" },
          { ...baseEnv, CLAUDE_PLUGIN_DATA: dataDir },
          { post: ok.post },
        );
      })(),
    ).resolves.not.toThrow();
    expect(ok.calls).toHaveLength(0);
    expect(result?.skipped).toBe("no-transcript");
  });

  it("fail-soft: missing LIBRARIAN_MCP_URL / token is a clean no-op (SC10)", async () => {
    fs.writeFileSync(transcriptPath, userLine("q") + assistantLine("a"));
    const ok = fakePoster({ ok: true });
    const result = await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "sess-1" },
      { CLAUDE_PLUGIN_DATA: dataDir }, // no URL/token
      { post: ok.post },
    );
    expect(ok.calls).toHaveLength(0);
    expect(result.skipped).toBe("not-configured");
    expect(cursor.readCursor(dataDir, "sess-1").offset).toBe(0);
  });

  it("passes ended:true when hook_event_name is SessionEnd (the explicit-end accelerator)", async () => {
    fs.writeFileSync(transcriptPath, userLine("bye") + assistantLine("cya"));
    const ok = fakePoster({ ok: true });
    await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "sess-1", hook_event_name: "SessionEnd" },
      { ...baseEnv, CLAUDE_PLUGIN_DATA: dataDir },
      { post: ok.post },
    );
    const payload = ok.calls[0] as { ended?: boolean };
    expect(payload.ended).toBe(true);
  });

  it("does NOT set ended on a plain per-turn Stop (only SessionEnd is the accelerator)", async () => {
    // PART A: SessionEnd is the explicit-end accelerator; a per-turn Stop must
    // leave `ended` unset so the server's idle settle-sweep owns the timing.
    fs.writeFileSync(transcriptPath, userLine("mid-turn") + assistantLine("still going"));
    const ok = fakePoster({ ok: true });
    await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "sess-1", hook_event_name: "Stop" },
      { ...baseEnv, CLAUDE_PLUGIN_DATA: dataDir },
      { post: ok.post },
    );
    const payload = ok.calls[0] as { ended?: boolean };
    expect(payload.ended).toBeUndefined();
  });

  it("ships the delta on a UserPromptSubmit hook exactly as Stop does, and does NOT set ended (Claude Stop-hook bug #29767)", async () => {
    // Plugin-scoped `Stop` hooks register but never fire in Claude Code (bug
    // #29767), so capture is driven primarily by `UserPromptSubmit` — which
    // carries the same `session_id` + `transcript_path` + `cwd`. The adapter
    // needs no per-event logic: it reads the cursor delta and ships it the same
    // way. `UserPromptSubmit` is NOT a session end, so `ended` stays unset (only
    // `SessionEnd` is the explicit-end accelerator); the server's idle
    // settle-sweep owns the extraction timing.
    fs.writeFileSync(
      transcriptPath,
      userLine("how do I run the linter?") + assistantLine("pnpm lint"),
    );
    const ok = fakePoster({ ok: true });
    const result = await capture.runCapture(
      {
        hook_event_name: "UserPromptSubmit",
        transcript_path: transcriptPath,
        session_id: "sess-1",
        cwd: "/repo",
      },
      { ...baseEnv, CLAUDE_PLUGIN_DATA: dataDir },
      { post: ok.post },
    );

    // Shipped the same delta the Stop path would.
    expect(result.posted).toBe(true);
    expect(ok.calls).toHaveLength(1);
    const payload = ok.calls[0] as {
      turns: { text: string }[];
      conv_id: string;
      ended?: boolean;
    };
    expect(payload.conv_id).toBe("sess-1");
    expect(payload.turns.map((t) => t.text)).toEqual(["how do I run the linter?", "pnpm lint"]);
    // NOT a session end — only SessionEnd sets `ended`.
    expect(payload.ended).toBeUndefined();
    // Cursor advanced to EOF and seq bumped, identical to the Stop path.
    const c = cursor.readCursor(dataDir, "sess-1");
    expect(c.offset).toBe(fs.statSync(transcriptPath).size);
    expect(c.seq).toBe(1);
  });
});

// ── live-server end-to-end (SC1) ────────────────────────────────────────────
// Spin up the REAL server with the intake gate ON and run the adapter logic
// against a transcript fixture; assert the server buffered exactly the expected
// (non-private) turns into its sidecar.

describe("end-to-end against a live server (SC1)", () => {
  let dataDir = "";
  let serverDataDir = "";
  let server: Awaited<ReturnType<typeof startHttpServer>> | null = null;
  let transcriptPath = "";

  beforeEach(() => {
    dataDir = makeTempDir(); // plugin data dir (cursor home)
    serverDataDir = makeTempDir(); // server data dir (buffer home)
    transcriptPath = path.join(dataDir, "sess-e2e.jsonl");
  });
  afterEach(async () => {
    if (server) await server.stop();
    server = null;
    if (dataDir) cleanupTempDir(dataDir);
    if (serverDataDir) cleanupTempDir(serverDataDir);
    dataDir = "";
    serverDataDir = "";
  });

  it("buffers the non-private turns server-side; private turns never land", async () => {
    server = await startHttpServer({ dataDir: serverDataDir, intake: "on" });

    fs.writeFileSync(
      transcriptPath,
      userLine("how do I run the tests in this repo?") +
        assistantLine("run pnpm test from the repo root") +
        userLine("[librarian:private=on]") +
        assistantLine("my api token is hunter2") +
        userLine("[librarian:private=off]") +
        userLine("thanks, what about typecheck?") +
        assistantLine("pnpm typecheck runs tsc across every workspace"),
    );

    const result = await capture.runCapture(
      { transcript_path: transcriptPath, session_id: "sess-e2e", hook_event_name: "Stop" },
      {
        LIBRARIAN_MCP_URL: `${server.url}/mcp`,
        LIBRARIAN_AGENT_TOKEN: server.agentToken,
        CLAUDE_PLUGIN_DATA: dataDir,
      },
      { post: post.postDelta },
    );

    expect(result.posted).toBe(true);
    expect(result.ack?.ok).toBe(true);
    // The server reports how many turns it buffered (post private-skip backstop).
    expect(result.ack?.buffered).toBe(4);

    // Inspect the server-side sidecar buffer: 4 non-private turns, no secret.
    const bufferDir = path.join(serverDataDir, "transcripts");
    const files = fs.readdirSync(bufferDir).sort();
    expect(files).toEqual(["sess-e2e.harness", "sess-e2e.md"]);
    expect(JSON.parse(fs.readFileSync(path.join(bufferDir, "sess-e2e.harness"), "utf8"))).toEqual({
      harness: "claude",
    });
    const body = fs.readFileSync(path.join(bufferDir, "sess-e2e.md"), "utf8");
    expect(body).toContain("how do I run the tests in this repo?");
    expect(body).toContain("pnpm typecheck runs tsc");
    // Private span content never reached the buffer.
    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("[librarian:private=on]");

    // Cursor advanced to EOF after the ack.
    expect(cursor.readCursor(dataDir, "sess-e2e").offset).toBe(fs.statSync(transcriptPath).size);
  }, 10_000);
});
