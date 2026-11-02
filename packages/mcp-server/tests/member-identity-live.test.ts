// Spec 065 T5 — the Teams-shape MEMBER-IDENTITY e2e (SC 9 + SC 10), over real HTTP.
//
// One fixture plugin fills BOTH provider seams (the teams-shape-live.test.ts shape): an
// authProvider implementing SC 9's assertion table via `readDashboardUser` on the INTERNAL
// listener (the provider-seam-live.test.ts:252 mechanics — real fetch with real headers), and the
// matching vaultRouter (alice → [members/alice/ (writable), team/ (read-only)]; bob → likewise;
// the designated admin subject → the full vault).
//
// SC 9's table, implemented by the fixture provider:
//   absent          → the admin-by-isolation principal (machine calls: the bare-client bootstrap)
//   invalid/poison  → refusal
//   {anon:true}     → refusal
//   unknown subject → refusal
//   known subject   → that mapping's principal
//
// The seven SC 10 assertion groups are the seven tests below.

import fs from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Principal, Shelf, VaultRouter } from "@librarian/core";
import { mintSetupLink, setOwnerPassword } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../test/helpers.js";
import {
  DASHBOARD_USER_HEADER,
  DASHBOARD_USER_POISON,
  readDashboardUser,
} from "../dist/extension.js";
import type { AuthProvider } from "../dist/http/auth.js";
import { type LibrarianServerOptions, createLibrarianServer } from "../dist/librarian-server.js";
import type { LibrarianPlugin } from "../dist/plugin.js";
import { RESTORE_CONFIRMATION_PHRASE } from "../dist/trpc/activity.js";

// ── The fixture world ────────────────────────────────────────────────────────────────────────
const ALICE_SHELF: Shelf = {
  id: "alice",
  prefix: "members/alice/",
  writable: true,
  label: "Alice's shelf",
};
const BOB_SHELF: Shelf = {
  id: "bob",
  prefix: "members/bob/",
  writable: true,
  label: "Bob's shelf",
};
const TEAM_SHELF: Shelf = { id: "team", prefix: "team/", writable: false, label: "Team library" };
const FULL_SHELF: Shelf = { id: "main", prefix: "", writable: true };

const adminPrincipal: Principal = { kind: "admin", actorId: "dashboard-admin", roles: ["admin"] };
function memberPrincipal(memberId: string): Principal {
  return {
    kind: "member",
    actorId: `member:${memberId}`,
    roles: ["member"],
    attrs: { memberId },
  };
}

// The subject map a member-aware provider owns: {provider, sub} → principal (SC 2's pair — sub
// alone is not unique across providers).
const SUBJECTS = new Map<string, Principal>([
  ["github:alice-id", memberPrincipal("alice")],
  ["github:bob-id", memberPrincipal("bob")],
  ["github:admin-id", adminPrincipal],
]);

// SC 9's table, verbatim: every PRESENT-but-unacceptable assertion refuses; only genuine absence
// retains isolation trust (the bare bootstrap client + module-init execution).
const memberAuthProvider: AuthProvider = {
  authenticate(req, surface) {
    if (surface !== "internal") return { ok: false, status: 401 }; // nothing here drives /mcp
    const assertion = readDashboardUser(req);
    switch (assertion.kind) {
      case "absent":
        return { ok: true, principal: adminPrincipal }; // ADR 0008 P3 — today's machine trust
      case "invalid":
      case "anonymous":
        return { ok: false, status: 401 };
      case "user": {
        const mapped = SUBJECTS.get(`${assertion.user.provider}:${assertion.user.sub}`);
        return mapped ? { ok: true, principal: mapped } : { ok: false, status: 401 };
      }
    }
  },
};

const memberVaultRouter: VaultRouter = {
  shelves(principal, op) {
    const memberId = principal.attrs?.memberId;
    if (memberId === "alice") return op === "write" ? [ALICE_SHELF] : [ALICE_SHELF, TEAM_SHELF];
    if (memberId === "bob") return op === "write" ? [BOB_SHELF] : [BOB_SHELF, TEAM_SHELF];
    // The admin (and the system pipelines) see EVERY shelf — "the admin sees everything" is a
    // ROUTER decision (the 062 teams-shape precedent maps the internal admin to all shelves);
    // the root prefix "" is its own disjoint shelf and does not subsume the member subtrees.
    if (principal.roles.includes("admin"))
      return op === "write" ? [FULL_SHELF] : [ALICE_SHELF, TEAM_SHELF, BOB_SHELF];
    return [FULL_SHELF];
  },
  writeTarget(principal) {
    const memberId = principal.attrs?.memberId;
    if (memberId === "alice") return ALICE_SHELF;
    if (memberId === "bob") return BOB_SHELF;
    return FULL_SHELF;
  },
};

