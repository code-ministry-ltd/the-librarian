// Dashboard page gating (A2; D2.4 made it store-driven + fail-closed).
//
// Enforcement is resolved per request from the store auth-config (cached), with the
// legacy LIBRARIAN_AUTH_ENABLED env as the fallback:
//   - open    → serve (no session check; no secret needed)
//   - claim   → redirect every matched route to the first-owner claim flow
//   - enforce → redirect any unauthenticated request to /login
//   - block   → an enabled-but-incomplete config, or an unreachable store: refuse to
//               serve with a store-independent page that names the CLI break-glass,
//               so a store outage can't silently fail OPEN.
//
// This is a PLAIN function default export — NOT `export default auth(...)`. The
// project's auth.ts uses the lazy `NextAuth(async () => …)` form, whose `auth`
// middleware-wrapper is not a usable default export here (Next: "must export a
// default function"), and invoking the wrapper manually throws at runtime. So we
// verify the session directly with getToken, only on the enforce path.
//
// The matcher excludes ALL of /api — middleware is the wrong layer to protect API
// routes (it can be skipped), so the security-critical /api/trpc proxy gates itself
// with the same enforcement (see app/api/trpc/[trpc]/route.ts). /login is excluded
// so the redirect can't loop, and so the owner can still reach it under "block".
// /settings/auth/reset is excluded too: a locked-out owner with no session must be
// able to reach the one-time-link reset page; the link token is its own credential.

import { type NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { hostRefusalMessage, isAllowedHost } from "@/lib/allowed-host";
import { getAuthConfigSafe } from "@/lib/auth-config-client";
import { decideEnforcement, isAuthEnforced, toEnforcementConfig } from "@/lib/auth-gate";

function blockResponse(): NextResponse {
  // Store-independent: no rendering that itself needs the store. Names the recovery.
  const body = `<!doctype html><meta charset="utf-8"><title>Authentication unavailable</title>
<h1>Authentication is unavailable</h1>
<p>The dashboard cannot verify its authentication configuration (the store is
unreachable or the config is incomplete), so it is refusing to serve — failing
closed rather than open.</p>
<p>On the server host, run <code>the-librarian auth disable</code> to turn off
enforcement (break-glass), then fix the configuration.</p>`;
  return new NextResponse(body, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

// Verify the session JWT with the store-derived secret. Tries both cookie variants
// (the `__Secure-` prefix is used on https) so it matches however the session was set
// behind a proxy. Any failure → no session (fail closed).
async function hasValidSession(req: NextRequest, secret: string): Promise<boolean> {
  for (const secureCookie of [true, false]) {
    try {
      if (await getToken({ req, secret, secureCookie })) return true;
    } catch {
      // try the other cookie variant; a decode failure is "no session"
    }
  }
  return false;
}

export default async function middleware(req: NextRequest): Promise<Response> {
  // null = the store was unreachable (getAuthConfigSafe swallows the error); a real
  // config with no methods configured → toEnforcementConfig null → env fallback.
  const config = await getAuthConfigSafe();
  const decision = decideEnforcement(
    config === null ? "unreachable" : toEnforcementConfig(config),
    isAuthEnforced(),
  );
  if (decision === "open") {
    // Open mode grants admin to anyone who reaches the dashboard, so refuse a
    // DNS-rebinding page (review 2026-09-29 #2). This also covers server actions,
    // which POST to these page routes.
    const host = req.headers.get("host");
    if (!isAllowedHost(host)) {
      return new NextResponse(hostRefusalMessage(host), {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    return NextResponse.next();
  }
  if (decision === "block") return blockResponse();
  if (decision === "claim") {
    return NextResponse.redirect(new URL("/claim", req.nextUrl.origin));
  }

  const secret = config?.authSecret ?? process.env.AUTH_SECRET;
  const authed = secret ? await hasValidSession(req, secret) : false;
  return authed
    ? NextResponse.next()
    : NextResponse.redirect(new URL("/login", req.nextUrl.origin));
}

export const config = {
  // Anchor each excluded segment so prefix lookalikes (e.g. /loginhelp, /apidocs)
  // are still gated — only the exact /api, /_next, /login subtrees and favicon are
  // skipped.
  matcher: [
    "/((?!api(?:/|$)|_next/|favicon.ico|login(?:/|$)|claim(?:/|$)|settings/auth/reset(?:/|$)|healthz(?:/|$)|primer\\.md(?:/|$)|mcp(?:/|$)|transcript(?:/|$)|ingest(?:/|$)).*)",
  ],
};
