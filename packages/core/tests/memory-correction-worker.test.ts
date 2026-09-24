import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LlmClient,
  type Memory,
  LlmClientError,
  createMarkdownMemoryStore,
  createVault,
  processMemoryCorrectionWork,
  serializeMemoryDocument,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;
let clockMs: number;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-correction-worker-"));
  clockMs = Date.parse("2026-07-01T00:00:00.000Z");
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function setup(overrides: Partial<Memory> = {}) {
  const now = () => new Date(clockMs);
  const vault = createVault({ dataDir });
  const store = createMarkdownMemoryStore({ vault, now: () => now().toISOString() });
  const memory: Memory = {
    id: "m-correction",
    title: "Mixed facts",
    body: "Keep this fact. Stale fact. Useful detail.",
    agent_id: "writer-agent",
    status: "active",
    tags: ["reference"],
    applies_to: [],
    supersedes: [],
    conflicts_with: [],
    flags: [],
    confidence: "working",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    curator_note: null,
    is_global: false,
    requires_approval: false,
    ...overrides,
  };
  vault.writeText(`memories/${memory.id}.md`, serializeMemoryDocument(memory));
  store.flagMemoryForCorrection({
    id: memory.id,
    reason: "The stale claim is no longer true.",
    agent_id: "reporting-agent",
    principal_id: "reporting-agent",
    shelf_id: "main",
  });
  const item = store.listDueMemoryCorrections(now().toISOString())[0];
  if (!item) throw new Error("flagged correction marker was not queued");
  const llmClient: LlmClient = {
    complete: vi.fn(async () => ({
      content: JSON.stringify({
        quotes: ["Stale fact."],
        addressed_flags: [0],
        confidence: 0.9,
        rationale: "The flagged sentence is outdated.",
      }),
      model: "test-model",
    })),
  };
  return { store, memory, item, llmClient, now };
}

function run(
  context: ReturnType<typeof setup>,
  options: {
    threshold?: number;
    authorizedToWrite?: boolean;
    adminCanReview?: boolean;
    llmClient?: LlmClient;
  } = {},
) {
  return processMemoryCorrectionWork({
    store: context.store,
    item: context.item,
    shelfId: "main",
    principalId: "reporting-agent",
    authorizedToWrite: options.authorizedToWrite ?? true,
    adminCanReview: options.adminCanReview ?? true,
    llmClient: options.llmClient ?? context.llmClient,
    confidenceThreshold: options.threshold ?? 0.8,
    now: context.now,
  });
}

