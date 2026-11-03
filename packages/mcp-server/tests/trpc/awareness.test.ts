// Primer admin tRPC tests (spec 041 A1, repointed by rethink T11, reshaped by spec 083).
//
// The dashboard's read/write surface over the primer: the fixed default plus the operator's
// addendum (`vault/primer.md`):
//   - awareness.primer (query) → { primer, defaultPrimer, addendum, reviewPending };
//   - awareness.setAddendum (mutation) → commits the addendum; refuses >2KB with a teaching
//     BAD_REQUEST (never a 500);
//   - awareness.dismissReview (mutation) → clears the migration review notice.
// All admin-gated. A pre-083 primer.md, and the legacy settings-key primer, migrate into the
// addendum once at boot.

import { DEFAULT_PRIMER, composePrimer, createLibrarianStore } from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

interface TrpcOk<T> {
  result: { data: T };
}
interface TrpcErr {
  error: unknown;
}
interface ServerHandle {
  url: string;
  token: string;
  stop: () => Promise<void>;
}

async function trpcPost<T>(server: ServerHandle, path: string, input?: unknown): Promise<T> {
  const response = await fetch(`${server.trpcUrl}/trpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const json = (await response.json()) as TrpcOk<T> | TrpcErr;
  if (response.status >= 400 || "error" in json) {
    throw new Error(`trpc POST ${path} failed: ${JSON.stringify(json)}`);
  }
  return (json as TrpcOk<T>).result.data;
}

async function trpcGet<T>(server: ServerHandle, path: string): Promise<T> {
  const response = await fetch(`${server.trpcUrl}/trpc/${path}`, {
    method: "GET",
    headers: { authorization: `Bearer ${server.token}` },
  });
  const json = (await response.json()) as TrpcOk<T> | TrpcErr;
  if (response.status >= 400 || "error" in json) {
    throw new Error(`trpc GET ${path} failed: ${JSON.stringify(json)}`);
  }
  return (json as TrpcOk<T>).result.data;
}

interface PrimerResult {
  primer: string;
  defaultPrimer: string;
  addendum: string;
  reviewPending: boolean;
}

describe("tRPC primer surface (vault/primer.md, rethink T11)", () => {
  let dataDir = "";
  beforeEach(() => {
    dataDir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dataDir);
  });

  it("primer read + write are unreachable from the public (network) listener (ADR 0008 P3)", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      // Post-P3 the admin gate is the network boundary, not a token: the primer
      // read/write surface is served only on the internal listener and 404s on
      // the public port — even for a network agent's bearer (ADR 0008 P1/P3).
      const readAgent = await fetch(`${server.url}/trpc/awareness.primer`, {
        method: "GET",
        headers: { authorization: "Bearer agent-token" },
      });
      expect(readAgent.status).toBe(404);

      const writeAgent = await fetch(`${server.url}/trpc/awareness.setAddendum`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer agent-token" },
        body: JSON.stringify({ addendum: "x" }),
      });
      expect(writeAgent.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it("reads the boot-seeded default primer on a fresh install", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcGet<PrimerResult>(server, "awareness.primer");
      expect(result.primer).toBe(DEFAULT_PRIMER);
    } finally {
      await server.stop();
    }
  });

  it("round-trips an addendum: the complete primer is the default followed by it", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const addendum = "Use British English.";
      const wrote = await trpcPost<PrimerResult>(server, "awareness.setAddendum", { addendum });
      expect(wrote.addendum).toBe(addendum);
      expect(wrote.primer).toBe(composePrimer(addendum));

      const read = await trpcGet<PrimerResult>(server, "awareness.primer");
      expect(read.primer).toBe(composePrimer(addendum));
      expect(read.defaultPrimer).toBe(DEFAULT_PRIMER);

      const publicPrimer = await fetch(`${server.url}/primer.md`);
      expect(await publicPrimer.text()).toBe(composePrimer(addendum));
    } finally {
      await server.stop();
    }
  });

  it("an empty addendum leaves the default alone; the primer can't be disabled", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const wrote = await trpcPost<PrimerResult>(server, "awareness.setAddendum", { addendum: "" });
      expect(wrote.addendum).toBe("");
      expect(wrote.primer).toBe(DEFAULT_PRIMER);
    } finally {
      await server.stop();
    }
  });

  it("refuses an over-2KB addendum with a teaching BAD_REQUEST, leaving it untouched", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.trpcUrl}/trpc/awareness.setAddendum`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ addendum: "x".repeat(2049) }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain("2048 bytes");
      expect(body.error.message).toContain("2049 bytes");

      const read = await trpcGet<PrimerResult>(server, "awareness.primer");
      expect(read.primer).toBe(DEFAULT_PRIMER);
    } finally {
      await server.stop();
    }
  });

  it("moves an edited pre-083 primer into the addendum at boot, flagged for review", async () => {
    const custom = "My old custom primer.";
    const seed = createLibrarianStore({ dataDir });
    seed.writePrimer(custom);
    seed.close();

    const server = await startHttpServer({ dataDir });
    try {
      const read = await trpcGet<PrimerResult>(server, "awareness.primer");
      expect(read.addendum).toBe(custom);
      expect(read.primer).toBe(composePrimer(custom));
      expect(read.reviewPending).toBe(true);

      const dismissed = await trpcPost<PrimerResult>(server, "awareness.dismissReview");
      expect(dismissed.reviewPending).toBe(false);
      expect(dismissed.addendum).toBe(custom);
    } finally {
      await server.stop();
    }
  });

  it("migrates the legacy settings-key primer into the addendum at boot (one-time)", async () => {
    const custom = "Legacy settings-key primer.";
    const seed = createLibrarianStore({ dataDir });
    seed.setSetting("awareness.primer", custom);
    seed.close();

    const server = await startHttpServer({ dataDir });
    try {
      const read = await trpcGet<PrimerResult>(server, "awareness.primer");
      expect(read.addendum).toBe(custom);
    } finally {
      await server.stop();
    }
  });

  it("persists an addendum across a server restart (it is a committed vault file)", async () => {
    const custom = "Persisted addendum.";
    const first = await startHttpServer({ dataDir });
    try {
      await trpcPost<PrimerResult>(first, "awareness.setAddendum", { addendum: custom });
    } finally {
      await first.stop();
    }

    const second = await startHttpServer({ dataDir });
    try {
      const read = await trpcGet<PrimerResult>(second, "awareness.primer");
      expect(read.addendum).toBe(custom);
      expect(read.reviewPending).toBe(false);
    } finally {
      await second.stop();
    }
  });
});
