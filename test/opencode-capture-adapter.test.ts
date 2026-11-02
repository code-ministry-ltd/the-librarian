// OpenCode auto-capture adapter — pure-logic unit tests + a live-server contract
// test. Spec 2026-06-16-harness-auto-capture, Phase 2A (OpenCode). Mirrors the
// Claude/Codex adapters' GUARANTEES (per-turn delta, forward-only private skip,
// advance-on-ack idempotency, fail-soft, header-token) — but OpenCode is a TS
// PLUGIN runtime, not a command-hook, so the capture rides the `chat.message`
// plugin hook and the per-turn delta is built from the session's MESSAGE LIST
// (read via the SDK client), NOT a JSONL transcript file.
//
// CONFIRMED `@opencode-ai/plugin` API (SP-OpenCode, vs mem0's usage). The live
// typed surface (@opencode-ai/plugin@1.16.2 / @opencode-ai/sdk@1.16.2, read from
// the bun cache) is:
//   - `chat.message` hook: input `{ sessionID: string; agent?; model?;
//     messageID? }`, output `{ message: UserMessage; parts: Part[] }`. It fires
//     on the USER message — `output.message.role === "user"` — so a single fire
//     carries the user's text parts but NOT the assistant reply (the reply lands
//     on the NEXT fire's message list; the Claude "one turn behind" tolerance,
//     spec §8.2). `input.sessionID` is the stable per-conversation id.
//   - `client.session.messages({ path: { id: sessionID } })` returns the full
//     ordered message list as `{ info: Message; parts: Part[] }[]` — both user
//     and assistant turns with their text parts. This is how we get BOTH roles.
//   - A `TextPart` is `{ type:"text", text, synthetic?, ... }`; we keep real
//     prose and drop `synthetic` / reasoning / tool parts (mirrors mem0's
//     `extractUserText`, which filters `p.type==="text" && !p.synthetic`).
// DIVERGENCE FROM mem0: mem0 read prose only off `chat.message`'s `output.parts`
// (user side) and keyed memories by `$USER`/`app_id`; we instead read the WHOLE
// message list per `sessionID` to capture both roles, and key conv_id by
// `sessionID` ONLY (never `$USER`/cwd) so concurrent same-machine sessions can't
// collide — the explicit mem0 bug we avoid.
//
// SC1 e2e (capture against a RUNNING OpenCode) is DEFERRED/unverified — there is
// no `opencode` CLI on the build machine. It is satisfied here at the unit +
// live-LOCAL-server contract level: the delta the adapter ships validates against
// the REAL /transcript intake and buffers exactly the non-private turns.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "./helpers.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = path.join(REPO_ROOT, "integrations", "opencode", "plugin", "lib");

// Plain ESM `.mjs`, Node stdlib only (no build step, no @opencode-ai import) —
// import directly, exactly like the Codex adapter's lib tests.
const transcript = await import(path.join(LIB, "transcript.mjs"));
const cursor = await import(path.join(LIB, "cursor.mjs"));
const post = await import(path.join(LIB, "post.mjs"));
const capture = await import(path.join(LIB, "capture.mjs"));
const runtime = await import(path.join(LIB, "runtime.mjs"));

// ── OpenCode message-list fixture helpers ────────────────────────────────────
// Shape mirrors `client.session.messages(...)` → `{ info: Message; parts }[]`.

function userMsg(text: string, over: Record<string, unknown> = {}): unknown {
  return {
    info: { id: `u-${text.slice(0, 6)}`, role: "user", time: { created: 1_750_000_000_000 } },
    parts: [{ type: "text", text }],
    ...over,
  };
}

function assistantMsg(text: string, over: Record<string, unknown> = {}): unknown {
  return {
    info: {
      id: `a-${text.slice(0, 6)}`,
      role: "assistant",
      time: { created: 1_750_000_001_000, completed: 1_750_000_002_000 },
    },
    parts: [{ type: "text", text }],
    ...over,
  };
}

// ── payload build: stamps harness:"opencode" ────────────────────────────────

