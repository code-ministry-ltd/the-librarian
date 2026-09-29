import "server-only";
import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { hostRefusalMessage, isAllowedHost } from "@/lib/allowed-host";
import { getAuthConfig } from "@/lib/auth-config-client";
import { resolveEnforcement } from "@/lib/auth-gate";
import {
  DASHBOARD_USER_HEADER,
  DASHBOARD_USER_POISON,
  encodeDashboardAssertion,
  hasSessionCookie,
  userClaimsFromSession,
} from "@/lib/dashboard-assertion";

const DEFAULT_SERVER_URL = "http://127.0.0.1:3838";
const ALLOWED_METHODS = new Set(["GET", "POST"]);
// The identity header joins STRIP_INBOUND in the SAME change that introduces it (spec 065 SC 1):
// the proxy forwards all non-stripped inbound headers verbatim (route.ts), so without this a
// browser could set `x-librarian-dashboard-user` itself and the proxy would relay it. It is
// stripped inbound, then re-derived below from the proxy's OWN session — never from the wire.
const STRIP_INBOUND = new Set([
  "host",
  "connection",
  "content-length",
  "authorization",
  "cookie",
  DASHBOARD_USER_HEADER,
]);
const STRIP_OUTBOUND = new Set(["content-encoding", "transfer-encoding"]);

// ADR 0008 P2/P3: the admin tRPC API is served on its OWN internal listener, on a
// different host:port from the agent /mcp surface, and is TRUSTED (admin with no
// bearer — reachable only over loopback / the internal docker network). So this
// proxy targets LIBRARIAN_TRPC_URL (NOT the agent LIBRARIAN_SERVER_URL) and
// forwards with NO Authorization header. LIBRARIAN_TRPC_URL wins; LIBRARIAN_SERVER_URL
// is kept only as the dev fallback (single server).
function trpcBaseUrl(): string {
  return process.env.LIBRARIAN_TRPC_URL ?? process.env.LIBRARIAN_SERVER_URL ?? DEFAULT_SERVER_URL;
}

function isSameOrigin(req: NextRequest): boolean {
  // Sec-Fetch-Site is set by modern browsers for fetch() requests. We reject
  // only cross-site requests as a CSRF defence. "same-origin" (browser fetch),
  // "none" (direct navigation), and absent (server-side internal fetches,
  // older clients) are all accepted.
  return req.headers.get("sec-fetch-site") !== "cross-site";
}

// spec 065 SC 1: derive the identity assertion the proxy will forward, from the proxy's OWN
// session. The rule, mirroring the identity callback's cookie rows (SC 3) so the two producers
// agree on an unresolvable session:
//   - a session that resolves to a stable subject → the USER assertion;
//   - a session cookie present but the session does NOT resolve (expired / tampered) → the poison
//     marker (refused, not silently trusted);
//   - no session cookie at all → the ANONYMOUS assertion (a browser with no session).
// The auth() resolve is skipped when no session cookie is present (there is nothing to resolve),
// which also keeps enforcement-"open" sessionless calls from paying for — or depending on — auth().
async function deriveDashboardAssertion(req: NextRequest): Promise<string> {
  const sessionCookiePresent = hasSessionCookie(req.cookies.getAll().map((c) => c.name));
  if (!sessionCookiePresent) return encodeDashboardAssertion({ anon: true });

  const session = await auth().catch(() => null);
  const claims = session?.user
    ? userClaimsFromSession({
        provider: session.user.provider,
        sub: session.user.sub,
        email: session.user.email,
        name: session.user.name,
      })
    : null;
  return claims ? encodeDashboardAssertion(claims) : DASHBOARD_USER_POISON;
}

async function proxy(req: NextRequest, segment: string): Promise<Response> {
  if (!ALLOWED_METHODS.has(req.method)) {
    return new Response("Method Not Allowed", { status: 405 });
  }
  if (!isSameOrigin(req)) {
    return new Response("Forbidden", { status: 403 });
  }
  // Critical: this proxy reaches the TRUSTED internal tRPC listener (admin with no
  // bearer, ADR 0008 P3), so when auth is enforced it must require a session of its
  // own — middleware does NOT cover API routes, and without this the dashboard's
  // admin power is reachable without logging in. Enforcement is store-driven (D2.4);
  // any non-"open" decision ("enforce" or the fail-closed "block") requires a valid
  // session. A thrown auth() (tampered JWT) is a deny, not a 500 — mirrors the signIn
  // callback in auth.ts. (This resolves enforcement again even though middleware did
  // too — middleware doesn't cover /api routes, so the proxy must gate itself; both
  // reads share the 30s cache.)
  const enforcement = await resolveEnforcement(() => getAuthConfig());
  if (enforcement !== "open") {
    const session = await auth().catch(() => null);
    if (!session) return new Response("Unauthorized", { status: 401 });
  } else if (!isAllowedHost(req.headers.get("host"))) {
    // Open mode has no session to check, so refuse a DNS-rebinding page before it
    // reaches the admin listener (review 2026-09-29 #2).
    return new Response(hostRefusalMessage(req.headers.get("host")), { status: 403 });
  }

  const upstream = new URL(`${trpcBaseUrl()}/trpc/${segment}`);
  for (const [k, v] of req.nextUrl.searchParams.entries()) upstream.searchParams.append(k, v);

  const headers = new Headers();
  for (const [k, v] of req.headers.entries()) {
    if (STRIP_INBOUND.has(k.toLowerCase())) continue;
    headers.set(k, v);
  }
  // ADR 0008 P3: no Authorization header is injected — the internal tRPC listener
  // is trusted (admin without a bearer). The inbound `authorization` is stripped
  // (STRIP_INBOUND) so a browser-supplied bearer can't leak upstream either.

  // spec 065 SC 1: the trusted proxy VOLUNTARILY NARROWS the request to its user by asserting, on
  // every call, who it is on behalf of — derived from its OWN session, never from the (stripped)
  // inbound header. The OSS default provider ignores it (byte-identical, SC 4); a member-aware
  // provider scopes on it. This runs on every proxied call, including under enforcement "open".
  headers.set(DASHBOARD_USER_HEADER, await deriveDashboardAssertion(req));

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const init: RequestInit = hasBody
    ? { method: req.method, headers, body: await req.arrayBuffer(), redirect: "manual" }
    : { method: req.method, headers, redirect: "manual" };
  const upstreamRes = await fetch(upstream, init);

  const responseHeaders = new Headers(upstreamRes.headers);
  for (const k of STRIP_OUTBOUND) responseHeaders.delete(k);
  // tRPC GET queries (e.g. auth.config) carry admin data — AUTH_SECRET, decrypted
  // OAuth secrets — and GETs are cacheable by default. Force no-store so no shared
  // cache / CDN / browser disk cache can persist secret material.
  responseHeaders.set("cache-control", "no-store");

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: responseHeaders,
  });
}

type Params = { params: Promise<{ trpc: string }> };

async function handler(req: NextRequest, ctx: Params): Promise<Response> {
  const { trpc } = await ctx.params;
  return proxy(req, trpc);
}

export { handler as GET, handler as POST };
