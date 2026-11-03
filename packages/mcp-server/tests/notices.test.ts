// Notices (spec 084): who sees a notice, what the fetch sends, and the admin surface.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type Principal,
  PRIMER_REVIEW_PENDING_KEY,
  createInertBootstrapClaimHandle,
  createLibrarianStore,
} from "@librarian/core";
import { appRouter, createCallerFactory } from "@librarian/mcp-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INSTALL_CREATED_AT_KEY,
  NOTICES_FETCH_ENABLED_KEY,
  type RemoteNotice,
  __resetNoticesCacheForTests,
  assembleNotices,
  ensureInstallDate,
  getRemoteNotices,
  markRead,
  noticesUrl,
  parseNotices,
  readIds,
  satisfies,
  visibleNotices,
} from "../dist/notices.js";
import type { TrpcContext } from "../dist/trpc/context.js";

const createCaller = createCallerFactory(appRouter);
const ADMIN: Principal = { kind: "admin", actorId: "admin", roles: ["admin"], tokenId: "t1" };
const MEMBER: Principal = { kind: "member", actorId: "m", roles: ["member"], tokenId: "t2" };

let dataDir = "";
let store: LibrarianStore;

function caller(principal: Principal = ADMIN) {
  const context: TrpcContext = {
    principal,
    role: principal.roles.includes("admin") ? "admin" : "anonymous",
    store,
    secretKey: null,
    adminToken: "",
    bootstrapClaim: createInertBootstrapClaimHandle(),
  };
  return createCaller(context);
}

const notice = (over: Partial<RemoteNotice> = {}): RemoteNotice => ({
  id: "n1",
  created: "2026-11-01",
  severity: "info",
  title: "Hello",
  body: "Body",
  audience: "all",
  ...over,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-notices-"));
  store = createLibrarianStore({ dataDir });
  __resetNoticesCacheForTests();
  delete process.env.LIBRARIAN_DISABLE_NOTICES;
  delete process.env.DO_NOT_TRACK;
});

afterEach(() => {
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.LIBRARIAN_DISABLE_NOTICES;
  delete process.env.DO_NOT_TRACK;
});

