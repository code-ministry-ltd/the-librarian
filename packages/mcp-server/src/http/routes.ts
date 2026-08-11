// HTTP request dispatcher.
//
// Pure routing layer over the LibrarianStore — no env, no boot-time
// validation. `createRouteHandler(deps)` returns the handler function
// the `node:http` server calls per request.
//
// Two surfaces (ADR 0008 P1 — split the listener; spec §4 "Two listeners"):
//
//   - "public"  — the published port (LIBRARIAN_HOST:PORT). Serves the
//     agent-facing surface: `/healthz`, `/primer.md`, `/mcp`. A request to
//     `/trpc/*` here 404s: the admin tRPC API (which `auth.config` uses to
//     return DECRYPTED secrets) is deliberately NOT exposed on the network.
//   - "internal" — a loopback/docker-network port (LIBRARIAN_TRPC_HOST:PORT,
//     unpublished). Serves ONLY `/trpc/*`. `/mcp`, `/healthz`, `/primer.md`
//     are not its job and 404.
//
// ADR 0008 P3: the `/trpc` surface is TRUSTED by isolation — the internal
// listener grants the admin role with NO bearer (the context factory resolves
// the "internal" surface to admin). The admin token is no longer a network gate;
// the socket itself is the boundary.
//
// The legacy dashboard file serves (`/`, `/styles.css`, `/app.js`) and `/api/*`
// REST routes are retired — the new Next.js dashboard at apps/dashboard
// is the canonical admin surface and uses Server Actions + browser
// tRPC. Anything else 404s.
//
// Routing is a per-surface route TABLE, not an if-ladder (ADR 0011, spec 060 T1):
// each listener owns an ordered list of route entries `createRouteHandler` walks.
// Core routes are the entries below; plugin routes (spec 060 T5) append to the same
// tables as more rows — public ones behind the origin gate, internal ones behind
// the same isolation check `/trpc/*` uses, each with its declared auth enforced in
// the walk. The hand-rolled handler stays (no Express/Fastify) — the table is
// small, audited, and ADR 0008-shaped.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type BootstrapClaimHandle,
  type IngestVia,
  type LibrarianStore,
  type Principal,
  INGEST_VIAS,
  checkIngestRateLimit,
  createInertBootstrapClaimHandle,
  isIntakeEnabled,
  markFailed,
  principalRefusalEvidence,
  processContentCapture,
  processTextCapture,
  processUrlCapture,
  readPrimer,
  recordPending,
} from "@librarian/core";
import type { AnyRouter } from "@trpc/server";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { handleMcpPayload } from "../mcp/rpc.js";
import type { ToolRegistry } from "../mcp/tool.js";
import { coreToolRegistry } from "../mcp/tools/index.js";
import type { ActorDisplayProvider, GuardedAuthProvider, LibrarianPlugin } from "../plugin.js";
import { createContextFactory } from "../trpc/context.js";
import { appRouter } from "../trpc/router.js";
import {
  type AuthConfig,
  type AuthProvider,
  type AuthProviderRefusal,
  type AuthResult,
  REQUIRE_EXPLICIT_AUTH_HEADER,
  defaultAuthProvider,
  isAllowedOrigin,
  principalToAuthResult,
  refusalRequestAttribution,
} from "./auth.js";
import { handleTranscriptIntake } from "./transcript-intake.js";

/** Which listener this handler serves (ADR 0008 P1, spec §4). */
export type RouteSurface = "public" | "internal";

export interface RouteDeps {
  store: LibrarianStore;
  auth: AuthConfig;
  maxBodyBytes: number;
  secretKey: Buffer | null;
  /** Pre-bound first-owner bootstrap handle; never a raw secret or data dir. */
  bootstrapClaim?: BootstrapClaimHandle;
  /**
   * The listener this handler serves. "public" serves the agent surface
   * (/mcp, /healthz, /primer.md) and 404s /trpc; "internal" serves ONLY
   * /trpc. Defaults to "public" so existing single-surface callers (and the
   * server factory's default) keep the agent surface.
   */
  surface?: RouteSurface;
  /**
   * The MCP tool registry the /mcp route dispatches through — the core tools plus
   * any plugin tools the factory merged in (spec 060 T3). Defaults to the core
   * registry so existing callers keep exactly today's tool surface.
   */
  toolRegistry?: ToolRegistry;
  /**
   * The tRPC router the internal listener's /trpc/* adapter serves — the core
   * `appRouter` plus any plugin routers the factory merged under their plugin
   * namespaces (spec 060 T4). Defaults to the core `appRouter` so existing callers
   * keep exactly today's admin surface. Unused on the public surface (no /trpc).
   */
  trpcRouter?: AnyRouter;
  /**
   * Plugin-contributed HTTP routes (spec 060 T5). The factory validates the set
   * ({@link assertPluginRoutes}) then passes ALL of them here; this handler serves
   * only the ones whose `surface` matches its own listener, appended AFTER the core
   * routes (public plugin routes always land in the post-origin-gate pass). Defaults
   * to none, so existing callers keep exactly today's route set.
   */
  pluginRoutes?: readonly PluginRoute[];
  /**
   * The factory-owned, guard-wrapped plugin auth provider (spec 060 T6, CONSUMED at spec 061 T4).
   * When present it REPLACES the OSS default ({@link defaultAuthProvider}) as the identity source
   * on every authenticated request path this handler serves — public `/mcp`, the plugin-route auth
   * walk, and the core capture routes (/transcript, /ingest) — and is threaded on to the internal
   * tRPC context factory ({@link createContextFactory}). The guard ({@link GuardedAuthProvider})
   * folds the no-admin-on-public 403 in. Absent unless a plugin supplied an `authProvider`, so
   * existing callers default to {@link defaultAuthProvider} and are byte-identical.
   */
  authProvider?: GuardedAuthProvider;
  /** Optional actor-display resolver delivered to the internal tRPC context. */
  actorDisplayProvider?: ActorDisplayProvider;
}