describe("opencode payload build", () => {
  it('builds the uniform contract delta with harness:"opencode"', () => {
    const payload = transcript.buildPayload({
      convId: "ses_abc",
      seq: 3,
      turns: [{ role: "user", text: "hi", ts: "2026-06-17T10:00:00.000Z" }],
      ended: true,
    });
    expect(payload.conv_id).toBe("ses_abc");
    expect(payload.harness).toBe("opencode");
    expect(payload.seq).toBe(3);
    expect(payload.turns).toEqual([{ role: "user", text: "hi", ts: "2026-06-17T10:00:00.000Z" }]);
    expect(payload.ended).toBe(true);
  });

  it("omits `ended` when not a session end", () => {
    const payload = transcript.buildPayload({ convId: "s", seq: 0, turns: [], ended: false });
    expect(payload.ended).toBeUndefined();
  });
});

// ── conv_id derivation: sessionID only, NEVER $USER/cwd (SC5) ────────────────

describe("conv_id derivation (SC5 — stable sessionID, never $USER/cwd)", () => {
  it("uses input.sessionID when present", () => {
    expect(transcript.deriveConvId({ sessionID: "ses_xyz" })).toBe("ses_xyz");
  });

  it("returns null when no sessionID (clean no-op upstream, never cwd/$USER)", () => {
    expect(transcript.deriveConvId({})).toBeNull();
    expect(transcript.deriveConvId({ sessionID: "" })).toBeNull();
    expect(transcript.deriveConvId({ cwd: "/home/alice/project" })).toBeNull();
  });

  // PIN: `@opencode-ai/plugin@1.16.2` declares `"chat.message"` input.sessionID as
  // a REQUIRED string (dist/index.d.ts:187-188). conv_id is therefore that
  // sessionID verbatim; a missing/blank one degrades to a clean no-op (no throw,
  // nothing shipped) — the safe fail-direction. The runCapture no-op assertion
  // lives below ("clean no-op (no conv_id) when sessionID is absent").
  it("derives conv_id from input.sessionID verbatim (the documented chat.message field)", () => {
    expect(transcript.deriveConvId({ sessionID: "ses_real" })).toBe("ses_real");
  });
});

// ── messages → turns: both roles, drop synthetic/tool/reasoning (SC1) ────────

describe("opencode messages → turns extraction", () => {
  it("extracts user + assistant prose in order from the message list", () => {
    const turns = transcript.messagesToTurns([
      userMsg("how do I run tests?"),
      assistantMsg("use pnpm test"),
    ]);
    expect(turns.map((t: { role: string; text: string }) => [t.role, t.text])).toEqual([
      ["user", "how do I run tests?"],
      ["assistant", "use pnpm test"],
    ]);
  });

  it("joins multiple text parts of one message and carries an ISO ts from time.created", () => {
    const turns = transcript.messagesToTurns([
      {
        info: { id: "u1", role: "user", time: { created: 1_750_000_000_000 } },
        parts: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
      },
    ]);
    expect(turns[0].text).toBe("line one\nline two");
    expect(turns[0].ts).toBe(new Date(1_750_000_000_000).toISOString());
  });

  it("skips the compaction recap (assistant message flagged summary:true)", () => {
    const turns = transcript.messagesToTurns([
      userMsg("carry on"),
      {
        info: { id: "a0", role: "assistant", summary: true, time: { created: 2 } },
        parts: [{ type: "text", text: "Summary of the conversation so far…" }],
      },
      assistantMsg("on it"),
    ]);
    expect(turns.map((t: { text: string }) => t.text)).toEqual(["carry on", "on it"]);
  });

  it("drops synthetic text parts, reasoning, and tool parts (prose only)", () => {
    const turns = transcript.messagesToTurns([
      {
        info: { id: "a1", role: "assistant", time: { created: 1 } },
        parts: [
          { type: "reasoning", text: "thinking..." },
          { type: "text", text: "real answer" },
          { type: "text", text: "injected ctx", synthetic: true },
          { type: "tool", tool: "bash", state: {} },
        ],
      },
    ]);
    expect(turns.map((t: { text: string }) => t.text)).toEqual(["real answer"]);
  });

  it("skips a message that has no real prose after extraction (tool-only turn)", () => {
    const turns = transcript.messagesToTurns([
      { info: { id: "a1", role: "assistant", time: { created: 1 } }, parts: [{ type: "tool" }] },
    ]);
    expect(turns).toEqual([]);
  });

  it("is fail-soft on a malformed message list (returns no turns, never throws)", () => {
    expect(transcript.messagesToTurns(null)).toEqual([]);
    expect(transcript.messagesToTurns(undefined)).toEqual([]);
    expect(transcript.messagesToTurns([null, 42, {}, { info: {} }])).toEqual([]);
  });
});

