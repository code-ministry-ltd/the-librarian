// HTTP auth + origin gating for the MCP server.
//
// Pure functions over a `AuthConfig` record. Boot-time validation lives
// in `bin/http.ts`; this module only resolves requests against an
// already-validated config so it stays unit-testable.

import { createHash, timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import {
  type Principal,
  SENTINEL_ACTOR_IDS,
  SYSTEM_ACTOR_IDS,
  type TokenScope,
} from "@librarian/core";

/** Which listener a request arrives on (ADR 0008 P1/P3). Mirrors routes.ts. */
export type AuthSurface = "public" | "internal";

export interface AuthConfig {
  /**
   * The dashboard auth-enable land-grab token (ADR 0008 P3): NO LONGER a network
   * gate — it never grants a role in {@link authenticateMcp}. It only seeds the
   * tRPC context's `adminToken` for the `auth.enable` timing-safe compare (the
   * operator types it once to flip enforcement on). Optional; "" when unset.
   */
  adminToken: string;
  agentToken: string;
  agentTokenMap: Map<string, string>;
  allowedOrigins: string[];
  /**
   * Extra DNS names this server may be reached by (LIBRARIAN_ALLOWED_HOSTS), on top
   * of the always-safe loopback, IP-literal and single-label names. See
   * {@link isAllowedHost}.
   */
  allowedHosts?: string[];
  /**
   * The no-auth bypass. When true, a public /mcp request with no/invalid bearer
   * resolves to `agent` — NEVER admin (ADR 0008 P3). Resolved at boot by
   * {@link resolveAllowNoAuth}, which fires the bypass ONLY when auth isn't
   * genuinely in force: the explicit LIBRARIAN_ALLOW_NO_AUTH=true opt-out, or a
   * loopback bind with NO agent token configured. A configured agent token is
   * therefore enforced even on loopback — closing the regression where a loopback
   * bind silently disabled a configured-token gate.
   */
  allowNoAuth: boolean;
  host: string;
  port: number;
  /**
   * Optional DB-backed token verifier (dashboard-minted agent tokens). Checked
   * AFTER the env tokens (backward compatible). Returns the agent id on a match,
   * else null. Always resolves to the `agent` role — DB tokens can't be admin.
   */
  verifyDbToken?: (
    token: string,
  ) => { agentId?: string; scope?: TokenScope; tokenId?: string } | null;
}

/**
 * Marker injected by the dashboard's single-port proxy. It makes the default
 * provider require a real credential even when the direct loopback listener
 * has its local-development no-auth bypass enabled.
 */
export const REQUIRE_EXPLICIT_AUTH_HEADER = "x-librarian-require-auth";

/**
 * Safe pre-principal attribution for a refused HTTP request (spec 071).
 * `authorizationPresent` is control metadata used to distinguish a missing
 * credential from an invalid one and is never persisted. A bearer is reduced
 * immediately to a short SHA-256 correlation hash; the raw credential never
 * leaves this function.
 */
export interface RefusalRequestAttribution {
  authorizationPresent: boolean;
  tokenHash?: string;
  ip?: string;
  forwardedFor?: string;
  origin?: string;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.join(", ");
  return value;
}

export function refusalRequestAttribution(req: IncomingMessage): RefusalRequestAttribution {
  const authorization = headerValue(req.headers.authorization);
  const forwardedFor = headerValue(req.headers["x-forwarded-for"]);
  const origin = headerValue(req.headers.origin);
  const ip = req.socket.remoteAddress;
  const bearer =
    authorization?.startsWith("Bearer ") === true
      ? authorization.slice("Bearer ".length)
      : undefined;

  return {
    authorizationPresent: authorization !== undefined,
    ...(bearer !== undefined
      ? { tokenHash: createHash("sha256").update(bearer).digest("hex").slice(0, 12) }
      : {}),
    ...(ip !== undefined ? { ip } : {}),
    ...(forwardedFor !== undefined ? { forwardedFor } : {}),
    ...(origin !== undefined ? { origin } : {}),
  };
}

/**
 * @deprecated Deprecated alias for one release (spec 061 SC 8). The one identity currency is now
 * {@link Principal} (`@librarian/core`), resolved by an {@link AuthProvider}: derive the role from
 * `principal.roles`, the attributed actor from `principal.actorId`, and the credential binding from
 * `principal.boundActorId` (only a real binding — never a sentinel — becomes an `agentId`/`boundActorId`).
 * This flat shape is retained only so the delegating {@link authenticateMcp}/{@link authenticatePublic}
 * and `PluginRouteContext.auth` keep compiling byte-for-byte; it is scheduled for removal after the 062
 * release, once every consumer reads the Principal directly. No new code should introduce it.
 */
export interface AuthResult {
  role: "admin" | "agent";
  agentId?: string;
  /**
   * The token's privilege scope (ingest spec D21), present on agent-role results.
   * `agent` reaches /mcp (the 7 verbs); `capture` reaches ONLY /ingest. Absent on
   * the admin (internal-surface) result, which is unrestricted by trust. Enforced
   * by {@link authenticatePublic}; an absent scope is treated as `agent`.
   */
  scope?: TokenScope;
  /**
   * Stable per-TOKEN identity (the `<id>` in `lib.<id>.<secret>`), present only on
   * DB-minted token results. The /ingest rate limiter keys on it so a leaked
   * capture token's quota is bounded on its own (ingest spec D19). Absent for env
   * tokens and the no-auth bypass — those are agent-scope and never reach /ingest.
   */
  tokenId?: string;
}

/**
 * Resolve a request's role PER SURFACE (ADR 0008 P3 — the security core).
 *
 * The admin token is no longer a network gate: the surface is. So the role
 * decision branches on which listener served the request:
 *
 *   - "internal" (/trpc): the internal listener is trusted — it's loopback /
 *     internal-docker-network only and never published — so it grants `admin`
 *     with NO bearer. The socket itself is the boundary.
 *   - "public" (/mcp): AGENT-ROLE ONLY. There is deliberately NO branch that
 *     resolves to admin here, so a network peer can never reach an admin action
 *     on the published port — even with no admin token configured. A valid agent
 *     token (env, map, or DB-minted) → agent; the localhost bypass → agent;
 *     anything else → null (401).
 */
export function authenticateMcp(
  req: IncomingMessage,
  config: AuthConfig,
  surface: AuthSurface = "public",
): AuthResult | null {
  // Delegate to the extracted matrix (spec 061 T1): {@link defaultAuthProvider} owns the
  // per-surface decision now; this thin adapter maps its Principal result back to today's
  // AuthResult so every existing caller/test stays byte-identical. With no required scope
  // the provider only ever refuses with 401 (never 403), so a refusal collapses to `null`
  // exactly as the old internal/public matrix did.
  const outcome = defaultAuthProvider(config).authenticate(req, surface);
  return outcome.ok ? principalToAuthResult(outcome.principal) : null;
}

/** Match a bearer against the agent credentials (env tokens, map, DB). Never admin. */
function resolveAgent(req: IncomingMessage, config: AuthConfig): AuthResult | null {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  // Env-configured tokens (single + per-agent map) are always AGENT scope: capture
  // tokens only ever come from the DB-minted store, never from env.
  for (const [agentId, mappedToken] of config.agentTokenMap) {
    if (timingSafeEqual(token, mappedToken)) return { role: "agent", agentId, scope: "agent" };
  }
  if (config.agentToken && timingSafeEqual(token, config.agentToken)) {
    return { role: "agent", scope: "agent" };
  }
  // DB-minted tokens, last and always agent-ROLE (never admin) but carrying their
  // stored SCOPE. A null from the verifier is indistinguishable from any other miss
  // → one generic failure. The agentId-less branch only exists because AuthConfig
  // permits an agentId-less match: a WELL-FORMED record always carries an agentId
  // (createAgentToken enforces it at mint), but a hand-edited / malformed record without
  // one lands here — authenticated but unbound, so it takes the env-token sentinel
  // downstream. An absent scope from the verifier defaults to `agent`.
  if (config.verifyDbToken) {
    const db = config.verifyDbToken(token);
    if (db) {
      const scope: TokenScope = db.scope ?? "agent";
      const result: AuthResult = { role: "agent", scope };
      if (db.agentId) result.agentId = db.agentId;
      if (db.tokenId) result.tokenId = db.tokenId;
      return result;
    }
  }
  return null;
}

/**
 * Authenticate a PUBLIC-surface request and enforce a required token scope — the
 * bidirectional wall of ingest spec D21:
 *
 *   - /mcp, /transcript → require "agent": a capture token is FORBIDDEN here.
 *   - /ingest           → require "capture": an agent token (and the localhost
 *                         bypass's agent identity) is FORBIDDEN here.
 *
 * The outcome is discriminated so the caller can map it to the right status:
 *   - no/invalid credential        → 401 (Unauthorized)
 *   - valid credential, wrong scope → 403 (Forbidden) — "right key, wrong door"
 *
 * An admin (internal-surface) result is never produced here (public surface), so
 * scope enforcement only ever sees agent-role results; an absent scope = `agent`.
 */
export type ScopeAuth = { ok: true; result: AuthResult } | { ok: false; status: 401 | 403 };

/**
 * @deprecated Dead on the live request paths since spec 061 T4 — every public route now consults
 * the deps-threaded {@link AuthProvider} (`ctx.provider.authenticate(req, "public", scope)`) and
 * reads the {@link Principal} directly, so the D21 wall is enforced there (and, for a substitute
 * provider, backstopped by `guardPublicAdmin`). This helper is retained only as the thin
 * {@link AuthConfig}-based adapter its unit tests still exercise; no live caller remains. Prefer
 * the provider seam. Scheduled for removal alongside {@link AuthResult} after the 062 release.
 */
export function authenticatePublic(
  req: IncomingMessage,
  config: AuthConfig,
  requiredScope: TokenScope,
): ScopeAuth {
  // Delegate to the same extracted matrix (spec 061 T1), this time WITH the required scope
  // so the provider enforces the D21 wall itself and the 401/403 distinction is preserved.
  const outcome = defaultAuthProvider(config).authenticate(req, "public", requiredScope);
  if (!outcome.ok) return { ok: false, status: outcome.status };
  return { ok: true, result: principalToAuthResult(outcome.principal) };
}

// ---------- Principal-based auth provider (spec 061 T1, ADR 0011 `authProvider` seam) ----------
//
// `defaultAuthProvider` IS today's auth matrix, extracted verbatim and re-expressed over the
// `Principal` identity currency (spec 061 SC 2). `authenticateMcp`/`authenticatePublic` above
// delegate to it and map its result back to `AuthResult`, so behaviour is unchanged (the
// existing auth suites are the proof) while a member-aware extension can REPLACE this provider
// wholesale through the 060 factory (wired at spec 061 T4). The provider is the sole owner of
// the sentinel distinction the flat `AuthResult` cannot carry: the env single-token path and
// the localhost bypass produce DIFFERENT sentinel `actorId`s (`env-token-agent` vs
// `local-agent`) even though both still collapse to `{ role: "agent", scope: "agent" }`.

/**
 * The discriminated result of {@link AuthProvider.authenticate} — mirrors {@link ScopeAuth}
 * but carries a {@link Principal}. A bare `Principal | null` could not express the wire
 * contract's wrong-scope-403 vs no-credential-401 distinction (spec 061 SC 2, key decision).
 */
export type AuthRefusalReason = "missing" | "invalid" | "wrong-scope" | "forbidden";
export type AuthProviderRefusal = {
  ok: false;
  status: 401 | 403;
  /**
   * Optional because substitute providers written against the original seam
   * return only a status. Core providers set it so refusal evidence never has
   * to guess why authentication failed.
   */
  reason?: AuthRefusalReason;
  /** A successfully resolved principal discarded by a later authorisation gate. */
  principal?: Principal;
};
export type AuthProviderResult = { ok: true; principal: Principal } | AuthProviderRefusal;

/**
 * The "who is this request?" seam (spec 061 SC 2, ADR 0011 Decision 3). One method resolves a
 * request PER SURFACE to a {@link Principal}, optionally enforcing a required token scope (the
 * public surface's D21 wall). This SEAM-FACING signature is async-capable
 * (`AuthProviderResult | Promise<AuthProviderResult>`) — the DECIDED spec 061 T4 widening (the
 * T1 note): a member-aware plugin provider may resolve identity remotely/asynchronously. The OSS
 * default ({@link defaultAuthProvider}) stays synchronous ({@link SyncAuthProvider}), and a sync
 * result is assignable to this union, so it drops into every consumption site unchanged. A plugin
 * REPLACES it via the 060 factory (spec 061 T4), where the factory-owned public-admin guard
 * (060 SC 7, {@link GuardedAuthProvider}) refuses an admin principal on the public surface before
 * it reaches a consumer.
 *
 * Provider contract: every returned {@link Principal} MUST carry a NON-EMPTY `actorId` (it becomes
 * the frontmatter `agent_id`; empty is a contract violation, not "anonymous" — use a sentinel-style
 * id for that), set `boundActorId` ONLY when a credential cryptographically binds the identity
 * (never for a fallback/sentinel — see {@link Principal}), and put the admin role in `roles` (not
 * `kind`) so the guard and `adminProcedure` read it. `attrs` is free-form and opaque to core.
 */
export interface AuthProvider {
  authenticate(
    req: IncomingMessage,
    surface: AuthSurface,
    requiredScope?: TokenScope,
  ): AuthProviderResult | Promise<AuthProviderResult>;
}

/**
 * The SYNCHRONOUS provider shape {@link defaultAuthProvider} returns. The OSS default decides
 * from the in-process {@link AuthConfig} with no I/O, so its result is always available
 * synchronously — which is what lets `authenticateMcp`/`authenticatePublic` read it without
 * `await` (their exported, synchronous behaviour is unchanged, spec 061 T4). A `SyncAuthProvider`
 * is assignable to the async-capable seam {@link AuthProvider} (method return-type covariance),
 * so the default and a guarded plugin provider share every consumption site.
 */
export interface SyncAuthProvider {
  authenticate(
    req: IncomingMessage,
    surface: AuthSurface,
    requiredScope?: TokenScope,
  ): AuthProviderResult;
}

/**
 * The OSS default auth provider: today's per-surface matrix, unchanged (ADR 0008 P3).
 *   - internal → the trusted admin actor (the socket is the boundary — {@link adminPrincipal});
 *   - public   → the {@link resolveAgent} credential ladder, then the localhost bypass, then
 *                401; with a `requiredScope`, a valid-but-wrong-scope credential is 403.
 */
export function defaultAuthProvider(config: AuthConfig): SyncAuthProvider {
  return {
    authenticate(req, surface, requiredScope) {
      // The internal listener is trusted by virtue of not being on the network.
      if (surface === "internal") return { ok: true, principal: adminPrincipal() };

      // Public /mcp: agent-role only. Try the configured agent credentials first so a real
      // token is attributed to its agent even under the localhost bypass; then the bypass as
      // a DISTINCT sentinel actor (never admin); else no credential at all.
      const credential = resolveAgent(req, config);
      let principal: Principal | undefined;
      if (credential) {
        principal = agentResultToPrincipal(credential);
      } else if (
        config.allowNoAuth &&
        req.headers[REQUIRE_EXPLICIT_AUTH_HEADER] !== "single-port"
      ) {
        principal = localAgentPrincipal();
      }
      if (principal === undefined) {
        return {
          ok: false,
          status: 401,
          reason: req.headers.authorization === undefined ? "missing" : "invalid",
        };
      }

      // Scope wall (ingest spec D21): only enforced when a scope is required (the
      // authenticateMcp delegation passes none). An absent scope is treated as `agent`,
      // exactly as authenticatePublic did — "right key, wrong door" is 403, not 401.
      if (requiredScope !== undefined) {
        const scope: TokenScope = principal.scope ?? "agent";
        if (scope !== requiredScope) {
          return { ok: false, status: 403, reason: "wrong-scope", principal };
        }
      }
      return { ok: true, principal };
    },
  };
}

/** The internal-surface admin actor (ADR 0008 P3): trusted by isolation, bound to nothing. */
function adminPrincipal(): Principal {
  return { kind: "admin", actorId: SYSTEM_ACTOR_IDS.dashboardAdmin, roles: ["admin"] };
}

/** The localhost no-auth bypass actor: an unbound, agent-scope sentinel — never admin. */
function localAgentPrincipal(): Principal {
  return { kind: "agent", actorId: SENTINEL_ACTOR_IDS.localhost, roles: ["agent"], scope: "agent" };
}

/**
 * Lift a resolved {@link AuthResult} from {@link resolveAgent} into a {@link Principal}. An
 * `agentId` from resolveAgent is a CRYPTOGRAPHIC binding (the per-agent token map, or a
 * DB-minted `lib.<id>.…` token), so it becomes BOTH `actorId` and `boundActorId`. resolveAgent's
 * agentId-LESS matches — the shared env single token, and the degenerate id-less DB match a
 * MALFORMED record can land here (not produced by a well-formed record) — are authenticated but
 * bind no identity, so they take the env-token sentinel `actorId` and NO `boundActorId`: a
 * sentinel must never masquerade as a binding (spec 061 SC 1). resolveAgent never yields the admin
 * role, so `roles` is `["agent"]`.
 */
function agentResultToPrincipal(result: AuthResult): Principal {
  const scope: TokenScope = result.scope ?? "agent";
  const principal: Principal =
    result.agentId !== undefined
      ? {
          kind: "agent",
          actorId: result.agentId,
          boundActorId: result.agentId,
          roles: ["agent"],
          scope,
        }
      : { kind: "agent", actorId: SENTINEL_ACTOR_IDS.envToken, roles: ["agent"], scope };
  if (result.tokenId !== undefined) return { ...principal, tokenId: result.tokenId };
  return principal;
}

/**
 * Collapse a {@link Principal} back to today's {@link AuthResult} for the delegating
 * {@link authenticateMcp}/{@link authenticatePublic}. The role is `admin` iff the principal
 * carries the admin role, else `agent`. Only a `boundActorId` (a real binding) becomes
 * `agentId` — a sentinel/fallback `actorId` is deliberately dropped, which is exactly why the
 * env-token and localhost paths keep yielding `{ role: "agent", scope }` with NO agentId,
 * byte-identical to before (spec 061 T1: zero observable behaviour change).
 */
export function principalToAuthResult(principal: Principal): AuthResult {
  const role: "admin" | "agent" = principal.roles.includes("admin") ? "admin" : "agent";
  const result: AuthResult = { role };
  if (principal.boundActorId !== undefined) result.agentId = principal.boundActorId;
  if (principal.scope !== undefined) result.scope = principal.scope;
  if (principal.tokenId !== undefined) result.tokenId = principal.tokenId;
  return result;
}

/**
 * Is loopback the bind host? Loopback is the one host where a no-auth bypass is
 * defensible (the socket is unreachable from the network).
 */
function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost";
}