describe("processMemoryCorrectionWork", () => {
  it("applies at D13 threshold zero even when correction confidence is zero", async () => {
    const context = setup();
    context.llmClient.complete = vi.fn(async () => ({
      content: JSON.stringify({
        quotes: ["Stale fact."],
        addressed_flags: [0],
        confidence: 0,
        rationale: "The claim is outdated.",
      }),
      model: "test-model",
    }));

    const result = await run(context, { threshold: 0 });

    expect(result).toMatchObject({ status: "applied" });
    expect(context.store.getMemory(context.memory.id)).toMatchObject({
      body: "Keep this fact.  Useful detail.",
      flags: [],
      correction_work: [
        expect.objectContaining({ status: "applied", applied_at: context.now().toISOString() }),
      ],
    });
  });

  it("creates a proposal below the shared threshold without changing source or flags", async () => {
    const context = setup();
    context.llmClient.complete = vi.fn(async () => ({
      content: JSON.stringify({
        quotes: ["Stale fact."],
        addressed_flags: [0],
        confidence: 0.4,
        rationale: "The source claim may be outdated.",
      }),
      model: "test-model",
    }));
    const result = await run(context);

    expect(result.status).toBe("proposal_pending");
    if (result.status !== "proposal_pending") return;
    expect(context.store.getMemory(result.proposal_id)).toMatchObject({
      status: "proposed",
      body: "Keep this fact.  Useful detail.",
      curator_note: {
        source: "flagged_correction",
        correction: { source_memory_id: context.memory.id },
      },
    });
    expect(context.store.getMemory(context.memory.id)).toMatchObject({
      body: context.memory.body,
      flags: [expect.objectContaining({ reason: "The stale claim is no longer true." })],
      correction_work: [
        expect.objectContaining({ status: "proposal_pending", proposal_id: result.proposal_id }),
      ],
    });
  });

  it("reuses a persisted proposal after a crash before the work marker is updated", async () => {
    const context = setup();
    const queued = context.item.work;
    const claimed = context.store.claimMemoryCorrection({
      id: context.memory.id,
      snapshot_digest: queued.snapshot_digest,
    })!;
    const source = context.store.getMemory(context.memory.id)!;
    const start = source.body.indexOf("Stale fact.");
    const proposalBody =
      source.body.slice(0, start) + source.body.slice(start + "Stale fact.".length);
    const proposal = context.store.createMemoryCorrectionProposal({
      source_memory_id: source.id,
      snapshot_digest: claimed.snapshot_digest,
      source_digest: claimed.source_digest,
      flags_digest: claimed.flags_digest,
      claim_attempt: claimed.attempt_count,
      shelf_id: queued.shelf_id,
      proposed_body: proposalBody,
      spans: [{ start, end: start + "Stale fact.".length, quote: "Stale fact." }],
      confidence: 0.4,
      rationale: "The claim may be outdated.",
      agent_id: "system-memory-curator",
    })!;
    clockMs += 60_001;
    context.item = context.store.listDueMemoryCorrections(context.now().toISOString())[0]!;
    const llmClient: LlmClient = { complete: vi.fn() };

    const result = await run(context, { llmClient });

    expect(result).toMatchObject({ status: "proposal_pending", proposal_id: proposal.id });
    expect(llmClient.complete).not.toHaveBeenCalled();
    expect(context.store.getMemory(context.memory.id)?.flags).toHaveLength(1);
  });

  it("forces a protected target through the proposal path even at threshold zero", async () => {
    const context = setup({ requires_approval: true });

    const result = await run(context, { threshold: 0 });

    expect(result.status).toBe("proposal_pending");
    expect(context.store.getMemory(context.memory.id)?.body).toBe(context.memory.body);
  });

  it("leaves incomplete flag coverage for manual review without editing the source", async () => {
    const context = setup();
    context.store.flagMemoryForCorrection({
      id: context.memory.id,
      reason: "A second independent claim is stale.",
      agent_id: "second-agent",
      principal_id: "reporting-agent",
      shelf_id: "main",
    });
    context.item = context.store.listDueMemoryCorrections(context.now().toISOString())[0]!;
    context.llmClient.complete = vi.fn(async () => ({
      content: JSON.stringify({
        quotes: ["Stale fact."],
        addressed_flags: [0],
        confidence: 1,
        rationale: "Only the first reason is addressed.",
      }),
      model: "test-model",
    }));

    const result = await run(context);

    expect(result).toMatchObject({
      status: "manual_review",
      reason_code: "incomplete_flag_coverage",
    });
    expect(context.store.getMemory(context.memory.id)?.body).toBe(context.memory.body);
    expect(context.store.getMemory(context.memory.id)?.flags).toHaveLength(2);
  });

  it("does not call the model when the flagger no longer has exact-shelf write authority", async () => {
    const context = setup();
    const result = await run(context, { authorizedToWrite: false });

    expect(result).toMatchObject({ status: "manual_review", reason_code: "no_write_scope" });
    expect(context.llmClient.complete).not.toHaveBeenCalled();
    expect(context.store.getMemory(context.memory.id)?.flags).toHaveLength(1);
  });

  it("does not call the model when the exact source shelf is not reviewer-visible", async () => {
    const context = setup();
    const result = await run(context, { adminCanReview: false });

    expect(result).toMatchObject({ status: "manual_review", reason_code: "no_admin_scope" });
    expect(context.llmClient.complete).not.toHaveBeenCalled();
    expect(context.store.getMemory(context.memory.id)?.flags).toHaveLength(1);
  });

  it("retries a transient provider timeout with bounded backoff", async () => {
    const context = setup();
    const llmClient: LlmClient = {
      complete: vi
        .fn()
        .mockRejectedValueOnce(new LlmClientError("timeout", "timeout"))
        .mockResolvedValueOnce({
          content: JSON.stringify({
            quotes: ["Stale fact."],
            addressed_flags: [0],
            confidence: 0.9,
            rationale: "The claim is outdated.",
          }),
          model: "test-model",
        }),
    };

    const retried = await run(context, { llmClient });
    expect(retried).toMatchObject({ status: "retry_scheduled" });
    expect(context.store.getMemory(context.memory.id)?.correction_work?.[0]).toMatchObject({
      status: "pending",
      attempt_count: 1,
      next_attempt_at: new Date(clockMs + 30_000).toISOString(),
    });

    clockMs += 30_000;
    const dueItem = context.store.listDueMemoryCorrections(context.now().toISOString())[0];
    if (!dueItem) throw new Error("the correction retry did not become due");
    context.item = dueItem;
    const applied = await run(context, { llmClient });
    expect(applied).toMatchObject({ status: "applied" });
    expect(llmClient.complete).toHaveBeenCalledTimes(2);
  });
});
