// Surface inventory — the exact route set each listener serves (spec 060 SC 2).
//
// The T1 route-table refactor (spec 060) replaces the per-surface if-ladder in
// http/routes.ts with a declarative table. This suite is its tripwire: it pins
// which paths each listener answers so a route can't silently move between
// surfaces (or a surface start answering a path it must not) without an
// assertion here flipping.
//
//   - PUBLIC  (LIBRARIAN_HOST:PORT)      → /healthz, /primer.md, /mcp,
//                                          /transcript, /journal.md, /ingest ; /trpc/* → 404
//   - INTERNAL(LIBRARIAN_TRPC_HOST:PORT) → /trpc/* only ; everything else → 404
//
// Each probe is UNAUTHENTICATED on purpose: the question is "is this path routed
// on this surface?", answered by 404 (absent) vs the route's own health/auth
// status (present) — NOT by exercising the handler (that is covered by
// routes.test / listeners.test / the per-endpoint suites).

import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

// The public agent surface: path + method + the status an UNAUTHENTICATED probe
// gets when the route is present. /healthz and /primer.md are open documents
// (200); the four authenticated routes 401 with no bearer — every one is "not
// 404", which is the present/absent inventory signal.
const PUBLIC_ROUTES = [
  { method: "GET", path: "/healthz", present: 200 },
  { method: "GET", path: "/primer.md", present: 200 },
  { method: "POST", path: "/mcp", present: 401 },
  { method: "POST", path: "/transcript", present: 401 },
  { method: "GET", path: "/journal.md", present: 401 },
  { method: "POST", path: "/ingest", present: 401 },
] as const;

// The one path the internal listener serves. health.ping is the cheapest public
// tRPC procedure (no bearer needed), so a bare GET resolves (200) when /trpc/* is
// mounted and 404s when it isn't.
const INTERNAL_ROUTE = { method: "GET", path: "/trpc/health.ping", present: 200 } as const;

async function probe(base: string, method: string, path: string): Promise<number> {
  const init =
    method === "GET"
      ? undefined
      : { method, headers: { "content-type": "application/json" }, body: "{}" };
  const res = await fetch(`${base}${path}`, init);
  return res.status;
}

describe("surface inventory — exact route set per listener (spec 060 SC 2)", () => {
  it("public serves its six routes and 404s /trpc/*; internal serves /trpc/* only", async () => {
    const dataDir = makeTempDir();
    // Bound 0.0.0.0 with an agent token (the helper default) so the no-auth bypass
    // is OFF: an unauthenticated /mcp|/transcript|/ingest probe 401s (present), not
    // agent-resolved — keeping the inventory signal a clean present/absent split.
    const server = await startHttpServer({ dataDir });
    try {
      // PUBLIC: every agent route is present (not 404); /trpc/* is absent (404).
      for (const route of PUBLIC_ROUTES) {
        expect(
          await probe(server.url, route.method, route.path),
          `public ${route.method} ${route.path} must be served`,
        ).toBe(route.present);
      }
      expect(
        await probe(server.url, INTERNAL_ROUTE.method, INTERNAL_ROUTE.path),
        "public must NOT serve /trpc/* (the admin surface is internal-only, ADR 0008 P1)",
      ).toBe(404);

      // INTERNAL: /trpc/* is present; every public route is absent (404).
      expect(
        await probe(server.trpcUrl, INTERNAL_ROUTE.method, INTERNAL_ROUTE.path),
        "internal must serve /trpc/*",
      ).toBe(INTERNAL_ROUTE.present);
      for (const route of PUBLIC_ROUTES) {
        expect(
          await probe(server.trpcUrl, route.method, route.path),
          `internal must NOT serve ${route.path}`,
        ).toBe(404);
      }
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("serves the pre-origin-gate documents to a foreign Origin, but gates the authenticated routes (beforeOriginGate)", async () => {
    // The two `beforeOriginGate` document routes (/healthz, /primer.md) are served AHEAD
    // of the browser-origin gate — a health probe or a remote-URL primer fetch carries a
    // foreign/absent Origin and must still read them. Every other public route sits
    // BEHIND the gate. This pins that data flag, which no other test exercised.
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    const evilOrigin = { headers: { origin: "https://evil.example" } };
    try {
      // Pre-gate documents answer 200 even from a disallowed Origin.
      expect(
        (await fetch(`${server.url}/healthz`, evilOrigin)).status,
        "/healthz is exempt from the origin gate",
      ).toBe(200);
      expect(
        (await fetch(`${server.url}/primer.md`, evilOrigin)).status,
        "/primer.md is exempt from the origin gate",
      ).toBe(200);
      // A gated route with the SAME foreign Origin is refused at the gate (403), before
      // auth even runs — proving the exemption is the flag, not a blanket open door.
      const gated = await fetch(`${server.url}/mcp`, {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: "{}",
      });
      expect(gated.status, "POST /mcp is behind the origin gate").toBe(403);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
