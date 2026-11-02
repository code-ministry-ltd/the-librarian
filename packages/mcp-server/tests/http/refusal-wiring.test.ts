import { createHash } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { createAgentToken, type LibrarianStore, type Principal } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../test/helpers.js";
import {
  type LibrarianServer,
  type LibrarianServerOptions,
  createLibrarianServer,
} from "../../dist/librarian-server.js";
import type { LibrarianPlugin } from "../../dist/plugin.js";

const AGENT_TOKEN = "agent-refusal-test-token";
const HOSTILE_BEARER = 'bearer-canary-"\\-must-never-persist';
const HOSTILE_ORIGIN = 'https://evil.example/"\\frame';

function baseOptions(
  dataDir: string,
  plugins: readonly LibrarianPlugin[] = [],
): LibrarianServerOptions {
  return {
    dataDir,
    secretKey: null,
    host: "127.0.0.1",
    port: 0,
    trpcHost: "127.0.0.1",
    trpcPort: 0,
    adminToken: "",
    agentToken: AGENT_TOKEN,
    agentTokenMap: new Map(),
    allowedOrigins: [],
    allowNoAuth: false,
    maxBodyBytes: 1024 * 1024,
    backupTickMs: 0,
    intakePollMs: 0,
    groomingPollMs: 0,
    transcriptSweepTickMs: 0,
    plugins,
  };
}

function listeningPort(server: import("node:http").Server): Promise<number> {
  const port = (): number => (server.address() as AddressInfo).port;
  if (server.listening) return Promise.resolve(port());
  return new Promise((resolve) => server.once("listening", () => resolve(port())));
}

async function withServer(
  plugins: readonly LibrarianPlugin[],
  run: (ctx: {
    server: LibrarianServer;
    store: LibrarianStore;
    dataDir: string;
    publicUrl: string;
    internalUrl: string;
  }) => Promise<void>,
  configure?: (store: LibrarianStore) => void,
): Promise<void> {
  const dataDir = makeTempDir();
  const server = createLibrarianServer(baseOptions(dataDir, plugins));
  configure?.(server.store);
  let stopped = false;
  try {
    server.start();
    const [publicPort, internalPort] = await Promise.all([
      listeningPort(server.internals.publicServer),
      listeningPort(server.internals.internalServer),
    ]);
    await run({
      server,
      store: server.store,
      dataDir,
      publicUrl: `http://127.0.0.1:${publicPort}`,
      internalUrl: `http://127.0.0.1:${internalPort}`,
    });
    await server.stop();
    stopped = true;
  } finally {
    if (!stopped) {
      try {
        await server.stop();
      } catch {
        // best-effort teardown after an assertion failure
      }
    }
    cleanupTempDir(dataDir);
  }
}