// ── private-span filter (SC2) ────────────────────────────────────────────────

describe("opencode private-span filter (SC2)", () => {
  it("skips every turn inside [private=on] … [private=off]", () => {
    const turns = [
      { role: "user", text: "public before" },
      { role: "user", text: "[librarian:private=on]" },
      { role: "assistant", text: "secret stuff" },
      { role: "user", text: "[librarian:private=off]" },
      { role: "assistant", text: "public after" },
    ];
    const { kept } = transcript.filterPrivateSpans(turns, { startPrivate: false });
    expect(kept.map((t: { text: string }) => t.text)).toEqual(["public before", "public after"]);
  });

  it("carries private state across runs (an unterminated span stays private)", () => {
    const run1 = transcript.filterPrivateSpans(
      [
        { role: "user", text: "[librarian:private=on]" },
        { role: "assistant", text: "hidden" },
      ],
      { startPrivate: false },
    );
    expect(run1.kept).toEqual([]);
    expect(run1.endPrivate).toBe(true);
    const run2 = transcript.filterPrivateSpans([{ role: "user", text: "now public" }], {
      startPrivate: run1.endPrivate,
    });
    expect(run2.kept).toEqual([]); // still private — span never closed
    const run3 = transcript.filterPrivateSpans(
      [
        { role: "user", text: "[librarian:private=off]" },
        { role: "user", text: "finally public" },
      ],
      { startPrivate: run2.endPrivate },
    );
    expect(run3.kept.map((t: { text: string }) => t.text)).toEqual(["finally public"]);
  });
});

// ── POST-URL derivation ──────────────────────────────────────────────────────

describe("opencode transcript URL derivation", () => {
  it("rewrites /mcp to /transcript on the same origin", () => {
    expect(post.deriveTranscriptUrl("https://librarian.example.com/mcp")).toBe(
      "https://librarian.example.com/transcript",
    );
  });
  it("returns null for an unusable URL (fail-soft upstream)", () => {
    expect(post.deriveTranscriptUrl("")).toBeNull();
    expect(post.deriveTranscriptUrl("not a url")).toBeNull();
  });
});

// ── in-memory cursor (SC3 advance-on-ack, SC5 per-conv isolation) ────────────

describe("opencode in-memory cursor (SC3 + SC5)", () => {
  it("a fresh conv reads as count 0, seq 0, not private", () => {
    const c = cursor.makeCursorStore();
    expect(c.read("ses_1")).toEqual({ count: 0, seq: 0, private: false });
  });

  it("two distinct sessionIDs keep two distinct cursors (concurrency, SC5)", () => {
    const c = cursor.makeCursorStore();
    c.write("ses_A", { count: 2, seq: 1, private: false });
    c.write("ses_B", { count: 9, seq: 5, private: true });
    expect(c.read("ses_A")).toEqual({ count: 2, seq: 1, private: false });
    expect(c.read("ses_B")).toEqual({ count: 9, seq: 5, private: true });
  });
});

// ── runtime glue: SDK message read + session-end detection (fail-soft) ───────
// The pure parts of the OpenCode-runtime bridge that the plugin entry leans on.
// They are tested here with fakes so the entry (which hard-imports
// @opencode-ai/plugin) stays a thin, logic-free shell.