describe("parseNotices", () => {
  it("keeps valid entries and skips invalid ones one by one", () => {
    const parsed = parseNotices({
      notices: [
        notice(),
        { ...notice({ id: "bad" }), severity: "urgent" },
        { ...notice({ id: "http" }), link: { href: "http://example.com", label: "x" } },
        notice({ id: "n2", link: { href: "https://example.com", label: "More" } }),
      ],
    });
    expect(parsed.map((n) => n.id)).toEqual(["n1", "n2"]);
  });

  it("returns nothing for a malformed file", () => {
    expect(parseNotices(null)).toEqual([]);
    expect(parseNotices({ notices: "x" })).toEqual([]);
  });

  it("the repository's notices.json parses cleanly", () => {
    const file = path.join(import.meta.dirname, "../../../notices.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { notices: unknown[] };
    expect(parseNotices(raw)).toHaveLength(raw.notices.length);
  });
});

describe("satisfies", () => {
  it.each([
    ["1.46.0", ">=1.40.0 <1.47.0", true],
    ["1.47.0", ">=1.40.0 <1.47.0", false],
    ["1.47.0", "1.47.0", true],
    ["1.47.1", "=1.47.0", false],
    ["1.47.1", ">1.47.0", true],
    ["1.47.0", "<=1.47.0", true],
    ["1.47.0", "nonsense", false],
    ["1.47.0", "", false],
  ])("%s in %j → %s", (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });
});

describe("visibleNotices", () => {
  const ctx = { today: "2026-11-10", installedOn: "2026-06-01", version: "1.47.0" };

  it("shows `existing` notices only to installs set up before the notice", () => {
    const n = notice({ audience: "existing", created: "2026-11-01" });
    expect(visibleNotices([n], ctx)).toHaveLength(1);
    expect(visibleNotices([n], { ...ctx, installedOn: "2026-11-05" })).toHaveLength(0);
    expect(visibleNotices([n], { ...ctx, installedOn: "2026-11-01" })).toHaveLength(0);
    // No recorded date: the install predates the date being kept, so it counts as existing.
    expect(visibleNotices([n], { ...ctx, installedOn: null })).toHaveLength(1);
  });

  it("shows `all` notices to new installs too", () => {
    const n = notice({ audience: "all", created: "2026-11-01" });
    expect(visibleNotices([n], { ...ctx, installedOn: "2027-11-01" })).toHaveLength(1);
  });

  it("drops expired notices and ones outside the version range", () => {
    expect(visibleNotices([notice({ expires: "2026-11-09" })], ctx)).toHaveLength(0);
    expect(visibleNotices([notice({ expires: "2026-11-10" })], ctx)).toHaveLength(1);
    expect(visibleNotices([notice({ versions: "<1.47.0" })], ctx)).toHaveLength(0);
    expect(visibleNotices([notice({ versions: ">=1.47.0" })], ctx)).toHaveLength(1);
  });
});

describe("local notices and read state", () => {
  it("shows the primer review notice while it is pending, linking to Settings → Primer", () => {
    expect(assembleNotices(store, [], { version: "1.47.0" })).toEqual([]);
    store.setSetting(PRIMER_REVIEW_PENDING_KEY, "true");
    const [n] = assembleNotices(store, [], { version: "1.47.0" });
    expect(n).toMatchObject({
      id: "local:primer-review",
      source: "local",
      read: false,
      link: { href: "/settings/primer" },
    });
  });

  it("a remote notice can't impersonate a local one", () => {
    const out = assembleNotices(store, [notice({ id: "local:primer-review" })], {
      version: "1.47.0",
    });
    expect(out).toEqual([]);
  });

  it("records read ids without duplicates", () => {
    markRead(store, ["a", "b"]);
    markRead(store, ["b", "c"]);
    expect([...readIds(store)]).toEqual(["a", "b", "c"]);
    const out = assembleNotices(store, [notice({ id: "a" }), notice({ id: "z" })], {
      version: "1.47.0",
      now: new Date("2026-11-10T00:00:00Z"),
    });
    expect(out.map((n) => [n.id, n.read])).toEqual([
      ["a", true],
      ["z", false],
    ]);
  });
});

describe("ensureInstallDate", () => {
  it("uses the vault's first commit for an install that predates the setting", () => {
    const vault = path.join(dataDir, "vault");
    store.writePrimer("Something to commit."); // gives the vault a root commit
    const root = execFileSync("git", ["-C", vault, "rev-list", "--max-parents=0", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const expected = new Date(
      execFileSync("git", ["-C", vault, "show", "-s", "--format=%cI", root], {
        encoding: "utf8",
      }).trim(),
    ).toISOString();
    ensureInstallDate(store, vault, new Date("2030-01-01T00:00:00Z"));
    expect(store.getSetting(INSTALL_CREATED_AT_KEY)).toBe(expected);
  });

  it("falls back to now with no vault history, and never overwrites", () => {
    ensureInstallDate(store, path.join(dataDir, "nowhere"), new Date("2030-01-01T00:00:00Z"));
    expect(store.getSetting(INSTALL_CREATED_AT_KEY)).toBe("2030-01-01T00:00:00.000Z");
    ensureInstallDate(store, path.join(dataDir, "nowhere"), new Date("2031-01-01T00:00:00Z"));
    expect(store.getSetting(INSTALL_CREATED_AT_KEY)).toBe("2030-01-01T00:00:00.000Z");
  });
});

describe("getRemoteNotices", () => {
  it("sends a plain GET with nothing about the install", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ notices: [notice()] }));
    const out = await getRemoteNotices(store, fetchImpl as unknown as typeof fetch);
    expect(out.status.kind).toBe("ok");
    expect(out.notices).toHaveLength(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(noticesUrl());
    expect(url).not.toContain("?");
    expect(init.headers).toEqual({ accept: "application/json", "user-agent": "the-librarian" });
    expect(init.redirect).toBe("error");
  });

  it("caches, and keeps the last good list when a refetch fails", async () => {
    const ok = vi.fn(async () => jsonResponse({ notices: [notice()] }));
    await getRemoteNotices(store, ok as unknown as typeof fetch);
    await getRemoteNotices(store, ok as unknown as typeof fetch);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("makes no request when switched off by the setting or the environment", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ notices: [] }));
    store.setSetting(NOTICES_FETCH_ENABLED_KEY, "false");
    expect((await getRemoteNotices(store, fetchImpl as unknown as typeof fetch)).status).toEqual({
      kind: "disabled",
      by: "setting",
    });
    store.setSetting(NOTICES_FETCH_ENABLED_KEY, "true");
    process.env.LIBRARIAN_DISABLE_NOTICES = "true";
    expect((await getRemoteNotices(store, fetchImpl as unknown as typeof fetch)).status).toEqual({
      kind: "disabled",
      by: "env",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never throws on a network error, a bad status or an oversized file", async () => {
    const boom = vi.fn(async () => {
      throw new Error("offline");
    });
    expect((await getRemoteNotices(store, boom as unknown as typeof fetch)).status).toEqual({
      kind: "unavailable",
      reason: "network_error",
    });
    __resetNoticesCacheForTests();
    const big = vi.fn(async () => new Response("x".repeat(70 * 1024)));
    expect((await getRemoteNotices(store, big as unknown as typeof fetch)).status).toEqual({
      kind: "unavailable",
      reason: "too_large",
    });
    __resetNoticesCacheForTests();
    const missing = vi.fn(async () => jsonResponse({}, 404));
    expect((await getRemoteNotices(store, missing as unknown as typeof fetch)).status).toEqual({
      kind: "unavailable",
      reason: "http_404",
    });
  });
});

describe("notices tRPC", () => {
  it("lists, marks read and switches the fetch, for admins only", async () => {
    process.env.LIBRARIAN_DISABLE_NOTICES = "true";
    process.env.DO_NOT_TRACK = "1"; // keep the usage-stats disclosure (spec 085) out of the count
    store.setSetting(PRIMER_REVIEW_PENDING_KEY, "true");
    const first = await caller().notices.list();
    expect(first.unread).toBe(1);
    expect(first.remote).toMatchObject({ forcedOff: true, status: { kind: "disabled" } });

    await caller().notices.markRead({ ids: ["local:primer-review"] });
    expect((await caller().notices.list()).unread).toBe(0);

    expect(await caller().notices.setFetch({ enabled: false })).toEqual({ enabled: false });
    expect((await caller().notices.list()).remote.enabled).toBe(false);
    expect(await caller().notices.config()).toEqual({ enabled: false, forcedOff: true });

    await expect(caller(MEMBER).notices.list()).rejects.toThrow();
    await expect(caller(MEMBER).notices.config()).rejects.toThrow();
    await expect(caller(MEMBER).notices.markRead({ ids: ["x"] })).rejects.toThrow();
    await expect(caller(MEMBER).notices.setFetch({ enabled: true })).rejects.toThrow();
  });
});
