// The Logs page's admin surface (spec 081): the read-log switch, and one paged view plus one
// download over every log the Librarian keeps.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type Principal,
  READ_LOG_ENABLED_KEY,
  createInertBootstrapClaimHandle,
  createLibrarianStore,
  markFailed,
  recordPending,
} from "@librarian/core";
import { appRouter, createCallerFactory } from "@librarian/mcp-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TrpcContext } from "../../dist/trpc/context.js";

const createCaller = createCallerFactory(appRouter);

const ADMIN: Principal = {
  kind: "admin",
  actorId: "dashboard-admin",
  roles: ["admin"],
  tokenId: "tok-admin",
};
const MEMBER: Principal = {
  kind: "member",
  actorId: "member:alice",
  roles: ["member"],
  tokenId: "tok-member",
};

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

async function recordRecalls(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await store.recordRead({
      kind: "recall",
      mode: "search",
      query: `query ${i}`,
      returnedIds: i === 0 ? [] : ["mem_a"],
      returnedCount: i === 0 ? 0 : 1,
      excerpts: true,
      resultChars: 100,
      actorId: "claude-code",
    });
  }
  await store.flushReads();
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-logs-"));
  store = createLibrarianStore({ dataDir, readLog: { armed: true }, refusalLog: { armed: true } });
});

afterEach(() => {
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("logs: the read-log switch", () => {
  it("is off by default and turns recording on and off without a restart", async () => {
    expect(await caller().logs.readLogConfig()).toEqual({ enabled: false, recording: false });
    expect(await caller().logs.setReadLog({ enabled: true })).toEqual({
      enabled: true,
      recording: true,
    });
    expect(store.getSetting(READ_LOG_ENABLED_KEY)).toBe("true");
    await recordRecalls(1);
    await caller().logs.setReadLog({ enabled: false });
    await recordRecalls(1);
    expect((await caller().logs.page({ source: "reads" })).total).toBe(1);
  });

  it("is admin-only", async () => {
    await expect(caller(MEMBER).logs.setReadLog({ enabled: true })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(caller(MEMBER).logs.page({ source: "reads" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(caller(MEMBER).logs.export({ source: "reads" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(store.getSetting(READ_LOG_ENABLED_KEY)).toBeNull();
  });
});

describe("logs.page", () => {
  it("pages the read log newest first, flagging empty recalls", async () => {
    store.setSetting(READ_LOG_ENABLED_KEY, "true");
    await recordRecalls(5);
    const first = await caller().logs.page({ source: "reads", limit: 3 });
    expect(first.total).toBe(5);
    expect(first.rows.map((row) => row.title)).toEqual([
      "Recall “query 4”: 1 result",
      "Recall “query 3”: 1 result",
      "Recall “query 2”: 1 result",
    ]);
    expect(first.nextCursor).toBe("3");
    const second = await caller().logs.page({ source: "reads", limit: 3, cursor: "3" });
    expect(second.rows.map((row) => row.tone)).toEqual(["ok", "warn"]);
    expect(second.rows[1]?.title).toBe("Recall “query 0”: 0 results");
    expect(second.rows[1]?.raw).toMatchObject({ kind: "recall", query: "query 0" });
    expect(second.nextCursor).toBeNull();
  });

  it("shows the admin's own refused calls in the refusal log", async () => {
    await expect(caller(MEMBER).logs.page({ source: "reads" })).rejects.toThrow();
    await store.flushRefusals();
    const page = await caller().logs.page({ source: "refusals" });
    expect(page.rows[0]).toMatchObject({ tone: "error" });
    expect(page.rows[0]?.detail).toContain("logs.page");
  });

  it("shows captures, failures first-class", async () => {
    const id = recordPending(store, { source: "https://example.com/post", via: "extension" });
    markFailed(store, id, "fetch timed out");
    const page = await caller().logs.page({ source: "captures" });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      title: "Failed: https://example.com/post",
      tone: "error",
    });
    expect(page.rows[0]?.detail).toContain("fetch timed out");
  });

  it("walks the vault history by commit cursor", async () => {
    for (let i = 0; i < 3; i += 1) {
      store.createMemory({ agent_id: "codex", title: `Fact ${i}`, body: `body ${i}` });
    }
    const first = await caller().logs.page({ source: "vault", limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).toBe(first.rows[1]?.id);
    const second = await caller().logs.page({
      source: "vault",
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.rows.length).toBeGreaterThan(0);
    expect(second.rows.map((row) => row.id)).not.toContain(first.rows[0]?.id);
  });

  it("answers empty sources with no rows rather than an error", async () => {
    for (const source of ["intake", "curation", "backups", "captures", "reads"] as const) {
      const page = await caller().logs.page({ source });
      expect(page.rows).toEqual([]);
      expect(page.nextCursor).toBeNull();
    }
  });
});

describe("logs.export", () => {
  it("returns every retained read, oldest first, as stored", async () => {
    store.setSetting(READ_LOG_ENABLED_KEY, "true");
    await recordRecalls(3);
    const exported = await caller().logs.export({ source: "reads" });
    expect(exported.truncated).toBe(false);
    expect(exported.rows.map((row) => (row as { query: string }).query)).toEqual([
      "query 0",
      "query 1",
      "query 2",
    ]);
  });

  it("returns the whole vault history, oldest first", async () => {
    for (let i = 0; i < 3; i += 1) {
      store.createMemory({ agent_id: "codex", title: `Fact ${i}`, body: `body ${i}` });
    }
    const page = await caller().logs.page({ source: "vault", limit: 200 });
    const exported = await caller().logs.export({ source: "vault" });
    expect(exported.rows.map((row) => (row as { hash: string }).hash)).toEqual(
      page.rows.map((row) => row.id).reverse(),
    );
  });
});
