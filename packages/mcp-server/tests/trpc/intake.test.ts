// Intake (intake) admin tRPC procedure tests (spec 043 PR-5a / Task C5a).
// The parallel of the grooming `curator` router for the unified dashboard's Intake
// section: admin gating on every procedure, the read-only `config` aggregation +
// the `setConfig` enablement toggle round-trip, run/operation observability over
// the C1 intake decision log, and the `runNow` sweep trigger.
//
// `runs`/`runOperations` are exercised by pre-seeding the intake-runs.json
// sidecar (created by a store on the same dataDir before the server boots, then
// read back through the router). `runNow` drives a REAL end-to-end sweep against a
// local stub LLM server, proving the admin trigger files an inbox item even when
// the scheduled tick would otherwise never have started (intake default-disabled).

import http from "node:http";
import type { AddressInfo } from "node:net";
import { createLibrarianStore } from "@librarian/core";
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

async function trpcGet<T>(server: ServerHandle, path: string, input?: unknown): Promise<T> {
  const url = new URL(`${server.trpcUrl}/trpc/${path}`);
  if (input !== undefined) url.searchParams.set("input", JSON.stringify(input));
  const response = await fetch(url, { headers: { authorization: `Bearer ${server.token}` } });
  const json = (await response.json()) as TrpcOk<T> | TrpcErr;
  if (response.status >= 400 || "error" in json) {
    throw new Error(`trpc GET ${path} failed: ${JSON.stringify(json)}`);
  }
  return (json as TrpcOk<T>).result.data;
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

interface IntakeConfig {
  enabled: boolean;
  intervalMinutes: number;
  applyConfidenceThreshold: number;
  consumer: {
    providerId: string;
    providerExists: boolean;
    model: string;
    isOperational: boolean;
  };
}

interface IntakeRun {
  id: string;
  status: string;
  trigger: string;
  consolidated: number;
}
interface IntakeOperation {
  id: string;
  run_id: string;
  action: string;
  outcome: string;
}

// A minimal OpenAI-compatible chat-completions stub the curator LLM client can
// talk to. Returns one fixed `create` judgment so a sweep files exactly one memory.
function startStubLlm(): Promise<{ url: string; stop: () => Promise<void> }> {
  const judgment = JSON.stringify({
    action: "create",
    title: "Elaine",
    body: "Elaine lives in Berlin.",
    tags: [],
    rationale: "novel",
    confidence: 0.97,
  });
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: judgment } }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("tRPC intake surface", () => {
  let dataDir = "";
  beforeEach(() => {
    dataDir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dataDir);
  });

  it("every procedure is unreachable from the public (network) listener (ADR 0008 P3)", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      // Post-P3 the admin gate is the network boundary, not a token: every intake
      // procedure is served only on the internal listener and 404s on the public
      // port — even for a network agent's bearer (ADR 0008 P1/P3).
      const reads = ["intake.config", "intake.runs"];
      for (const path of reads) {
        const response = await fetch(`${server.url}/trpc/${path}`, {
          headers: { authorization: "Bearer agent-token" },
        });
        expect(response.status, path).toBe(404);
      }
      const opsUrl = new URL(`${server.url}/trpc/intake.runOperations`);
      opsUrl.searchParams.set("input", JSON.stringify({ runId: "x" }));
      expect(
        (await fetch(opsUrl, { headers: { authorization: "Bearer agent-token" } })).status,
      ).toBe(404);

      // Mutations are equally unreachable for a network agent's bearer.
      for (const path of ["intake.setConfig", "intake.runNow"]) {
        const agent = await fetch(`${server.url}/trpc/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer agent-token" },
          body: path.endsWith("setConfig") ? JSON.stringify({ enabled: true }) : undefined,
        });
        expect(agent.status, `${path} agent`).toBe(404);
      }
    } finally {
      await server.stop();
    }
  });

  it("config round-trips the intake enablement toggle (default off, authoritative)", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const before = await trpcGet<IntakeConfig>(server, "intake.config");
      expect(before.enabled).toBe(false);
      expect(before.consumer.isOperational).toBe(false);

      const enabled = await trpcPost<IntakeConfig>(server, "intake.setConfig", { enabled: true });
      expect(enabled.enabled).toBe(true);
      expect(await trpcGet<IntakeConfig>(server, "intake.config").then((c) => c.enabled)).toBe(
        true,
      );

      const disabled = await trpcPost<IntakeConfig>(server, "intake.setConfig", { enabled: false });
      expect(disabled.enabled).toBe(false);
      expect(await trpcGet<IntakeConfig>(server, "intake.config").then((c) => c.enabled)).toBe(
        false,
      );
    } finally {
      await server.stop();
    }
  });

  it("config exposes the intake sweep interval (default 5 minutes)", async () => {
    // D-3: the cadence is part of the admin config read, folded in from the core
    // readIntakeInterval pair so the dashboard's Intake control has a value to render.
    const server = await startHttpServer({ dataDir });
    try {
      const config = await trpcGet<IntakeConfig>(server, "intake.config");
      expect(config.intervalMinutes).toBe(5);
    } finally {
      await server.stop();
    }
  });

  it("setConfig persists the intake sweep interval and reads it back", async () => {
    // D-3: the admin can SET the cadence over tRPC; it round-trips through the core
    // writeIntakeInterval (the single source of truth) and is visible on the next read.
    const server = await startHttpServer({ dataDir });
    try {
      const updated = await trpcPost<IntakeConfig>(server, "intake.setConfig", {
        intervalMinutes: 15,
      });
      expect(updated.intervalMinutes).toBe(15);
      // Read-back through a fresh query proves it persisted, not just echoed.
      const reread = await trpcGet<IntakeConfig>(server, "intake.config");
      expect(reread.intervalMinutes).toBe(15);
      // The interval is independent of the enablement toggle — setting one leaves
      // the other untouched (a partial patch).
      expect(reread.enabled).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it("setConfig rejects an invalid intake interval with the core teaching error", async () => {
    // Validation defers to the core writer (writeIntakeInterval: integer >= 1). An
    // interval of 0 is rejected and surfaced as a tRPC error, not silently stored.
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.trpcUrl}/trpc/intake.setConfig`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ intervalMinutes: 0, enabled: true, applyConfidenceThreshold: 0 }),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      const json = (await response.json()) as { error?: { message?: string } };
      expect(json.error?.message).toMatch(/interval_minutes must be an integer >= 1/);

      // The rejected write did not persist — the interval stays at its default.
      const config = await trpcGet<IntakeConfig>(server, "intake.config");
      expect(config.intervalMinutes).toBe(5);
      expect(config.enabled).toBe(false);
      expect(config.applyConfidenceThreshold).toBe(0.8);
    } finally {
      await server.stop();
    }
  });

  it("the intake threshold updates the single setting shared with grooming", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      expect((await trpcGet<IntakeConfig>(server, "intake.config")).applyConfidenceThreshold).toBe(
        0.8,
      );
      const saved = await trpcPost<IntakeConfig>(server, "intake.setConfig", {
        applyConfidenceThreshold: 0,
      });
      expect(saved.applyConfidenceThreshold).toBe(0);
      expect((await trpcGet<IntakeConfig>(server, "intake.config")).applyConfidenceThreshold).toBe(
        0,
      );
      const grooming = await trpcGet<{ applyConfidenceThreshold: number }>(
        server,
        "grooming.config",
      );
      expect(grooming.applyConfidenceThreshold).toBe(0);
      await trpcPost(server, "grooming.setConfig", { applyConfidenceThreshold: 0.5 });
      expect((await trpcGet<IntakeConfig>(server, "intake.config")).applyConfidenceThreshold).toBe(
        0.5,
      );
    } finally {
      await server.stop();
    }
  });

  it("rejects an out-of-range threshold without changing intake enablement or cadence", async () => {
    const server = await startHttpServer({ dataDir });
    try {
      const response = await fetch(`${server.trpcUrl}/trpc/intake.setConfig`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
        body: JSON.stringify({
          enabled: true,
          intervalMinutes: 30,
          applyConfidenceThreshold: -0.1,
        }),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await trpcGet<IntakeConfig>(server, "intake.config")).toMatchObject({
        enabled: false,
        intervalMinutes: 5,
        applyConfidenceThreshold: 0.8,
      });
    } finally {
      await server.stop();
    }
  });

  it("runs + runOperations expose the intake decision log through the router", async () => {
    // Seed the sidecar log via a store on the same dataDir BEFORE the server boots.
    const seed = createLibrarianStore({ dataDir });
    const run = seed.createIntakeRun({ trigger: "manual" });
    seed.startIntakeRun(run.id);
    seed.recordIntakeOperation({
      run_id: run.id,
      action: "create",
      outcome: "applied",
      confidence: 0.97,
      rationale: "novel",
      source_id: "inbox-1",
      target_id: "mem_1",
    });
    seed.completeIntakeRun(run.id, { summary: "consolidated 1", consolidated: 1 });
    seed.close();

    const server = await startHttpServer({ dataDir });
    try {
      const runs = await trpcGet<IntakeRun[]>(server, "intake.runs");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.id).toBe(run.id);
      expect(runs[0]?.consolidated).toBe(1);
      expect(runs[0]?.status).toBe("completed");

      const ops = await trpcGet<IntakeOperation[]>(server, "intake.runOperations", {
        runId: run.id,
      });
      expect(ops).toHaveLength(1);
      expect(ops[0]?.action).toBe("create");
      expect(ops[0]?.outcome).toBe("applied");

      // A limit of 0-rows query path still works (no runs for an unknown id).
      const none = await trpcGet<IntakeOperation[]>(server, "intake.runOperations", {
        runId: "does-not-exist",
      });
      expect(none).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("runNow drives a real sweep that files an inbox item (even though intake ships disabled)", async () => {
    // A real, decryptable provider token requires the master key. Assembled at
    // runtime so no key-shaped literal lands in committed source.
    const secretKey = "0123456789abcdef".repeat(4);
    const stub = await startStubLlm();
    // Seed one inbox item via a store on the same dataDir before boot.
    const seed = createLibrarianStore({ dataDir, secretKey: Buffer.from(secretKey, "hex") });
    seed.submitToInbox("Elaine moved to Berlin.");
    seed.close();

    const server = await startHttpServer({ dataDir, secretKey });
    try {
      // Configure the intake consumer to point at the stub LLM, and enable intake.
      const provider = await trpcPost<{ id: string }>(server, "llm.addProvider", {
        name: "stub",
        endpoint: stub.url,
        token: "dummy-stub-token",
      });
      await trpcPost(server, "llm.setConsumerConfig", {
        consumer: "intake",
        providerId: provider.id,
        model: "gpt-x",
      });
      await trpcPost(server, "intake.setConfig", { enabled: true });

      const result = await trpcPost<{ ran: boolean; summary?: { consolidated: number } }>(
        server,
        "intake.runNow",
      );
      expect(result.ran).toBe(true);
      expect(result.summary?.consolidated).toBe(1);

      // The sweep wrote a run row queryable through the router.
      const runs = await trpcGet<IntakeRun[]>(server, "intake.runs");
      expect(runs.length).toBeGreaterThanOrEqual(1);
      expect(runs[0]?.consolidated).toBe(1);
    } finally {
      await server.stop();
      await stub.stop();
    }
  });

  it("runNow bypasses the enable gate but still surfaces incomplete_config when no LLM is set", async () => {
    // Run-now is an admin override (spec 045 D-4): it no longer refuses a disabled
    // job. With no LLM configured it bypasses the enable gate and surfaces the next
    // gate's reason (incomplete_config) — the dashboard shows that, never "disabled".
    const server = await startHttpServer({ dataDir });
    try {
      const result = await trpcPost<{ ran: boolean; reason?: string }>(server, "intake.runNow");
      expect(result).toEqual({ ran: false, reason: "incomplete_config" });
    } finally {
      await server.stop();
    }
  });

  it("runNow sweeps a DISABLED but fully-configured intake job (admin override, spec 045 D-4)", async () => {
    // The behaviour change: intake stays disabled, yet an admin run-now files a
    // queued item end-to-end (the scheduled tick would never have run while disabled).
    const secretKey = "0123456789abcdef".repeat(4);
    const stub = await startStubLlm();
    const seed = createLibrarianStore({ dataDir, secretKey: Buffer.from(secretKey, "hex") });
    seed.submitToInbox("Elaine moved to Berlin.");
    seed.close();

    const server = await startHttpServer({ dataDir, secretKey });
    try {
      const provider = await trpcPost<{ id: string }>(server, "llm.addProvider", {
        name: "stub",
        endpoint: stub.url,
        token: "dummy-stub-token",
      });
      await trpcPost(server, "llm.setConsumerConfig", {
        consumer: "intake",
        providerId: provider.id,
        model: "gpt-x",
      });
      // Intake is left DISABLED (default) — run-now overrides it.
      const config = await trpcGet<IntakeConfig>(server, "intake.config");
      expect(config.enabled).toBe(false);

      const result = await trpcPost<{ ran: boolean; summary?: { consolidated: number } }>(
        server,
        "intake.runNow",
      );
      expect(result.ran).toBe(true);
      expect(result.summary?.consolidated).toBe(1);
    } finally {
      await server.stop();
      await stub.stop();
    }
  });
});
