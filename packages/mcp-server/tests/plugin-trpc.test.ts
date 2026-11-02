// Plugin tRPC router registration (spec 060 T4, SC 5 + SC 7's namespace refusal).
//
// Proves a build-time plugin's tRPC routers merge under the plugin's NAME as a
// namespace (appRouter.<pluginName>.*), served on the INTERNAL listener only and
// 404 on the public one — and that a plugin name shadowing a core tRPC namespace
// is a LOUD construction-time refusal that names the plugin. Core behaviour with
// no plugin router stays byte-identical: buildAppRouter hands back the core
// appRouter OBJECT (the unedited existing trpc suites are the proof of parity).
//
// The end-to-end mount is exercised over a REAL socket through the SAME
// createHttpServer → route table → tRPC adapter the factory wires, on an
// ephemeral port (port 0, no port race). Collisions are exercised through the
// real factory, createLibrarianServer, per "throws at construction time".
//
// Imports the compiled artifacts (../dist), like the other internal-module suites.

import http from "node:http";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, withStore } from "../../../test/helpers.js";
import type { AuthConfig } from "../dist/http/auth.js";
import { createHttpServer } from "../dist/http/server.js";
import { type LibrarianServerOptions, createLibrarianServer } from "../dist/librarian-server.js";
import {
  type LibrarianPlugin,
  assertNoCoreNamespaceCollision,
  buildAppRouter,
} from "../dist/plugin.js";
import { appRouter } from "../dist/trpc/router.js";
import { publicProcedure, router } from "../dist/trpc/trpc.js";

// A plugin whose `members` router serves one public query. Built with the SAME
// `router` / `publicProcedure` the core uses (identical TrpcContext), exactly as a
// real plugin author would — so the merge is the real nesting, not a stand-in.
function makeTeamsPlugin(): LibrarianPlugin {
  const membersRouter = router({
    whoami: publicProcedure.query(() => ({ who: "teams-plugin" as const })),
  });
  return { name: "teams", trpcRouters: { members: membersRouter } };
}

// A minimal internal-surface AuthConfig: the internal listener resolves admin by
// isolation (ADR 0008 P3), and an unauthenticated fetch carries no Origin so the
// browser-origin gate passes (empty allow-list).
function makeAuth(): AuthConfig {
  return {
    adminToken: "",
    agentToken: "",
    agentTokenMap: new Map(),
    allowedOrigins: [],
    allowNoAuth: true,
    host: "127.0.0.1",
    port: 0,
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

// Base factory options with every scheduler timer OFF and loopback binds, so a
// throwing construction never binds a listener and never opens a store past the
// pre-store name validation (matches plugin-tools.test.ts).
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

interface TrpcData<T> {
  result: { data: T };
}

describe("plugin tRPC router registration — merge under the plugin namespace (spec 060 SC 5)", () => {
  it("returns the core appRouter object unchanged when no plugin supplies a tRPC router", () => {
    // Byte-identical default: no plugin router ⇒ the SAME appRouter instance, so the
    // dashboard's AppRouter contract and the admin surface are untouched.
    expect(buildAppRouter([])).toBe(appRouter);
    expect(buildAppRouter([{ name: "empty" }])).toBe(appRouter);
    expect(buildAppRouter([{ name: "tools-only", tools: [] }, { name: "also-empty" }])).toBe(
      appRouter,
    );
  });

  it("mounts a plugin procedure at appRouter.<pluginName>.* on the internal listener and 404s it on the public one", async () => {
    await withStore(async (store) => {
      const trpcRouter = buildAppRouter([makeTeamsPlugin()]);
      const auth = makeAuth();

      // The SAME createHttpServer the factory drives, one per surface. The internal
      // one serves the merged router at /trpc/*; the public one never mounts /trpc.
      const internal = createHttpServer({ store, auth, surface: "internal", trpcRouter });
      const publicServer = createHttpServer({ store, auth, surface: "public", trpcRouter });
      const internalPort = await listen(internal);
      const publicPort = await listen(publicServer);
      try {
        // SC 5: the plugin procedure is callable end-to-end over the internal listener
        // at its namespaced path appRouter.teams.members.whoami.
        const pluginRes = await fetch(`http://127.0.0.1:${internalPort}/trpc/teams.members.whoami`);
        expect(pluginRes.status).toBe(200);
        const pluginBody = (await pluginRes.json()) as TrpcData<{ who: string }>;
        expect(pluginBody.result.data.who).toBe("teams-plugin");

        // The merge kept the core surface intact — a core procedure still resolves.
        const coreRes = await fetch(`http://127.0.0.1:${internalPort}/trpc/health.ping`);
        expect(coreRes.status).toBe(200);
        const coreBody = (await coreRes.json()) as TrpcData<{ ok: boolean }>;
        expect(coreBody.result.data.ok).toBe(true);

        // Surface constraint: the plugin path is NOT reachable on the public listener
        // (the admin tRPC surface is internal-only, ADR 0008 P1) — it 404s there.
        const publicRes = await fetch(`http://127.0.0.1:${publicPort}/trpc/teams.members.whoami`);
        expect(publicRes.status).toBe(404);
      } finally {
        await closeServer(internal);
        await closeServer(publicServer);
      }
    });
  });
});

describe("plugin tRPC namespace refusals — loud, at construction time (spec 060 SC 7)", () => {
  it("throws naming the plugin when a plugin name shadows a core tRPC namespace", () => {
    const dataDir = makeTempDir();
    try {
      // A plugin mounting a router under a core key (`health`) — refused, message
      // names the plugin. The throw is at construction (baseOptions binds nothing).
      expect(() =>
        createLibrarianServer({
          ...baseOptions(dataDir),
          plugins: [{ name: "health", trpcRouters: makeTeamsPlugin().trpcRouters }],
        }),
      ).toThrow(/Plugin "health" collides with the core tRPC router namespace "health"/);
    } finally {
      cleanupTempDir(dataDir);
    }
  });

  it("refuses a core-shadowing plugin NAME even with no trpcRouters (the name reserves the namespace)", () => {
    const dataDir = makeTempDir();
    try {
      expect(() =>
        createLibrarianServer({ ...baseOptions(dataDir), plugins: [{ name: "memories" }] }),
      ).toThrow(/Plugin "memories" collides with the core tRPC router namespace "memories"/);
    } finally {
      cleanupTempDir(dataDir);
    }
  });

  it("the same refusal fires from assertNoCoreNamespaceCollision the factory calls", () => {
    // Exercised directly so the refusal isn't only observable through the factory.
    expect(() => assertNoCoreNamespaceCollision([{ name: "vault" }])).toThrow(
      /Plugin "vault" collides with the core tRPC router namespace "vault"/,
    );
    // A non-colliding name is accepted (composes with the plugin-vs-plugin gate).
    expect(() => assertNoCoreNamespaceCollision([{ name: "teams" }])).not.toThrow();
  });

  it("constructs cleanly with a well-formed plugin tRPC router (no collision)", () => {
    const dataDir = makeTempDir();
    try {
      const server = createLibrarianServer({
        ...baseOptions(dataDir),
        plugins: [makeTeamsPlugin()],
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
