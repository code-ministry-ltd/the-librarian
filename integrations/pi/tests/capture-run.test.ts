// runCapture — the per-turn auto-capture orchestration (Phase 2B / T-Pi).
//
// The Pi `agent_end` handler hands runCapture the completed turn's messages
// in-payload + the stable conv_id (from getSessionId()) + the process env. This
// ships that as a per-turn delta to POST /transcript, mirroring the Claude/Hermes
// adapter guarantees:
//   - per-turn delta built O(1) from the in-payload turn (no cursor, no re-read);
//   - forward-only private skip (a [private=on] turn + successors never ship);
//   - conv_id = the Pi session id (never $USER/cwd → no concurrent collision);
//   - fail-soft (never throws out of the handler, never blocks the turn);
//   - default-on, suppressed under private mode + LIBRARIAN_AUTO_SAVE=false;
//   - inert when the server intake gate is off; advance seq only on a 2xx ack.
//
// The network `post` is INJECTED so the orchestration is unit-testable without a
// running Pi or a socket.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCaptureState } from "../extensions/librarian/capture-state.js";
import { runCapture } from "../extensions/librarian/capture.js";
import type { CaptureAck } from "../extensions/librarian/transcript-post.js";

/** The injected ship's signature, so post.mock.calls[i] is a typed [url, payload, token]. */
type PostFn = (url: string, payload: unknown, token: string) => Promise<CaptureAck>;

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "pi-capture-run-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const ENV = {
  LIBRARIAN_MCP_URL: "https://librarian.example/mcp",
  LIBRARIAN_AGENT_TOKEN: "tok-test",
};

function okPost(ack: Partial<CaptureAck> = {}) {
  return vi.fn<PostFn>(async () => ({ ok: true, status: 200, buffered: 1, ...ack }));
}

function userMsg(text: string) {
  return { role: "user", content: text, timestamp: 1_700_000_000_000 };
}
function assistantMsg(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 1_700_000_000_000,
  };
}

// ---- happy path ----

describe("runCapture happy path (a public turn ships and advances seq)", () => {
  it("POSTs both halves with the session id as conv_id, harness:'pi', seq 1", async () => {
    const post = okPost();
    const res = await runCapture(
      { convId: "sess-1", messages: [userMsg("deploy?"), assistantMsg("make deploy")], env: ENV },
      { dataDir, post },
    );

    expect(res.posted).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    const [url, payload, token] = post.mock.calls[0]!;
    expect(url).toBe("https://librarian.example/transcript");
    expect(token).toBe("tok-test");
    expect(payload).toMatchObject({
      conv_id: "sess-1",
      harness: "pi",
      seq: 1,
      turns: [
        { role: "user", text: "deploy?" },
        { role: "assistant", text: "make deploy" },
      ],
    });
    expect(readCaptureState(dataDir, "sess-1").seq).toBe(1);
  });

  it("increments seq across turns", async () => {
    const post = okPost();
    await runCapture({ convId: "s", messages: [userMsg("q1")], env: ENV }, { dataDir, post });
    await runCapture({ convId: "s", messages: [userMsg("q2")], env: ENV }, { dataDir, post });
    expect(post.mock.calls.map((c) => (c[1] as { seq: number }).seq)).toEqual([1, 2]);
  });

  it("labels the payload with the project it is given (spec 078), and omits it otherwise", async () => {
    const post = okPost();
    await runCapture(
      { convId: "a", messages: [userMsg("q1")], env: ENV, project: "pi-repo" },
      { dataDir, post },
    );
    await runCapture(
      { convId: "b", messages: [userMsg("q1")], env: ENV, project: null },
      { dataDir, post },
    );
    expect((post.mock.calls[0]![1] as { project?: string }).project).toBe("pi-repo");
    expect(post.mock.calls[1]![1]).not.toHaveProperty("project");
  });
});

// ---- conv_id is required and never cwd/$USER ----

