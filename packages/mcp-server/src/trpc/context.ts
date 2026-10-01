// tRPC context.
//
// The tRPC API is served ONLY on the internal listener (ADR 0008 P1), which is
// trusted — loopback / internal-docker-network only, never published. So the
// context resolves the caller `Principal` for every request through the SAME
// per-surface identity seam the /mcp route uses (spec 061 T3/T4): the factory's
// guard-wrapped plugin `authProvider` when one was supplied, else T1's
// `defaultAuthProvider` on the "internal" surface (which, admin-by-isolation, resolves
// the trusted admin principal WITHOUT a bearer — ADR 0008 P3). SC 7 requires a
// substitute provider to be CONSULTED here, so ADR 0008's isolation trust becomes the
// DEFAULT provider's policy, no longer structural. The `store` is threaded through so
// the feature routers (memories, handoffs, …) can call it without reaching for globals.

import {
  type BootstrapClaimHandle,
  type ConsumerConnection,
  type LibrarianStore,
  type LlmClient,
  type Principal,
  createInertBootstrapClaimHandle,
} from "@librarian/core";
import type { CreateHTTPContextOptions } from "@trpc/server/adapters/standalone";
import {
  type AuthConfig,
  type AuthProvider,
  type AuthProviderResult,
  defaultAuthProvider,
} from "../http/auth.js";
import type { ActorDisplayProvider, GuardedAuthProvider } from "../plugin.js";

export type TrpcRole = "admin" | "anonymous";

/** Build an LLM client from a resolved connection + token (the curator.chat seam). */
export type BuildChatClient = (conn: ConsumerConnection, token: string) => LlmClient;

export interface TrpcContext {
  /**
   * The resolved caller (spec 061 SC 5) — the one identity currency new code reads.
   * On the internal listener this is the trusted admin principal (admin-by-isolation,
   * ADR 0008 P3); `adminProcedure` gates on `principal.roles`, and dashboard writes
   * derive their actor from `principal.actorId` (default `dashboard-admin`).
   */
  principal: Principal;
  /** @deprecated derive from `principal`: `principal.roles.includes("admin") ? "admin" : "anonymous"`. */
  role: TrpcRole;
  store: LibrarianStore;
  /** Master key for deriving AUTH_SECRET / decrypting OAuth secrets (null when unset). */
  secretKey: Buffer | null;
  /** The configured admin token — the auth router compares it timing-safe in `enable`. */
  adminToken: string;
  /** Pre-bound first-owner claim capability; contains no exposed raw secret/path. */
  bootstrapClaim: BootstrapClaimHandle;
  /**
   * Optional injectable LLM-client builder for `curator.chat` (D6b). Production
   * leaves it unset (the procedure builds the real OpenAI-compatible client); a test
   * can inject a scripted client. A pure seam — never serialised, never logged.
   */
  buildChatClient?: BuildChatClient;
  /** Optional display-name resolver supplied by a build-time plugin (spec 068). */
  actorDisplayProvider?: ActorDisplayProvider;
  /**
   * Arms the curator's targeted flag groom (ADR 0013) after "Ask the curator
   * again". Absent outside the HTTP server; the flags then wait for the next groom.
   */
  onMemoryFlagged?: () => void;
}

export interface TrpcContextDeps {
  store: LibrarianStore;
  auth: AuthConfig;
  secretKey: Buffer | null;
  /** Optional only for lower-level callers; the context factory always installs an inert handle. */
  bootstrapClaim?: BootstrapClaimHandle;
  /** Optional injectable LLM-client builder for curator.chat (test seam). */
  buildChatClient?: BuildChatClient;
  /**
   * The factory's guard-wrapped plugin auth provider (spec 061 T4). When present it REPLACES
   * {@link defaultAuthProvider} as the internal-surface identity source (SC 7 — the substitute
   * provider is consulted here). Absent on every non-factory caller (and the T3 context tests),
   * so the context factory keeps its synchronous default path.
   */
  authProvider?: GuardedAuthProvider;
  /** Optional display-name resolver threaded unchanged to response mappers. */
  actorDisplayProvider?: ActorDisplayProvider;
  /** Arms the targeted flag groom (ADR 0013). */
  onMemoryFlagged?: () => void;
}

/**
 * A role-less principal for the (unreachable with the default provider) internal
 * refusal. The internal surface is admin-by-isolation (ADR 0008 P3), so
 * `defaultAuthProvider` always resolves it to admin; failing CLOSED here preserves
 * the old `null → "anonymous"` mapping — a refusal is rejected by every
 * `adminProcedure` (401), never a 500 and never silently admitted.
 */
const ANONYMOUS_PRINCIPAL: Principal = { kind: "agent", actorId: "anonymous", roles: [] };

/**
 * Assemble the {@link TrpcContext} from a resolved {@link AuthProviderResult} — the shared shape
 * of the default and a substitute provider. A refusal fails CLOSED to {@link ANONYMOUS_PRINCIPAL}
 * (rejected by every `adminProcedure` as 401, never a 500, never silently admitted).
 */
function buildTrpcContext(
  deps: TrpcContextDeps & { bootstrapClaim: BootstrapClaimHandle },
  outcome: AuthProviderResult,
): TrpcContext {
  const principal = outcome.ok ? outcome.principal : ANONYMOUS_PRINCIPAL;
  return {
    principal,
    role: principal.roles.includes("admin") ? "admin" : "anonymous",
    store: deps.store,
    secretKey: deps.secretKey,
    adminToken: deps.auth.adminToken,
    bootstrapClaim: deps.bootstrapClaim,
    ...(deps.buildChatClient ? { buildChatClient: deps.buildChatClient } : {}),
    ...(deps.actorDisplayProvider ? { actorDisplayProvider: deps.actorDisplayProvider } : {}),
    ...(deps.onMemoryFlagged ? { onMemoryFlagged: deps.onMemoryFlagged } : {}),
  };
}

// Overloads: the DEFAULT path (no plugin provider) is SYNCHRONOUS — the OSS default provider
// resolves the internal surface with no I/O — so a direct caller (and the existing T3 context
// tests) get a plain `TrpcContext`. A supplied guard-wrapped plugin provider is async-capable
// (the spec 061 T4 widening), so that path returns a `Promise<TrpcContext>` the tRPC adapter
// awaits. tRPC accepts either.
export function createContextFactory(
  deps: TrpcContextDeps & { authProvider?: undefined },
): (opts: CreateHTTPContextOptions) => TrpcContext;
export function createContextFactory(
  deps: TrpcContextDeps,
): (opts: CreateHTTPContextOptions) => TrpcContext | Promise<TrpcContext>;
export function createContextFactory(
  deps: TrpcContextDeps,
): (opts: CreateHTTPContextOptions) => TrpcContext | Promise<TrpcContext> {
  const contextDeps = {
    ...deps,
    bootstrapClaim: deps.bootstrapClaim ?? createInertBootstrapClaimHandle(),
  };
  // The one per-surface identity point (spec 061 T4): the factory's guarded plugin provider when
  // one was supplied, else T1's default provider. Resolved on the "internal" surface, where the
  // default grants admin by isolation (ADR 0008 P3) and a substitute provider owns its own policy.
  const provider: AuthProvider = deps.authProvider ?? defaultAuthProvider(deps.auth);
  return function createContext({ req }) {
    const outcome = provider.authenticate(req, "internal");
    return outcome instanceof Promise
      ? outcome.then((resolved) => buildTrpcContext(contextDeps, resolved))
      : buildTrpcContext(contextDeps, outcome);
  };
}
