// Ingest spec D21 — bidirectional token-scope isolation at the auth seam.
//
// The /ingest endpoint (browser extension / mobile share) authenticates with a
// least-privilege `capture` token. The wall must hold BOTH ways:
//   - a capture token must NOT reach the /mcp agent surface (the 7 verbs);
//   - an agent token must NOT reach /ingest;
//   - the localhost no-auth bypass (an agent identity) must NOT grant capture.
// A wrong-scope-but-valid credential is 403 (forbidden), distinct from 401
// (no/invalid credential) — so a client can tell "you used the wrong token" from
// "you used no token". Unit-tests the compiled auth seam, like the sibling suites.

import type { IncomingMessage } from "node:http";
import { createAgentToken, createLibrarianStore } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";
import { type AuthConfig, authenticatePublic } from "../../dist/http/auth.js";

function reqWith(token?: string): IncomingMessage {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as unknown as IncomingMessage;
}

// A capture token and an agent token, both DB-minted (the dashboard path). The
// verifier mirrors verifyAgentToken: it returns the scope it stored.
const config: AuthConfig = {
  adminToken: "",
  agentToken: "env-agent",
  agentTokenMap: new Map(),
  allowedOrigins: [],
  allowNoAuth: false,
  host: "0.0.0.0",
  port: 3838,
  verifyDbToken: (t) => {
    if (t === "cap-tok") return { agentId: "clipper", scope: "capture" };
    if (t === "agent-tok") return { agentId: "claude", scope: "agent" };
    return null;
  },
};

describe("authenticatePublic — agent surface (/mcp, /transcript) requires agent scope", () => {
  it("accepts an agent token", () => {
    expect(authenticatePublic(reqWith("agent-tok"), config, "agent")).toEqual({
      ok: true,
      result: { role: "agent", agentId: "claude", scope: "agent" },
    });
  });

  it("accepts the env agent token (env tokens are agent scope)", () => {
    const r = authenticatePublic(reqWith("env-agent"), config, "agent");
    expect(r).toEqual({ ok: true, result: { role: "agent", scope: "agent" } });
  });

  it("FORBIDS a capture token (403, not 401) — it can never reach the 7 verbs", () => {
    expect(authenticatePublic(reqWith("cap-tok"), config, "agent")).toEqual({
      ok: false,
      status: 403,
    });
  });

  it("rejects a missing/invalid credential as 401", () => {
    expect(authenticatePublic(reqWith(), config, "agent")).toEqual({ ok: false, status: 401 });
    expect(authenticatePublic(reqWith("nope"), config, "agent")).toEqual({
      ok: false,
      status: 401,
    });
  });
});

describe("authenticatePublic — capture surface (/ingest) requires capture scope", () => {
  it("accepts a capture token", () => {
    expect(authenticatePublic(reqWith("cap-tok"), config, "capture")).toEqual({
      ok: true,
      result: { role: "agent", agentId: "clipper", scope: "capture" },
    });
  });

  it("FORBIDS an agent token (403) — least privilege, the other direction of the wall", () => {
    expect(authenticatePublic(reqWith("agent-tok"), config, "capture")).toEqual({
      ok: false,
      status: 403,
    });
  });

  it("rejects a missing credential as 401", () => {
    expect(authenticatePublic(reqWith(), config, "capture")).toEqual({ ok: false, status: 401 });
  });

  it("does NOT honor the localhost no-auth bypass — the bypass is an agent identity (criterion 8)", () => {
    const bypass: AuthConfig = { ...config, allowNoAuth: true };
    // The bypass would grant agent on /mcp, but /ingest needs capture: a tokenless
    // local call is forbidden, not silently granted.
    expect(authenticatePublic(reqWith(), bypass, "capture")).toEqual({ ok: false, status: 403 });
  });
});

describe("capture-scope isolation end-to-end", () => {
  it("walls capture tokens off /mcp and agent/tokenless callers off /ingest", async () => {
    const dataDir = makeTempDir();
    // Mint one of each scope into the data dir before the server boots.
    const seed = createLibrarianStore({ dataDir });
    const agentTok = createAgentToken(seed, { agentId: "claude", scope: "agent" });
    const captureTok = createAgentToken(seed, { agentId: "clipper", scope: "capture" });
    seed.close();

    const server = await startHttpServer({ dataDir });
    // /mcp wants a JSON-RPC body; /ingest wants a capture body (one of
    // content/url/text) — send the right shape per path so a 202 reflects the
    // auth boundary, not a body-validation 400.
    const post = (path: string, token?: string) =>
      fetch(`${server.url}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(
          path === "/ingest"
            ? { url: "https://example.com/article", via: "extension" }
            : { jsonrpc: "2.0", id: 1, method: "tools/list" },
        ),
      });
    const getMcp = (token: string) =>
      fetch(`${server.url}/mcp`, {
        headers: { accept: "text/event-stream", authorization: `Bearer ${token}` },
      });
    try {
      // /mcp: agent reaches the 7 verbs; a capture token is FORBIDDEN (403), not
      // merely unauthorized — the wall's first direction.
      expect((await post("/mcp", agentTok.token)).status).toBe(200);
      expect((await post("/mcp", captureTok.token)).status).toBe(403);
      expect((await getMcp(captureTok.token)).status).toBe(403);

      // /ingest: capture token accepted (202 queued — the row is written pending;
      // the real write path is a later task); an agent token is FORBIDDEN (403);
      // no token is 401.
      expect((await post("/ingest", captureTok.token)).status).toBe(202);
      expect((await post("/ingest", agentTok.token)).status).toBe(403);
      expect((await post("/ingest")).status).toBe(401);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