/**
 * The per-request context handed to every route handler: the request pair plus
 * the deps a handler needs. A route entry closes over nothing else, so each
 * surface's routes are a plain declarative list — the structure plugin routes
 * append to as more rows (spec 060 T5).
 */
interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  store: LibrarianStore;
  auth: AuthConfig;
  maxBodyBytes: number;
  toolRegistry: ToolRegistry;
  surface: RouteSurface;
  path: string;
  /**
   * The one identity source for this request (spec 061 T4): the factory's guard-wrapped plugin
   * provider when a plugin supplied one, else T1's {@link defaultAuthProvider}. The authenticated
   * public handlers consult it (never the raw plugin provider). Async-capable, so consultation is
   * always `await`ed.
   */
  provider: AuthProvider;
}

/**
 * A route handler owns its own method handling and (for authenticated routes)
 * its own auth call — the if-ladder bodies moved verbatim, not rewritten. Sync
 * routes return void; the /mcp, /transcript, /ingest handlers are async and may
 * reject, which the walk's `await` funnels to the outer try/catch.
 */
type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

interface Route {
  readonly match: (method: string | undefined, pathname: string) => boolean;
  readonly handle: RouteHandler;
}

/**
 * A public-surface route. `beforeOriginGate` marks the two unauthenticated
 * document routes (/healthz, /primer.md) that are served AHEAD of the browser-
 * origin gate; every other route — and the 404 floor — sits behind it.
 */
interface PublicRoute extends Route {
  readonly beforeOriginGate: boolean;
}

/** An internal-surface route (ADR 0008 P1: only /trpc/*). */
type InternalRoute = Route;

// ---------- Plugin HTTP routes (spec 060 T5, ADR 0011 seam S1) ----------

/**
 * The HTTP methods a plugin route may bind. Matching is EXACT method + path — a
 * plugin route answers one method on one path, no prefix/wildcard (the `/trpc/*`
 * prefix stays a core-only capability, spec 060 T5; widening is a future task).
 */
export type PluginRouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/**
 * A plugin route's declared authentication (spec 060 SC 6). The factory enforces
 * it in the TABLE WALK, before the handler runs, reusing the SAME helpers the core
 * routes use — so a plugin route can't reproduce the self-authenticating-handler
 * mistake ADR 0008 exists to prevent:
 *   - "agent"   → the agent-scope check `/mcp` and `/transcript` use: a valid but
 *                 wrong-scope capture token is 403; a missing/invalid credential is
 *                 401 with the SAME `WWW-Authenticate: Bearer` challenge core emits.
 *   - "capture" → the capture-scope check `/ingest` uses (an agent token is 403).
 *   - "none"    → no credential check; the handler receives a null auth result.
 * These are PUBLIC-surface scope semantics. On the INTERNAL surface the listener is
 * trusted by isolation (ADR 0008 P3) — the socket is the gate, not a bearer scope —
 * so an internal route is served behind the same origin gate the core `/trpc/*`
 * route uses and resolves to the trusted admin principal regardless of this field.
 */
export type PluginRouteAuth = "agent" | "capture" | "none";

/**
 * The per-request context a plugin route handler receives — the SAME idiom the
 * core route handlers get (the request pair, the store dep, the body cap) plus the
 * RESOLVED auth the factory enforced before dispatch. `auth` is the {@link AuthResult}
 * for `auth: "agent" | "capture"` (or the trusted admin result on the internal
 * surface) and `null` for `auth: "none"`. The Principal identity currency (ADR 0011
 * §4) supersedes `AuthResult` here in spec 061 — plugin handlers read it, they don't
 * build it.
 */
export interface PluginRouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly store: LibrarianStore;
  readonly maxBodyBytes: number;
  readonly auth: AuthResult | null;
}

/** A plugin route handler: like a core {@link RouteHandler}, sync or async. */
export type PluginRouteHandler = (ctx: PluginRouteContext) => Promise<void> | void;

/**
 * A plugin-contributed HTTP route (spec 060 T5, the `routes` seam of
 * {@link LibrarianPlugin}). Declares its `surface` and `auth` contract; the factory
 * enforces auth in the table walk and serves it as one more row in the declared
 * listener's table (public plugin routes ALWAYS land in the post-origin-gate pass).
 * Matching is exact `method` + `path`. A public route whose path is under `/trpc`,
 * a method+path collision with a core route on the same surface, or a collision
 * between two plugin routes on the same surface, is a boot error naming the plugin
 * ({@link assertPluginRoutes}) — registrations add, they never override.
 */
export interface PluginRoute {
  readonly path: string;
  readonly method: PluginRouteMethod;
  readonly surface: RouteSurface;
  readonly auth: PluginRouteAuth;
  readonly handler: PluginRouteHandler;
}

/** The admin tRPC path prefix (ADR 0008 P1) — the one prefix core matches. */
function isTrpcPrefix(pathname: string): boolean {
  return pathname.startsWith("/trpc/");
}