const teamsPlugin: LibrarianPlugin = {
  name: "teams065",
  authProvider: memberAuthProvider,
  vaultRouter: memberVaultRouter,
};

// The SAME vaultRouter WITHOUT the member-aware authProvider — the SC 10 coupling case.
const routerOnlyPlugin: LibrarianPlugin = { name: "teams065", vaultRouter: memberVaultRouter };

// ── Harness (per provider-seam-live.test.ts) ────────────────────────────────────────────────
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

interface StartedServer {
  internalBase: string;
  dataDir: string;
  store: ReturnType<typeof createLibrarianServer>["store"];
}

async function withStartedServer(
  plugins: readonly LibrarianPlugin[],
  fn: (started: StartedServer) => Promise<void>,
): Promise<void> {
  const dataDir = makeTempDir();
  const server = createLibrarianServer({ ...baseOptions(dataDir), plugins });
  let stopped = false;
  try {
    server.start();
    const internalPort = await listeningPort(server.internals.internalServer);
    await fn({
      internalBase: `http://127.0.0.1:${internalPort}`,
      dataDir,
      store: server.store,
    });
    await server.stop();
    stopped = true;
  } finally {
    if (!stopped) {
      try {
        await server.stop();
      } catch {
        /* best-effort teardown */
      }
    }
    cleanupTempDir(dataDir);
  }
}

/** base64url(UTF-8 JSON) — the wire encoding the dashboard setter produces. */
function enc(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

const ALICE_HEADER = enc({ provider: "github", sub: "alice-id", name: "Alice" });
const ADMIN_HEADER = enc({ provider: "github", sub: "admin-id" });
const UNKNOWN_HEADER = enc({ provider: "github", sub: "mallory-id" });
const ANON_HEADER = enc({ anon: true });

function withHeader(header?: string): Record<string, string> {
  return header === undefined ? {} : { [DASHBOARD_USER_HEADER]: header };
}

async function trpcQuery(
  base: string,
  proc: string,
  input?: unknown,
  header?: string,
): Promise<Response> {
  const url =
    input === undefined
      ? `${base}/trpc/${proc}`
      : `${base}/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(input))}`;
  return fetch(url, { headers: withHeader(header) });
}

async function trpcMutation(
  base: string,
  proc: string,
  input: unknown,
  header?: string,
): Promise<Response> {
  return fetch(`${base}/trpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...withHeader(header) },
    body: JSON.stringify(input),
  });
}

interface TrpcData<T> {
  result: { data: T };
}

interface WireMemory {
  id: string;
  title: string;
  shelfId?: string;
  shelfLabel?: string;
}

/** Seed the three-member world: memories + references on alice's, bob's, and the team shelf. */
function seedWorld(started: StartedServer): { bobMemoryId: string } {
  const { store, dataDir } = started;
  store
    .forShelf(ALICE_SHELF)
    .createMemory({ title: "alice note", body: "harp tuning", agent_id: "x" }, {});
  // The team shelf is read-only for principals; seed through the raw system path.
  store
    .groomingStoreForShelf(TEAM_SHELF)
    .createMemory({ title: "team note", body: "harp roster", agent_id: "x" }, {});
  const bob = store
    .forShelf(BOB_SHELF)
    .createMemory({ title: "bob secret", body: "harp secret", agent_id: "x" }, {});

  for (const [shelf, name] of [
    [ALICE_SHELF, "alice-ref"],
    [TEAM_SHELF, "team-ref"],
    [BOB_SHELF, "bob-ref"],
  ] as const) {
    const dir = path.join(
      dataDir,
      "vault",
      ...shelf.prefix.split("/").filter(Boolean),
      "references",
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.md`), `# ${name}\n\nlute maintenance notes\n`);
  }
  return { bobMemoryId: bob.memory.id };
}

