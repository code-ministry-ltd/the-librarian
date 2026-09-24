// HTTP server factory.
//
// Composition root for the HTTP API: auth config + store →
// a configured `node:http` server. The bin entrypoint (bin/http.ts) owns
// env parsing, boot-time validation, and signal handling; this module
// just assembles the runtime pieces so the same server can be spun up
// from tests without spawning a subprocess.

import http from "node:http";
import {
  type BootstrapClaimHandle,
  type LibrarianStore,
  createInertBootstrapClaimHandle,
} from "@librarian/core";
import type { AnyRouter } from "@trpc/server";
import type { MemoryCorrectionWakeRequest, ToolRegistry } from "../mcp/tool.js";
import { coreToolRegistry } from "../mcp/tools/index.js";
import type { ActorDisplayProvider, GuardedAuthProvider } from "../plugin.js";
import { appRouter } from "../trpc/router.js";
import type { AuthConfig } from "./auth.js";
import { type PluginRoute, type RouteSurface, createRouteHandler } from "./routes.js";

export interface HttpServerOptions {
  store: LibrarianStore;
  auth: AuthConfig;
  maxBodyBytes?: number;
  /** Master key — threaded to the tRPC auth router for AUTH_SECRET / OAuth secrets. */
  secretKey?: Buffer | null;
  /** Pre-bound first-owner bootstrap handle; absent is the inert OSS default. */
  bootstrapClaim?: BootstrapClaimHandle;
  /**
   * Which surface this server serves (ADR 0008 P1). "public" (default) carries
   * the agent surface (/mcp, /healthz, /primer.md); "internal" carries only the
   * admin tRPC API (/trpc/*). The bin spins up one of each.
   */
  surface?: RouteSurface;
  /**
   * The MCP tool registry the /mcp route dispatches through (spec 060 T3). The
   * factory passes a merged core+plugin registry; defaults to the core registry so
   * existing callers keep exactly today's tool surface.
   */
  toolRegistry?: ToolRegistry;
  /**
   * The tRPC router the internal listener's /trpc/* adapter serves (spec 060 T4).
   * The factory passes a merged core+plugin router (`buildAppRouter`); defaults to
   * the core `appRouter` so existing callers keep exactly today's admin surface.
   * Ignored on the public surface, which never mounts /trpc (ADR 0008 P1).
   */
  trpcRouter?: AnyRouter;
  /**
   * Plugin-contributed HTTP routes (spec 060 T5). The factory passes the whole
   * validated set to each listener; the route handler serves only the ones whose
   * `surface` matches. Defaults to none, so existing callers keep today's route set.
   */
  pluginRoutes?: readonly PluginRoute[];
  /**
   * The factory-owned, guard-wrapped plugin auth provider (spec 060 T6, CONSUMED at spec 061 T4).
   * Threaded to the route handler, where — when present — it REPLACES the OSS default as the
   * identity source on the authenticated request paths (and on to the internal tRPC context).
   * Absent unless a plugin supplied one, so existing callers are byte-identical.
   */
  authProvider?: GuardedAuthProvider;
  /** Optional actor-display resolver delivered to the internal tRPC context. */
  actorDisplayProvider?: ActorDisplayProvider;
  /** Post-persist wake callback for durable flagged-correction work. */
  wakeMemoryCorrection?: (request: MemoryCorrectionWakeRequest) => void;
}

export function createHttpServer(options: HttpServerOptions): http.Server {
  const handler = createRouteHandler({
    store: options.store,
    auth: options.auth,
    maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
    secretKey: options.secretKey ?? null,
    bootstrapClaim: options.bootstrapClaim ?? createInertBootstrapClaimHandle(),
    surface: options.surface ?? "public",
    toolRegistry: options.toolRegistry ?? coreToolRegistry,
    trpcRouter: options.trpcRouter ?? appRouter,
    pluginRoutes: options.pluginRoutes ?? [],
    // Consumed on the request paths (spec 061 T4). exactOptionalPropertyTypes: only add the key
    // when a provider was actually supplied, so the default handler is byte-identical.
    ...(options.authProvider ? { authProvider: options.authProvider } : {}),
    ...(options.actorDisplayProvider ? { actorDisplayProvider: options.actorDisplayProvider } : {}),
    ...(options.wakeMemoryCorrection ? { wakeMemoryCorrection: options.wakeMemoryCorrection } : {}),
  });
  const server = http.createServer((req, res) => {
    // A client that disconnects mid-response makes the next `res`/socket write
    // EPIPE. Node throws on an UNHANDLED stream 'error', so without these guards a
    // dropped client crashes the whole server process. A client must never be able
    // to kill the server — swallow per-request stream errors (the request is
    // already dead; nothing sensitive is logged).
    req.on("error", () => {});
    res.on("error", () => {});
    void handler(req, res);
  });
  // A malformed request line / TLS junk / a disconnect before the response surfaces
  // as 'clientError'. Close the socket cleanly rather than letting it bubble.
  server.on("clientError", (_err, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } else {
      socket.destroy();
    }
  });
  // Backstop: any connection-level socket error (an RST/EPIPE during teardown, a
  // half-open peer) is swallowed so a dropped client can never crash the server.
  server.on("connection", (socket) => {
    socket.on("error", () => {});
  });
  return server;
}
