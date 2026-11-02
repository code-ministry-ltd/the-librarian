// spec 065 T1 / SC 4 — OSS default provider is BYTE-IDENTICAL under the identity header.
//
// The identity assertion is meaningful only to a member-aware provider. Under the OSS
// `defaultAuthProvider`, the internal surface is admin-by-isolation (ADR 0008 P3): its internal
// branch reads NO headers, so EVERY header variant — a valid user assertion, the anonymous
// assertion, the poison marker, an oversize value, garbage, or an absent header — resolves to the
// SAME admin principal. Driven over real HTTP against the internal listener, mechanics per
// `provider-seam-live.test.ts` (the 060 factory-e2e infrastructure).

import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../test/helpers.js";
import { DASHBOARD_USER_HEADER, DASHBOARD_USER_POISON } from "../dist/extension.js";
import { type LibrarianServerOptions, createLibrarianServer } from "../dist/librarian-server.js";
import type { LibrarianPlugin } from "../dist/plugin.js";
import { publicProcedure, router } from "../dist/trpc/trpc.js";

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

function listeningPort(server: import("node:http").Server): Promise<number> {
  const portOf = (): number => (server.address() as AddressInfo).port;
  if (server.listening) return Promise.resolve(portOf());
  return new Promise((resolve) => server.once("listening", () => resolve(portOf())));
}

// A probe plugin with NO authProvider — so the OSS default provider stays the identity source —
// exposing a PUBLIC procedure that echoes the resolved principal back over the wire (the point is
// what the default provider resolves the request TO, regardless of header — which is admin by
// isolation; admin-gated reachability under the default provider is covered by the live e2e).
const identityRouter = router({
  whoami: publicProcedure.query(({ ctx }) => ({
    kind: ctx.principal.kind,
    actorId: ctx.principal.actorId,
    roles: [...ctx.principal.roles],
  })),
});
const probePlugin: LibrarianPlugin = {
  name: "sc4probe",
  trpcRouters: { identity: identityRouter },
};

function enc(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

interface TrpcData<T> {
  result: { data: T };
}

describe("spec 065 SC 4 — default provider ignores the identity header (byte-identical admin)", () => {
  it("resolves the SAME admin principal for every header variant on the internal surface", async () => {
    const dataDir = makeTempDir();
    const server = createLibrarianServer({ ...baseOptions(dataDir), plugins: [probePlugin] });
    try {
      server.start();
      const internalPort = await listeningPort(server.internals.internalServer);
      const internalBase = `http://127.0.0.1:${internalPort}`;

      const variants: Array<{ label: string; header?: string }> = [
        { label: "absent" }, // no header
        { label: "user assertion", header: enc({ provider: "github", sub: "42" }) },
        { label: "anonymous assertion", header: enc({ anon: true }) },
        { label: "poison marker", header: DASHBOARD_USER_POISON },
        { label: "oversize", header: enc({ provider: "github", sub: "x".repeat(5000) }) },
        { label: "garbage", header: "!!!not-base64!!!" },
      ];

      const results = [];
      for (const variant of variants) {
        const res = await fetch(`${internalBase}/trpc/sc4probe.identity.whoami`, {
          headers: variant.header ? { [DASHBOARD_USER_HEADER]: variant.header } : {},
        });
        expect(res.status, variant.label).toBe(200);
        const body = (await res.json()) as TrpcData<{
          kind: string;
          actorId: string;
          roles: string[];
        }>;
        results.push(body.result.data);
      }

      // Every variant resolved to the identical admin-by-isolation principal.
      const expected = { kind: "admin", actorId: "dashboard-admin", roles: ["admin"] };
      for (const [i, data] of results.entries()) {
        expect(data, variants[i]!.label).toEqual(expected);
      }
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
