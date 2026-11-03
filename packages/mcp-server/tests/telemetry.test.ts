// Anonymous usage stats (spec 085): what is sent, when, and what stops it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type Principal,
  createInertBootstrapClaimHandle,
  createLibrarianStore,
} from "@librarian/core";
import { appRouter, createCallerFactory } from "@librarian/mcp-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INSTALL_CREATED_AT_KEY } from "../dist/notices.js";
import {
  TELEMETRY_DISCLOSED_AT_KEY,
  TELEMETRY_ENABLED_KEY,
  TELEMETRY_INSTALL_ID_KEY,
  TELEMETRY_LAST_SENT_AT_KEY,
  blocker,
  buildPayload,
  forcedOff,
  harnessFamilies,
  markDisclosed,
  sendIfDue,
  telemetryUrl,
} from "../dist/telemetry.js";
import type { TrpcContext } from "../dist/trpc/context.js";

const createCaller = createCallerFactory(appRouter);
const ADMIN: Principal = { kind: "admin", actorId: "admin", roles: ["admin"], tokenId: "t1" };
const MEMBER: Principal = { kind: "member", actorId: "m", roles: ["member"], tokenId: "t2" };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let dataDir = "";
let store: LibrarianStore;
const savedEnv = { ...process.env };

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

/** An install set up and disclosed at `t0`. */
function setUp(t0: number): void {
  store.setSetting(INSTALL_CREATED_AT_KEY, new Date(t0).toISOString());
  markDisclosed(store, new Date(t0));
}

const ok = () => vi.fn(async () => new Response("{}", { status: 202 }));
const env = {} as NodeJS.ProcessEnv;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-telemetry-"));
  store = createLibrarianStore({ dataDir });
  delete process.env.DO_NOT_TRACK;
  delete process.env.LIBRARIAN_TELEMETRY;
  delete process.env.LIBRARIAN_DISABLE_NOTICES;
});

