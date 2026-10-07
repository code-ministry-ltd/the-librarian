// Curator worker (spec §10 pipeline + §12/§14) — end-to-end over a real store
// with an INJECTED fake LLM client (no network). Pins that a run threads
// gather → prepass → prompt → parse → validate → apply and records its lifecycle.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type LlmClient,
  type LlmCompletion,
  LlmClientError,
  createLibrarianStore,
  runCuration,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface Scope {
  store: LibrarianStore;
  dataDir: string;
}

let s: Scope | null = null;

beforeEach(() => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-worker-"));
  s = { store: createLibrarianStore({ dataDir }), dataDir };
});
afterEach(() => {
  if (!s) return;
  try {
    s.store.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(s.dataDir, { recursive: true, force: true });
  s = null;
});

function seed(over: Record<string, unknown> = {}) {
  return s!.store.createMemory({
    agent_id: "agent-a",
    title: "title",
    body: "body",
    visibility: "common",
    confidence: "working",
    ...over,
  }).memory;
}

/** A fake LLM client returning a canned completion. */
function fakeClient(content: string, usage?: LlmCompletion["usage"]): LlmClient {
  return { complete: async () => ({ content, model: "gpt-x", usage: usage ?? null }) };
}

const SLICE = { kind: "common_global" as const };

/** runCuration, asserting it wasn't skipped (the common case in these tests). */
async function runOk(
  ...args: Parameters<typeof runCuration>
): Promise<NonNullable<Awaited<ReturnType<typeof runCuration>>>> {
  const run = await runCuration(...args);
  if (!run) throw new Error("expected a run, got an input-hash skip");
  return run;
}

function options(llmClient: LlmClient, confidenceThreshold = 0.8) {
  return {
    store: s!.store,
    llmClient,
    trigger: "manual",
    actorId: "system-memory-curator",
    confidenceThreshold,
    model: { provider: "openai", name: "gpt-x" },
  };
}

describe("runCuration — happy path", () => {
  it("threads the pipeline and routes a duplicate archive to the flag queue (D13)", async () => {
    const dupA = seed({ title: "Dup", body: "same body" });
    const dupB = seed({ title: "Dup", body: "same body" });
    const client = fakeClient(
      JSON.stringify({
        operations: [
          {
            type: "archive",
            source_memory_ids: [dupB.id],
            rationale: "exact duplicate of the other",
            confidence: 0.95,
          },
        ],
      }),
      { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    );

    const run = await runOk(SLICE, options(client));

    expect(run.status).toBe("completed");
    // ADR 0014: a confident archive applies like any other operation.
    expect(s!.store.getMemory(dupB.id)?.status).toBe("archived");
    expect(s!.store.getMemory(dupA.id)?.status).toBe("active"); // only the cited dup
    expect(s!.store.getMemory(dupB.id)?.flags.length).toBe(0); // nothing sent for review
    expect(run.summary).toContain("applied 1");
    expect(run.usage_input_tokens).toBe(100);
    expect(run.usage_output_tokens).toBe(20);
    expect(run.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.model_name).toBe("gpt-x");

    const recorded = s!.store.getCurationOperations(run.id);
    expect(recorded.some((o) => o.operation_type === "archive" && o.status === "applied")).toBe(
      true,
    );
  });

  it("records schema-rejected operations as skipped without aborting the run", async () => {
    const m = seed();
    const client = fakeClient(
      JSON.stringify({
        operations: [
          { type: "not_a_real_type", source_memory_ids: [m.id], rationale: "x", confidence: 1 },
          { type: "noop", source_memory_ids: [], rationale: "nothing", confidence: 0.5 },
        ],
      }),
    );

    const run = await runOk(SLICE, options(client));
    expect(run.status).toBe("completed");
    const recorded = s!.store.getCurationOperations(run.id);
    expect(recorded.some((o) => o.status === "skipped" && o.rationale.startsWith("schema:"))).toBe(
      true,
    );
  });
});

describe("runCuration — run record + input hash", () => {
  it("derives the run record fields from the global slice (project_key is always null now)", async () => {
    const run = await runOk(SLICE, options(fakeClient(JSON.stringify({ operations: [] }))));
    expect(run.project_key).toBeNull();
  });

  it("changes the input hash when the prompt addendum changes, without leaking a secret", async () => {
    const empty = JSON.stringify({ operations: [] });
    const base = await runOk(SLICE, {
      ...options(fakeClient(empty)),
      promptAddendum: "prefer merging",
    });
    const changed = await runOk(SLICE, {
      ...options(fakeClient(empty)),
      promptAddendum: 'prefer merging; token = "FAKEHASHSECRET"',
    });
    expect(changed.input_hash).not.toBe(base.input_hash);
    expect(changed.input_hash).not.toContain("FAKEHASHSECRET"); // hash is opaque + redacted
  });
});

describe("runCuration — input-hash idempotency (§10.2)", () => {
  it("skips a scheduled re-run with an identical input hash, but a bypass runs again", async () => {
    seed(); // some evidence; the LLM does nothing so the evidence (and hash) is stable
    const noOp = () => fakeClient(JSON.stringify({ operations: [] }));

    const first = await runOk(SLICE, { ...options(noOp()), trigger: "schedule" });
    expect(first.status).toBe("completed");

    // Same evidence → same input hash → a scheduled re-run is skipped (null, no run).
    const skipped = await runCuration(SLICE, { ...options(noOp()), trigger: "schedule" });
    expect(skipped).toBeNull();

    // A manual/maintenance trigger may bypass the skip.
    const bypassed = await runCuration(SLICE, {
      ...options(noOp()),
      trigger: "manual",
      bypassSkip: true,
    });
    expect(bypassed).not.toBeNull();
    expect(bypassed!.id).not.toBe(first.id);
  });

  // Spec 072 D7: proposals are EVIDENCE, not a trigger. They still reach the
  // prompt (the curator must see what is pending), they just no longer perturb
  // the skip hash — before this, filing a proposal made the very next sweep look
  // novel, so it spent another LLM call re-deriving the judgment it had just
  // filed, and (without T2's suppression) filed it a second time.
  it("does not re-trigger the next scheduled sweep just because a proposal was filed", async () => {
    const m = seed({ title: "Fact", body: "old value" });
    // Below the 0.8 confidence knob → routed to a proposal: a new proposed
    // memory appears and the source stays active.
    const proposeOnce = fakeClient(
      JSON.stringify({
        operations: [
          {
            type: "update",
            source_memory_id: m.id,
            patch: { title: "Fact, corrected" },
            rationale: "fix",
            confidence: 0.5,
          },
        ],
      }),
    );

    const first = await runOk(SLICE, { ...options(proposeOnce), trigger: "schedule" });
    expect(first.status).toBe("completed");
    expect(s!.store.getMemory(m.id)!.status).toBe("active");

    const skipped = await runCuration(SLICE, {
      ...options(fakeClient(JSON.stringify({ operations: [] }))),
      trigger: "schedule",
    });
    expect(skipped).toBeNull();
  });

  // The other half of D7, and the mechanism D3's copy promises the operator:
  // "the curator re-reads this memory on its next grooming run". Editing a
  // source — which is exactly what makes a proposal drift — must still re-run.
  it("still re-runs when an active memory actually changes", async () => {
    const m = seed({ title: "Fact", body: "old value" });
    const noOp = () => fakeClient(JSON.stringify({ operations: [] }));
    await runOk(SLICE, { ...options(noOp()), trigger: "schedule" });

    s!.store.updateMemory(m.id, { body: "edited by hand" });

    const rerun = await runCuration(SLICE, { ...options(noOp()), trigger: "schedule" });
    expect(rerun).not.toBeNull();
  });
});

describe("runCuration — failure paths leave memory untouched", () => {
  it("fails the run with a value-free label on an LLM error", async () => {
    const m = seed();
    const client: LlmClient = {
      complete: async () => {
        throw new LlmClientError("network", "connection refused to 10.0.0.1");
      },
    };

    const run = await runOk(SLICE, options(client));
    expect(run.status).toBe("failed");
    expect(run.error).toBe("llm_network"); // value-free, no host/detail
    expect(s!.store.getMemory(m.id)?.status).toBe("active");
  });

  it("fails the run on unparseable output", async () => {
    const m = seed();
    const run = await runOk(SLICE, options(fakeClient("this is not json at all")));
    expect(run.status).toBe("failed");
    expect(run.error).toBe("parse_error");
    expect(s!.store.getMemory(m.id)?.status).toBe("active");
  });
});

/** A client that records each call's serialized messages, so a test can count
 * the LLM calls and see which memories each call carried. */
function recordingClient(content: string): { client: LlmClient; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    client: {
      complete: async (req) => {
        calls.push(JSON.stringify(req.messages));
        return {
          content,
          model: "gpt-x",
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
        };
      },
    },
  };
}

describe("runCuration — chunking oversized slices (global-slice LLM timeout)", () => {
  it("splits a slice larger than chunkSize into multiple bounded LLM calls, covering every memory", async () => {
    const ids = Array.from({ length: 5 }, (_, i) => seed({ title: `t${i}`, body: `body ${i}` }).id);
    const { client, calls } = recordingClient(JSON.stringify({ operations: [] }));

    const run = await runOk(SLICE, { ...options(client), caps: { chunkSize: 2 } });

    expect(run.status).toBe("completed");
    expect(calls.length).toBe(3); // ceil(5 / 2): no single call sees the whole slice
    for (const call of calls) {
      expect(ids.filter((id) => call.includes(id)).length).toBeLessThanOrEqual(2);
    }
    // every memory is covered in exactly one call — bounded, but nothing dropped
    for (const id of ids) {
      expect(calls.filter((c) => c.includes(id)).length).toBe(1);
    }
  });

  it("isolates a failing chunk so the remaining chunks still complete the run", async () => {
    Array.from({ length: 5 }, (_, i) => seed({ title: `t${i}`, body: `b${i}` }));
    let n = 0;
    const client: LlmClient = {
      complete: async () => {
        n += 1;
        if (n === 2) throw new LlmClientError("timeout", "slow chunk");
        return { content: JSON.stringify({ operations: [] }), model: "gpt-x", usage: null };
      },
    };

    const run = await runOk(SLICE, { ...options(client), caps: { chunkSize: 2 } });

    expect(run.status).toBe("completed"); // one chunk timed out; the run does not fail
    expect(n).toBe(3); // all three chunks were attempted, not aborted at the failure
  });
});