export function createRouteHandler(
  deps: RouteDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { store, auth, maxBodyBytes, secretKey } = deps;
  const bootstrapClaim = deps.bootstrapClaim ?? createInertBootstrapClaimHandle();
  const surface: RouteSurface = deps.surface ?? "public";
  const toolRegistry: ToolRegistry = deps.toolRegistry ?? coreToolRegistry;
  const trpcRouter: AnyRouter = deps.trpcRouter ?? appRouter;
  const pluginRoutes: readonly PluginRoute[] = deps.pluginRoutes ?? [];
  // The single per-process identity seam (spec 061 T4): the factory's guard-wrapped plugin
  // provider when one was supplied, else T1's default provider (today's auth matrix). With no
  // plugin provider this is byte-identical to the pre-T4 direct `defaultAuthProvider(auth)` calls.
  const provider: AuthProvider = deps.authProvider ?? defaultAuthProvider(auth);

  // Weave the plugin routes for THIS surface into the core table (spec 060 T5),
  // built once. Public plugin routes append to the public table as post-origin-gate
  // rows (beforeOriginGate: false), so the walk's two passes place them correctly.
  const publicTable: readonly PublicRoute[] =
    surface === "public"
      ? [
          ...publicRoutes,
          ...pluginRoutes.filter((route) => route.surface === "public").map(toPublicPluginRoute),
        ]
      : publicRoutes;

  // The tRPC adapter only serves the internal listener; the public one never
  // mounts it (defense by not-exposing, ADR 0008 P1). Build the internal route
  // table (and its adapter) once, for the internal surface alone — the core
  // /trpc/* route plus any internal plugin routes behind the same origin gate.
  const internalRoutes: readonly InternalRoute[] =
    surface === "internal"
      ? createInternalRoutes({
          store,
          auth,
          secretKey,
          bootstrapClaim,
          trpcRouter,
          pluginRoutes: pluginRoutes.filter((route) => route.surface === "internal"),
          // Thread the guarded plugin provider (when present) to the tRPC context factory so the
          // internal surface consults the SAME identity seam (spec 061 T4, SC 7).
          ...(deps.authProvider ? { authProvider: deps.authProvider } : {}),
          ...(deps.actorDisplayProvider ? { actorDisplayProvider: deps.actorDisplayProvider } : {}),
        })
      : [];

  return async function handle(req, res) {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      const ctx: RouteContext = {
        req,
        res,
        store,
        auth,
        maxBodyBytes,
        toolRegistry,
        provider,
        surface,
        path: url.pathname,
      };

      // Internal listener: the admin tRPC surface and nothing else. Anything that
      // isn't a mounted route (only /trpc/*) on this socket is not its job → 404.
      if (surface === "internal") {
        for (const route of internalRoutes) {
          if (route.match(req.method, url.pathname)) return await route.handle(ctx);
        }
        return sendJson(res, { error: "Not found" }, 404);
      }

      // Public listener (the published port): agent surface only. The two
      // unauthenticated document routes (/healthz, /primer.md) are served ahead of
      // the browser-origin gate — a health probe or a remote-URL primer fetch
      // attaches no Origin and must still read them.
      for (const route of publicTable) {
        if (route.beforeOriginGate && route.match(req.method, url.pathname)) {
          return await route.handle(ctx);
        }
      }

      if (!isAllowedOrigin(req, auth)) {
        recordOriginRefusal(ctx);
        return sendJson(res, { error: "Origin not allowed" }, 403);
      }

      // /trpc/* is NOT served on the public listener (ADR 0008 P1): the admin API
      // lives on the internal listener. It is simply absent from `publicRoutes`, so
      // a network peer here — and any unknown path — falls through to the 404 floor
      // below (a disallowed origin already 403'd above) and can't reach an admin
      // procedure.
      for (const route of publicTable) {
        if (!route.beforeOriginGate && route.match(req.method, url.pathname)) {
          return await route.handle(ctx);
        }
      }

      sendJson(res, { error: "Not found" }, 404);
    } catch (error) {
      const err = error as Error & { statusCode?: number };
      sendJson(res, { error: err.message }, err.statusCode || 500);
    }
  };
}

/**
 * Build the internal listener's route table: the admin tRPC surface (ADR 0008 P1)
 * plus any internal plugin routes (spec 060 T5). The tRPC adapter is constructed
 * once here and closed over by the core route; each plugin route is served behind
 * the SAME origin/isolation check the core `/trpc/*` route uses.
 */
function createInternalRoutes(deps: {
  store: LibrarianStore;
  auth: AuthConfig;
  secretKey: Buffer | null;
  bootstrapClaim: BootstrapClaimHandle;
  /** The tRPC router served at /trpc/* — core `appRouter`, or the merged core+plugin router (spec 060 T4). */
  trpcRouter: AnyRouter;
  /** Internal-surface plugin routes (spec 060 T5) — already filtered to this surface. */
  pluginRoutes: readonly PluginRoute[];
  /** The guard-wrapped plugin auth provider (spec 061 T4); absent ⇒ the tRPC context uses the default. */
  authProvider?: GuardedAuthProvider;
  /** Optional actor-display resolver (spec 068). */
  actorDisplayProvider?: ActorDisplayProvider;
}): readonly InternalRoute[] {
  // The tRPC context factory resolves the internal-surface principal through the SAME provider
  // seam the request paths use (spec 061 T4, SC 7): the guarded plugin provider when supplied,
  // else T1's default. Two concrete calls (not a spread) so overload resolution picks the sync
  // default signature when no plugin provider is present — the pre-T4 synchronous context.
  const createContext = deps.authProvider
    ? createContextFactory({
        store: deps.store,
        auth: deps.auth,
        secretKey: deps.secretKey,
        bootstrapClaim: deps.bootstrapClaim,
        authProvider: deps.authProvider,
        ...(deps.actorDisplayProvider ? { actorDisplayProvider: deps.actorDisplayProvider } : {}),
      })
    : createContextFactory({
        store: deps.store,
        auth: deps.auth,
        secretKey: deps.secretKey,
        bootstrapClaim: deps.bootstrapClaim,
        ...(deps.actorDisplayProvider ? { actorDisplayProvider: deps.actorDisplayProvider } : {}),
      });
  const trpcHandler = createHTTPHandler({
    router: deps.trpcRouter,
    createContext,
    basePath: "/trpc/",
  });
  const routes: InternalRoute[] = [
    {
      match: (_method, pathname) => isTrpcPrefix(pathname),
      handle: (ctx) => {
        // The internal listener is trusted by isolation (loopback / docker net,
        // never published — ADR 0008 P3), but the browser-origin gate still runs
        // before the tRPC adapter, exactly as the if-ladder did.
        if (!isAllowedOrigin(ctx.req, ctx.auth)) {
          recordOriginRefusal(ctx);
          return sendJson(ctx.res, { error: "Origin not allowed" }, 403);
        }
        return trpcHandler(ctx.req, ctx.res);
      },
    },
  ];
  for (const route of deps.pluginRoutes) {
    routes.push({
      match: (method, pathname) => method === route.method && pathname === route.path,
      handle: (ctx) => runInternalPluginRoute(route, ctx),
    });
  }
  return routes;
}

