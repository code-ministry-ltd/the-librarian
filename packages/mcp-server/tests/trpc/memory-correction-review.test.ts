import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type Principal,
  type Shelf,
  type VaultRouter,
  DEFAULT_SHELF,
  createLibrarianStore,
} from "@librarian/core";
import { appRouter, createCallerFactory } from "@librarian/mcp-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../../dist/trpc/context.js";

const createCaller = createCallerFactory(appRouter);
const admin: Principal = { kind: "admin", actorId: "dashboard-admin", roles: ["admin"] };
const dataDirs: string[] = [];
const stores: ReturnType<typeof createLibrarianStore>[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      /* ignore cleanup errors */
    }
  }
  for (const dir of dataDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function freshStore(router?: VaultRouter): ReturnType<typeof createLibrarianStore> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-correction-review-"));
  dataDirs.push(dataDir);
  const store = createLibrarianStore({ dataDir, ...(router ? { vaultRouter: router } : {}) });
  stores.push(store);
  return store;
}

function callerFor(store: ReturnType<typeof createLibrarianStore>) {
  const context: TrpcContext = {
    principal: admin,
    role: "admin",
    store,
    secretKey: null,
    adminToken: "",
  };
  return createCaller(context);
}

function createCorrectionProposal(
  store: ReturnType<typeof createLibrarianStore>,
  shelf: Shelf = DEFAULT_SHELF,
) {
  const shelfStore = store.forShelf(shelf);
  const source = shelfStore.createMemory(
    {
      title: "Mixed facts",
      body: "Keep this useful fact. The outdated statement.",
      agent_id: "writer-agent",
    },
    {},
  ).memory;
  shelfStore.flagMemoryForCorrection({
    id: source.id,
    reason: "The final statement is outdated.",
    agent_id: "scribe",
    principal_id: "reporting-agent",
    shelf_id: shelf.id,
  });
  const due = shelfStore
    .listDueMemoryCorrections(new Date().toISOString())
    .find((item) => item.memory_id === source.id);
  const queued = due?.work;
  if (!queued) throw new Error("flagged correction was not queued");
  const claimed = shelfStore.claimMemoryCorrection({
    id: source.id,
    snapshot_digest: queued.snapshot_digest,
  });
  if (!claimed) throw new Error("flagged correction was not claimable");

  const quote = "The outdated statement.";
  const start = source.body.indexOf(quote);
  const proposedBody = source.body.slice(0, start) + source.body.slice(start + quote.length);
  const proposal = shelfStore.createMemoryCorrectionProposal({
    source_memory_id: source.id,
    snapshot_digest: claimed.snapshot_digest,
    source_digest: claimed.source_digest,
    flags_digest: claimed.flags_digest,
    claim_attempt: claimed.attempt_count,
    shelf_id: shelf.id,
    proposed_body: proposedBody,
    spans: [{ start, end: start + quote.length, quote }],
    confidence: 0.4,
    rationale: "Remove only the outdated statement.",
    agent_id: "system-memory-curator",
  });
  if (!proposal) throw new Error("flagged correction proposal was not created");
  const pending = shelfStore.updateMemoryCorrectionWork({
    id: source.id,
    snapshot_digest: claimed.snapshot_digest,
    claim_attempt: claimed.attempt_count,
    patch: { status: "proposal_pending", proposal_id: proposal.id },
  });
  if (!pending) throw new Error("correction work did not enter proposal review");
  return { source, proposal };
}

