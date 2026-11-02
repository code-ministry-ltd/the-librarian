// Plugin HTTP route registration (spec 060 T5, SC 6 + SC 7's collision refusals).
//
// Proves a build-time plugin's HTTP routes append to the per-surface route tables
// as more rows: the factory ENFORCES each route's declared `auth` in the table walk
// (the same 401-challenge / 403-scope helpers the core routes use) BEFORE the
// handler runs, the handler receives the resolved auth, and a route is served only
// on its declared surface (404 on the other). Ill-formed routes are LOUD
// construction-time refusals that name the plugin: a public `/trpc` mount, a
// collision with a core route, or a collision between two plugin routes.
//
// The end-to-end path is exercised over a REAL socket through the SAME
// createHttpServer → route table the factory wires, on ephemeral ports (port 0, no
// race). Collisions are exercised through the real factory, createLibrarianServer,
// per "throws at construction time". Imports the compiled artifacts (../dist), like
// the other internal-module suites.

import http from "node:http";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, withStore } from "../../../test/helpers.js";
import type { AuthConfig } from "../dist/http/auth.js";
import { type PluginRoute, assertPluginRoutes } from "../dist/http/routes.js";
import { createHttpServer } from "../dist/http/server.js";
import { type LibrarianServerOptions, createLibrarianServer } from "../dist/librarian-server.js";

// A public route that requires an `agent` token and echoes the RESOLVED auth back,
// so a test can prove the handler ran only after auth passed and saw what the
// factory resolved. `auth: "agent"` ⇒ a capture token is 403, no token is 401.
const AGENT_WHOAMI: PluginRoute = {
  path: "/plugin/whoami",
  method: "GET",
  surface: "public",
  auth: "agent",
  handler: (ctx) => {
    ctx.res.writeHead(200, { "content-type": "application/json" });
    ctx.res.end(JSON.stringify({ auth: ctx.auth }));
  },
};

// An internal route (auth: "none"): the internal listener is trusted by isolation
// (ADR 0008 P3), so it resolves to the admin principal behind the origin gate.
const INTERNAL_PING: PluginRoute = {
  path: "/plugin/internal-ping",
  method: "GET",
  surface: "internal",
  auth: "none",
  handler: (ctx) => {
    ctx.res.writeHead(200, { "content-type": "application/json" });
    ctx.res.end(JSON.stringify({ auth: ctx.auth }));
  },
};

const NOOP: PluginRoute["handler"] = () => {};

// A DB-token verifier that mints one agent- and one capture-scope token, mirroring
// verifyAgentToken (it returns the scope it stored). allowNoAuth false = a tokenless
// public request is a clean 401, not the localhost agent bypass.
function makeAuth(): AuthConfig {
  return {
    adminToken: "",
    agentToken: "",
    agentTokenMap: new Map(),
    allowedOrigins: [],
    allowNoAuth: false,
    host: "127.0.0.1",
    port: 0,
    verifyDbToken: (t) => {
      if (t === "agent-tok") return { agentId: "claude", scope: "agent", tokenId: "t-agent" };
      if (t === "cap-tok") return { agentId: "clipper", scope: "capture", tokenId: "t-cap" };
      return null;
    },
  };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// Base factory options: every scheduler timer OFF and loopback binds, so a throwing
// construction never binds a listener and never opens a store past the pre-store
// validation (matches plugin-tools / plugin-trpc).
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
    transcriptSweepTickMs: 0,
  };
}

interface AuthEcho {
  auth: { role: string; agentId?: string; scope?: string; tokenId?: string } | null;
}