/**
 * Adapt a public plugin route into a {@link PublicRoute} table row (spec 060 T5).
 * `beforeOriginGate` is FALSE unconditionally — plugin routes always sit in the
 * post-origin-gate pass; the pre-gate flag is a core-route quirk (/healthz,
 * /primer.md) never exposed to plugins. Matching is exact method + path.
 */
function toPublicPluginRoute(route: PluginRoute): PublicRoute {
  return {
    beforeOriginGate: false,
    match: (method, pathname) => method === route.method && pathname === route.path,
    handle: (ctx) => runPublicPluginRoute(route, ctx),
  };
}

/**
 * Run a PUBLIC plugin route: enforce its declared `auth` in the table walk, before
 * the handler, with the SAME helpers and 401/403 shapes the core public routes use
 * (spec 060 SC 6). The handler runs only after auth passes and receives the resolved
 * auth (or null for `auth: "none"`).
 */
async function runPublicPluginRoute(route: PluginRoute, ctx: RouteContext): Promise<void> {
  if (route.auth === "none") return route.handler(toPluginContext(ctx, null));
  // route.auth is "agent" | "capture" here — the same TokenScope the core public routes require
  // for /mcp, /transcript ("agent") and /ingest ("capture"). Consult the SAME deps-threaded
  // provider (spec 061 T4) so a substitute member-aware provider sees plugin-route requests too,
  // and the public-admin guard's 403 lands here as well. The 401-challenge/403 wire shapes are
  // preserved; the resolved principal is mapped back to the AuthResult the plugin handler reads.
  const authed = await ctx.provider.authenticate(ctx.req, "public", route.auth);
  if (!authed.ok) {
    return sendAuthRefusal(ctx, authed);
  }
  return route.handler(toPluginContext(ctx, principalToAuthResult(authed.principal)));
}

/**
 * Run an INTERNAL plugin route: the internal listener is trusted by isolation
 * (ADR 0008 P3), so — mirroring the core `/trpc/*` route — the browser-origin gate
 * is the enforcement. The identity itself is resolved through the SAME deps-threaded
 * provider every other authenticated path consults (spec 061 review fix 2, SC 7), NOT a
 * direct `authenticateMcp` call — so a substitute member-aware provider is consulted here
 * too. No required scope: on this socket the declared `auth` field has no bearer scope to
 * check (see {@link PluginRouteAuth}); the socket is the gate. The DEFAULT provider's internal
 * branch returns exactly the admin principal `authenticateMcp` used to produce, so the default
 * path is byte-identical. A substitute that REFUSES on internal fails closed with the status it
 * names (401/403) — a new capability for substitutes, unreachable on the default path (whose
 * internal branch always oks).
 */
async function runInternalPluginRoute(route: PluginRoute, ctx: RouteContext): Promise<void> {
  if (!isAllowedOrigin(ctx.req, ctx.auth)) {
    recordOriginRefusal(ctx);
    return sendJson(ctx.res, { error: "Origin not allowed" }, 403);
  }
  const authed = await ctx.provider.authenticate(ctx.req, "internal");
  if (!authed.ok) return sendAuthRefusal(ctx, authed);
  return route.handler(toPluginContext(ctx, principalToAuthResult(authed.principal)));
}

/** Narrow a core {@link RouteContext} to the plugin-facing context + resolved auth. */
function toPluginContext(ctx: RouteContext, auth: AuthResult | null): PluginRouteContext {
  return { req: ctx.req, res: ctx.res, store: ctx.store, maxBodyBytes: ctx.maxBodyBytes, auth };
}

/**
 * Does a CORE route on `surface` already claim (method, path)? Uses the core
 * routes' OWN matchers, so the collision check is exactly "would a core route
 * handle this request?" — no duplicated route inventory that could drift.
 */
function coreRouteMatches(surface: RouteSurface, method: string, pathname: string): boolean {
  if (surface === "public") return publicRoutes.some((route) => route.match(method, pathname));
  // Internal: the one core route, the admin tRPC prefix (ADR 0008 P1).
  return isTrpcPrefix(pathname);
}

/**
 * Refuse (a construction-time boot error) any ill-formed plugin route BEFORE the
 * store opens (spec 060 SC 6 + SC 7). Three refusals, each naming the offending
 * plugin:
 *   1. a route (either surface) whose path is `/trpc` or under `/trpc/` — the prefix
 *      is core-reserved on BOTH listeners: publicly a mount would shadow the admin
 *      surface onto the published port (ADR 0008 P1); internally it is the core
 *      admin tRPC API's own prefix.
 *   2. a method+path collision with a CORE route on the same surface.
 *   3. a method+path collision between two PLUGIN routes on the same surface.
 * The factory calls this alongside the T3/T4 asserts, before constructing the store —
 * registrations add, they never override (ADR 0011).
 */
export function assertPluginRoutes(plugins: readonly LibrarianPlugin[]): void {
  // surface → "METHOD path" → the plugin that already registered it.
  const seen: Record<RouteSurface, Map<string, string>> = {
    public: new Map(),
    internal: new Map(),
  };
  for (const plugin of plugins) {
    for (const route of plugin.routes ?? []) {
      // 1. /trpc is core-reserved on BOTH surfaces. Reserve the whole prefix, including
      // the bare `/trpc` (not just `/trpc/*`): on the public surface a /trpc mount would
      // shadow the admin surface onto the published port (ADR 0008 P1), and on the
      // internal surface /trpc is the core admin tRPC API's own prefix — a plugin may not
      // squat it on either listener. (The internal `/trpc/*` case would also trip the
      // core-collision check below; catching the bare `/trpc` here closes the gap where a
      // trailing-slash-less path slipped through on the internal surface.)
      if (route.path === "/trpc" || isTrpcPrefix(route.path)) {
        const article = route.surface === "internal" ? "an" : "a";
        throw new Error(
          `Plugin "${plugin.name}" registers ${article} ${route.surface} route "${route.method} ${route.path}" ` +
            `under /trpc, but /trpc is the core admin tRPC surface (ADR 0008 P1) and is reserved on ` +
            `both listeners — a plugin may not mount /trpc on the ${route.surface} surface (spec 060 SC 6).`,
        );
      }
      // 2. Collision with a core route on the same surface.
      if (coreRouteMatches(route.surface, route.method, route.path)) {
        throw new Error(
          `Plugin "${plugin.name}" registers a route "${route.method} ${route.path}" on the ` +
            `${route.surface} surface, which collides with a core route — registrations add, they ` +
            `never override (spec 060 SC 7).`,
        );
      }
      // 3. Collision with another plugin's route on the same surface.
      const key = `${route.method} ${route.path}`;
      const owner = seen[route.surface].get(key);
      if (owner !== undefined) {
        throw new Error(
          `Plugin "${plugin.name}" registers a route "${route.method} ${route.path}" on the ` +
            `${route.surface} surface, which is already registered by plugin "${owner}" — ` +
            `registrations add, they never override (spec 060 SC 7).`,
        );
      }
      seen[route.surface].set(key, plugin.name);
    }
  }
}