const post = (url: string, headers: Record<string, string> = {}, body: unknown = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("HTTP refusal evidence", () => {
  it("maps all three core auth walks, preserves wire responses, and never logs a bearer", async () => {
    await withServer([], async ({ store, dataDir, publicUrl }) => {
      const missing = await post(
        `${publicUrl}/mcp`,
        {},
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        },
      );
      expect(missing.status).toBe(401);
      expect(missing.headers.get("www-authenticate")).toBe("Bearer");
      expect(await missing.text()).toBe('{"error":"Unauthorized"}');

      const invalid = await post(
        `${publicUrl}/transcript`,
        {
          authorization: `Bearer ${HOSTILE_BEARER}`,
          "x-forwarded-for": "198.51.100.7, 203.0.113.9",
        },
        { conv_id: "refusal", harness: "codex", seq: 0, turns: [] },
      );
      expect(invalid.status).toBe(401);
      expect(await invalid.text()).toBe('{"error":"Unauthorized"}');

      const wrongScope = await post(
        `${publicUrl}/ingest`,
        { authorization: `Bearer ${AGENT_TOKEN}` },
        { text: "capture me" },
      );
      expect(wrongScope.status).toBe(403);
      expect(await wrongScope.text()).toBe(
        '{"error":"Forbidden: token scope not permitted on this endpoint"}',
      );

      const evidence = await store.readRefusals();
      expect(evidence.rows).toHaveLength(3);
      expect(evidence.rows.map((row) => row.kind)).toEqual([
        "bearer-wrong-scope",
        "bearer-invalid",
        "bearer-missing",
      ]);
      expect(evidence.rows[0]).toMatchObject({
        kind: "bearer-wrong-scope",
        actorId: "env-token-agent",
        roles: ["agent"],
      });
      expect(evidence.rows[1]).toMatchObject({
        kind: "bearer-invalid",
        surface: "public",
        outcome: 401,
        path: "/transcript",
        tokenHash: createHash("sha256").update(HOSTILE_BEARER).digest("hex").slice(0, 12),
        ip: "127.0.0.1",
        forwardedFor: "198.51.100.7, 203.0.113.9",
      });
      expect(evidence.rows[2]).not.toHaveProperty("tokenHash");

      const serialized = fs.readFileSync(`${dataDir}/refusal-log.ndjson`, "utf8");
      expect(serialized).not.toContain(HOSTILE_BEARER);

      const success = await post(
        `${publicUrl}/mcp`,
        { authorization: `Bearer ${AGENT_TOKEN}` },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      );
      expect(success.status).toBe(200);
      expect((await store.readRefusals()).total).toBe(3);
    });
  });

  it("records both public and internal plugin-provider refusals", async () => {
    const member: Principal = {
      kind: "member",
      actorId: "member-one",
      roles: ["agent"],
      scope: "agent",
    };
    const plugin: LibrarianPlugin = {
      name: "refusal-plugin",
      authProvider: {
        authenticate(req, surface) {
          if (surface === "internal") return { ok: false, status: 401 };
          if (req.headers.authorization === "Bearer plugin-forbidden") {
            return { ok: false, status: 403 };
          }
          return req.headers.authorization === "Bearer plugin-good"
            ? { ok: true, principal: member }
            : { ok: false, status: 401 };
        },
      },
      routes: [
        {
          path: "/plugin/public",
          method: "GET",
          surface: "public",
          auth: "agent",
          handler: () => {
            throw new Error("the refused public handler must not run");
          },
        },
        {
          path: "/plugin/internal",
          method: "GET",
          surface: "internal",
          auth: "none",
          handler: () => {
            throw new Error("the refused internal handler must not run");
          },
        },
      ],
    };

    await withServer([plugin], async ({ store, publicUrl, internalUrl }) => {
      expect(
        (
          await fetch(`${publicUrl}/plugin/public`, {
            headers: { authorization: "Bearer plugin-bad" },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${publicUrl}/plugin/public`, {
            headers: { authorization: "Bearer plugin-forbidden" },
          })
        ).status,
      ).toBe(403);
      expect((await fetch(`${internalUrl}/plugin/internal`)).status).toBe(401);

      const evidence = await store.readRefusals();
      expect(evidence.rows).toHaveLength(3);
      expect(evidence.rows).toEqual([
        expect.objectContaining({
          kind: "provider-refused",
          surface: "internal",
          outcome: 401,
          path: "/plugin/internal",
        }),
        expect.objectContaining({
          kind: "provider-refused",
          surface: "public",
          outcome: 403,
          path: "/plugin/public",
        }),
        expect.objectContaining({
          kind: "provider-refused",
          surface: "public",
          outcome: 401,
          path: "/plugin/public",
        }),
      ]);
    });
  });

  it("records each origin gate once and JSON-frames hostile header text", async () => {
    const plugin: LibrarianPlugin = {
      name: "origin-plugin",
      routes: [
        {
          path: "/plugin/internal-origin",
          method: "GET",
          surface: "internal",
          auth: "none",
          handler: () => {
            throw new Error("the origin-gated handler must not run");
          },
        },
      ],
    };

    await withServer([plugin], async ({ store, dataDir, publicUrl, internalUrl }) => {
      const headers = { origin: HOSTILE_ORIGIN };
      const publicDenied = await post(`${publicUrl}/mcp`, headers);
      const internalDenied = await fetch(`${internalUrl}/trpc/health.ping`, { headers });
      const pluginDenied = await fetch(`${internalUrl}/plugin/internal-origin`, { headers });
      for (const response of [publicDenied, internalDenied, pluginDenied]) {
        expect(response.status).toBe(403);
        expect(await response.text()).toBe('{"error":"Origin not allowed"}');
      }

      const evidence = await store.readRefusals();
      expect(evidence.rows).toHaveLength(3);
      expect(evidence.rows.every((row) => row.kind === "origin-blocked")).toBe(true);
      expect(evidence.rows.map((row) => ("path" in row ? row.path : undefined))).toEqual([
        "/plugin/internal-origin",
        "/trpc/health.ping",
        "/mcp",
      ]);
      expect(
        evidence.rows.every((row) => "origin" in row && row.origin === "https://evil.example"),
      ).toBe(true);

      const serialized = fs.readFileSync(`${dataDir}/refusal-log.ndjson`, "utf8");
      expect(serialized).not.toContain(HOSTILE_ORIGIN);
      expect(serialized.trim().split("\n")).toHaveLength(3);
    });
  });

  it("attributes an ingest 429 to the authenticated principal", async () => {
    let captureToken = "";
    await withServer(
      [],
      async ({ store, publicUrl }) => {
        let throttled: Response | undefined;
        for (let index = 0; index < 6; index += 1) {
          const response = await post(
            `${publicUrl}/ingest`,
            { authorization: `Bearer ${captureToken}` },
            { url: `http://10.0.0.${index + 1}/blocked`, via: "extension" },
          );
          if (response.status === 429) throttled = response;
          else await response.body?.cancel();
        }
        expect(throttled?.status).toBe(429);
        expect(throttled?.headers.get("retry-after")).toMatch(/^\d+$/);
        await throttled?.body?.cancel();

        const evidence = await store.readRefusals({ kind: "rate-limited" });
        expect(evidence.rows).toHaveLength(1);
        expect(evidence.rows[0]).toMatchObject({
          kind: "rate-limited",
          surface: "public",
          outcome: 429,
          path: "/ingest",
          actorId: "capture-client",
          roles: ["agent"],
        });
        expect(evidence.rows[0]).toHaveProperty("tokenId");
      },
      (store) => {
        captureToken = createAgentToken(store, {
          agentId: "capture-client",
          scope: "capture",
        }).token;
      },
    );
  });
});