describe("opencode runtime glue (readSessionMessages — fail-soft SDK read)", () => {
  it("returns the SDK client's `.data` message array", async () => {
    const messages = [userMsg("q"), assistantMsg("a")];
    const client = {
      session: {
        messages: async (opts: { path: { id: string } }) => {
          expect(opts.path.id).toBe("ses_1");
          return { data: messages };
        },
      },
    };
    const got = await runtime.readSessionMessages(client, "ses_1");
    expect(got).toBe(messages);
  });

  it("returns [] when the SDK call rejects (network/transport) — never throws", async () => {
    const client = {
      session: {
        messages: async () => {
          throw new Error("ECONNREFUSED");
        },
      },
    };
    await expect(runtime.readSessionMessages(client, "ses_1")).resolves.toEqual([]);
  });

  it("returns [] for a missing/garbage client or a non-array `.data`", async () => {
    expect(await runtime.readSessionMessages(undefined, "ses_1")).toEqual([]);
    expect(await runtime.readSessionMessages({}, "ses_1")).toEqual([]);
    expect(
      await runtime.readSessionMessages(
        { session: { messages: async () => ({ data: null }) } },
        "ses_1",
      ),
    ).toEqual([]);
  });
});

describe("opencode runtime glue (isSessionEndEvent — explicit-end accelerator)", () => {
  it("recognises a session.idle event as a conversation-end signal for the session", () => {
    expect(
      runtime.isSessionEndEvent(
        { type: "session.idle", properties: { sessionID: "ses_1" } },
        "ses_1",
      ),
    ).toBe(true);
  });

  it("ignores an idle event for a DIFFERENT session (no cross-session end)", () => {
    expect(
      runtime.isSessionEndEvent(
        { type: "session.idle", properties: { sessionID: "ses_OTHER" } },
        "ses_1",
      ),
    ).toBe(false);
  });

  it("ignores unrelated events and is fail-soft on garbage", () => {
    expect(runtime.isSessionEndEvent({ type: "message.updated" }, "ses_1")).toBe(false);
    expect(runtime.isSessionEndEvent(null, "ses_1")).toBe(false);
    expect(runtime.isSessionEndEvent(undefined, "ses_1")).toBe(false);
  });
});

// ── runCapture orchestration (SC2, SC3, SC4, SC5) ───────────────────────────

