// Minimal HTTP routes coverage post-T7.1.
//
// The legacy /api/* REST surface and dashboard file serves have been
// retired (see http.test.ts / sessions.http.test.ts removed in T7.1).
// What remains is intentionally small: /healthz, /primer.md, /mcp +
// auth, and the tRPC mount. tRPC-specific behaviour is covered in
// tests/trpc/*. This suite just confirms the trimmed router still:
//   - exposes /healthz unauthenticated
//   - serves /primer.md unauthenticated (rethink T11 — the ONLY
//     unauthenticated content route) while /mcp still 401s
//   - 404s on unknown paths (no public dashboard files)
//   - protects /mcp with the admin/agent token
//   - 401s when no token is supplied on /mcp
//   - rejects browser origins not on the allow-list

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  makeTempDir,
  postJson,
  startHttpServer,
} from "../../../../test/helpers.js";

describe("HTTP routes (post-T7.1)", () => {
  it("exposes /healthz without auth", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir, token: "http-token" });
    try {
      const res = await fetch(`${server.url}/healthz`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("ok");
      expect(body.mcp_auth).toBe("enabled");
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("serves /primer.md without auth while an authenticated route still 401s (rethink T11)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir, token: "http-token" });
    try {
      // (i) The primer is served with NO bearer token, as markdown — the
      // OpenCode remote-URL instructions config has no way to attach one.
      const primer = await fetch(`${server.url}/primer.md`);
      expect(primer.status).toBe(200);
      expect(primer.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      const body = await primer.text();
      expect(body).toContain("The Librarian"); // the boot-seeded default primer
      expect(body).toContain("recall");

      // (ii) The auth bypass is scoped to exactly this path: a representative
      // authenticated route on the same server still rejects a token-less call.
      const mcp = await postJson(`${server.url}/mcp`, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
      });
      expect(mcp.response.status).toBe(401);

      // POSTing the primer path is not a write surface — anything but the
      // public GET falls through to the 404 floor.
      const post = await fetch(`${server.url}/primer.md`, { method: "POST", body: "x" });
      expect(post.status).toBe(404);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("returns 404 for legacy dashboard paths", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir, token: "http-token" });
    try {
      for (const pathname of ["/", "/styles.css", "/app.js", "/api/state", "/api/memories"]) {
        const res = await fetch(`${server.url}${pathname}`);
        expect(res.status, `${pathname} should 404`).toBe(404);
      }
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("requires a bearer token on /mcp and accepts the AGENT token (ADR 0008 P3)", async () => {
    const dataDir = makeTempDir();
    // Bound beyond localhost (the helper binds 0.0.0.0), so the no-auth bypass is
    // off: /mcp is gated by the AGENT token. The admin token is NOT a /mcp gate.
    const server = await startHttpServer({ dataDir, agentToken: "agent-token" });
    try {
      const unauth = await postJson(`${server.url}/mcp`, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      expect(unauth.response.status).toBe(401);

      const ok = await postJson(
        `${server.url}/mcp`,
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { authorization: `Bearer ${server.agentToken}` },
      );
      expect(ok.response.status).toBe(200);
      expect(ok.json).toMatchObject({ jsonrpc: "2.0", id: 1 });
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("returns 405 for authenticated standalone stream probes while preserving auth and POST", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir, agentToken: "agent-token" });
    const authorization = `Bearer ${server.agentToken}`;
    try {
      const unauthenticated = await fetch(`${server.url}/mcp`);
      expect(unauthenticated.status).toBe(401);

      const hostileOrigin = await fetch(`${server.url}/mcp`, {
        headers: {
          accept: "text/event-stream",
          authorization,
          origin: "https://evil.example",
        },
      });
      expect(hostileOrigin.status).toBe(403);

      for (const method of ["GET", "HEAD", "DELETE"] as const) {
        const response = await fetch(`${server.url}/mcp`, {
          method,
          headers: { accept: "text/event-stream", authorization },
        });
        expect(response.status, `${method} /mcp should reject the unsupported method`).toBe(405);
        expect(response.headers.get("allow"), `${method} /mcp should advertise POST`).toBe("POST");
        expect(response.headers.get("cache-control")).toBe("no-store");
        if (method === "GET") {
          expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
          expect(await response.json()).toEqual({ error: "Method not allowed" });
        }
      }

      const post = await postJson(
        `${server.url}/mcp`,
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { authorization },
      );
      expect(post.response.status).toBe(200);
      expect(post.json).toMatchObject({ jsonrpc: "2.0", id: 1 });
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("flags a memory over /mcp end-to-end and no longer exposes verify_memory", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir, agentToken: "agent-token" });
    const auth = { authorization: `Bearer ${server.agentToken}` };
    const callTool = (name: string, args: Record<string, unknown>) =>
      postJson(
        `${server.url}/mcp`,
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        auth,
      );
    try {
      // flag_memory is advertised; verify_memory is gone.
      const list = await postJson(
        `${server.url}/mcp`,
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        auth,
      );
      const names = (list.json as { result: { tools: { name: string }[] } }).result.tools.map(
        (t) => t.name,
      );
      expect(names).toContain("flag_memory");
      expect(names).not.toContain("verify_memory");

      // Seed a memory, then flag it end-to-end.
      await callTool("remember", {
        agent_id: "codex",
        title: "Old endpoint",
        body: "POST to /legacy for the API.",
      });
      const recall = await callTool("recall", {
        agent_id: "codex",
        query: "endpoint",
        include_ids: true,
      });
      const recallText = (recall.json as { result: { content: { text: string }[] } }).result
        .content[0]!.text;
      const memoryId = /\[(mem_[a-f0-9-]+)\]/.exec(recallText)?.[1];
      expect(memoryId).toBeTruthy();

      const flag = await callTool("flag_memory", {
        agent_id: "codex",
        memory_id: memoryId,
        reason: "the API moved to /v2",
      });
      expect(flag.response.status).toBe(200);
      const flagText = (flag.json as { result: { content: { text: string }[] } }).result.content[0]!
        .text;
      expect(flagText).toMatch(/flag/i);

      // verify_memory is method-not-found (the tool was retired).
      const verify = await callTool("verify_memory", { memory_id: memoryId, result: "useful" });
      expect((verify.json as { error: { message: string } }).error.message).toMatch(
        /Unknown tool: verify_memory/,
      );
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("requires the agent token on POST /transcript (mirrors /mcp auth, ADR 0008 P3)", async () => {
    const dataDir = makeTempDir();
    // Bound beyond localhost (helper binds 0.0.0.0) so the no-auth bypass is off:
    // /transcript is gated by the AGENT token, exactly like /mcp.
    const server = await startHttpServer({ dataDir, agentToken: "agent-token" });
    const body = { conv_id: "c1", harness: "claude", seq: 0, turns: [] };
    try {
      const unauth = await postJson(`${server.url}/transcript`, body);
      expect(unauth.response.status).toBe(401);

      const wrongToken = await postJson(`${server.url}/transcript`, body, {
        authorization: "Bearer not-the-agent-token",
      });
      expect(wrongToken.response.status).toBe(401);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("accepts an authed transcript delta end-to-end and buffers it (intake gate on)", async () => {
    const dataDir = makeTempDir();
    // Seed curator.intake.enabled at boot so the capture gate is open.
    const server = await startHttpServer({
      dataDir,
      agentToken: "agent-token",
      intake: "on",
    });
    try {
      const res = await postJson(
        `${server.url}/transcript`,
        {
          conv_id: "conv-e2e",
          harness: "claude",
          seq: 0,
          turns: [{ role: "user", text: "ship it" }],
        },
        { authorization: `Bearer ${server.agentToken}` },
      );
      expect(res.response.status).toBe(200);
      expect(res.json).toMatchObject({ accepted: true, buffered: 1 });

      // The buffer landed in the data-dir transcripts/ sidecar, not the vault.
      const buffer = fs.readFileSync(path.join(dataDir, "transcripts", "conv-e2e.md"), "utf8");
      expect(buffer).toContain("ship it");
      expect(fs.existsSync(path.join(dataDir, "vault", "transcripts"))).toBe(false);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("refuses a transcript delta with a 400 when the payload is malformed (intake gate on)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({
      dataDir,
      agentToken: "agent-token",
      intake: "on",
    });
    try {
      const res = await postJson(
        `${server.url}/transcript`,
        { conv_id: "c", harness: "claude", turns: "not-an-array" },
        { authorization: `Bearer ${server.agentToken}` },
      );
      expect(res.response.status).toBe(400);
      expect((res.json as { accepted: boolean }).accepted).toBe(false);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("buffers nothing and signals disabled when the intake gate is off", async () => {
    const dataDir = makeTempDir();
    // No `intake` opt-in ⇒ curator.intake.enabled defaults off ⇒ capture gate closed.
    const server = await startHttpServer({ dataDir, agentToken: "agent-token" });
    try {
      const res = await postJson(
        `${server.url}/transcript`,
        {
          conv_id: "conv-off",
          harness: "claude",
          seq: 0,
          turns: [{ role: "user", text: "no capture please" }],
        },
        { authorization: `Bearer ${server.agentToken}` },
      );
      expect(res.response.status).toBe(200);
      expect(res.json).toMatchObject({ accepted: false, disabled: true });
      // Nothing at rest for a dead pipeline.
      expect(fs.existsSync(path.join(dataDir, "transcripts"))).toBe(false);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("rejects browser origins not on the allow-list", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir, token: "http-token" });
    try {
      // /healthz is intentionally open; the origin gate runs after it,
      // so /mcp is the right probe.
      const res = await postJson(
        `${server.url}/mcp`,
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { origin: "https://evil.example", authorization: "Bearer http-token" },
      );
      expect(res.response.status).toBe(403);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