describe("flagged correction proposal review procedures", () => {
  it("requires the exact writable shelf and approves only the stored correction", async () => {
    const store = freshStore();
    const { source, proposal } = createCorrectionProposal(store);
    const caller = callerFor(store);

    const [review] = await caller.memories.proposalsForReview();
    expect(review).toMatchObject({
      proposal: { id: proposal.id, shelfId: "main", shelfWritable: true },
      correctionReview: { source_memory_id: source.id, shelf_id: "main", status: "ready" },
      targets: [{ id: source.id, flags: [{ reason: "The final statement is outdated." }] }],
    });

    await expect(
      caller.memories.approve({ id: proposal.id, shelf_id: "not-the-source-shelf" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller.memories.update({ id: proposal.id, patch: { tags: ["changed-during-review"] } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.memories.approve({ id: proposal.id, shelf_id: "main", patch: { body: "altered" } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await caller.memories.approve({ id: proposal.id, shelf_id: "main" });

    expect(store.getMemory(proposal.id)?.status).toBe("active");
    expect(store.getMemory(source.id)).toMatchObject({
      status: "archived",
      flags: [],
      correction_work: [expect.objectContaining({ status: "applied", proposal_id: proposal.id })],
    });
    await expect(caller.memories.correctionHistory()).resolves.toMatchObject({
      total: 1,
      corrections: [
        expect.objectContaining({
          source_memory_id: source.id,
          shelf_id: "main",
          outcome: "proposal_approved",
          proposal_id: proposal.id,
        }),
      ],
    });
  });

  it("keeps a correction flagged and unapproved when its source snapshot has drifted", async () => {
    const store = freshStore();
    const { source, proposal } = createCorrectionProposal(store);
    const caller = callerFor(store);
    store.updateMemory(source.id, { body: "Keep this useful fact. A newer statement." });

    const [review] = await caller.memories.proposalsForReview();
    expect(review?.correctionReview).toMatchObject({
      status: "blocked",
      reason_code: "correction_content_drifted",
    });
    await expect(
      caller.memories.approve({ id: proposal.id, shelf_id: "main" }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(store.getMemory(proposal.id)?.status).toBe("proposed");
    expect(store.getMemory(source.id)).toMatchObject({
      status: "active",
      flags: [{ reason: "The final statement is outdated." }],
    });
  });

  it("rejecting a correction preserves the source and sends its work to manual review", async () => {
    const store = freshStore();
    const { source, proposal } = createCorrectionProposal(store);
    const caller = callerFor(store);

    await caller.memories.reject({ id: proposal.id, shelf_id: "main" });

    expect(store.getMemory(proposal.id)?.status).toBe("archived");
    expect(store.getMemory(source.id)).toMatchObject({
      status: "active",
      flags: [{ reason: "The final statement is outdated." }],
      correction_work: [expect.objectContaining({ status: "manual_review" })],
    });
  });

  it("fails closed when a custom router cannot verify exact-shelf write authority", async () => {
    const visible: Shelf = { id: "visible", prefix: "visible/", writable: true };
    let writePrefix = visible.prefix;
    const router: VaultRouter = {
      shelves: (_principal, op) =>
        op === "write" ? [{ ...visible, prefix: writePrefix }] : [visible],
      writeTarget: () => visible,
    };
    const store = freshStore(router);
    const { source, proposal } = createCorrectionProposal(store, visible);
    writePrefix = "different/";
    const caller = callerFor(store);

    const [review] = await caller.memories.proposalsForReview();
    expect(review).toMatchObject({
      proposal: { shelfId: visible.id, shelfWritable: false },
      correctionReview: { shelf_id: visible.id, status: "ready" },
    });
    await expect(
      caller.memories.approve({ id: proposal.id, shelf_id: visible.id }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const shelfStore = store.forShelf(visible);
    expect(shelfStore.getMemory(proposal.id)?.status).toBe("proposed");
    expect(shelfStore.getMemory(source.id)?.status).toBe("active");
  });

  it("limits correction history to the preceding 30 days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const store = freshStore();
    const { proposal } = createCorrectionProposal(store);
    const caller = callerFor(store);
    await caller.memories.approve({ id: proposal.id, shelf_id: "main" });

    vi.setSystemTime(new Date("2026-02-02T00:00:00.000Z"));
    await expect(caller.memories.correctionHistory()).resolves.toMatchObject({
      total: 0,
      corrections: [],
    });
  });
});
