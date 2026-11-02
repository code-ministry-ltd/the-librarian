// Two-listener split (ADR 0008 P1, spec §4 "Two listeners").
//
// The admin tRPC API used to ride the SAME HTTP listener as /mcp, which is
// published (0.0.0.0) so remote agents can reach /mcp. That incidentally
// exposed the admin surface (auth.config returns DECRYPTED secrets) to any
// network peer with the admin token. This slice takes /trpc off the public
// port and serves it on a SEPARATE internal listener — defense by not-
// exposing (ADR 0008). The admin-token auth on /trpc is UNCHANGED here; only
// the socket that serves it moved (token removal is P3).
//
// Surfaces after the split:
//   - PUBLIC  (LIBRARIAN_HOST:LIBRARIAN_PORT)      → /mcp, /healthz, /primer.md
//                                                    /trpc/* → 404 (NOT served)
//   - INTERNAL(LIBRARIAN_TRPC_HOST:LIBRARIAN_TRPC_PORT) → /trpc/* only
//                                                    /mcp, /healthz → 404

import { JOURNAL_ENABLED_KEY, createLibrarianStore } from "@librarian/core";
import { describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  makeTempDir,
  postJson,
  startHttpServer,
} from "../../../../test/helpers.js";

describe("two-listener split (ADR 0008 P1)", () => {
  it("does NOT serve /trpc on the public listener (404)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      // health.ping is the cheapest public tRPC procedure; on the PUBLIC
      // listener the whole /trpc/* prefix is gone, so it 404s at the route
      // floor — the admin surface is simply not reachable from the published
      // port, with OR without a bearer.
      const noAuth = await fetch(`${server.url}/trpc/health.ping`);
      expect(noAuth.status, "/trpc on the public listener must 404").toBe(404);

      const withAdmin = await fetch(`${server.url}/trpc/auth.config`, {
        headers: { authorization: `Bearer ${server.token}` },
      });
      expect(
        withAdmin.status,
        "even an admin bearer cannot reach /trpc on the public listener",
      ).toBe(404);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("serves /trpc on the internal listener (routes to the tRPC handler)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      // Same request that 404s on the public port resolves on the internal one.
      const res = await fetch(`${server.trpcUrl}/trpc/health.ping`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: { data: { ok: boolean } } };
      expect(body.result.data.ok).toBe(true);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("serves /mcp on the public listener only — not on the internal one", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    // /mcp is gated by the AGENT token now (ADR 0008 P3 — admin token is not a gate).
    const call = (base: string) =>
      postJson(
        `${base}/mcp`,
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { authorization: `Bearer ${server.agentToken}` },
      );
    try {
      const pub = await call(server.url);
      expect(pub.response.status, "/mcp works on the public listener").toBe(200);
      expect(pub.json).toMatchObject({ jsonrpc: "2.0", id: 1 });

      const internal = await call(server.trpcUrl);
      expect(internal.response.status, "/mcp is NOT served on the internal listener").toBe(404);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("keeps /healthz and /primer.md on the public listener (health unbroken)", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      // The container HEALTHCHECK probes /healthz on the published port — it
      // MUST stay there.
      const health = await fetch(`${server.url}/healthz`);
      expect(health.status).toBe(200);
      expect(((await health.json()) as { status: string }).status).toBe("ok");

      const primer = await fetch(`${server.url}/primer.md`);
      expect(primer.status).toBe(200);
      expect(primer.headers.get("content-type")).toBe("text/markdown; charset=utf-8");

      // Neither health route exists on the internal (tRPC-only) listener.
      expect((await fetch(`${server.trpcUrl}/healthz`)).status).toBe(404);
      expect((await fetch(`${server.trpcUrl}/primer.md`)).status).toBe(404);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("reports capture status on /healthz: on while intake OR the journal is on (T5/SC9)", async () => {
    // Capture is disabled by default (the intake gate is off on a fresh spawn).
    const offDir = makeTempDir();
    const off = await startHttpServer({ dataDir: offDir });
    try {
      const body = (await (await fetch(`${off.url}/healthz`)).json()) as { capture: string };
      expect(body.capture).toBe("disabled");
    } finally {
      await off.stop();
      cleanupTempDir(offDir);
    }

    // With the intake gate seeded ON, /healthz reports capture enabled — this is
    // the field the SessionStart banner reads to know capture is live.
    const onDir = makeTempDir();
    const on = await startHttpServer({ dataDir: onDir, intake: "on" });
    try {
      const body = (await (await fetch(`${on.url}/healthz`)).json()) as {
        capture: string;
        intake: string;
      };
      expect(body.capture).toBe("enabled");
      expect(body.intake).toBe("enabled");
    } finally {
      await on.stop();
      cleanupTempDir(onDir);
    }

    // Journal only: capture is on, but `intake` says nothing is mined for memories.
    const journalDir = makeTempDir();
    const seed = createLibrarianStore({ dataDir: journalDir });
    seed.setSetting(JOURNAL_ENABLED_KEY, "true");
    seed.close();
    const journalOnly = await startHttpServer({ dataDir: journalDir });
    try {
      const body = (await (await fetch(`${journalOnly.url}/healthz`)).json()) as Record<
        string,
        string
      >;
      expect(body).toMatchObject({ capture: "enabled", intake: "disabled", journal: "enabled" });
    } finally {
      await journalOnly.stop();
      cleanupTempDir(journalDir);
    }
  });

  it("binds BOTH listeners on boot and stops them cleanly", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    // startHttpServer only resolves once BOTH listeners answer (helper waits on
    // /healthz and /trpc/health.ping), so reaching here proves both are bound.
    expect(server.port).toBeGreaterThan(0);
    expect(server.trpcPort).toBeGreaterThan(0);
    expect(server.trpcPort).not.toBe(server.port);

    await server.stop();
    // Both sockets are released: a fresh fetch to either is refused (no leaked
    // listener after SIGTERM).
    await expect(fetch(`${server.url}/healthz`)).rejects.toThrow();
    await expect(fetch(`${server.trpcUrl}/trpc/health.ping`)).rejects.toThrow();
    cleanupTempDir(dataDir);
  });
});