describe("plugin HTTP routes — surface + auth contract (spec 060 SC 6)", () => {
  it('enforces auth: "agent" in the walk — agent token runs the handler with resolved auth, capture is 403, none is 401', async () => {
    await withStore(async (store) => {
      const auth = makeAuth();
      const publicServer = createHttpServer({
        store,
        auth,
        surface: "public",
        pluginRoutes: [AGENT_WHOAMI],
      });
      const port = await listen(publicServer);
      try {
        const url = `http://127.0.0.1:${port}/plugin/whoami`;

        // Valid agent token → the handler ran and received the RESOLVED auth (the
        // same AuthResult authenticatePublic yields, threaded by the factory).
        const ok = await fetch(url, { headers: { authorization: "Bearer agent-tok" } });
        expect(ok.status).toBe(200);
        const body = (await ok.json()) as AuthEcho;
        expect(body.auth).toEqual({
          role: "agent",
          agentId: "claude",
          scope: "agent",
          tokenId: "t-agent",
        });

        // A valid but wrong-scope capture token is 403 — the handler never runs
        // (same "right key, wrong door" distinction the core agent routes emit).
        const forbidden = await fetch(url, { headers: { authorization: "Bearer cap-tok" } });
        expect(forbidden.status).toBe(403);

        // No credential is 401 with the SAME Bearer challenge core emits.
        const unauth = await fetch(url);
        expect(unauth.status).toBe(401);
        expect(unauth.headers.get("www-authenticate")).toBe("Bearer");
      } finally {
        await closeServer(publicServer);
      }
    });
  });

  it("serves a route only on its declared surface (404 on the other listener)", async () => {
    await withStore(async (store) => {
      const auth = makeAuth();
      // BOTH listeners get the SAME plugin-route set; each serves only its surface.
      const pluginRoutes = [AGENT_WHOAMI, INTERNAL_PING];
      const publicServer = createHttpServer({ store, auth, surface: "public", pluginRoutes });
      const internalServer = createHttpServer({ store, auth, surface: "internal", pluginRoutes });
      const publicPort = await listen(publicServer);
      const internalPort = await listen(internalServer);
      try {
        // The public route answers on the public listener (200 with a valid token)…
        const onPublic = await fetch(`http://127.0.0.1:${publicPort}/plugin/whoami`, {
          headers: { authorization: "Bearer agent-tok" },
        });
        expect(onPublic.status).toBe(200);
        // …and 404s on the internal listener (wrong surface — never auth-gated there).
        const publicOnInternal = await fetch(`http://127.0.0.1:${internalPort}/plugin/whoami`, {
          headers: { authorization: "Bearer agent-tok" },
        });
        expect(publicOnInternal.status).toBe(404);

        // The internal route answers on the internal listener, resolving to the
        // trusted admin principal (isolation is the gate, ADR 0008 P3)…
        const onInternal = await fetch(`http://127.0.0.1:${internalPort}/plugin/internal-ping`);
        expect(onInternal.status).toBe(200);
        const body = (await onInternal.json()) as AuthEcho;
        expect(body.auth).toEqual({ role: "admin" });
        // …and 404s on the public listener (wrong surface).
        const internalOnPublic = await fetch(`http://127.0.0.1:${publicPort}/plugin/internal-ping`);
        expect(internalOnPublic.status).toBe(404);
      } finally {
        await closeServer(publicServer);
        await closeServer(internalServer);
      }
    });
  });
});