/**
 * The public listener's route table (the agent surface, ADR 0008 P1). Walked in
 * order by {@link createRouteHandler}: the two `beforeOriginGate` document routes
 * match first (served without the browser-origin gate), then the gate runs, then
 * the authenticated agent routes — then any public plugin routes ({@link
 * toPublicPluginRoute}), which always sit in that post-gate pass (spec 060 T5).
 */
const publicRoutes: readonly PublicRoute[] = [
  {
    beforeOriginGate: true,
    match: (m, p) => m === "GET" && p === "/healthz",
    handle: handleHealthz,
  },
  {
    beforeOriginGate: true,
    match: (m, p) => m === "GET" && p === "/primer.md",
    handle: handlePrimer,
  },
  { beforeOriginGate: false, match: (_m, p) => p === "/mcp", handle: handleMcp },
  { beforeOriginGate: false, match: (_m, p) => p === "/transcript", handle: handleTranscript },
  { beforeOriginGate: false, match: (_m, p) => p === "/ingest", handle: handleIngestRoute },
];

async function handleHealthz(ctx: RouteContext): Promise<void> {
  const { auth, store, req, res } = ctx;
  // ADR 0008 P3: the admin token is no longer the /mcp gate — the agent
  // token is. Report MCP auth status off the AGENT credential (the bypass
  // = disabled), not the (now non-gating) admin token.
  const staticMcpAuth = !auth.allowNoAuth && (auth.agentToken || auth.agentTokenMap.size);
  let mcpAuth: "enabled" | "disabled" | "unknown" = staticMcpAuth ? "enabled" : "disabled";
  const url = new URL(req.url || "/healthz", `http://${req.headers.host ?? "localhost"}`);
  if (url.searchParams.get("auth_probe") === "1") {
    // The probe answers "would an ANONYMOUS agent be admitted?" — evaluate it
    // on a credential-stripped view of the request, so an operator probing
    // with their own valid bearer is not told auth is disabled (their
    // credential proves nothing about anonymous admission).
    const anonymousHeaders = { ...req.headers };
    delete anonymousHeaders.authorization;
    delete anonymousHeaders["proxy-authorization"];
    const anonymousProbe = Object.assign(Object.create(req) as typeof req, {
      headers: anonymousHeaders,
    });
    let timeout: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([
        Promise.resolve(ctx.provider.authenticate(anonymousProbe, "public", "agent")),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("auth provider probe timed out")), 1_000);
        }),
      ]);
      mcpAuth = outcome.ok ? "disabled" : "enabled";
    } catch {
      mcpAuth = "unknown";
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
  // Capture status (spec 2026-06-16-harness-auto-capture, T5 / SC9): the
  // harness SessionStart banner reads this to tell the agent whether
  // automatic capture is live or warn (with the fix) when it is off.
  // `capture` is "enabled" iff the curator INTAKE gate that drains the
  // transcript buffer is on (the server-authoritative gate, spec §5 Q-gate)
  // — the same gate /transcript checks before buffering. It is a plain
  // boolean of an admin setting, no secret, so it is unauthenticated-safe
  // (like the rest of /healthz). `isIntakeEnabled` is fail-soft, but a
  // store-level throw (e.g. a transient DB read error) must NEVER turn the
  // container's HEALTHCHECK probe into a 500 — /healthz answering at all IS
  // the health signal. Default `capture` to "disabled" (the safe, no-leak
  // value) if the gate read throws.
  let captureEnabled = false;
  try {
    captureEnabled = isIntakeEnabled(store);
  } catch {
    captureEnabled = false;
  }
  return sendJson(res, {
    status: "ok",
    dashboard_auth: "disabled",
    mcp_auth: mcpAuth,
    auth: mcpAuth,
    agent_auth: auth.agentToken || auth.agentTokenMap.size ? "enabled" : "disabled",
    capture: captureEnabled ? "enabled" : "disabled",
  });
}

