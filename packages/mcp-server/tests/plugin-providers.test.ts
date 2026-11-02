// Provider pass-throughs + the allowPublicAdmin guard (spec 060 T6, SC 8 + SC 7's
// guard half, ADR 0011 Decision 3).
//
// Re-pointed at spec 061 T4 onto the OWNED types: the fakes now produce the real
// `AuthProviderResult` (`{ ok: true, principal } | { ok: false, status }`) over spec 061's
// `Principal`/`AuthProvider`, replacing the 060 `PluginPrincipalPlaceholder`/-`AuthProvider`
// placeholders (060 T6 anticipated this). Proves three things:
//   1. The FACTORY-OWNED public-admin guard (guardPublicAdmin): a supplied provider
//      that yields an admin-role principal on the PUBLIC surface is refused (403) by
//      default and passes through only when the supplying plugin set allowPublicAdmin.
//      A non-admin/internal principal — and any `{ ok: false }` refusal — passes through
//      untouched; the guard folds in ONLY the no-admin-on-public 403.
//   2. Delivery (SC 8 + spec 062 T1): a supplied authProvider (guarded) and vaultRouter arrive
//      at the composition root. The guarded authProvider is surfaced on the handle's non-API
//      `internals` (the same reference the factory spreads into both createHttpServer calls);
//      the vaultRouter is now THREADED INTO the store (spec 062 T1, discharging 060 residual 2),
//      so this test asserts the SAME reference reaches both `store.vaultRouter` AND `internals`.
//      With no plugins the internals slots are absent and the store falls back to the OSS default
//      router (byte-identical default, SC 2 proves the rest).
//   3. Seam uniqueness (ADR 0011 Decision 3): two plugins supplying the SAME provider
//      seam is a loud construction-time refusal naming both — providers replace,
//      registrations add.
//
// Imports the compiled artifacts (../dist), like the other internal-module suites.

import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { type Principal, type VaultRouter, defaultVaultRouter } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../test/helpers.js";
import type { AuthProvider } from "../dist/http/auth.js";
import { type LibrarianServerOptions, createLibrarianServer } from "../dist/librarian-server.js";
import {
  type ActorDisplayProvider,
  guardPublicAdmin,
  resolveActorDisplayProvider,
  resolveAuthProvider,
  resolveVaultRouter,
} from "../dist/plugin.js";

// A bare, typed request. The guard passes it straight to the underlying provider,
// which ignores it — so a default-constructed IncomingMessage is enough (no cast, no
// `any`).
function makeReq(): IncomingMessage {
  return new IncomingMessage(new Socket());
}

// A minimal real Principal (spec 061's owned type) carrying the given roles — the guard reads
// only `roles`, but the discriminated result now carries a full Principal, so passthrough
// assertions compare the whole object.
function principalWithRoles(roles: readonly string[]): Principal {
  return { kind: "agent", actorId: "test-actor", roles };
}

// A fake AuthProvider (the owned seam type) that authenticates every request to a Principal with
// the given roles on every surface — the minimum the guard reads (SC 7). Records nothing; the
// guard is the unit under test.
function makeProvider(roles: readonly string[]): AuthProvider {
  const principal = principalWithRoles(roles);
  return { authenticate: () => ({ ok: true, principal }) };
}

const ACTOR_DISPLAY_PROVIDER: ActorDisplayProvider = {
  resolveActorDisplays: (ids) => new Map(ids.map((id) => [id, `Display ${id}`])),
};

// A fake provider that refuses every request (no credential → 401). The guard passes an
// `{ ok: false }` refusal straight through untouched.
const NULL_PROVIDER: AuthProvider = { authenticate: () => ({ ok: false, status: 401 }) };

// A real VaultRouter (spec 062's owned type). The delivery test asserts reference identity,
// not behaviour, so a minimal single-shelf router suffices.
const VAULT_ROUTER: VaultRouter = {
  shelves: () => [{ id: "overlay-main", prefix: "", writable: true }],
  writeTarget: () => ({ id: "overlay-main", prefix: "", writable: true }),
};
const SECOND_VAULT_ROUTER: VaultRouter = {
  shelves: () => [{ id: "other", prefix: "", writable: true }],
  writeTarget: () => ({ id: "other", prefix: "", writable: true }),
};

// Base factory options: every scheduler timer OFF and loopback binds, so a constructed
// server never binds a listener (start() is never called) and a throwing construction
// never opens a store past the pre-store validation (matches plugin-tools/-routes).
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

