// Spec 061 T4 — the auth-provider seam goes LIVE (SC 7), driven over real HTTP through the
// 060 factory-e2e infrastructure (`internals.publicServer` / `internalServer`, ephemeral ports).
//
// Two halves:
//
//   1. Substitute provider — a member-aware, ASYNC AuthProvider supplied via a plugin (proving
//      the async-capable seam union). For a recognised bearer it resolves a `kind: "member"`
//      principal (`roles: ["agent"]`, `attrs.memberId`, `boundActorId` set); otherwise 401. The
//      guarded reference becomes THE identity source, so:
//        (a) an MCP tool-call's ToolContext carries that principal (a test tool records it);
//        (b) a plugin tRPC procedure reads it from ctx (attrs.memberId asserted);
//        (c) an MCP `remember` records the member's actor in frontmatter — asserted from the file
//            (the bound `member:sarah` normalises to `member-sarah` through resolveCaller, the
//            same normalisation every agent_id write goes through);
//        (d) the provider is CONSULTED on the internal surface (a spy records each surface).
//
//   2. The public-admin guard, now LIVE end-to-end over HTTP (re-running 060 SC 7 against the
//      OWNED types): a provider yielding an admin-role principal on the PUBLIC surface makes the
//      REQUEST 403 (the handler/tool never runs) — unless the supplying plugin set
//      `allowPublicAdmin` — and a case-variant role (`["Admin"]`) is still refused (normalisation
//      pinned at the request level).
//
// Imports the compiled artifact (../dist), like librarian-server.test.ts.

import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Principal } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../test/helpers.js";
import type { AuthProvider, AuthResult } from "../dist/http/auth.js";
import type { PluginRoute } from "../dist/http/routes.js";
import { type LibrarianServerOptions, createLibrarianServer } from "../dist/librarian-server.js";
import type { ToolDefinition } from "../dist/mcp/tool.js";
import type { LibrarianPlugin } from "../dist/plugin.js";
import { publicProcedure, router } from "../dist/trpc/trpc.js";

const MEMBER_BEARER = "Bearer member-secret";

// The member principal a recognised bearer resolves to (the SC 7 shape). `boundActorId` is the
// cryptographic binding scopeAgentArgs threads as resolveCaller's authenticatedAgentId.
const memberPrincipal: Principal = {
  kind: "member",
  actorId: "member:sarah",
  boundActorId: "member:sarah",
  roles: ["agent"],
  attrs: { memberId: "sarah" },
};

// A member-aware, ASYNC provider with a surface spy — proves the async union works and lets the
// test assert the internal-surface consultation (SC 7 d).
function makeMemberProvider(): { provider: AuthProvider; surfaces: string[] } {
  const surfaces: string[] = [];
  const provider: AuthProvider = {
    async authenticate(req: IncomingMessage, surface) {
      surfaces.push(surface);
      // Await a resolved promise so this is genuinely async (a remote member lookup, modelled).
      await Promise.resolve();
      if ((req.headers.authorization ?? "") === MEMBER_BEARER) {
        return { ok: true, principal: memberPrincipal };
      }
      return { ok: false, status: 401 };
    },
  };
  return { provider, surfaces };
}

// A provider that yields an admin-role principal on every request (the guard-live half).
function makeAdminProvider(roles: readonly string[]): AuthProvider {
  const principal: Principal = { kind: "admin", actorId: "admin-actor", roles };
  return { authenticate: () => ({ ok: true, principal }) };
}

const CAPTURE_BEARER = "Bearer capture-secret";

// A capture-scope, bound member principal — for the /ingest scope-MATCH probe (fix 3/6).
const captureMemberPrincipal: Principal = {
  kind: "member",
  actorId: "member:grabber",
  boundActorId: "member:grabber",
  roles: ["agent"],
  scope: "capture",
  attrs: { memberId: "grabber" },
};