describe("spec 065 SC 9/SC 10 — the member-identity fixture e2e (internal listener, real headers)", () => {
  it("group 1: alice's list is her shelf + team, merged and attributed; bob's memory is invisible on the wire AND at the core", async () => {
    await withStartedServer([teamsPlugin], async (started) => {
      const { bobMemoryId } = seedWorld(started);

      const res = await trpcQuery(
        started.internalBase,
        "memories.list",
        { sort: "title", order: "asc" },
        ALICE_HEADER,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as TrpcData<{ memories: WireMemory[]; total: number }>;
      const rows = body.result.data.memories;

      expect(rows.map((m) => m.title)).toEqual(["alice note", "team note"]);
      expect(body.result.data.total).toBe(2);
      expect(rows[0]?.shelfId).toBe("alice");
      expect(rows[0]?.shelfLabel).toBe("Alice's shelf");
      expect(rows[1]?.shelfId).toBe("team");
      expect(rows[1]?.shelfLabel).toBe("Team library");

      // The core-level invisibility proof alongside the wire ones (SC 7's primitive):
      // bob's id resolves to null through alice's shelf set — indistinguishable from absent.
      expect(started.store.getMemoryForPrincipal(memberPrincipal("alice"), bobMemoryId)).toBeNull();
      expect(
        started.store.getMemoryForPrincipal(memberPrincipal("bob"), bobMemoryId),
      ).not.toBeNull();
    });
  });

  it("group 2: alice's recall and searchReferences carry 062's shelf provenance", async () => {
    await withStartedServer([teamsPlugin], async (started) => {
      seedWorld(started);

      const recall = await trpcMutation(
        started.internalBase,
        "memories.recall",
        { query: "harp" },
        ALICE_HEADER,
      );
      expect(recall.status).toBe(200);
      const recallBody = (await recall.json()) as TrpcData<{ memories: WireMemory[] }>;
      const hits = recallBody.result.data.memories;
      expect(hits.map((m) => m.title).sort()).toEqual(["alice note", "team note"]);
      expect(hits.find((m) => m.title === "alice note")?.shelfId).toBe("alice");
      expect(hits.find((m) => m.title === "alice note")?.shelfLabel).toBe("Alice's shelf");
      expect(hits.find((m) => m.title === "team note")?.shelfId).toBe("team");
      expect(hits.find((m) => m.title === "team note")?.shelfLabel).toBe("Team library");

      const refs = await trpcMutation(
        started.internalBase,
        "vault.searchReferences",
        { query: "lute" },
        ALICE_HEADER,
      );
      expect(refs.status).toBe(200);
      const refsBody = (await refs.json()) as TrpcData<{
        references: Array<{ id: string; shelfId?: string; shelfLabel?: string }>;
        searched: number;
      }>;
      expect(refsBody.result.data.searched).toBe(2); // alice's scoped denominator, not the vault's 3
      const refHits = refsBody.result.data.references;
      expect(refHits.map((h) => h.shelfId).sort()).toEqual(["alice", "team"]);
      expect(refHits.some((h) => h.id.includes("bob"))).toBe(false);
    });
  });

  it("group 3: alice's restoreVault WITH the correct confirmation phrase is 401 — the phrase is never reachable before the role gate", async () => {
    await withStartedServer([teamsPlugin], async (started) => {
      const res = await trpcMutation(
        started.internalBase,
        "activity.restoreVault",
        { hash: "abcdef1", confirm: RESTORE_CONFIRMATION_PHRASE },
        ALICE_HEADER,
      );
      expect(res.status).toBe(401);
    });
  });

  it("group 4: the admin subject sees everything — byte-identical to today's machine-trust view", async () => {
    await withStartedServer([teamsPlugin], async (started) => {
      seedWorld(started);
      const input = { sort: "title", order: "asc" };

      const adminRes = await trpcQuery(started.internalBase, "memories.list", input, ADMIN_HEADER);
      expect(adminRes.status).toBe(200);
      const adminBody = (await adminRes.json()) as TrpcData<{
        memories: WireMemory[];
        total: number;
      }>;

      // Everything: alice's, bob's, and the team shelf, in one merged view.
      expect(adminBody.result.data.total).toBe(3);
      expect(adminBody.result.data.memories.map((m) => m.title)).toEqual([
        "alice note",
        "bob secret",
        "team note",
      ]);

      // Byte-identical to TODAY's trust: the admin subject resolves the SAME principal an absent
      // (machine) assertion does — ADR 0008 P3's admin-by-isolation — so the two wire responses
      // are equal, field for field.
      const absentRes = await trpcQuery(started.internalBase, "memories.list", input, undefined);
      expect(absentRes.status).toBe(200);
      const absentBody = (await absentRes.json()) as TrpcData<{
        memories: WireMemory[];
        total: number;
      }>;
      expect(adminBody.result.data).toEqual(absentBody.result.data);
    });
  });

  it("group 5: unknown subject, poison, and {anon:true} each 401 on admin-gated procedures; health stays reachable", async () => {
    await withStartedServer([teamsPlugin], async (started) => {
      for (const header of [UNKNOWN_HEADER, DASHBOARD_USER_POISON, ANON_HEADER]) {
        // A member-tier procedure and an admin-gated one both refuse.
        const list = await trpcQuery(started.internalBase, "memories.list", undefined, header);
        expect(list.status, `memories.list under ${header.slice(0, 12)}…`).toBe(401);
        const aggregates = await trpcQuery(
          started.internalBase,
          "memories.aggregates",
          undefined,
          header,
        );
        expect(aggregates.status, `memories.aggregates under ${header.slice(0, 12)}…`).toBe(401);
        // health is publicProcedure by design and survives any assertion.
        const health = await trpcQuery(started.internalBase, "health.ping", undefined, header);
        expect(health.status, `health.ping under ${header.slice(0, 12)}…`).toBe(200);
      }
    });
  });

  it("group 6: an ABSENT header resolves admin, so BOTH bootstrap shapes work sessionlessly — sign-in (verifyPassword) and the break-glass reset (redeemSetupLink)", async () => {
    await withStartedServer([teamsPlugin], async (started) => {
      // The sessionless verifyPassword-shaped sign-in call (its credential is the password).
      setOwnerPassword(started.store, "owner", "correct-horse-battery-staple");
      const verify = await trpcMutation(started.internalBase, "auth.verifyPassword", {
        username: "owner",
        password: "correct-horse-battery-staple",
      }); // NO identity header — the bare bootstrap client's shape
      expect(verify.status).toBe(200);
      const verifyBody = (await verify.json()) as TrpcData<{ ok: boolean }>;
      expect(verifyBody.result.data.ok).toBe(true);

      // The sessionless redeemSetupLink-shaped reset redemption (its credential is the one-time
      // link token) — the break-glass flow verify pass 2 caught being broken by the anonymous row.
      const token = mintSetupLink(started.store, 60_000);
      const redeem = await trpcMutation(started.internalBase, "auth.redeemSetupLink", {
        token,
        password: "next-correct-horse-battery",
      }); // NO identity header
      expect(redeem.status).toBe(200);
      const redeemBody = (await redeem.json()) as TrpcData<{ ok: boolean }>;
      expect(redeemBody.result.data.ok).toBe(true);
    });
  });

  it("group 7 (the coupling case): the fixture vaultRouter WITHOUT the member-aware authProvider leaves every request admin-with-full-vault", async () => {
    await withStartedServer([routerOnlyPlugin], async (started) => {
      seedWorld(started);

      // Even a request carrying alice's USER assertion resolves admin under the DEFAULT provider
      // (its internal branch reads no headers), and the router maps admin to EVERY shelf — so the
      // list is vault-wide, bob's private memory included. This is why a scoping vaultRouter is
      // meaningless without a provider that mints member principals (documented in the extension
      // docs) — and why the combination is documented + e2e-pinned rather than refused at boot
      // (a router may legitimately scope by agent principals with no dashboard auth involved).
      const res = await trpcQuery(started.internalBase, "memories.list", undefined, ALICE_HEADER);
      expect(res.status).toBe(200);
      const body = (await res.json()) as TrpcData<{ memories: WireMemory[]; total: number }>;
      expect(body.result.data.total).toBe(3); // bob's secret included — full vault
      expect(body.result.data.memories.map((m) => m.title)).toContain("bob secret");
    });
  });
});
