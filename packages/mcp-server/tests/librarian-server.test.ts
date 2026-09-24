// createLibrarianServer composition root — handle shape, scheduler lifecycle, and
// the assembled-server e2e (spec 060 T2, SC 1 + SC 3 + seam wiring).
//
// SC 1 (handle shape) is asserted against the real factory on a temp data dir,
// without binding listeners (start() is never called). SC 3 (scheduler
// semantics, BOTH directions) is asserted against the load-bearing ordering
// functions the factory's handle delegates to — startRuntime / stopRuntime —
// driven with instrumented fakes:
//
//   - start(): the internal listener binds first, then the public one, then
//     every scheduler starts exactly ONCE, inside the public listen callback
//     (i.e. after the public listener is accepting) — same as today's boot.
//   - stop(): schedulers stopped → store.close() → both listeners closed, in
//     that order. The order is load-bearing because a scheduler tick writes
//     through the store. Both racing-tick tests DRIVE THE REAL stopRuntime (not a
//     hand-scripted sequence): the correct-order case proves a tick racing the
//     store-close is a no-op (the scheduler was halted first), and a deliberately
//     broken "won't-stop" scheduler proves the hazard is real (a still-live tick
//     writing through the just-closed store throws) — so the stop-before-close
//     order is what saves it.
//
// The FACTORY SEAM E2E drives the whole assembled `createLibrarianServer` over real
// sockets (ephemeral ports via `port: 0`): a single plugin carrying a tool, a tRPC
// router, and two routes (public + internal) is probed through the real listeners
// exposed on the handle's `internals`, and the scheduler lifecycle is pinned through
// `internals.schedulers` across construct → start → stop. This is the ONE test that
// fails if the factory stops threading the merged registries/routes into its
// createHttpServer calls (every other seam suite injects below that seam).
//
// Imports the compiled artifact (../dist), like per-surface-role.test.ts.

import type { AddressInfo } from "node:net";
import { type SerialScheduler, writeChronicleConfig } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../test/helpers.js";
import type { PluginRoute } from "../dist/http/routes.js";
import {
  type LibrarianServerOptions,
  type ServerRuntime,
  createLibrarianServer,
  startRuntime,
  stopRuntime,
} from "../dist/librarian-server.js";
import type { ToolDefinition } from "../dist/mcp/tool.js";
import type { LibrarianPlugin } from "../dist/plugin.js";
import { publicProcedure, router } from "../dist/trpc/trpc.js";

// An instrumented store: close() records + marks it closed; write() throws once
// closed — modelling a scheduler tick that lands on a store closed too early.
interface FakeStore {
  flushRefusals(): Promise<void>;
  close(): void;
  write(): void;
}

function makeStore(order: string[], onClose?: () => void): FakeStore {
  let closed = false;
  return {
    flushRefusals() {
      order.push("store.flushRefusals");
      return Promise.resolve();
    },
    close() {
      order.push("store.close");
      closed = true;
      // Fire a caller-supplied hook from INSIDE the close — used to model a scheduler
      // tick racing the shutdown at the worst moment (right as the store shuts). If the
      // tick's scheduler is still live it will write() through the now-closed store.
      onClose?.();
    },
    write() {
      if (closed) throw new Error("wrote through a closed store");
    },
  };
}

// An instrumented scheduler: records start/stop, and tick() writes through the
// store ONLY while live — so a tick after stop() is a no-op, but a tick while
// still live against a closed store throws (the hazard the order guards against).
interface FakeScheduler extends SerialScheduler {
  tick(): void;
}

function makeScheduler(
  name: string,
  order: string[],
  store: FakeStore,
  // A deliberately broken scheduler: stop() records but does NOT halt it (live stays
  // true). Models the mis-ordered-shutdown hazard — a scheduler still producing ticks
  // when the store is torn down — driven through the REAL stopRuntime.
  opts: { ignoreStop?: boolean } = {},
): FakeScheduler {
  let live = false;
  let started = false;
  return {
    start() {
      order.push(`${name}.start`);
      live = true;
      started = true;
    },
    stop() {
      order.push(`${name}.stop`);
      started = false;
      if (!opts.ignoreStop) live = false;
    },
    isRunning: () => false,
    isStarted: () => started,
    runNow: () => Promise.resolve(),
    tick() {
      if (live) store.write();
    },
  };
}

// A minimal instrumented listener: listen() records + fires its callback (the
// listener is "accepting"); close() records + reports done.
interface FakeListener {
  listen(port: number, host: string, onListening: () => void): void;
  close(callback: (err?: Error) => void): void;
}