// A richer member provider with the same surface spy: MEMBER_BEARER → the (unscoped, so
// effectively agent-scope) member; CAPTURE_BEARER → a capture-scope member; else 401.
function makeScopedMemberProvider(): { provider: AuthProvider; surfaces: string[] } {
  const surfaces: string[] = [];
  const provider: AuthProvider = {
    async authenticate(req: IncomingMessage, surface) {
      surfaces.push(surface);
      await Promise.resolve();
      const bearer = req.headers.authorization ?? "";
      if (bearer === MEMBER_BEARER) return { ok: true, principal: memberPrincipal };
      if (bearer === CAPTURE_BEARER) return { ok: true, principal: captureMemberPrincipal };
      return { ok: false, status: 401 };
    },
  };
  return { provider, surfaces };
}

// Base options: every scheduler timer OFF, ephemeral loopback binds.
function baseOptions(dataDir: string): LibrarianServerOptions {
  return {
    dataDir,
    secretKey: null,
    host: "127.0.0.1",
    port: 0,
    trpcHost: "127.0.0.1",
    trpcPort: 0,
    adminToken: "",
    agentToken: "",
    agentTokenMap: new Map(),
    allowedOrigins: [],
    allowNoAuth: true,
    maxBodyBytes: 1024 * 1024,
    backupTickMs: 0,
    intakePollMs: 0,
    groomingPollMs: 0,
    chroniclePollMs: 0,
    transcriptSweepTickMs: 0,
  };
}

// Wait until an http.Server has bound (a `port: 0` bind is asynchronous) and return its port.
function listeningPort(server: import("node:http").Server): Promise<number> {
  const portOf = (): number => (server.address() as AddressInfo).port;
  if (server.listening) return Promise.resolve(portOf());
  return new Promise((resolve) => server.once("listening", () => resolve(portOf())));
}

// Construct + start a server on ephemeral ports, run `fn` against its live bases, then stop it
// and clean the data dir.
async function withStartedServer(
  plugins: readonly LibrarianPlugin[],
  fn: (bases: { publicBase: string; internalBase: string; dataDir: string }) => Promise<void>,
): Promise<void> {
  const dataDir = makeTempDir();
  const server = createLibrarianServer({ ...baseOptions(dataDir), plugins });
  let stopped = false;
  try {
    server.start();
    const publicPort = await listeningPort(server.internals.publicServer);
    const internalPort = await listeningPort(server.internals.internalServer);
    await fn({
      publicBase: `http://127.0.0.1:${publicPort}`,
      internalBase: `http://127.0.0.1:${internalPort}`,
      dataDir,
    });
    await server.stop();
    stopped = true;
  } finally {
    if (!stopped) {
      try {
        await server.stop();
      } catch {
        /* best-effort teardown */
      }
    }
    cleanupTempDir(dataDir);
  }
}

async function mcpCall(
  base: string,
  bearer: string | undefined,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: bearer } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
}