describe("opencode runCapture orchestration", () => {
  function fakePoster(ack: { ok: boolean; status?: number; buffered?: number }) {
    const calls: unknown[] = [];
    return {
      calls,
      post: async (_url: string, payload: unknown, _token: string) => {
        calls.push(payload);
        return { status: 200, ...ack };
      },
    };
  }

  const baseEnv = {
    LIBRARIAN_MCP_URL: "https://librarian.example.com/mcp",
    LIBRARIAN_AGENT_TOKEN: "agent-token",
  };

  function ctx(messages: unknown[]) {
    return { sessionID: "ses_1", messages, env: baseEnv };
  }

  it('ships the non-private delta with harness:"opencode" and advances the cursor on a 2xx ack (SC1)', async () => {
    const store = cursor.makeCursorStore();
    const poster = fakePoster({ ok: true });
    const result = await capture.runCapture(
      ctx([userMsg("how do I run tests?"), assistantMsg("pnpm test")]),
      { store, post: poster.post },
    );
    expect(result.posted).toBe(true);
    const payload = poster.calls[0] as {
      harness: string;
      conv_id: string;
      turns: { text: string }[];
    };
    expect(payload.harness).toBe("opencode");
    expect(payload.conv_id).toBe("ses_1");
    expect(payload.turns.map((t) => t.text)).toEqual(["how do I run tests?", "pnpm test"]);
    expect(store.read("ses_1")).toMatchObject({ count: 2, seq: 1 });
  });

  it("ships only the NEW turns on the next fire (per-turn delta, advance-on-ack SC3)", async () => {
    const store = cursor.makeCursorStore();
    const ok = fakePoster({ ok: true });
    await capture.runCapture(ctx([userMsg("q1"), assistantMsg("a1")]), { store, post: ok.post });
    // Next fire: the list now also has the prior assistant reply + a new user turn.
    const ok2 = fakePoster({ ok: true });
    const r2 = await capture.runCapture(
      {
        sessionID: "ses_1",
        messages: [userMsg("q1"), assistantMsg("a1"), userMsg("q2"), assistantMsg("a2")],
        env: baseEnv,
      },
      { store, post: ok2.post },
    );
    expect(r2.posted).toBe(true);
    expect((ok2.calls[0] as { turns: { text: string }[] }).turns.map((t) => t.text)).toEqual([
      "q2",
      "a2",
    ]);
    expect((ok2.calls[0] as { seq: number }).seq).toBe(2);
  });

  it("does NOT advance the cursor on a failed POST; the next fire re-ships (SC3 idempotent)", async () => {
    const store = cursor.makeCursorStore();
    const failing = fakePoster({ ok: false, status: 503 });
    await capture.runCapture(ctx([userMsg("q1"), assistantMsg("a1")]), {
      store,
      post: failing.post,
    });
    expect(store.read("ses_1")).toMatchObject({ count: 0, seq: 0 });
    const ok = fakePoster({ ok: true });
    const r2 = await capture.runCapture(ctx([userMsg("q1"), assistantMsg("a1")]), {
      store,
      post: ok.post,
    });
    expect(r2.posted).toBe(true);
    expect((ok.calls[0] as { turns: { text: string }[] }).turns.map((t) => t.text)).toEqual([
      "q1",
      "a1",
    ]);
  });

  it("forward-only private skip across fires: private then public never re-ships private (SC2)", async () => {
    const store = cursor.makeCursorStore();
    const ok = fakePoster({ ok: true });
    await capture.runCapture(ctx([userMsg("[librarian:private=on]"), assistantMsg("secret one")]), {
      store,
      post: ok.post,
    });
    expect(ok.calls).toHaveLength(0); // nothing public shipped
    expect(store.read("ses_1").private).toBe(true);
    expect(store.read("ses_1").count).toBe(2); // advanced past the private turns

    const ok2 = fakePoster({ ok: true });
    const r2 = await capture.runCapture(
      {
        sessionID: "ses_1",
        messages: [
          userMsg("[librarian:private=on]"),
          assistantMsg("secret one"),
          userMsg("[librarian:private=off]"),
          assistantMsg("public answer"),
        ],
        env: baseEnv,
      },
      { store, post: ok2.post },
    );
    expect(r2.posted).toBe(true);
    const payload = ok2.calls[0] as { turns: { text: string }[] };
    expect(payload.turns.map((t) => t.text)).toEqual(["public answer"]);
    expect(payload.turns.some((t) => t.text.includes("secret"))).toBe(false);
  });

  it("suppressed entirely when LIBRARIAN_AUTO_SAVE=false (per-machine kill-switch, SC4)", async () => {
    const store = cursor.makeCursorStore();
    const ok = fakePoster({ ok: true });
    const result = await capture.runCapture(
      {
        sessionID: "ses_1",
        messages: [userMsg("q"), assistantMsg("a")],
        env: { ...baseEnv, LIBRARIAN_AUTO_SAVE: "false" },
      },
      { store, post: ok.post },
    );
    expect(ok.calls).toHaveLength(0);
    expect(result.skipped).toBe("auto-save-off");
    expect(store.read("ses_1")).toMatchObject({ count: 0, seq: 0 });
  });

  it("treats LIBRARIAN_AUTO_SAVE values other than 'false' as on (default-on, SC4)", async () => {
    const store = cursor.makeCursorStore();
    const ok = fakePoster({ ok: true });
    const result = await capture.runCapture(
      {
        sessionID: "ses_1",
        messages: [userMsg("q"), assistantMsg("a")],
        env: { ...baseEnv, LIBRARIAN_AUTO_SAVE: "true" },
      },
      { store, post: ok.post },
    );
    expect(result.posted).toBe(true);
    expect(ok.calls).toHaveLength(1);
  });

  it("clean no-op (no conv_id) when sessionID is absent, NEVER cwd-keyed (SC5)", async () => {
    const store = cursor.makeCursorStore();
    const ok = fakePoster({ ok: true });
    const result = await capture.runCapture(
      { sessionID: "", messages: [userMsg("q"), assistantMsg("a")], env: baseEnv },
      { store, post: ok.post },
    );
    expect(ok.calls).toHaveLength(0);
    expect(result.skipped).toBe("no-conv-id");
  });

  it("fail-soft: a throwing poster resolves (no throw), cursor not advanced (SC3)", async () => {
    const store = cursor.makeCursorStore();
    const throwingPoster = {
      post: async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:1");
      },
    };
    let result: { posted: boolean } | undefined;
    await expect(
      (async () => {
        result = await capture.runCapture(ctx([userMsg("q"), assistantMsg("a")]), {
          store,
          post: throwingPoster.post,
        });
      })(),
    ).resolves.not.toThrow();
    expect(result?.posted).toBe(false);
    expect(store.read("ses_1")).toMatchObject({ count: 0, seq: 0 });
  });

  it("fail-soft: missing LIBRARIAN_MCP_URL / token is a clean no-op (SC3)", async () => {
    const store = cursor.makeCursorStore();
    const ok = fakePoster({ ok: true });
    const result = await capture.runCapture(
      { sessionID: "ses_1", messages: [userMsg("q"), assistantMsg("a")], env: {} },
      { store, post: ok.post },
    );
    expect(ok.calls).toHaveLength(0);
    expect(result.skipped).toBe("not-configured");
  });

  it("no new turns since the cursor → clean no-op, nothing shipped", async () => {
    const store = cursor.makeCursorStore();
    const ok = fakePoster({ ok: true });
    await capture.runCapture(ctx([userMsg("q"), assistantMsg("a")]), { store, post: ok.post });
    const ok2 = fakePoster({ ok: true });
    const r2 = await capture.runCapture(ctx([userMsg("q"), assistantMsg("a")]), {
      store,
      post: ok2.post,
    });
    expect(ok2.calls).toHaveLength(0);
    expect(r2.skipped).toBe("no-new-turns");
  });

  it("sets ended:true when the capture call is flagged a session end (explicit-end accelerator)", async () => {
    const store = cursor.makeCursorStore();
    const ok = fakePoster({ ok: true });
    await capture.runCapture(
      {
        sessionID: "ses_1",
        messages: [userMsg("bye"), assistantMsg("cya")],
        env: baseEnv,
        ended: true,
      },
      { store, post: ok.post },
    );
    expect((ok.calls[0] as { ended?: boolean }).ended).toBe(true);
  });
});