describe("public-admin guard — the factory-owned no-admin-on-public default (spec 060 SC 7)", () => {
  it("refuses an admin principal on the PUBLIC surface with 403 by default (handler never runs)", async () => {
    const guarded = guardPublicAdmin(makeProvider(["admin"]), false);
    const outcome = await guarded.authenticate(makeReq(), "public");
    // ok:false ⇒ a consumer stops before the handler; the status is a 403 refusal.
    expect(outcome).toEqual({
      ok: false,
      status: 403,
      reason: "forbidden",
      principal: principalWithRoles(["admin"]),
    });
  });

  it("passes an admin principal through on the public surface WITH the opt-out", async () => {
    const guarded = guardPublicAdmin(makeProvider(["admin"]), true);
    const outcome = await guarded.authenticate(makeReq(), "public");
    expect(outcome).toEqual({ ok: true, principal: principalWithRoles(["admin"]) });
  });

  it("passes a NON-admin principal through on the public surface (guard is admin-only)", async () => {
    const guarded = guardPublicAdmin(makeProvider(["member"]), false);
    const outcome = await guarded.authenticate(makeReq(), "public");
    expect(outcome).toEqual({ ok: true, principal: principalWithRoles(["member"]) });
  });

  it("recognises the admin role case-insensitively + trimmed — a brittle exact match would fail OPEN", async () => {
    // The guard normalises each role (trim + case-fold) before matching, so a provider
    // that yields "Admin" / "ADMIN" / "admin " (whitespace) is still refused 403 on the
    // public surface. An exact-string includes("admin") would let all three sail through.
    for (const roles of [["Admin"], ["ADMIN"], ["admin "], [" Admin "]]) {
      const guarded = guardPublicAdmin(makeProvider(roles), false);
      expect(
        await guarded.authenticate(makeReq(), "public"),
        `roles ${JSON.stringify(roles)} must be recognised as admin and refused`,
      ).toEqual({
        ok: false,
        status: 403,
        reason: "forbidden",
        principal: principalWithRoles(roles),
      });
    }
  });

  it("treats a DIFFERENT role (e.g. administrator) as non-admin — the guard matches only the exact admin token", async () => {
    // 061 owns the role vocabulary; the guard recognises ONLY the exact `admin` token
    // (normalised). "administrator" is a distinct role and passes — a plugin minting its
    // own admin-equivalent role under another name owns guarding it.
    const guarded = guardPublicAdmin(makeProvider(["administrator"]), false);
    expect(await guarded.authenticate(makeReq(), "public")).toEqual({
      ok: true,
      principal: principalWithRoles(["administrator"]),
    });
  });

  it("does NOT guard the INTERNAL surface — an admin principal passes there (isolation is the gate)", async () => {
    const guarded = guardPublicAdmin(makeProvider(["admin"]), false);
    const outcome = await guarded.authenticate(makeReq(), "internal");
    expect(outcome).toEqual({ ok: true, principal: principalWithRoles(["admin"]) });
  });

  it("passes an { ok: false } refusal (401) straight through untouched on either surface", async () => {
    const guarded = guardPublicAdmin(NULL_PROVIDER, false);
    expect(await guarded.authenticate(makeReq(), "public")).toEqual({ ok: false, status: 401 });
    expect(await guarded.authenticate(makeReq(), "internal")).toEqual({ ok: false, status: 401 });
  });
});