function handlePrimer(ctx: RouteContext): void {
  const { store, res } = ctx;
  // The primer endpoint (rethink T11, spec §5.2): unauthenticated BY
  // DESIGN — OpenCode's remote-URL `instructions` config fetches it with
  // no way to attach a bearer. The auth bypass is scoped to exactly this
  // path; it serves only vault/primer.md, which must never interpolate
  // operator-specific or secret content. GET-only and, like /healthz,
  // ahead of the browser-origin gate (it is a public document).
  res.writeHead(200, {
    "content-type": "text/markdown; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(readPrimer(store));
}

async function handleMcp(ctx: RouteContext): Promise<void> {
  const { req, res, store, maxBodyBytes } = ctx;
  // Public surface: agent-role only — the default provider has NO admin path here, so /mcp can
  // never resolve to admin (ADR 0008 P3), and the factory-owned public-admin guard refuses an
  // admin principal from a substitute provider (403) before dispatch. It also requires `agent`
  // SCOPE: a least-privilege capture token is FORBIDDEN (403), never reaching the 7 verbs (ingest
  // spec D21). We consult the deps-threaded PROVIDER (spec 061 T4 — the factory's guarded plugin
  // provider, or T1's default) and read its Principal directly: the lossy AuthResult would drop
  // the env-token / localhost SENTINEL actorId, which SC 4 needs as the no-id fallback actor. With
  // no plugin provider this is byte-identical to the pre-T4 `defaultAuthProvider(auth)` call.
  if (refuseMissingProxyBearer(ctx)) return;
  const authed = await ctx.provider.authenticate(req, "public", "agent");
  if (!authed.ok) return sendAuthRefusal(ctx, authed);
  if (req.method !== "POST") {
    return sendJson(res, { error: "Method not allowed" }, 405, { allow: "POST" });
  }
  const payload = await readJson(req, maxBodyBytes);
  const response = await handleMcpPayload(
    store,
    payload,
    { principal: authed.principal },
    ctx.toolRegistry,
  );
  if (response === null) return sendEmpty(res);
  return sendJson(res, response);
}

async function handleTranscript(ctx: RouteContext): Promise<void> {
  const { req, res, store, maxBodyBytes } = ctx;
  // Harness-driven automatic capture (spec 2026-06-16-harness-auto-capture,
  // T1). Same agent-scope auth as /mcp on this public surface — routed through the SAME
  // deps-threaded provider (spec 061 T4) so the identity seam is one place; never admin
  // (ADR 0008 P3 + the public-admin guard): a non-agent/unauthed caller 401s, mirroring /mcp.
  // Requires `agent` scope — a capture token is forbidden here (D21). Byte-identical to the
  // pre-T4 `authenticatePublic` call when no plugin provider is installed.
  if (refuseMissingProxyBearer(ctx)) return;
  const authed = await ctx.provider.authenticate(req, "public", "agent");
  if (!authed.ok) return sendAuthRefusal(ctx, authed);
  if (req.method !== "POST") return sendJson(res, { error: "Method not allowed" }, 405);
  const payload = await readJson(req, maxBodyBytes);
  // The handler is fail-soft (validates, gate-checks, redacts, buffers) and
  // never throws — it returns the status + body to send. The resolved principal
  // (spec 061 T4) lets it record the capturing agent's write-target shelf so the
  // settle-sweep routes this conversation's facts to that shelf's inbox (spec 062 SC 8a).
  const intake = handleTranscriptIntake(store, payload, authed.principal);
  return sendJson(res, intake.body, intake.status);
}

async function handleIngestRoute(ctx: RouteContext): Promise<void> {
  const { req, res, store } = ctx;
  // Reference ingest (ingest spec D3): the browser-extension / mobile-share
  // endpoint. Requires `capture` SCOPE — an agent token (and the localhost
  // bypass's agent identity) is FORBIDDEN (403), the other direction of the
  // D21 wall; no/invalid credential is 401. Routed through the SAME deps-threaded
  // provider (spec 061 T4) — byte-identical to the pre-T4 `authenticatePublic`
  // call with no plugin provider. The fetch/extract/write pipeline lands in later
  // tasks — this is the synchronous front door (D22): auth → size cap →
  // field-presence/`via` validation → write a `pending` log row → 202
  // {status:"queued", id}. The row stays `pending` until a later task adds
  // background processing.
  if (refuseMissingProxyBearer(ctx)) return;
  const authed = await ctx.provider.authenticate(req, "public", "capture");
  if (!authed.ok) return sendAuthRefusal(ctx, authed);
  if (req.method !== "POST") return sendJson(res, { error: "Method not allowed" }, 405);
  // `await` (not a bare `return`) so a readJson throw (413/400) rejects while
  // still inside the route walk's try/catch and is sent by the outer catch — a
  // bare return would let the rejection escape the handler and reset the socket.
  // The full Principal rides through: the rate limiter keys on its tokenId (D19), and the
  // background write resolves its write-target shelf so captured references land under that
  // shelf's prefix (spec 062 SC 8b).
  return await handleIngest(req, res, store, INGEST_MAX_BODY_BYTES, authed.principal);
}

// ---------- /ingest front door (ingest spec Task 3, D22) ----------

/**
 * Request-body cap for /ingest (ingest spec criterion 3 / D14). Independent of
 * the generic `LIBRARIAN_MAX_BODY_BYTES` (/mcp, /transcript) because a `content`
 * capture carries a full extracted article — ~2 MB headroom, not the 1 MB MCP
 * default. The EXTRACTED-markdown cap (~1 MB) is a different, post-fetch limit
 * applied in a later task (it is a logged failure, not a synchronous 413).
 */
const INGEST_MAX_BODY_BYTES = 2 * 1024 * 1024;

// `INGEST_VIAS` is imported from core (spec 073 D3). This file used to keep a
// second copy of the list, so adding a `via` in one place while the other
// silently rejected it was a standing trap — exactly the drift that pair
// invites.

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The synchronous /ingest pipeline (D22). Validates, writes a `pending` row, and
 * returns 202 — it never throws to the caller (fail-soft): every outcome is a
 * deliberate status with a teaching message. The size-cap (413) and malformed-JSON
 * (400) throws from {@link readJson} are caught by the route's outer try/catch,
 * which sends a clean JSON error (no stack trace, no secrets) — not a leak.
 */
async function handleIngest(
  req: IncomingMessage,
  res: ServerResponse,
  store: LibrarianStore,
  maxBodyBytes: number,
  principal: Principal,
): Promise<void> {
  // The /ingest rate limiter keys on the capture token's id (D19).
  const tokenId = principal.tokenId;
  // Captured references land on the CAPTURING principal's write-target shelf (spec 062 SC 8b): the
  // processors stay shelf-IGNORANT (they still mint `references/web/…`), and the route/store
  // boundary prepends the shelf prefix. A shelf's `vaultFiles` speaks FULL vault-relative paths
  // (T3's documented asymmetry), so the boundary is a thin prefix-prepending adapter over the
  // scoped surface — its onWrite invalidates the RIGHT shelf's index, and the ingest-log
  // dedup/mark stays on the shared vault-singular settings. Resolved LAZILY inside the background
  // work so a misconfigured supplied router surfaces as a logged failure, never a post-202 throw.
  // Under the DEFAULT router the write-target is the vault-root shelf (prefix "") ⇒ pass-through ⇒
  // the minted paths are byte-identical to before.
  const captureStore = (): Parameters<typeof processContentCapture>[0] => {
    const shelf = store.resolveWriteTarget(principal);
    const scoped = store.forShelf(shelf, principal);
    const { prefix } = shelf;
    return {
      ...store,
      vaultFiles: {
        // Thread the acting principal (spec 064 SC 4): TypeScript would accept a
        // shorter-arity wrapper here and SILENTLY DROP the actor — the ingest pipeline
        // mints filenames from fetched content, so its writes must be attributed too.
        createFile: (rel, raw) =>
          scoped.vaultFiles.createFile(prefix + rel, raw, principal.actorId),
        writeFile: (rel, raw, options) =>
          scoped.vaultFiles.writeFile(prefix + rel, raw, options, principal.actorId),
      },
    };
  };
  // Size cap first (criterion 3): a >cap body is rejected before we buffer or
  // parse it. readJson streams + aborts over the cap (413) and 400s malformed JSON.
  const body = await readJson(req, maxBodyBytes, {
    tooLargeMessage: `Request body too large: the /ingest cap is ${Math.round(maxBodyBytes / (1024 * 1024))} MB`,
    drainOnOverflow: true,
  });

  // Field-presence dispatch (criterion 2 / D12): exactly which field is present
  // (content vs url vs text) drives the LATER write tasks — here we only require
  // at least one, and teach by naming all three.
  if (
    !isNonEmptyString(body.content) &&
    !isNonEmptyString(body.url) &&
    !isNonEmptyString(body.text)
  ) {
    return sendJson(
      res,
      {
        error:
          "Expected one of: content, url, text (a non-empty string). " +
          "Send `content` for pre-extracted markdown, `url` to fetch + extract, or `text` for a raw note.",
      },
      400,
    );
  }

  // `via` (D13 frontmatter): which client produced the capture. Validate against
  // the known set; default to `extension` when absent (the browser path is the
  // common case). A present-but-unknown value is a teaching 400, never silently
  // coerced — recordPending would otherwise reject it.
  const via = resolveVia(body.via);
  if (!via) {
    return sendJson(
      res,
      {
        error: `Expected 'via' to be one of: ${INGEST_VIAS.join(", ")} (or omitted, defaulting to extension)`,
      },
      400,
    );
  }

  // Per-token rate limit (criterion 10 / D19): a leaked capture token is the
  // threat, so the limiter keys on the specific tokenId — a daily quota + a short
  // burst cap, both counted in the durable settings sidecar. Over either limit →
  // 429 with a Retry-After header + a teaching body. Checked AFTER validation (a
  // malformed request shouldn't burn quota) and BEFORE writing the pending row (a
  // throttled request records nothing). Every /ingest caller is a DB-minted capture
  // token, so tokenId is present; the guard is belt-and-braces (env tokens and the
  // no-auth bypass are agent-scope and can't reach here).
  if (tokenId) {
    const limit = checkIngestRateLimit(store, tokenId);
    if (!limit.allowed) {
      const {
        authorizationPresent: _authorizationPresent,
        tokenHash: _tokenHash,
        ...request
      } = refusalRequestAttribution(req);
      void store.recordRefusal({
        kind: "rate-limited",
        surface: "public",
        outcome: 429,
        path: "/ingest",
        ...principalRefusalEvidence(principal),
        ...request,
      });
      return sendJson(
        res,
        {
          error:
            `Rate limit exceeded (${limit.reason}); slow down and retry in ` +
            `${limit.retryAfterSeconds}s. Each capture token is capped per day and per burst (D19).`,
          retry_after_seconds: limit.retryAfterSeconds,
        },
        429,
        { "retry-after": String(limit.retryAfterSeconds) },
      );
    }
  }

  // The dedup/crash-safety invariant (criterion 5 / D22): write a `pending` row
  // BEFORE the 202 so a crash before background processing still leaves a recorded
  // attempt. `source` is the url when present (the dedup key for url/content
  // captures) or a marker for a text/content-only capture; recordPending redacts
  // it (D25). The id is returned so a client can show "Queued ✓".
  const source = isNonEmptyString(body.url)
    ? body.url.trim()
    : isNonEmptyString(body.content)
      ? "content-capture"
      : "text-capture";
  const id = recordPending(store, { source, via });
  sendJson(res, { status: "queued", id }, 202);

  // Background processing (D22): the heavy write runs AFTER the 202 so the client
  // is never blocked, and a failure here is LOGGED, never returned. Field-presence
  // (D12) picks the branch: `content` carries pre-extracted markdown (no fetch),
  // a bare `url` is fetched + extracted server-side (SSRF-guarded, Task 6), and
  // `text` is a raw note (no fetch, no dedup, no source). `content` wins when both
  // are present (it is the richer capture); `url` is the mobile share path.
  // `setImmediate` defers the work past this response's flush + handler return.
  // Each processor is itself fail-soft (records failures via markFailed and
  // resolves rather than throwing); the `.catch` is belt-and-braces so an
  // unexpected rejection can't escape as an unhandled promise.
  if (isNonEmptyString(body.content)) {
    const input = {
      content: body.content,
      ...(isNonEmptyString(body.url) ? { url: body.url.trim() } : {}),
      ...(isNonEmptyString(body.title) ? { title: body.title } : {}),
      // Forward the extension's extracted site/byline (D13) so a client-side
      // (Defuddle-in-browser) capture populates the same frontmatter the
      // server-fetch path does. processContentCapture already accepts them.
      ...(isNonEmptyString(body.site) ? { site: body.site } : {}),
      ...(isNonEmptyString(body.byline) ? { byline: body.byline } : {}),
      via,
    };
    setImmediate(() => {
      // `Promise.resolve().then` so a captureStore() throw (a misconfigured router's write-target)
      // rejects into the same fail-soft `.catch` rather than escaping the setImmediate callback.
      Promise.resolve()
        .then(() => processContentCapture(captureStore(), input, id))
        .catch((error) => failBackground(store, id, error));
    });
  } else if (isNonEmptyString(body.url)) {
    // url-only capture (D1/D23): the server fetches + extracts. processUrlCapture
    // owns the SSRF-guarded fetch (resolved-IP deny-list, socket pinning, per-hop
    // re-validation, body cap, text/html gate) and is itself fail-soft — every
    // refusal/error is recorded via markFailed and it never throws.
    const input = { url: body.url.trim(), via };
    setImmediate(() => {
      Promise.resolve()
        .then(() => processUrlCapture(captureStore(), input, id))
        .catch((error) => failBackground(store, id, error));
    });
  } else if (isNonEmptyString(body.text)) {
    const input = { text: body.text, via };
    setImmediate(() => {
      Promise.resolve()
        .then(() => processTextCapture(captureStore(), input, id))
        .catch((error) => failBackground(store, id, error));
    });
  }
}

/**
 * Belt-and-braces failure record for a background capture processor that somehow
 * rejected (the processors are fail-soft and shouldn't, but an unhandled rejection
 * must never escape a fire-and-forget turn). The markFailed write is itself
 * wrapped — if even that throws there is nothing more we can safely do.
 */
function failBackground(store: LibrarianStore, id: string, error: unknown): void {
  try {
    markFailed(store, id, error instanceof Error ? error.message : String(error));
  } catch {
    // The log write itself failed — nothing more to do from a background turn.
  }
}

/** Resolve the body `via` to a known {@link IngestVia}, defaulting to extension when absent. */
function resolveVia(value: unknown): IngestVia | null {
  if (value === undefined || value === null || value === "") return "extension";
  return INGEST_VIAS.includes(value as IngestVia) ? (value as IngestVia) : null;
}

// ---------- HTTP IO helpers ----------

function sendJson(
  res: ServerResponse,
  payload: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function sendEmpty(res: ServerResponse): void {
  res.writeHead(202, { "cache-control": "no-store" });
  res.end();
}

function recordOriginRefusal(ctx: RouteContext): void {
  const { authorizationPresent: _authorizationPresent, ...request } = refusalRequestAttribution(
    ctx.req,
  );
  void ctx.store.recordRefusal({
    kind: "origin-blocked",
    surface: ctx.surface,
    outcome: 403,
    path: ctx.path,
    ...request,
  });
}

/**
 * The single-port proxy is a bearer-only boundary regardless of a substitute
 * provider's anonymous policy. The marker is injected by the dashboard and can
 * only make a direct request stricter; it never grants access.
 */
function refuseMissingProxyBearer(ctx: RouteContext): boolean {
  if (ctx.req.headers[REQUIRE_EXPLICIT_AUTH_HEADER] !== "single-port") return false;
  const raw = ctx.req.headers.authorization;
  const authorization = Array.isArray(raw) ? raw.join(", ") : raw;
  if (authorization?.startsWith("Bearer ") && authorization.length > "Bearer ".length) {
    return false;
  }
  const attribution = refusalRequestAttribution(ctx.req);
  sendAuthRefusal(ctx, {
    ok: false,
    status: 401,
    reason: attribution.authorizationPresent ? "invalid" : "missing",
  });
  return true;
}

function sendAuthRefusal(ctx: RouteContext, refusal: AuthProviderRefusal): void {
  const { authorizationPresent: _authorizationPresent, ...request } = refusalRequestAttribution(
    ctx.req,
  );
  const kind =
    refusal.reason === "missing"
      ? "bearer-missing"
      : refusal.reason === "invalid"
        ? "bearer-invalid"
        : refusal.reason === "wrong-scope"
          ? "bearer-wrong-scope"
          : "provider-refused";
  void ctx.store.recordRefusal({
    kind,
    surface: ctx.surface,
    outcome: refusal.status,
    path: ctx.path,
    ...(refusal.principal === undefined
      ? {}
      : {
          actorId: refusal.principal.actorId,
          roles: [...refusal.principal.roles],
          ...(refusal.principal.tokenId === undefined
            ? {}
            : { tokenId: refusal.principal.tokenId }),
        }),
    ...request,
  });
  return refusal.status === 403 ? sendForbidden(ctx.res) : sendUnauthorized(ctx.res);
}

function sendUnauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    "www-authenticate": "Bearer",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

// A valid credential of the WRONG scope (ingest spec D21): 403, not 401 — the
// caller authenticated but isn't permitted on this surface (capture token on
// /mcp, or agent token on /ingest). No `www-authenticate` challenge: presenting
// different agent credentials won't help; the scope is the gate.
function sendForbidden(res: ServerResponse): void {
  res.writeHead(403, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify({ error: "Forbidden: token scope not permitted on this endpoint" }));
}

async function readJson(
  req: IncomingMessage,
  maxBodyBytes: number,
  opts: { tooLargeMessage?: string; drainOnOverflow?: boolean } = {},
): Promise<Record<string, unknown>> {
  let body = "";
  let size = 0;
  let overflow = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      // Responding to an in-flight upload without consuming the rest of the body
      // makes Node RST the socket, so the client sees a connection reset instead
      // of the 413 (ingest spec criterion 3 wants a CLEAN status). When asked,
      // keep draining (discarding) the remainder so the 413 flushes — but bound
      // the drain so a malicious oversize upload can't tie up the socket forever.
      if (!opts.drainOnOverflow) {
        throw httpError(opts.tooLargeMessage ?? "Request body too large", 413);
      }
      overflow = true;
      if (size > maxBodyBytes * 8) {
        req.destroy();
        break;
      }
      continue;
    }
    body += chunk;
  }
  if (overflow) throw httpError(opts.tooLargeMessage ?? "Request body too large", 413);
  if (!body) return {};
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch (error) {
    throw httpError(`Invalid JSON body: ${(error as Error).message}`, 400);
  }
}

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}