function makeListener(name: string, order: string[]): FakeListener {
  return {
    listen(_port, _host, onListening) {
      order.push(`${name}.listen`);
      onListening();
    },
    close(callback) {
      order.push(`${name}.close`);
      callback();
    },
  };
}

function makeRuntime(
  order: string[],
  schedulers: FakeScheduler[],
  store: FakeStore,
): ServerRuntime {
  return {
    schedulers,
    store,
    drainCorrectionWork: async () => {
      order.push("correction.drain");
    },
    publicServer: makeListener("public", order),
    internalServer: makeListener("internal", order),
    publicBind: { port: 3838, host: "127.0.0.1" },
    internalBind: { port: 3840, host: "127.0.0.1" },
    onInternalListening: () => order.push("internal.banner"),
    onPublicListening: () => order.push("public.banner"),
  };
}

const SCHEDULER_NAMES = [
  "backup",
  "intake",
  "grooming",
  "chronicle",
  "transcript",
  "correction",
] as const;

// Base options with every configurable poller OFF; targeted correction recovery
// remains registered so durable markers are scanned on startup.
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
    chroniclePollMs: 0,
    transcriptSweepTickMs: 0,
  };
}

describe("createLibrarianServer — handle shape (spec 060 SC 1)", () => {
  it("returns a { start, stop, store, internals } handle", () => {
    const dataDir = makeTempDir();
    try {
      const server = createLibrarianServer(baseOptions(dataDir));
      try {
        expect(typeof server.start).toBe("function");
        expect(typeof server.stop).toBe("function");
        expect(server.store).toBeDefined();
        // Correction recovery is always registered, even with other pollers off.
        expect(server.internals.schedulers).toHaveLength(1);
        expect(server.internals.schedulers[0]?.isStarted()).toBe(false);
      } finally {
        server.store.close();
      }
    } finally {
      cleanupTempDir(dataDir);
    }
  });

  it("internals.schedulers lists exactly the enabled schedulers", () => {
    const dataDir = makeTempDir();
    try {
      // Only the backup timer is > 0 ⇒ backup plus correction recovery.
      const server = createLibrarianServer({ ...baseOptions(dataDir), backupTickMs: 60_000 });
      try {
        expect(server.internals.schedulers.length).toBe(2);
      } finally {
        server.store.close();
      }
    } finally {
      cleanupTempDir(dataDir);
    }
  });

  it("the assembled Chronicle scheduler runs the real due-check and writes a weekly entry", async () => {
    const dataDir = makeTempDir();
    try {
      const server = createLibrarianServer({
        ...baseOptions(dataDir),
        chroniclePollMs: 60_000,
      });
      try {
        writeChronicleConfig(server.store, {
          enabled: true,
          dayOfWeek: "monday",
          scheduleTime: "00:00",
        });
        expect(server.internals.schedulers).toHaveLength(2);

        await server.internals.schedulers[0]!.runNow();

        expect(server.store.listChronicleRuns()[0]).toMatchObject({
          trigger: "schedule",
          status: "completed",
        });
        expect(server.store.listChronicleRuns()[0]?.path).toMatch(
          /^references\/chronicle\/\d{4}-W\d{2}\.md$/,
        );
      } finally {
        server.store.close();
      }
    } finally {
      cleanupTempDir(dataDir);
    }
  });
});