// Read the sole written memory's `agent_id` straight from the persisted frontmatter.
function soleMemoryAgentId(dataDir: string): string {
  const dir = path.join(dataDir, "vault", "memories");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  expect(files).toHaveLength(1);
  const raw = fs.readFileSync(path.join(dir, files[0]!), "utf8");
  const match = raw.match(/^agent_id:\s*(.+)$/m);
  if (!match) throw new Error(`no agent_id in frontmatter:\n${raw}`);
  return match[1]!.trim().replace(/^['"]|['"]$/g, "");
}

interface TrpcData<T> {
  result: { data: T };
}

describe("spec 061 T4 — substitute auth provider is the live identity source (SC 7)", () => {
  it("reports auth-probe health from the active provider, not static environment tokens", async () => {
    const { provider, surfaces } = makeMemberProvider();
    const overlay: LibrarianPlugin = { name: "overlay", authProvider: provider };

    await withStartedServer([overlay], async ({ publicBase }) => {
      const response = await fetch(`${publicBase}/healthz?auth_probe=1`);
      const body = (await response.json()) as { mcp_auth: string };

      expect(response.status).toBe(200);
      expect(body.mcp_auth).toBe("enabled");
      expect(surfaces).toContain("public");
    });
  });

  it("reports enabled to a caller probing WITH a valid bearer — the probe is about anonymous admission", async () => {
    const { provider } = makeMemberProvider();
    const overlay: LibrarianPlugin = { name: "overlay", authProvider: provider };

    await withStartedServer([overlay], async ({ publicBase }) => {
      const response = await fetch(`${publicBase}/healthz?auth_probe=1`, {
        headers: { authorization: MEMBER_BEARER },
      });
      const body = (await response.json()) as { mcp_auth: string };

      expect(response.status).toBe(200);
      expect(body.mcp_auth).toBe("enabled");
    });
  });

  it("requires an actual bearer on marked proxy requests even when a path-sensitive provider admits anonymous MCP", async () => {
    let protectedCalls = 0;
    const pathSensitiveProvider: AuthProvider = {
      authenticate(req, surface) {
        if (surface === "internal") {
          return {
            ok: true,
            principal: { kind: "admin", actorId: "internal-admin", roles: ["admin"] },
          };
        }
        if (req.url?.startsWith("/healthz")) return { ok: false, status: 401 };
        protectedCalls += 1;
        return { ok: true, principal: memberPrincipal };
      },
    };
    const overlay: LibrarianPlugin = {
      name: "path-sensitive",
      authProvider: pathSensitiveProvider,
    };

    await withStartedServer([overlay], async ({ publicBase }) => {
      const probe = await fetch(`${publicBase}/healthz?auth_probe=1`);
      expect((await probe.json()) as { mcp_auth: string }).toMatchObject({
        mcp_auth: "enabled",
      });

      const anonymous = await fetch(`${publicBase}/mcp`, {
        headers: { "x-librarian-require-auth": "single-port" },
      });
      expect(anonymous.status).toBe(401);
      expect(protectedCalls).toBe(0);

      const credentialed = await fetch(`${publicBase}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer provider-owned-credential",
          "content-type": "application/json",
          "x-librarian-require-auth": "single-port",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(credentialed.status).toBe(200);
      expect(protectedCalls).toBe(1);
    });
  });

  it("threads the member principal to the MCP tool context, the tRPC ctx, and the written frontmatter — and is consulted on the internal surface", async () => {
    const { provider, surfaces } = makeMemberProvider();
    let recorded: Principal | undefined;

    const recorderTool: ToolDefinition = {
      name: "overlay_whoami",
      description: "Records the caller principal (SC 7 test tool).",
      inputSchema: { type: "object", properties: {} },
      handler: (_store, _args, context) => {
        recorded = context.principal;
        return { content: [{ type: "text", text: "recorded" }] };
      },
    };

    // A plugin tRPC procedure that reads the principal from ctx (publicProcedure — the member is
    // NON-admin, so adminProcedure would reject it).
    const memberRouter = router({
      whoami: publicProcedure.query(({ ctx }) => ({
        memberId: ctx.principal.attrs?.memberId ?? null,
      })),
    });

    const overlay: LibrarianPlugin = {
      name: "overlay",
      tools: [recorderTool],
      trpcRouters: { member: memberRouter },
      authProvider: provider,
    };

    await withStartedServer([overlay], async ({ publicBase, internalBase, dataDir }) => {
      // (a) the MCP tool context carries the member principal (verbatim — provider result is
      // passed through the guard unchanged for a non-admin on the public surface).
      const toolRes = await mcpCall(publicBase, MEMBER_BEARER, "overlay_whoami", {});
      expect(toolRes.status).toBe(200);
      expect(recorded).toEqual(memberPrincipal);

      // (c) an MCP remember records the member's actor in the persisted frontmatter. The bound
      // `member:sarah` normalises to `member-sarah` through resolveCaller (colon → dash), the same
      // normalisation every agent_id write goes through — no body agent_id, so the binding wins.
      const rememberRes = await mcpCall(publicBase, MEMBER_BEARER, "remember", {
        title: "Member note",
        body: "Written by a recognised member.",
        category: "tools",
        visibility: "common",
        scope: "global",
      });
      expect(rememberRes.status).toBe(200);
      expect(soleMemoryAgentId(dataDir)).toBe("member-sarah");

      // (b) a plugin tRPC procedure reads the member principal from ctx (internal surface).
      const trpcRes = await fetch(`${internalBase}/trpc/overlay.member.whoami`, {
        headers: { authorization: MEMBER_BEARER },
      });
      expect(trpcRes.status).toBe(200);
      const trpcBody = (await trpcRes.json()) as TrpcData<{ memberId: string | null }>;
      expect(trpcBody.result.data.memberId).toBe("sarah");

      // (d) the provider was CONSULTED on the internal surface (alongside the public consults).
      expect(surfaces).toContain("internal");
      expect(surfaces).toContain("public");
    });
  });
});

describe("spec 061 T4 — the public-admin guard is LIVE end-to-end over HTTP (SC 7)", () => {
  // A recorder tool whose flag proves whether the handler ran past the guard.
  function makeRecorder(): { tool: ToolDefinition; ran: () => boolean } {
    const state = { ran: false };
    return {
      tool: {
        name: "guard_probe",
        description: "Flips a flag if the handler runs (guard-live probe).",
        inputSchema: { type: "object", properties: {} },
        handler: () => {
          state.ran = true;
          return { content: [{ type: "text", text: "ran" }] };
        },
      },
      ran: () => state.ran,
    };
  }

  it("refuses an admin-role principal on the PUBLIC surface with 403 — the tool never runs", async () => {
    const { tool, ran } = makeRecorder();
    const plugin: LibrarianPlugin = {
      name: "adminish",
      tools: [tool],
      authProvider: makeAdminProvider(["admin"]),
    };
    await withStartedServer([plugin], async ({ publicBase }) => {
      const res = await mcpCall(publicBase, undefined, "guard_probe", {});
      expect(res.status).toBe(403);
      expect(ran()).toBe(false);
    });
  });

  it("passes the admin principal through WITH allowPublicAdmin — the tool runs (200)", async () => {
    const { tool, ran } = makeRecorder();
    const plugin: LibrarianPlugin = {
      name: "trusted",
      tools: [tool],
      authProvider: makeAdminProvider(["admin"]),
      allowPublicAdmin: true,
    };
    await withStartedServer([plugin], async ({ publicBase }) => {
      const res = await mcpCall(publicBase, undefined, "guard_probe", {});
      expect(res.status).toBe(200);
      expect(ran()).toBe(true);
    });
  });

  it("still refuses a case-variant admin role (['Admin']) with 403 — normalisation pinned at the request level", async () => {
    const { tool, ran } = makeRecorder();
    const plugin: LibrarianPlugin = {
      name: "caseish",
      tools: [tool],
      authProvider: makeAdminProvider(["Admin"]),
    };
    await withStartedServer([plugin], async ({ publicBase }) => {
      const res = await mcpCall(publicBase, undefined, "guard_probe", {});
      expect(res.status).toBe(403);
      expect(ran()).toBe(false);
    });
  });
});

describe("spec 061 review fixes 2/3/6 — the substitute provider is consulted on more paths", () => {
  it("pins /transcript, /ingest (scope backstop), and a PUBLIC plugin route through the substitute", async () => {
    const { provider, surfaces } = makeScopedMemberProvider();
    let recordedAuth: AuthResult | null = null;

    // A public plugin route (auth:"agent") whose handler records the resolved auth it received.
    const echoRoute: PluginRoute = {
      path: "/overlay/echo",
      method: "POST",
      surface: "public",
      auth: "agent",
      handler: (ctx) => {
        recordedAuth = ctx.auth;
        ctx.res.writeHead(200, { "content-type": "application/json" });
        ctx.res.end(JSON.stringify({ ok: true }));
      },
    };

    const overlay: LibrarianPlugin = {
      name: "overlay",
      routes: [echoRoute],
      authProvider: provider,
    };

    await withStartedServer([overlay], async ({ publicBase }) => {
      const post = (path: string, bearer: string, body: unknown): Promise<Response> =>
        fetch(`${publicBase}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: bearer },
          body: JSON.stringify(body),
        });

      // (1) /transcript — consulted through the provider (fix 6). An UNRECOGNISED bearer gets the
      // provider's 401 — NOT the localhost bypass that a revert to `authenticatePublic` would grant
      // under allowNoAuth (that's the revert-fails-a-test guarantee); a member bearer is admitted.
      expect((await post("/transcript", "Bearer nope", {})).status).toBe(401);
      expect((await post("/transcript", MEMBER_BEARER, {})).status).not.toBe(401);

      // (2) /ingest — the D21 scope wall, backstopped for a substitute (fix 3). The member's
      // effective `agent` scope is FORBIDDEN on the capture endpoint (403); a capture-scope
      // principal is admitted (202 queued) — a revert to `authenticatePublic` would 403 that too.
      expect((await post("/ingest", MEMBER_BEARER, { text: "hi" })).status).toBe(403);
      expect((await post("/ingest", CAPTURE_BEARER, { text: "hi" })).status).toBe(202);

      // (3) a PUBLIC plugin route (auth:"agent") — the handler's auth carries the member BINDING,
      // proving the route consulted the substitute (a revert would bypass to an unbound agent with
      // no agentId). An unrecognised bearer gets the provider's 401.
      expect((await post("/overlay/echo", MEMBER_BEARER, {})).status).toBe(200);
      expect(recordedAuth).toEqual({ role: "agent", agentId: "member:sarah" });
      expect((await post("/overlay/echo", "Bearer nope", {})).status).toBe(401);

      expect(surfaces).toContain("public");
    });
  });

  it("an INTERNAL plugin route resolves its identity through the substitute, not admin-by-isolation (fix 2)", async () => {
    const { provider, surfaces } = makeScopedMemberProvider();
    let recordedAuth: AuthResult | null = null;

    // An internal plugin route: on the trusted internal listener the `auth` field has no bearer
    // scope to check, but the identity is now resolved through the SAME provider (fix 2) — so a
    // substitute is consulted here too and the handler receives ITS principal, not a hard-coded
    // admin. A bearer the substitute doesn't recognise fails CLOSED (401), a new substitute
    // capability the default admin-by-isolation path never exposes.
    const whoamiRoute: PluginRoute = {
      path: "/overlay/internal-whoami",
      method: "GET",
      surface: "internal",
      auth: "none",
      handler: (ctx) => {
        recordedAuth = ctx.auth;
        ctx.res.writeHead(200, { "content-type": "application/json" });
        ctx.res.end(JSON.stringify({ ok: true }));
      },
    };

    const overlay: LibrarianPlugin = {
      name: "overlay",
      routes: [whoamiRoute],
      authProvider: provider,
    };

    await withStartedServer([overlay], async ({ internalBase }) => {
      const res = await fetch(`${internalBase}/overlay/internal-whoami`, {
        headers: { authorization: MEMBER_BEARER },
      });
      expect(res.status).toBe(200);
      // The handler's auth carries the member binding — proving the internal route consulted the
      // substitute (the default provider would have yielded the admin principal here).
      expect(recordedAuth).toEqual({ role: "agent", agentId: "member:sarah" });
      expect(surfaces).toContain("internal");

      // A bearer the substitute rejects now fails closed on the internal route too (fix 2).
      const refused = await fetch(`${internalBase}/overlay/internal-whoami`, {
        headers: { authorization: "Bearer nope" },
      });
      expect(refused.status).toBe(401);
    });
  });
});