/**
 * The boot-time no-auth decision (ADR 0008 P3 regression fix). The localhost
 * bypass must fire ONLY when auth isn't genuinely in force — otherwise a loopback
 * bind silently disables a configured agent-token gate (the bug: a configured
 * token grants `agent` on a tokenless /mcp via the bypass). So the bypass is:
 *
 *   - the EXPLICIT opt-out: LIBRARIAN_ALLOW_NO_AUTH === "true" (the all-in-one
 *     localhost path opts into no-auth even WITH a token set — that's deliberate); OR
 *   - the IMPLICIT zero-config local-dev case: a loopback bind AND no agent auth
 *     configured (no LIBRARIAN_AGENT_TOKEN, no LIBRARIAN_AGENT_TOKENS).
 *
 * A configured agent token (single or per-agent map) is therefore ENFORCED on
 * loopback too — only an exposed bind with NO token still 401s (never silently
 * opens). DB-minted tokens don't keep the bypass off: the verifier is always
 * wired in production, and a minted token authenticates on its own, so it has no
 * bearing on the zero-config-dev bypass.
 */
export function resolveAllowNoAuth(opts: {
  allowNoAuthEnv?: string | undefined;
  host: string;
  agentToken: string;
  agentTokenMap: Map<string, string>;
}): boolean {
  if (opts.allowNoAuthEnv === "true") return true;
  const noAgentAuthConfigured = !opts.agentToken && opts.agentTokenMap.size === 0;
  return isLoopbackHost(opts.host) && noAgentAuthConfigured;
}