describe("conv_id discipline", () => {
  it("is a clean no-op when there is no conv_id (never falls back to cwd/$USER)", async () => {
    const post = okPost();
    const res = await runCapture(
      { convId: "", messages: [userMsg("q")], env: ENV },
      { dataDir, post },
    );
    expect(res.posted).toBe(false);
    expect(res.skipped).toBe("no-conv-id");
    expect(post).not.toHaveBeenCalled();
  });
});

// ---- config gate ----

describe("configuration gate (fail-soft)", () => {
  it("is a clean no-op without URL + token (re-ships once configured)", async () => {
    const post = okPost();
    const res = await runCapture(
      { convId: "s", messages: [userMsg("q")], env: {} },
      { dataDir, post },
    );
    expect(res.posted).toBe(false);
    expect(res.skipped).toBe("not-configured");
    expect(post).not.toHaveBeenCalled();
  });
});

// ---- kill-switch ----

describe("LIBRARIAN_AUTO_SAVE kill-switch (SC4)", () => {
  it("suppresses capture entirely when set to 'false'", async () => {
    const post = okPost();
    const res = await runCapture(
      { convId: "s", messages: [userMsg("q")], env: { ...ENV, LIBRARIAN_AUTO_SAVE: "false" } },
      { dataDir, post },
    );
    expect(res.skipped).toBe("auto-save-off");
    expect(post).not.toHaveBeenCalled();
  });

  it("is case-insensitive on 'false'", async () => {
    const post = okPost();
    await runCapture(
      { convId: "s", messages: [userMsg("q")], env: { ...ENV, LIBRARIAN_AUTO_SAVE: "FALSE" } },
      { dataDir, post },
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("treats any other value (unset, 'true', '1', '') as default-ON", async () => {
    for (const v of [undefined, "true", "1", "", "yes"]) {
      const post = okPost();
      const env = v === undefined ? ENV : { ...ENV, LIBRARIAN_AUTO_SAVE: v };
      await runCapture({ convId: "s", messages: [userMsg("q")], env }, { dataDir, post });
      expect(post, `value=${String(v)}`).toHaveBeenCalledTimes(1);
    }
  });
});

// ---- private mode: forward-only, carry-forward, never retroactive ----

describe("private mode (forward-only skip)", () => {
  it("a [private=on] turn does not ship and leaves the span open", async () => {
    const post = okPost();
    const res = await runCapture(
      { convId: "s", messages: [userMsg("[librarian:private=on] secret")], env: ENV },
      { dataDir, post },
    );
    expect(post).not.toHaveBeenCalled();
    expect(res.skipped).toBe("no-new-turns");
    expect(readCaptureState(dataDir, "s").private).toBe(true);
  });

  it("carries an open span forward across deltas; per-turn (Claude) semantics after =off", async () => {
    const post = okPost();
    // Delta 1: opens privacy → nothing public.
    await runCapture(
      {
        convId: "s",
        messages: [userMsg("[librarian:private=on] secret"), assistantMsg("ok")],
        env: ENV,
      },
      { dataDir, post },
    );
    // Delta 2: still in the open span (no marker) → nothing public.
    await runCapture(
      { convId: "s", messages: [userMsg("still secret")], env: ENV },
      { dataDir, post },
    );
    // Delta 3: =off closes the span (its marker turn is skipped), but the
    // assistant reply AFTER =off is genuinely public — per-turn filter, exactly
    // the Claude adapter's semantics (not Hermes's exchange-level skip).
    await runCapture(
      {
        convId: "s",
        messages: [userMsg("[librarian:private=off] back"), assistantMsg("hi")],
        env: ENV,
      },
      { dataDir, post },
    );
    // Delta 4: fully public.
    await runCapture(
      { convId: "s", messages: [userMsg("public again"), assistantMsg("sure")], env: ENV },
      { dataDir, post },
    );

    // Two public deltas shipped (deltas 3 and 4); the private turns NEVER shipped.
    expect(post).toHaveBeenCalledTimes(2);
    expect((post.mock.calls[0]![1] as { turns: unknown[] }).turns).toEqual([
      { role: "assistant", text: "hi", ts: "2023-11-14T22:13:20.000Z" },
    ]);
    expect((post.mock.calls[1]![1] as { turns: unknown[] }).turns).toEqual([
      { role: "user", text: "public again", ts: "2023-11-14T22:13:20.000Z" },
      { role: "assistant", text: "sure", ts: "2023-11-14T22:13:20.000Z" },
    ]);
    // The private content never appeared on the wire.
    for (const call of post.mock.calls) {
      expect(JSON.stringify(call[1])).not.toContain("secret");
    }
  });

  it("never ships the private turns even when private→public are in one delta", async () => {
    const post = okPost();
    await runCapture(
      {
        convId: "s",
        messages: [
          userMsg("[librarian:private=on] sensitive"),
          assistantMsg("noted"),
          userMsg("[librarian:private=off] done"),
          userMsg("a normal question"),
          assistantMsg("a normal answer"),
        ],
        env: ENV,
      },
      { dataDir, post },
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(post.mock.calls[0]![1])).not.toContain("sensitive");
  });
});

// ---- advance only on a 2xx ack ----

describe("advance-on-ack (idempotent re-ship)", () => {
  it("holds seq when the ship is not acked (non-2xx) so the delta re-ships", async () => {
    const post = vi.fn<PostFn>(async () => ({ ok: false, status: 500 }));
    await runCapture({ convId: "s", messages: [userMsg("q1")], env: ENV }, { dataDir, post });
    expect(readCaptureState(dataDir, "s").seq).toBe(0); // NOT advanced
    const post2 = okPost();
    await runCapture(
      { convId: "s", messages: [userMsg("q2")], env: ENV },
      { dataDir, post: post2 },
    );
    expect((post2.mock.calls[0]![1] as { seq: number }).seq).toBe(1); // still seq 1
  });

  it("holds seq when the ship throws (transient) and never throws out of runCapture", async () => {
    const post = vi.fn<PostFn>(async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await runCapture(
      { convId: "s", messages: [userMsg("q")], env: ENV },
      { dataDir, post },
    );
    expect(res.posted).toBe(false);
    expect(res.skipped).toBe("post-failed");
    expect(readCaptureState(dataDir, "s").seq).toBe(0);
  });

  it("a gate-off 2xx advances seq (the turn is just not captured while disabled)", async () => {
    const post = okPost({ ok: true, status: 200 });
    await runCapture({ convId: "s", messages: [userMsg("q")], env: ENV }, { dataDir, post });
    expect(readCaptureState(dataDir, "s").seq).toBe(1);
  });
});

// ---- explicit-end accelerator ----

describe("explicit-end accelerator", () => {
  it("ships an ended:true delta (even with no public turns) to flag the settle-sweep", async () => {
    const post = okPost();
    const res = await runCapture(
      { convId: "s", messages: [], env: ENV, ended: true },
      { dataDir, post },
    );
    expect(res.posted).toBe(true);
    expect((post.mock.calls[0]![1] as { ended?: boolean }).ended).toBe(true);
  });
});

// ---- nothing-to-ship + fail-soft posture ----

describe("no-op + fail-soft posture", () => {
  it("does not POST when there is no public text and the turn did not end", async () => {
    const post = okPost();
    const res = await runCapture(
      { convId: "s", messages: [{ role: "toolResult", content: [], isError: false }], env: ENV },
      { dataDir, post },
    );
    expect(post).not.toHaveBeenCalled();
    expect(res.skipped).toBe("no-new-turns");
  });

  it("never throws on garbage messages — returns a clean no-op", async () => {
    const post = okPost();
    const res = await runCapture(
      { convId: "s", messages: "not an array" as unknown as unknown[], env: ENV },
      { dataDir, post },
    );
    expect(res.posted).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
});