describe("plugin HTTP route refusals — loud, at construction time (spec 060 SC 7)", () => {
  it("throws naming the plugin for a public route under /trpc", () => {
    const dataDir = makeTempDir();
    try {
      expect(() =>
        createLibrarianServer({
          ...baseOptions(dataDir),
          plugins: [
            {
              name: "sneaky",
              routes: [
                {
                  path: "/trpc/steal",
                  method: "GET",
                  surface: "public",
                  auth: "none",
                  handler: NOOP,
                },
              ],
            },
          ],
        }),
      ).toThrow(/Plugin "sneaky" registers a public route "GET \/trpc\/steal" under/);
    } finally {
      cleanupTempDir(dataDir);
    }
  });

  it("throws naming the plugin when a route collides with a CORE route on the same surface", () => {
    const dataDir = makeTempDir();
    try {
      expect(() =>
        createLibrarianServer({
          ...baseOptions(dataDir),
          plugins: [
            {
              name: "clobber",
              routes: [
                { path: "/mcp", method: "POST", surface: "public", auth: "agent", handler: NOOP },
              ],
            },
          ],
        }),
      ).toThrow(
        /Plugin "clobber" registers a route "POST \/mcp" on the public surface, which collides with a core route/,
      );
    } finally {
      cleanupTempDir(dataDir);
    }
  });

  it("throws naming the offending plugin when two PLUGINS register the same route", () => {
    const dataDir = makeTempDir();
    try {
      expect(() =>
        createLibrarianServer({
          ...baseOptions(dataDir),
          plugins: [
            {
              name: "first",
              routes: [
                {
                  path: "/plugin/dup",
                  method: "GET",
                  surface: "public",
                  auth: "none",
                  handler: NOOP,
                },
              ],
            },
            {
              name: "second",
              routes: [
                {
                  path: "/plugin/dup",
                  method: "GET",
                  surface: "public",
                  auth: "none",
                  handler: NOOP,
                },
              ],
            },
          ],
        }),
      ).toThrow(
        /Plugin "second" registers a route "GET \/plugin\/dup".*already registered by plugin "first"/s,
      );
    } finally {
      cleanupTempDir(dataDir);
    }
  });

  it("the same refusals fire from assertPluginRoutes the factory calls", () => {
    // Exercised directly so the refusal isn't only observable through the factory.
    expect(() =>
      assertPluginRoutes([
        {
          name: "sneaky",
          routes: [
            { path: "/trpc/x", method: "GET", surface: "public", auth: "none", handler: NOOP },
          ],
        },
      ]),
    ).toThrow(/Plugin "sneaky".*\/trpc.*public surface/s);

    // Same path+method on DIFFERENT surfaces is NOT a collision (they answer on
    // different listeners), so a well-formed pair composes cleanly.
    expect(() =>
      assertPluginRoutes([
        {
          name: "ok",
          routes: [
            { path: "/plugin/a", method: "GET", surface: "public", auth: "none", handler: NOOP },
            { path: "/plugin/a", method: "GET", surface: "internal", auth: "none", handler: NOOP },
          ],
        },
      ]),
    ).not.toThrow();
  });

  it("reserves /trpc — bare and prefixed — on BOTH surfaces (not just public)", () => {
    // /trpc is the core admin surface's own prefix; a plugin may not squat it on EITHER
    // listener. Cover the four cases that previously had a gap: the internal surface
    // reserved only `/trpc/*`, so a bare `/trpc` (no trailing slash) slipped through.
    const cases: { surface: PluginRoute["surface"]; path: string }[] = [
      { surface: "public", path: "/trpc" },
      { surface: "public", path: "/trpc/x" },
      { surface: "internal", path: "/trpc" },
      { surface: "internal", path: "/trpc/x" },
    ];
    for (const { surface, path } of cases) {
      expect(
        () =>
          assertPluginRoutes([
            {
              name: "squatter",
              routes: [{ path, method: "GET", surface, auth: "none", handler: NOOP }],
            },
          ]),
        `${surface} ${path} must be refused`,
      ).toThrow(/Plugin "squatter".*\/trpc.*reserved on\s+both listeners/s);
    }
  });

  it("constructs cleanly with a well-formed plugin route (no collision)", () => {
    const dataDir = makeTempDir();
    try {
      const server = createLibrarianServer({
        ...baseOptions(dataDir),
        plugins: [{ name: "extras", routes: [AGENT_WHOAMI, INTERNAL_PING] }],
      });
      try {
        expect(server.store).toBeDefined();
      } finally {
        server.store.close();
      }
    } finally {
      cleanupTempDir(dataDir);
    }
  });
});