// ── plugin entry wiring (the thin shell over the pure .mjs core) ─────────────
// The entry hard-imports `@opencode-ai/plugin` (a Bun-runtime peer absent from
// this monorepo), so it can't be imported into vitest. We instead assert it stays
// a thin shell that wires the EXACT pure modules the suite proves — guarding
// against the entry drifting from the tested core.

describe("opencode plugin entry (librarian-capture.ts) wiring", () => {
  const ENTRY = path.join(REPO_ROOT, "integrations", "opencode", "plugin", "librarian-capture.ts");
  const src = fs.readFileSync(ENTRY, "utf8");

  it("imports the type from @opencode-ai/plugin and the pure .mjs core", () => {
    expect(src).toMatch(/import type \{ Plugin \} from "@opencode-ai\/plugin"/);
    expect(src).toContain('from "./lib/capture.mjs"');
    expect(src).toContain('from "./lib/cursor.mjs"');
    expect(src).toContain('from "./lib/runtime.mjs"');
  });

  it("rides the chat.message hook and exports a default plugin", () => {
    expect(src).toContain('"chat.message"');
    expect(src).toMatch(/export default/);
  });

  it("derives conv_id from sessionID and never reaches for $USER/cwd", () => {
    expect(src).toContain("input.sessionID");
    expect(src).not.toMatch(/process\.env\.USER|process\.cwd\(\)/);
  });

  it("every ./lib module the entry imports actually exists and loads", async () => {
    for (const mod of ["capture", "cursor", "runtime", "transcript", "post"]) {
      await expect(import(path.join(LIB, `${mod}.mjs`))).resolves.toBeTruthy();
    }
  });

  it("the integration README documents the auto-capture plugin (README is the contract)", () => {
    const readme = fs.readFileSync(
      path.join(REPO_ROOT, "integrations", "opencode", "README.md"),
      "utf8",
    );
    expect(readme.toLowerCase()).toContain("automatic capture");
    expect(readme).toContain("chat.message");
    expect(readme).toContain("LIBRARIAN_AUTO_SAVE");
  });
});