/**
 * DNS-rebinding guard. A page on `evil.example` can rebind its name to this
 * machine, after which the browser treats the server as same-origin and sends
 * `Host: evil.example` — but a page can never choose the Host header itself. So
 * refuse any Host a rebinding attacker could produce: a public DNS name the
 * operator did not list. Always allowed, because no public DNS name can stand in
 * for them:
 *
 *   - IP literals (the browser's origin is then the IP itself);
 *   - `localhost` and names under `.localhost`, `.local`, `.lan`, `.internal` and
 *     `.home.arpa`, which only a local resolver answers, and Tailscale's `.ts.net`,
 *     whose DNS only Tailscale answers;
 *   - single-label names such as a docker-compose service (`mcp-server`), which
 *     public DNS cannot serve;
 *   - the configured bind host, LIBRARIAN_ALLOWED_HOSTS, and the hosts of
 *     LIBRARIAN_ALLOWED_ORIGINS.
 *
 * A request with no Host header is not from a browser and passes.
 */
export function isAllowedHost(req: IncomingMessage, config: AuthConfig): boolean {
  const header = req.headers.host;
  if (!header) return true;
  let hostname: string;
  try {
    hostname = new URL(`http://${header}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  const bare = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (isIP(bare) !== 0) return true;
  if (hostname === "localhost" || LOCAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return true;
  }
  if (!hostname.includes(".")) return true;
  return listedHostnames(config).has(hostname);
}

/**
 * Names only a local resolver answers (mDNS, the LAN router, reserved special-use
 * domains), plus Tailscale MagicDNS (`*.ts.net`), whose DNS Tailscale alone controls.
 * Rebinding needs an attacker who answers a name's DNS, so none of these can be rebound.
 */
const LOCAL_SUFFIXES = [".localhost", ".local", ".lan", ".internal", ".home.arpa", ".ts.net"];

function listedHostnames(config: AuthConfig): Set<string> {
  const names = new Set<string>([config.host.toLowerCase()]);
  for (const host of config.allowedHosts ?? []) names.add(host.trim().toLowerCase());
  for (const origin of config.allowedOrigins) {
    try {
      names.add(new URL(origin).hostname.toLowerCase());
    } catch {
      // Not a URL — it can only ever match an Origin header verbatim.
    }
  }
  return names;
}

/** The teaching refusal for {@link isAllowedHost}. */
export function hostRefusalMessage(req: IncomingMessage): string {
  return (
    `Host '${req.headers.host ?? ""}' is not allowed. This refuses DNS-rebinding requests ` +
    "from web pages. If you reach this server by that name, add it to LIBRARIAN_ALLOWED_HOSTS " +
    "(comma-separated)."
  );
}

/** Where a request landed, for {@link isAllowedOrigin}. */
export interface OriginScope {
  surface: AuthSurface;
  /** The request path; only `/ingest` accepts browser-extension origins. */
  path?: string;
}

export function isAllowedOrigin(
  req: IncomingMessage,
  config: AuthConfig,
  scope: OriginScope = { surface: "public" },
): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (config.allowedOrigins.length && config.allowedOrigins.includes(origin)) return true;
  // The internal listener grants admin with no bearer (ADR 0008 P3). Its callers
  // are the dashboard's server and proxy, never a browser page, so a browser
  // Origin is refused unless the operator listed it explicitly.
  if (scope.surface === "internal") return false;
  if (config.allowedOrigins.length) return false;
  // Browser-extension capture path (ingest spec criterion 1 / S1, D28): a
  // Chromium MV3 background service worker POSTs to /ingest with an
  // `Origin: chrome-extension://<id>` header, which the same-host rule below
  // would 403 before dispatch. The capture bearer token is the real gate there
  // (D28), so the exemption applies to /ingest only: any extension with localhost
  // access must not reach another route by it (review 2026-09-29 #22a).
  if (origin.startsWith("chrome-extension://")) return scope.path === "/ingest";
  try {
    const originUrl = new URL(origin);
    const hostHeader = req.headers.host || `${config.host}:${config.port}`;
    return originUrl.origin === `http://${hostHeader}`;
  } catch {
    return false;
  }
}

export function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return cryptoTimingSafeEqual(left, right);
}

export function parseCsv(value: string): string[] {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export class AgentTokensError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentTokensError";
  }
}

export function parseAgentTokenMap(value: string): Map<string, string> {
  const entries = parseCsv(value);
  const map = new Map<string, string>();
  const seenTokens = new Map<string, string>();
  for (const entry of entries) {
    const separator = entry.indexOf(":");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new AgentTokensError(
        "Invalid LIBRARIAN_AGENT_TOKENS entry. Use agent_id:token pairs separated by commas.",
      );
    }
    const agentId = entry.slice(0, separator).trim();
    const token = entry.slice(separator + 1).trim();
    if (map.has(agentId)) {
      throw new AgentTokensError(`Duplicate LIBRARIAN_AGENT_TOKENS entry for agent ${agentId}.`);
    }
    if (seenTokens.has(token)) {
      throw new AgentTokensError(
        `Duplicate LIBRARIAN_AGENT_TOKENS token for agents ${seenTokens.get(token)} and ${agentId}.`,
      );
    }
    map.set(agentId, token);
    seenTokens.set(token, agentId);
  }
  return map;
}