describe("server lifecycle order (spec 060 SC 3)", () => {
  it("start() binds internal, then public, then starts every scheduler exactly once after the public listener is accepting", () => {
    const order: string[] = [];
    const store = makeStore(order);
    const schedulers = SCHEDULER_NAMES.map((name) => makeScheduler(name, order, store));

    startRuntime(makeRuntime(order, schedulers, store));

    expect(order).toEqual([
      "internal.listen",
      "internal.banner",
      "public.listen",
      "backup.start",
      "intake.start",
      "grooming.start",
      "chronicle.start",
      "transcript.start",
      "correction.start",
      "public.banner",
    ]);
    // Exactly once each: a double start(), or a start outside the public listen
    // callback, would show up as a duplicate or a misordered entry above.
    for (const name of SCHEDULER_NAMES) {
      expect(order.filter((entry) => entry === `${name}.start`).length).toBe(1);
    }
  });

  it("stop() stops every scheduler, THEN closes the store, THEN closes both listeners", async () => {
    const order: string[] = [];
    const store = makeStore(order);
    const schedulers = SCHEDULER_NAMES.map((name) => makeScheduler(name, order, store));
    const runtime = makeRuntime(order, schedulers, store);
    // Bring them up first so a stray post-close tick would be a real hazard.
    for (const scheduler of schedulers) scheduler.start();
    order.length = 0;

    await stopRuntime(runtime);

    expect(order).toEqual([
      "backup.stop",
      "intake.stop",
      "grooming.stop",
      "chronicle.stop",
      "transcript.stop",
      "correction.stop",
      "correction.drain",
      "store.flushRefusals",
      "store.close",
      "public.close",
      "internal.close",
    ]);
  });

  it("the REAL stopRuntime halts schedulers before the store closes, so a tick racing the close writes nothing", async () => {
    const order: string[] = [];
    // The store's close() fires a racing scheduler tick from INSIDE the stop window
    // (a queued timer callback landing mid-shutdown). Real stopRuntime is the machinery
    // under test — not a hand-scripted sequence.
    const racer: { scheduler?: FakeScheduler } = {};
    const store = makeStore(order, () => racer.scheduler?.tick());
    const scheduler = makeScheduler("intake", order, store);
    racer.scheduler = scheduler;
    scheduler.start(); // live, as it is at runtime
    const runtime = makeRuntime(order, [scheduler], store);

    // stopRuntime stops the scheduler BEFORE store.close(), so the racing tick fired
    // during the close finds the scheduler halted (no write) — it resolves cleanly.
    await expect(stopRuntime(runtime)).resolves.toBeUndefined();
    // And the recorded order proves the load-bearing sequence the safety relies on.
    expect(order.indexOf("intake.stop")).toBeLessThan(order.indexOf("store.close"));
  });

  it("a scheduler that fails to halt writes through the closed store — proving the stop-before-close order is load-bearing", async () => {
    const order: string[] = [];
    // A deliberately mis-ordered harness: the scheduler's stop() does NOT halt it, so
    // when the REAL stopRuntime reaches store.close() the still-live tick (fired from
    // inside the close) writes through the just-closed store and throws. stopRuntime
    // reaches store.close(). This is the negative that gives the positive test
    // teeth: halting the scheduler first is exactly what averts this.
    const racer: { scheduler?: FakeScheduler } = {};
    const store = makeStore(order, () => racer.scheduler?.tick());
    const scheduler = makeScheduler("intake", order, store, { ignoreStop: true });
    racer.scheduler = scheduler;
    scheduler.start();
    const runtime = makeRuntime(order, [scheduler], store);

    await expect(stopRuntime(runtime)).rejects.toThrow("wrote through a closed store");
  });
});

// Wait until an http.Server has bound (a `port: 0` bind is asynchronous) and return
// its OS-assigned port. Resolves immediately if already listening.
function listeningPort(server: import("node:http").Server): Promise<number> {
  const portOf = (): number => (server.address() as AddressInfo).port;
  if (server.listening) return Promise.resolve(portOf());
  return new Promise((resolve) => server.once("listening", () => resolve(portOf())));
}

interface ToolsList {
  result: { tools: { name: string }[] };
}
interface TrpcData<T> {
  result: { data: T };
}