afterEach(() => {
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

describe("the payload", () => {
  it("holds only the documented fields, with no counts, names or paths", () => {
    const payload = buildPayload(store);
    expect(Object.keys(payload).sort()).toEqual(
      [
        "arch",
        "features",
        "harnesses",
        "installId",
        "memories",
        "os",
        "runtime",
        "schema",
        "version",
      ].sort(),
    );
    expect(payload.memories).toBe("<100");
    expect(Object.keys(payload.features).sort()).toEqual(["capture", "grooming", "intake"]);
    expect(payload.installId).toMatch(/^[0-9a-f-]{36}$/);
    const text = JSON.stringify(payload);
    expect(text).not.toContain(dataDir);
    expect(text).not.toContain(os.hostname());
  });

  it("keeps the same random install id until it is reset", async () => {
    const first = buildPayload(store).installId;
    expect(buildPayload(store).installId).toBe(first);
    const after = await caller().telemetry.resetInstallId();
    expect(after.preview.installId).not.toBe(first);
    expect(store.getSetting(TELEMETRY_INSTALL_ID_KEY)).toBe(after.preview.installId);
  });

  it("reports only known harness families, never other agent names", () => {
    expect(
      harnessFamilies([
        "claude-code",
        "Codex CLI",
        "opencode",
        "hermes",
        "pi",
        "jims-secret-bot",
        7,
      ]),
    ).toEqual(["claude", "codex", "opencode", "hermes", "pi"]);
    expect(harnessFamilies(["pipeline", "api-client"])).toEqual([]);
  });
});

describe("when a ping may go", () => {
  const t0 = Date.parse("2026-11-04T09:00:00Z");

  it("not before the disclosure has reached the dashboard", () => {
    store.setSetting(INSTALL_CREATED_AT_KEY, new Date(t0 - 30 * DAY).toISOString());
    expect(blocker(store, t0, env)).toEqual({ kind: "not_disclosed" });
  });

  it("not until 24 hours after both install and disclosure", () => {
    setUp(t0);
    expect(blocker(store, t0 + DAY - 1, env)).toMatchObject({ kind: "waiting" });
    expect(blocker(store, t0 + DAY, env)).toBeNull();
  });

  it("an old install still waits 24 hours from the disclosure", () => {
    store.setSetting(INSTALL_CREATED_AT_KEY, new Date(t0 - 300 * DAY).toISOString());
    markDisclosed(store, new Date(t0));
    expect(blocker(store, t0 + HOUR, env)).toMatchObject({ kind: "waiting" });
  });

  it("only the first disclosure counts", () => {
    markDisclosed(store, new Date(t0));
    markDisclosed(store, new Date(t0 + 5 * DAY));
    expect(store.getSetting(TELEMETRY_DISCLOSED_AT_KEY)).toBe(new Date(t0).toISOString());
  });

  it("weekly after the last ping", async () => {
    setUp(t0);
    const fetchImpl = ok();
    expect(await sendIfDue(store, { now: new Date(t0 + DAY), env, fetchImpl })).toMatchObject({
      sent: true,
    });
    expect(await sendIfDue(store, { now: new Date(t0 + 7 * DAY), env, fetchImpl })).toMatchObject({
      sent: false,
      reason: "waiting",
    });
    expect(await sendIfDue(store, { now: new Date(t0 + 8 * DAY), env, fetchImpl })).toMatchObject({
      sent: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("never when switched off, or forced off by DO_NOT_TRACK or LIBRARIAN_TELEMETRY", async () => {
    setUp(t0);
    const fetchImpl = ok();
    const later = new Date(t0 + 2 * DAY);
    store.setSetting(TELEMETRY_ENABLED_KEY, "false");
    expect(await sendIfDue(store, { now: later, env, fetchImpl })).toEqual({
      sent: false,
      reason: "switched_off",
    });
    store.setSetting(TELEMETRY_ENABLED_KEY, "true");
    for (const forced of [{ DO_NOT_TRACK: "1" }, { LIBRARIAN_TELEMETRY: "off" }]) {
      expect(
        await sendIfDue(store, { now: later, env: forced as NodeJS.ProcessEnv, fetchImpl }),
      ).toEqual({ sent: false, reason: "forced_off" });
    }
    expect(forcedOff({ DO_NOT_TRACK: "0" } as NodeJS.ProcessEnv)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("sending", () => {
  const t0 = Date.parse("2026-11-04T09:00:00Z");

  it("POSTs exactly the payload, records it, and never throws", async () => {
    setUp(t0);
    const fetchImpl = ok();
    await sendIfDue(store, { now: new Date(t0 + DAY), env, fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(telemetryUrl(env));
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      "user-agent": "the-librarian",
    });
    const status = await caller().telemetry.status();
    expect(status.lastPayload).toEqual(JSON.parse(init.body as string));
    expect(status.lastSentAt).toBe(new Date(t0 + DAY).toISOString());

    store.deleteSetting(TELEMETRY_LAST_SENT_AT_KEY);
    const boom = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await sendIfDue(store, { now: new Date(t0 + 30 * DAY), env, fetchImpl: boom })).toEqual({
      sent: false,
      reason: "network_error",
    });
  });

  it("a failed ping isn't recorded, so it is retried", async () => {
    setUp(t0);
    const bad = vi.fn(async () => new Response("", { status: 500 }));
    expect(await sendIfDue(store, { now: new Date(t0 + DAY), env, fetchImpl: bad })).toEqual({
      sent: false,
      reason: "http_500",
    });
    expect(store.getSetting(TELEMETRY_LAST_SENT_AT_KEY)).toBeNull();
  });
});

describe("telemetry tRPC and the disclosure notice", () => {
  it("serving the notices list shows the disclosure and starts the wait", async () => {
    process.env.LIBRARIAN_DISABLE_NOTICES = "true";
    expect(store.getSetting(TELEMETRY_DISCLOSED_AT_KEY)).toBeNull();
    const list = await caller().notices.list();
    expect(list.notices.map((n) => n.id)).toContain("local:telemetry");
    expect(store.getSetting(TELEMETRY_DISCLOSED_AT_KEY)).not.toBeNull();
  });

  it("no disclosure notice, and no disclosure, when stats are off", async () => {
    process.env.LIBRARIAN_DISABLE_NOTICES = "true";
    process.env.DO_NOT_TRACK = "1";
    const list = await caller().notices.list();
    expect(list.notices.map((n) => n.id)).not.toContain("local:telemetry");
    expect(store.getSetting(TELEMETRY_DISCLOSED_AT_KEY)).toBeNull();
  });

  it("status and the switch, for admins only", async () => {
    const status = await caller().telemetry.status();
    expect(status).toMatchObject({ enabled: true, forcedOff: null, intervalDays: 7 });
    expect(status.blocker).toEqual({ kind: "not_disclosed" });
    const off = await caller().telemetry.setEnabled({ enabled: false });
    expect(off.enabled).toBe(false);
    expect(off.blocker).toEqual({ kind: "switched_off" });
    await expect(caller(MEMBER).telemetry.status()).rejects.toThrow();
    await expect(caller(MEMBER).telemetry.setEnabled({ enabled: true })).rejects.toThrow();
    await expect(caller(MEMBER).telemetry.resetInstallId()).rejects.toThrow();
  });
});