// ── live-server end-to-end (SC1, at contract level — true OpenCode e2e deferred) ─
// There is no `opencode` CLI on this build machine to drive a real turn, so SC1's
// FULL acceptance (a live OpenCode session) is DEFERRED/unverified. This proves the
// next-best thing: the exact delta the adapter ships validates against the REAL
// /transcript intake and buffers exactly the non-private turns.

describe("end-to-end against a live server (SC1 — contract level; true OpenCode e2e deferred)", () => {
  let serverDataDir = "";
  let server: Awaited<ReturnType<typeof startHttpServer>> | null = null;

  beforeEach(() => {
    serverDataDir = makeTempDir();
  });
  afterEach(async () => {
    if (server) await server.stop();
    server = null;
    if (serverDataDir) cleanupTempDir(serverDataDir);
    serverDataDir = "";
  });

  it("buffers the non-private turns server-side; private turns never land", async () => {
    server = await startHttpServer({ dataDir: serverDataDir, intake: "on" });
    const store = cursor.makeCursorStore();

    const result = await capture.runCapture(
      {
        sessionID: "ses-e2e",
        ended: true,
        messages: [
          userMsg("how do I run the tests in this repo?"),
          assistantMsg("run pnpm test from the repo root"),
          userMsg("[librarian:private=on]"),
          assistantMsg("my api token is hunter2"),
          userMsg("[librarian:private=off]"),
          userMsg("thanks, what about typecheck?"),
          assistantMsg("pnpm typecheck runs tsc across every workspace"),
        ],
        env: {
          LIBRARIAN_MCP_URL: `${server.url}/mcp`,
          LIBRARIAN_AGENT_TOKEN: server.agentToken,
        },
      },
      { store, post: post.postDelta },
    );

    expect(result.posted).toBe(true);
    expect(result.ack?.ok).toBe(true);
    expect(result.ack?.buffered).toBe(4);

    const bufferDir = path.join(serverDataDir, "transcripts");
    const bufferFiles = fs.readdirSync(bufferDir).filter((f) => f.endsWith(".md"));
    expect(bufferFiles).toHaveLength(1);
    const body = fs.readFileSync(path.join(bufferDir, bufferFiles[0]), "utf8");
    expect(body).toContain("how do I run the tests in this repo?");
    expect(body).toContain("pnpm typecheck runs tsc");
    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("[librarian:private=on]");
  });

  it("server refuses + buffers nothing when the intake gate is OFF (SC4 inert)", async () => {
    server = await startHttpServer({ dataDir: serverDataDir, intake: "off" });
    const store = cursor.makeCursorStore();
    const result = await capture.runCapture(
      {
        sessionID: "ses-e2e",
        messages: [userMsg("q"), assistantMsg("a")],
        env: {
          LIBRARIAN_MCP_URL: `${server.url}/mcp`,
          LIBRARIAN_AGENT_TOKEN: server.agentToken,
        },
      },
      { store, post: post.postDelta },
    );
    expect(result.ack?.ok).toBe(true);
    expect(result.ack?.buffered).toBeUndefined();
    const bufferDir = path.join(serverDataDir, "transcripts");
    expect(fs.existsSync(bufferDir) ? fs.readdirSync(bufferDir) : []).toEqual([]);
  });
});