describe("createLibrarianServer — factory seam e2e (spec 060 seam wiring)", () => {
  it("threads a plugin's tool + tRPC router + both routes into the assembled listeners, and pins scheduler lifecycle across start/stop", async () => {
    const dataDir = makeTempDir();

    // ONE plugin carrying every registration seam: an MCP tool, a tRPC router, a public
    // route (auth: "none") and an internal route. If the factory stops threading any of
    // these into its createHttpServer calls, the matching probe below flips.
    const tool: ToolDefinition = {
      name: "e2e_ping",
      description: "A demo e2e tool.",
      inputSchema: { type: "object", properties: {} },
      handler: () => ({ content: [{ type: "text", text: "pong" }] }),
    };
    const echoRouter = router({
      hello: publicProcedure.query(() => ({ hi: "e2e" as const })),
    });
    const publicRoute: PluginRoute = {
      path: "/e2e/public",
      method: "GET",
      surface: "public",
      auth: "none",
      handler: (ctx) => {
        ctx.res.writeHead(200, { "content-type": "application/json" });
        ctx.res.end(JSON.stringify({ ok: "public" }));
      },
    };
    const internalRoute: PluginRoute = {
      path: "/e2e/internal",
      method: "GET",
      surface: "internal",
      auth: "none",
      handler: (ctx) => {
        ctx.res.writeHead(200, { "content-type": "application/json" });
        ctx.res.end(JSON.stringify({ ok: "internal" }));
      },
    };
    const plugin: LibrarianPlugin = {
      name: "e2e",
      tools: [tool],
      trpcRouters: { echo: echoRouter },
      routes: [publicRoute, internalRoute],
    };

    // One configurable scheduler enabled (a 60s poll, so it never actually fires during the test),
    // plus the always-registered correction recovery scheduler.
    const server = createLibrarianServer({
      ...baseOptions(dataDir),
      backupTickMs: 60_000,
      plugins: [plugin],
    });

    // BEFORE start(): the scheduler pair exists but is not started.
    expect(server.internals.schedulers).toHaveLength(2);
    expect(server.internals.schedulers[0]?.isStarted()).toBe(false);

    let stopped = false;
    try {
      server.start();
      // Binding is asynchronous (port 0), and startRuntime starts the schedulers inside
      // the PUBLIC listener's listen callback — so wait for the listeners to accept.
      const publicPort = await listeningPort(server.internals.publicServer);
      const internalPort = await listeningPort(server.internals.internalServer);
      const publicBase = `http://127.0.0.1:${publicPort}`;
      const internalBase = `http://127.0.0.1:${internalPort}`;

      // AFTER start() + the public listener accepting: the scheduler is running (its
      // start() runs in the bind callback, mirroring boot — no tick before accept).
      expect(server.internals.schedulers[0]?.isStarted()).toBe(true);

      // (1) The plugin TOOL lists via the PUBLIC /mcp (agent role via the loopback
      // no-auth bypass) — proof the merged tool registry reached the public listener.
      const listRes = await fetch(`${publicBase}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as ToolsList;
      expect(listBody.result.tools.map((t) => t.name)).toContain("e2e_ping");

      // (2) The plugin tRPC PROCEDURE answers on the INTERNAL listener at its namespaced
      // path, and 404s on the public one (the admin surface is internal-only).
      const trpcRes = await fetch(`${internalBase}/trpc/e2e.echo.hello`);
      expect(trpcRes.status).toBe(200);
      const trpcBody = (await trpcRes.json()) as TrpcData<{ hi: string }>;
      expect(trpcBody.result.data.hi).toBe("e2e");
      expect((await fetch(`${publicBase}/trpc/e2e.echo.hello`)).status).toBe(404);

      // (3) Each plugin ROUTE answers on its declared surface and 404s on the other.
      expect((await fetch(`${publicBase}/e2e/public`)).status).toBe(200);
      expect((await fetch(`${internalBase}/e2e/public`)).status).toBe(404);
      expect((await fetch(`${internalBase}/e2e/internal`)).status).toBe(200);
      expect((await fetch(`${publicBase}/e2e/internal`)).status).toBe(404);

      // stop() runs the real shutdown (schedulers → store.close() → both listeners).
      await server.stop();
      stopped = true;
      // AFTER stop(): the scheduler is halted.
      expect(server.internals.schedulers[0]?.isStarted()).toBe(false);
    } finally {
      // Guarantee the listeners + store are released even if an assertion threw before
      // stop() ran; stop() closes the store exactly once (double-close would throw).
      if (!stopped) {
        try {
          await server.stop();
        } catch {
          /* best-effort teardown */
        }
      }
      cleanupTempDir(dataDir);
    }
  });
});

describe("HTTP flagged-memory correction wake", () => {
  it("wakes the durable correction worker after flag_memory persists its marker", async () => {
    const dataDir = makeTempDir();
    const server = createLibrarianServer(baseOptions(dataDir));
    const { memory } = server.store.createMemory({
      agent_id: "claude",
      title: "Old fact",
      body: "This fact is outdated.",
    });

    try {
      server.start();
      const publicPort = await listeningPort(server.internals.publicServer);
      const response = await fetch(`http://127.0.0.1:${publicPort}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "flag_memory",
            arguments: { memory_id: memory.id, reason: "this is outdated" },
          },
        }),
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        result: { content: { text: string }[] };
      };
      expect(result.result.content[0]?.text).toMatch(/targeted correction review was queued/i);

      await expect
        .poll(() => server.store.getMemory(memory.id)?.correction_work?.at(-1)?.status)
        .toBe("manual_review");
      expect(server.store.getMemory(memory.id)?.correction_work?.at(-1)).toMatchObject({
        reason_code: "grooming_disabled",
      });
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
