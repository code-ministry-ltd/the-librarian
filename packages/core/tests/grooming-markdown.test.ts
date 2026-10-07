// Curator on the markdown backend (plan 036 Phase 4) — the "awakening" test.
//
// With the vault-backed GroomingMemorySource wired in, the
// curator enumerates slices + gathers evidence from the git vault, and a full
// run threads gather → prepass → LLM → apply against the vault. Run bookkeeping
// lives in the curation-runs.json sidecar.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type LlmClient,
  type LlmCompletion,
  createLibrarianStore,
  runCuration,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let store: LibrarianStore | null = null;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-curator-md-"));
  store = createLibrarianStore({ dataDir, backend: "markdown" });
});
afterEach(() => {
  try {
    store?.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  store = null;
});

function seed(over: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  return store!.createMemory(
    { agent_id: "agent-a", title: "title", body: "body", ...over },
    options,
  ).memory;
}

function fakeClient(content: string): LlmClient {
  const usage: LlmCompletion["usage"] = {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  };
  return { complete: async () => ({ content, model: "gpt-x", usage }) };
}

const SLICE = { kind: "common_global" as const };

describe("curator on the markdown backend — read side reads the vault", () => {
  it("enumerates the single global slice from vault memories", () => {
    seed({ title: "one" });
    seed({ title: "two" });
    const slices = store!.listGroomingSlices();
    expect(slices).toEqual([{ kind: "common_global" }]);
  });

  it("gathers active/proposed/tombstone evidence for a slice from the vault", () => {
    const active = seed({ title: "active-one" });
    const proposed = seed({ title: "proposed-one" }, { requires_approval: true });
    const archived = seed({ title: "deleted thing", body: "the original body" });
    store!.archiveMemory(archived.id);

    const bundle = store!.gatherMemoryEvidence(SLICE, { maxMemories: 50 });

    expect(bundle.activeMemories.map((m) => m.id)).toContain(active.id);
    expect(bundle.proposedMemories.map((m) => m.id)).toContain(proposed.id);
    const tomb = bundle.tombstones.find((t) => t.id === archived.id);
    expect(tomb).toBeDefined();
    expect(tomb!.contentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    // The deleted body must not be re-exposed.
    expect(JSON.stringify(tomb)).not.toContain("the original body");
  });

  it("lists the global slice for a grooming pass (the per-slice interval gate is retired)", () => {
    seed({ title: "one" });
    // A grooming pass attempts every slice (spec 045 D-3a); the store enumerates the
    // full slice set and idempotency (not an interval gate) decides what does work.
    const slices = store!.listGroomingSlices();
    const hit = slices.find((s) => s.kind === "common_global");
    expect(hit).toBeDefined();
  });
});

describe("curator on the markdown backend — full run mutates the vault", () => {
  it("runs a curation pass that archives a confident duplicate in the vault (ADR 0014)", async () => {
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
    );

    const run = await runCuration(SLICE, {
      store: store!,
      llmClient: client,
      trigger: "manual",
      actorId: "system-memory-curator",
      confidenceThreshold: 0.8,
      model: { provider: "openai", name: "gpt-x" },
    });

    expect(run).not.toBeNull();
    expect(run!.status).toBe("completed");
    // ADR 0014: a confident archive applies — the vault doc is archived, not flagged.
    expect(store!.getMemory(dupB.id)?.status).toBe("archived");
    expect(store!.getMemory(dupB.id)?.flags.length).toBe(0);
    expect(store!.getMemory(dupA.id)?.status).toBe("active");
    // The run + operation were recorded in the sidecar run log.
    const ops = store!.getCurationOperations(run!.id);
    expect(ops.some((o) => o.operation_type === "archive" && o.status === "applied")).toBe(true);
  });
});