describe("public-admin guard — scope backstop for substitute providers (spec 061 review fix 3)", () => {
  // A provider that authenticates to a principal with the given roles + optional scope. The
  // backstop matters precisely for a substitute that IGNORES requiredScope (returns ok anyway).
  function providerWith(roles: readonly string[], scope?: "agent" | "capture"): AuthProvider {
    const principal: Principal =
      scope === undefined
        ? { kind: "agent", actorId: "test-actor", roles }
        : { kind: "agent", actorId: "test-actor", roles, scope };
    return { authenticate: () => ({ ok: true, principal }) };
  }

  it("refuses a non-admin whose scope does NOT match the required scope (403)", async () => {
    const guarded = guardPublicAdmin(providerWith(["agent"], "agent"), false);
    expect(await guarded.authenticate(makeReq(), "public", "capture")).toEqual({
      ok: false,
      status: 403,
      reason: "wrong-scope",
      principal: {
        kind: "agent",
        actorId: "test-actor",
        roles: ["agent"],
        scope: "agent",
      },
    });
  });

  it("passes a non-admin whose scope MATCHES the required scope", async () => {
    const guarded = guardPublicAdmin(providerWith(["agent"], "capture"), false);
    expect(await guarded.authenticate(makeReq(), "public", "capture")).toEqual({
      ok: true,
      principal: { kind: "agent", actorId: "test-actor", roles: ["agent"], scope: "capture" },
    });
  });

  it("treats an ABSENT scope as `agent` (matches the default provider + AuthResult contract)", async () => {
    const guarded = guardPublicAdmin(providerWith(["agent"]), false);
    // agent route → passes (absent == agent)…
    expect(await guarded.authenticate(makeReq(), "public", "agent")).toEqual({
      ok: true,
      principal: { kind: "agent", actorId: "test-actor", roles: ["agent"] },
    });
    // …capture route → 403.
    expect(await guarded.authenticate(makeReq(), "public", "capture")).toEqual({
      ok: false,
      status: 403,
      reason: "wrong-scope",
      principal: { kind: "agent", actorId: "test-actor", roles: ["agent"] },
    });
  });

  it("an admin principal BYPASSES the scope wall (admin outranks scope) — with the opt-out, no scope still passes", async () => {
    const guarded = guardPublicAdmin(providerWith(["admin"]), true);
    expect(await guarded.authenticate(makeReq(), "public", "capture")).toEqual({
      ok: true,
      principal: { kind: "agent", actorId: "test-actor", roles: ["admin"] },
    });
  });

  it("does NOT apply the scope wall on the internal surface (no requiredScope threaded there)", async () => {
    const guarded = guardPublicAdmin(providerWith(["agent"], "agent"), false);
    expect(await guarded.authenticate(makeReq(), "internal")).toEqual({
      ok: true,
      principal: { kind: "agent", actorId: "test-actor", roles: ["agent"], scope: "agent" },
    });
  });
});

describe("provider-seam delivery — supplied slots reach the composition root (spec 060 SC 8)", () => {
  it("surfaces all supplied providers on the handle", async () => {
    const dataDir = makeTempDir();
    try {
      const server = createLibrarianServer({
        ...baseOptions(dataDir),
        plugins: [
          {
            name: "overlay",
            authProvider: makeProvider(["member"]),
            vaultRouter: VAULT_ROUTER,
            actorDisplayProvider: ACTOR_DISPLAY_PROVIDER,
          },
        ],
      });
      try {
        // authProvider arrives GUARDED on `internals` (delivery to the composition root);
        // consulting it exercises the guard (a non-admin member passes through).
        expect(server.internals.authProvider).toBeDefined();
        const outcome = await server.internals.authProvider?.authenticate(makeReq(), "public");
        expect(outcome).toEqual({ ok: true, principal: principalWithRoles(["member"]) });
        // vaultRouter delivery (spec 062 T1): the SAME reference reaches BOTH the store (threaded
        // into createLibrarianStore, re-exposed as store.vaultRouter) AND the handle's internals.
        expect(server.store.vaultRouter).toBe(VAULT_ROUTER);
        expect(server.internals.vaultRouter).toBe(VAULT_ROUTER);
        expect(server.internals.vaultRouter).toBe(server.store.vaultRouter);
        expect(server.internals.actorDisplayProvider).toBe(ACTOR_DISPLAY_PROVIDER);
      } finally {
        server.store.close();
      }
    } finally {
      cleanupTempDir(dataDir);
    }
  });

  it("leaves every provider slot absent when no plugin supplies one", async () => {
    const dataDir = makeTempDir();
    try {
      const server = createLibrarianServer({
        ...baseOptions(dataDir),
        plugins: [{ name: "noop" }],
      });
      try {
        expect(server.internals.authProvider).toBeUndefined();
        expect(server.internals.vaultRouter).toBeUndefined();
        expect(server.internals.actorDisplayProvider).toBeUndefined();
        // The store always holds a router — with none supplied it falls back to the OSS
        // default (byte-identical, spec 062 T1).
        expect(server.store.vaultRouter).toBe(defaultVaultRouter);
      } finally {
        server.store.close();
      }
    } finally {
      cleanupTempDir(dataDir);
    }
  });

  it("wires the supplying plugin's allowPublicAdmin into the factory guard", async () => {
    const dataDir = makeTempDir();
    try {
      // Same admin provider, opt-out ON: the guard the factory built lets admin through
      // on the public surface.
      const optedIn = createLibrarianServer({
        ...baseOptions(dataDir),
        plugins: [
          { name: "trusted", authProvider: makeProvider(["admin"]), allowPublicAdmin: true },
        ],
      });
      try {
        expect(await optedIn.internals.authProvider?.authenticate(makeReq(), "public")).toEqual({
          ok: true,
          principal: principalWithRoles(["admin"]),
        });
      } finally {
        optedIn.store.close();
      }

      // Opt-out ABSENT (default): the factory guard refuses admin on the public surface.
      const dataDir2 = makeTempDir();
      const guarded = createLibrarianServer({
        ...baseOptions(dataDir2),
        plugins: [{ name: "default", authProvider: makeProvider(["admin"]) }],
      });
      try {
        expect(await guarded.internals.authProvider?.authenticate(makeReq(), "public")).toEqual({
          ok: false,
          status: 403,
          reason: "forbidden",
          principal: principalWithRoles(["admin"]),
        });
      } finally {
        guarded.store.close();
        cleanupTempDir(dataDir2);
      }
    } finally {
      cleanupTempDir(dataDir);
    }
  });
});

describe("provider-seam uniqueness — providers replace, they don't add (spec 060 SC 8, ADR 0011 Decision 3)", () => {
  it("refuses two plugins both supplying an authProvider, naming both", () => {
    const dataDir = makeTempDir();
    try {
      expect(() =>
        createLibrarianServer({
          ...baseOptions(dataDir),
          plugins: [
            { name: "alpha", authProvider: makeProvider(["member"]) },
            { name: "beta", authProvider: makeProvider(["member"]) },
          ],
        }),
      ).toThrow(/Plugin "beta" and plugin "alpha" both supply a authProvider provider/);
    } finally {
      cleanupTempDir(dataDir);
    }
  });

  it("refuses two plugins both supplying a vaultRouter, naming both", () => {
    const dataDir = makeTempDir();
    try {
      expect(() =>
        createLibrarianServer({
          ...baseOptions(dataDir),
          plugins: [
            { name: "alpha", vaultRouter: VAULT_ROUTER },
            { name: "beta", vaultRouter: SECOND_VAULT_ROUTER },
          ],
        }),
      ).toThrow(/Plugin "beta" and plugin "alpha" both supply a vaultRouter provider/);
    } finally {
      cleanupTempDir(dataDir);
    }
  });

  it("refuses two plugins both supplying an actorDisplayProvider, naming both", () => {
    const dataDir = makeTempDir();
    try {
      expect(() =>
        createLibrarianServer({
          ...baseOptions(dataDir),
          plugins: [
            { name: "alpha", actorDisplayProvider: ACTOR_DISPLAY_PROVIDER },
            { name: "beta", actorDisplayProvider: ACTOR_DISPLAY_PROVIDER },
          ],
        }),
      ).toThrow(/Plugin "beta" and plugin "alpha" both supply a actorDisplayProvider provider/);
    } finally {
      cleanupTempDir(dataDir);
    }
  });

  it("the same refusals fire from the resolvers the factory calls", () => {
    expect(() =>
      resolveAuthProvider([
        { name: "one", authProvider: NULL_PROVIDER },
        { name: "two", authProvider: NULL_PROVIDER },
      ]),
    ).toThrow(/Plugin "two" and plugin "one" both supply a authProvider provider/);
    expect(() =>
      resolveVaultRouter([
        { name: "one", vaultRouter: VAULT_ROUTER },
        { name: "two", vaultRouter: VAULT_ROUTER },
      ]),
    ).toThrow(/Plugin "two" and plugin "one" both supply a vaultRouter provider/);
    expect(() =>
      resolveActorDisplayProvider([
        { name: "one", actorDisplayProvider: ACTOR_DISPLAY_PROVIDER },
        { name: "two", actorDisplayProvider: ACTOR_DISPLAY_PROVIDER },
      ]),
    ).toThrow(/Plugin "two" and plugin "one" both supply a actorDisplayProvider provider/);

    // One provider (or none) resolves cleanly.
    expect(resolveAuthProvider([{ name: "solo", authProvider: NULL_PROVIDER }])?.pluginName).toBe(
      "solo",
    );
    expect(resolveVaultRouter([{ name: "empty" }])).toBeUndefined();
    expect(
      resolveActorDisplayProvider([{ name: "solo", actorDisplayProvider: ACTOR_DISPLAY_PROVIDER }]),
    ).toBe(ACTOR_DISPLAY_PROVIDER);
    expect(resolveActorDisplayProvider([{ name: "empty" }])).toBeUndefined();
  });
});
