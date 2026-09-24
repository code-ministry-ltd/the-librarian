// Markdown MemoryStore — updateMemory / archiveMemory / flagMemory /
// resolveFlags / approveProposal (plan 036 Phase 2; flag verbs from spec 047 /
// ADR 0006). The store applies the transitions directly to the document.
// Pins: the protection gate
// + status-patch guard on update, the idempotent archive, the route-to-review
// flag accumulation + resolution, and the proposal approve/reject transitions.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type Memory,
  createMarkdownMemoryStore,
  createVault,
  serializeMemoryDocument,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-md-mut-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const NOW = "2026-07-01T00:00:00.000Z";

function setup(options: { now?: () => string; onWrite?: () => void } = {}) {
  const vault = createVault({ dataDir });
  const store = createMarkdownMemoryStore({
    vault,
    now: options.now ?? (() => NOW),
    onWrite: options.onWrite,
  });
  const seed = (over: Partial<Memory> & { id: string }): Memory => {
    const memory: Memory = {
      id: over.id,
      title: over.title ?? over.id,
      body: over.body ?? "body",
      agent_id: over.agent_id ?? "codex",
      confidence: "working",
      tags: over.tags ?? [],
      applies_to: [],
      supersedes: [],
      conflicts_with: [],
      flags: over.flags ?? [],
      status: over.status ?? "active",
      is_global: false,
      requires_approval: over.requires_approval ?? false,
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
      curator_note: over.curator_note ?? null,
    };
    vault.writeText(`memories/${memory.id}.md`, serializeMemoryDocument(memory));
    return memory;
  };
  return { vault, store, seed };
}

function createReadyCorrectionProposal(
  store: ReturnType<typeof createMarkdownMemoryStore>,
  seed: (over: Partial<Memory> & { id: string }) => Memory,
) {
  seed({ id: "source", title: "Fact", body: "Useful fact. Stale fact." });
  const flagged = store.flagMemoryForCorrection({
    id: "source",
    reason: "The second claim is outdated.",
    agent_id: "claude",
    principal_id: "principal-1",
    shelf_id: "shelf-1",
  });
  const work = flagged!.correction_work![0]!;
  const claimed = store.claimMemoryCorrection({
    id: "source",
    snapshot_digest: work.snapshot_digest,
  })!;
  const source = store.getMemory("source")!;
  const start = source.body.indexOf("Stale fact.");
  const span = { start, end: start + "Stale fact.".length, quote: "Stale fact." };
  const proposedBody = source.body.slice(0, span.start) + source.body.slice(span.end);
  const proposal = store.createMemoryCorrectionProposal({
    source_memory_id: source.id,
    snapshot_digest: claimed.snapshot_digest,
    source_digest: claimed.source_digest,
    flags_digest: claimed.flags_digest,
    claim_attempt: claimed.attempt_count,
    shelf_id: "shelf-1",
    proposed_body: proposedBody,
    spans: [span],
    confidence: 0.2,
    rationale: "The second claim may be outdated.",
    agent_id: "system-memory-curator",
  })!;
  store.updateMemoryCorrectionWork({
    id: source.id,
    snapshot_digest: claimed.snapshot_digest,
    claim_attempt: claimed.attempt_count,
    patch: { status: "proposal_pending", proposal_id: proposal.id },
  });
  return { proposal, source, work: claimed };
}

describe("markdown MemoryStore — updateMemory", () => {
  it("applies a whitelisted patch and bumps updated_at", () => {
    const { store, seed } = setup();
    seed({ id: "m", title: "old", body: "old body" });
    const updated = store.updateMemory("m", { title: "new", body: "new body" });
    expect(updated!.title).toBe("new");
    expect(updated!.body).toBe("new body");
    expect(updated!.updated_at).toBe(NOW);
  });

  it("throws for an unknown id", () => {
    const { store } = setup();
    expect(() => store.updateMemory("ghost", { title: "x" })).toThrow(/No memory found/);
  });

  it("rejects a status change via updateMemory", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "active" });
    expect(() => store.updateMemory("m", { status: "archived" })).toThrow(/status changes/);
  });

  it("blocks edits to a protected active memory unless allowProtected is set", () => {
    const { store, seed } = setup();
    seed({ id: "p", status: "active", requires_approval: true });
    expect(() => store.updateMemory("p", { body: "edit" })).toThrow(/Protected memories/);
    const ok = store.updateMemory("p", { body: "edit" }, "codex", { allowProtected: true });
    expect(ok!.body).toBe("edit");
  });

  it("strips protected fields smuggled through a patch (cleanPatch allow-list)", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "active", requires_approval: false });
    const updated = store.updateMemory("m", {
      body: "ok",
      is_global: true,
      requires_approval: true,
      curator_note: { forged: true },
    });
    expect(updated!.body).toBe("ok");
    expect(updated!.is_global).toBe(false);
    expect(updated!.requires_approval).toBe(false);
    expect(updated!.curator_note).toBeNull();
  });

  it("keeps proposed correction metadata immutable outside its dedicated review path", () => {
    const { store, seed } = setup();
    const { proposal } = createReadyCorrectionProposal(store, seed);
    const before = store.getMemory(proposal.id);

    expect(() =>
      store.updateMemory(proposal.id, { tags: ["unrelated"], applies_to: ["other"] }),
    ).toThrow(/Flagged-correction proposals can only change through correction review/);
    expect(store.getMemory(proposal.id)).toEqual(before);
    expect(
      store.inspectMemoryCorrectionProposal({ proposal_id: proposal.id, shelf_id: "shelf-1" }),
    ).toMatchObject({ status: "ready" });
  });
});

describe("markdown MemoryStore — archiveMemory", () => {
  it("archives a memory and is idempotent", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "active" });
    expect(store.archiveMemory("m")!.status).toBe("archived");
    expect(store.archiveMemory("m")!.status).toBe("archived"); // no-op second call
  });

  it("throws for an unknown id", () => {
    const { store } = setup();
    expect(() => store.archiveMemory("ghost")).toThrow(/No memory found/);
  });
});

describe("markdown MemoryStore — unarchiveMemory", () => {
  it("restores an archived memory to active and bumps updated_at", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "archived" });
    const restored = store.unarchiveMemory("m");
    expect(restored!.status).toBe("active");
    expect(restored!.updated_at).toBe(NOW);
  });

  it("is idempotent on an already-active memory (no-op)", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "active" });
    expect(store.unarchiveMemory("m")!.status).toBe("active"); // already active → no-op
  });

  it("throws for an unknown id", () => {
    const { store } = setup();
    expect(() => store.unarchiveMemory("ghost")).toThrow(/No memory found/);
  });
});

describe("markdown MemoryStore — purgeMemory", () => {
  it("hard-deletes an archived memory (file gone, getMemory null) and is idempotent", () => {
    const { store, vault, seed } = setup();
    seed({ id: "m", status: "archived" });
    expect(vault.exists("memories/m.md")).toBe(true);

    const purged = store.purgeMemory("m");
    expect(purged!.id).toBe("m");
    expect(vault.exists("memories/m.md")).toBe(false);
    expect(store.getMemory("m")).toBeNull();

    // idempotent — purging an already-absent memory is a no-op returning null
    expect(store.purgeMemory("m")).toBeNull();
  });

  it("refuses to purge a non-archived memory (archive first) and leaves it untouched", () => {
    const { store, seed } = setup();
    seed({ id: "a", status: "active" });
    expect(() => store.purgeMemory("a")).toThrow(/archived/i);
    expect(store.getMemory("a")!.status).toBe("active");
  });

  it("is a no-op for an unknown id", () => {
    const { store } = setup();
    expect(store.purgeMemory("ghost")).toBeNull();
  });
});

describe("markdown MemoryStore — flagMemory", () => {
  it("records a flag without changing the memory's status", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "active" });
    const flagged = store.flagMemory("m", "this is outdated", "codex");
    expect(flagged!.status).toBe("active"); // route-to-review, never archive
    expect(flagged!.flags).toEqual([
      { agent_id: "codex", reason: "this is outdated", created_at: NOW },
    ]);
    expect(flagged!.updated_at).toBe(NOW);
  });

  it("accumulates flags from multiple agents", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "active" });
    store.flagMemory("m", "wrong", "codex");
    const flagged = store.flagMemory("m", "misleading", "claude");
    expect(flagged!.flags).toEqual([
      { agent_id: "codex", reason: "wrong", created_at: NOW },
      { agent_id: "claude", reason: "misleading", created_at: NOW },
    ]);
  });

  it("is a fail-soft no-op returning null for an unknown id", () => {
    const { store } = setup();
    expect(store.flagMemory("ghost", "reason", "codex")).toBeNull();
  });
});

describe("markdown MemoryStore — flagged correction work", () => {
  it("persists a flag and a digest-only pending work marker in one write", () => {
    let writes = 0;
    const { store, seed } = setup({ onWrite: () => writes++ });
    seed({ id: "m", body: "Useful fact. Stale fact." });
    writes = 0;

    const flagged = store.flagMemoryForCorrection({
      id: "m",
      reason: "The stale fact is no longer true.",
      agent_id: "codex",
      principal_id: "principal-1",
      shelf_id: "shelf-1",
    });

    expect(writes).toBe(1);
    expect(flagged!.flags).toHaveLength(1);
    expect(flagged!.correction_work).toHaveLength(1);
    const [work] = flagged!.correction_work!;
    expect(work).toMatchObject({
      principal_id: "principal-1",
      shelf_id: "shelf-1",
      status: "pending",
      attempt_count: 0,
      queued_at: NOW,
    });
    expect(work.snapshot_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(work.source_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(work.flags_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(work)).not.toContain("Useful fact");
    expect(JSON.stringify(work)).not.toContain("Stale fact");
    expect(JSON.stringify(work)).not.toContain("no longer true");
  });

  it("persists an explicit no-admin-scope outcome instead of queueing inaccessible work", () => {
    const { store, seed } = setup();
    seed({ id: "m" });

    const flagged = store.flagMemoryForCorrection({
      id: "m",
      reason: "review this claim",
      agent_id: "codex",
      principal_id: "principal-1",
      shelf_id: "shelf-1",
      manual_review_reason_code: "no_admin_scope",
    });

    expect(flagged!.correction_work?.[0]).toMatchObject({
      status: "manual_review",
      reason_code: "no_admin_scope",
    });
    expect(store.listDueMemoryCorrections(NOW)).toEqual([]);
  });

  it("coalesces new flags into a fresh batch and cancels stale pending work", () => {
    const { store, seed } = setup();
    seed({ id: "m" });
    store.flagMemoryForCorrection({
      id: "m",
      reason: "first",
      agent_id: "codex",
      principal_id: "principal-1",
      shelf_id: "shelf-1",
    });
    const flagged = store.flagMemoryForCorrection({
      id: "m",
      reason: "second",
      agent_id: "claude",
      principal_id: "principal-2",
      shelf_id: "shelf-1",
    });

    expect(flagged!.flags).toHaveLength(2);
    expect(flagged!.correction_work).toHaveLength(2);
    expect(flagged!.correction_work?.map(({ status }) => status)).toEqual(["cancelled", "pending"]);
    expect(flagged!.correction_work?.[0].reason_code).toBe("superseded_by_new_flag");
  });

  it("applies exact spans and resolves the reviewed flag batch in one write", () => {
    let writes = 0;
    const { store, seed } = setup({ onWrite: () => writes++ });
    const source = "Keep. Stale. Useful.";
    seed({ id: "m", body: source, tags: ["retained"] });
    store.flagMemoryForCorrection({
      id: "m",
      reason: "The middle claim is outdated.",
      agent_id: "codex",
      principal_id: "p",
      shelf_id: "s",
    });
    const flagged = store.flagMemoryForCorrection({
      id: "m",
      reason: "The same middle claim is stale.",
      agent_id: "claude",
      principal_id: "p",
      shelf_id: "s",
    });
    const work = flagged!.correction_work![1];
    store.claimMemoryCorrection({
      id: "m",
      snapshot_digest: work!.snapshot_digest,
      lease_ms: 1_000,
      agent_id: "worker",
    });
    writes = 0;

    const applied = store.applyMemoryCorrection({
      id: "m",
      snapshot_digest: work!.snapshot_digest,
      claim_attempt: 1,
      spans: [
        { start: source.indexOf("Stale."), end: source.indexOf("Stale.") + 6, quote: "Stale." },
      ],
    });

    expect(writes).toBe(1);
    expect(applied!.body).toBe("Keep.  Useful.");
    expect(applied!.tags).toEqual(["retained"]);
    expect(applied!.status).toBe("active");
    expect(applied!.flags).toEqual([]);
    expect(applied!.correction_work![1]).toMatchObject({ status: "applied", applied_at: NOW });
  });

  it("refuses forged spans without changing the source or its flags", () => {
    const { store, seed } = setup();
    seed({ id: "m", body: "Keep. Stale fact." });
    const flagged = store.flagMemoryForCorrection({
      id: "m",
      reason: "The second sentence is outdated.",
      agent_id: "codex",
      principal_id: "p",
      shelf_id: "s",
    });
    const work = flagged!.correction_work![0];
    store.claimMemoryCorrection({ id: "m", snapshot_digest: work!.snapshot_digest });

    expect(
      store.applyMemoryCorrection({
        id: "m",
        snapshot_digest: work!.snapshot_digest,
        claim_attempt: 1,
        spans: [{ start: 0, end: 4, quote: "fake" }],
      }),
    ).toBeNull();
    expect(store.getMemory("m")!.body).toBe("Keep. Stale fact.");
    expect(store.getMemory("m")!.flags).toHaveLength(1);
    expect(store.getMemory("m")!.correction_work![0].status).toBe("processing");
  });

  it("does not apply a direct correction to a protected memory", () => {
    const { store, seed } = setup();
    seed({ id: "m", body: "Keep. Stale fact.", requires_approval: true });
    const flagged = store.flagMemoryForCorrection({
      id: "m",
      reason: "The second sentence is outdated.",
      agent_id: "codex",
      principal_id: "p",
      shelf_id: "s",
    });
    const work = flagged!.correction_work![0];
    store.claimMemoryCorrection({ id: "m", snapshot_digest: work!.snapshot_digest });

    expect(
      store.applyMemoryCorrection({
        id: "m",
        snapshot_digest: work!.snapshot_digest,
        claim_attempt: 1,
        spans: [{ start: 6, end: 17, quote: "Stale fact." }],
      }),
    ).toBeNull();
    expect(store.getMemory("m")!.body).toBe("Keep. Stale fact.");
    expect(store.getMemory("m")!.flags).toHaveLength(1);
    expect(store.getMemory("m")!.correction_work![0].status).toBe("processing");
  });

  it("fences off a worker whose expired lease was reclaimed", () => {
    let currentTime = NOW;
    const { store, seed } = setup({ now: () => currentTime });
    seed({ id: "m", body: "source" });
    const flagged = store.flagMemoryForCorrection({
      id: "m",
      reason: "outdated",
      agent_id: "codex",
      principal_id: "p",
      shelf_id: "s",
    });
    const snapshot = flagged!.correction_work![0].snapshot_digest;
    expect(
      store.claimMemoryCorrection({
        id: "m",
        snapshot_digest: snapshot,
        lease_ms: 1_000,
        agent_id: "worker",
      })?.attempt_count,
    ).toBe(1);

    currentTime = "2026-07-01T00:00:02.000Z";
    expect(
      store.claimMemoryCorrection({
        id: "m",
        snapshot_digest: snapshot,
        lease_ms: 1_000,
        agent_id: "worker",
      })?.attempt_count,
    ).toBe(2);
    expect(
      store.updateMemoryCorrectionWork({
        id: "m",
        snapshot_digest: snapshot,
        claim_attempt: 1,
        patch: { status: "manual_review", reason_code: "stale_worker" },
      }),
    ).toBeNull();
    expect(
      store.updateMemoryCorrectionWork({
        id: "m",
        snapshot_digest: snapshot,
        claim_attempt: 2,
        patch: { status: "manual_review", reason_code: "current_worker" },
      }),
    ).toMatchObject({ status: "manual_review", attempt_count: 2 });
  });

  it("recovers a processing marker with a missing lease", () => {
    const { store, vault, seed } = setup();
    seed({ id: "m", body: "source" });
    const flagged = store.flagMemoryForCorrection({
      id: "m",
      reason: "outdated",
      agent_id: "codex",
      principal_id: "p",
      shelf_id: "s",
    });
    const [queued] = flagged!.correction_work!;
    const { lease_expires_at: _lease, ...withoutLease } = queued;
    const memory = store.getMemory("m")!;
    vault.writeText(
      "memories/m.md",
      serializeMemoryDocument({
        ...memory,
        correction_work: [{ ...withoutLease, status: "processing", attempt_count: 1 }],
      }),
    );

    expect(store.listDueMemoryCorrections(NOW)).toHaveLength(1);
    expect(
      store.claimMemoryCorrection({
        id: "m",
        snapshot_digest: queued.snapshot_digest,
        lease_ms: 1_000,
        agent_id: "worker",
      }),
    ).toMatchObject({ status: "processing", attempt_count: 2 });
  });

  it("dismiss cancels active correction work in the same write that clears flags", () => {
    let writes = 0;
    const { store, seed } = setup({ onWrite: () => writes++ });
    seed({ id: "m" });
    const flagged = store.flagMemoryForCorrection({
      id: "m",
      reason: "outdated",
      agent_id: "codex",
      principal_id: "p",
      shelf_id: "s",
    });
    const snapshot = flagged!.correction_work![0].snapshot_digest;
    store.claimMemoryCorrection({
      id: "m",
      snapshot_digest: snapshot,
      lease_ms: 1_000,
      agent_id: "worker",
    });
    writes = 0;

    const dismissed = store.resolveFlags("m", "dashboard");

    expect(writes).toBe(1);
    expect(dismissed!.flags).toEqual([]);
    expect(dismissed!.correction_work![0]).toMatchObject({
      status: "cancelled",
      reason_code: "cancelled_by_dismiss",
    });
    expect(dismissed!.correction_work![0].lease_expires_at).toBeUndefined();
  });

  it("archives and resolves a flagged memory while cancelling work in one write", () => {
    let writes = 0;
    const { store, seed } = setup({ onWrite: () => writes++ });
    seed({ id: "m" });
    store.flagMemoryForCorrection({
      id: "m",
      reason: "outdated",
      agent_id: "codex",
      principal_id: "p",
      shelf_id: "s",
    });
    writes = 0;

    const archived = store.archiveFlaggedMemory("m", "dashboard");

    expect(writes).toBe(1);
    expect(archived!.status).toBe("archived");
    expect(archived!.flags).toEqual([]);
    expect(archived!.correction_work![0]).toMatchObject({
      status: "cancelled",
      reason_code: "cancelled_by_archive",
    });
  });

  it("creates one source-and-flag-snapshot-bound single-target proposal", () => {
    const { store, seed } = setup();
    seed({ id: "m", body: "Useful fact. Stale fact." });
    const flagged = store.flagMemoryForCorrection({
      id: "m",
      reason: "The second claim is no longer true.",
      agent_id: "codex",
      principal_id: "principal-1",
      shelf_id: "shelf-1",
    });
    const work = flagged!.correction_work![0]!;
    const claimed = store.claimMemoryCorrection({
      id: "m",
      snapshot_digest: work.snapshot_digest,
    })!;
    const source = store.getMemory("m")!;
    const start = source.body.indexOf("Stale fact.");
    const span = { start, end: start + "Stale fact.".length, quote: "Stale fact." };
    const proposedBody = source.body.slice(0, start) + source.body.slice(span.end);
    const input = {
      source_memory_id: "m",
      snapshot_digest: claimed.snapshot_digest,
      source_digest: claimed.source_digest,
      flags_digest: claimed.flags_digest,
      claim_attempt: claimed.attempt_count,
      shelf_id: "shelf-1",
      proposed_body: proposedBody,
      spans: [span],
      confidence: 0.4,
      rationale: "The flagged statement may be outdated.",
      agent_id: "system-memory-curator",
    };

    const proposal = store.createMemoryCorrectionProposal(input);
    const reused = store.createMemoryCorrectionProposal(input);

    expect(proposal).toMatchObject({
      status: "proposed",
      body: proposedBody.trim(),
      curator_note: {
        source: "flagged_correction",
        proposed_action: "update",
        supersedes: ["m"],
        correction: {
          source_memory_id: "m",
          source_shelf_id: "shelf-1",
          snapshot_digest: claimed.snapshot_digest,
          source_digest: claimed.source_digest,
          flags_digest: claimed.flags_digest,
        },
      },
    });
    expect(reused?.id).toBe(proposal?.id);
    expect(
      store.getMemoryCorrectionProposal({
        source_memory_id: "m",
        snapshot_digest: work.snapshot_digest,
      })?.id,
    ).toBe(proposal?.id);
    expect(store.getMemory("m")).toMatchObject({
      status: "active",
      body: source.body,
      flags: source.flags,
    });
  });

  it("refuses correction proposals after source drift or for a forged replacement", () => {
    const { store, seed } = setup();
    seed({ id: "m", body: "Useful fact. Stale fact." });
    const flagged = store.flagMemoryForCorrection({
      id: "m",
      reason: "The second claim is stale.",
      agent_id: "codex",
      principal_id: "principal-1",
      shelf_id: "shelf-1",
    });
    const work = flagged!.correction_work![0]!;
    const claimed = store.claimMemoryCorrection({
      id: "m",
      snapshot_digest: work.snapshot_digest,
    })!;
    const source = store.getMemory("m")!;
    const start = source.body.indexOf("Stale fact.");
    const span = { start, end: start + "Stale fact.".length, quote: "Stale fact." };
    const base = {
      source_memory_id: "m",
      snapshot_digest: claimed.snapshot_digest,
      source_digest: claimed.source_digest,
      flags_digest: claimed.flags_digest,
      claim_attempt: claimed.attempt_count,
      shelf_id: "shelf-1",
      proposed_body: "forged replacement",
      spans: [span],
      confidence: 0.4,
      rationale: "Outdated.",
      agent_id: "system-memory-curator",
    };

    expect(store.createMemoryCorrectionProposal(base)).toBeNull();
    store.updateMemory("m", { body: "Changed while model was working." });
    expect(
      store.createMemoryCorrectionProposal({
        ...base,
        proposed_body: source.body.slice(0, start) + source.body.slice(span.end),
      }),
    ).toBeNull();
    expect(store.listMemories({ status: "proposed" }).total).toBe(0);
  });

  it("approves a correction proposal only on its reviewed shelf and finalizes source history", () => {
    const { store, seed } = setup();
    const { proposal, source } = createReadyCorrectionProposal(store, seed);

    expect(
      store.inspectMemoryCorrectionProposal({ proposal_id: proposal.id, shelf_id: "shelf-1" }),
    ).toMatchObject({ status: "ready", source_memory_id: source.id, shelf_id: "shelf-1" });
    expect(() => store.approveProposal(proposal.id)).toThrow(/exact-shelf correction review/);
    expect(() => store.resolveProposal(proposal.id, "resolved_via_chat")).toThrow(
      /approved or rejected directly/,
    );

    const approved = store.approveMemoryCorrectionProposal({
      proposal_id: proposal.id,
      shelf_id: "shelf-1",
      agent_id: "dashboard-admin",
    });

    expect(approved).toMatchObject({ id: proposal.id, status: "active" });
    expect(store.getMemory(source.id)).toMatchObject({ status: "archived", flags: [] });
    expect(store.getMemory(source.id)?.correction_work?.[0]).toMatchObject({
      status: "applied",
      proposal_id: proposal.id,
      applied_at: NOW,
    });
  });

  it("withdraws an older correction proposal when a newer flag snapshot is approved", () => {
    const { store, seed } = setup();
    const { proposal: earlierProposal } = createReadyCorrectionProposal(store, seed);
    const flagged = store.flagMemoryForCorrection({
      id: "source",
      reason: "The newer flag identifies another outdated claim.",
      agent_id: "codex",
      principal_id: "principal-1",
      shelf_id: "shelf-1",
    })!;
    const work = flagged.correction_work!.at(-1)!;
    const claimed = store.claimMemoryCorrection({
      id: "source",
      snapshot_digest: work.snapshot_digest,
    })!;
    const source = store.getMemory("source")!;
    const quote = "Stale fact.";
    const start = source.body.indexOf(quote);
    const span = { start, end: start + quote.length, quote };
    const nextProposal = store.createMemoryCorrectionProposal({
      source_memory_id: source.id,
      snapshot_digest: claimed.snapshot_digest,
      source_digest: claimed.source_digest,
      flags_digest: claimed.flags_digest,
      claim_attempt: claimed.attempt_count,
      shelf_id: "shelf-1",
      proposed_body: source.body.slice(0, span.start) + source.body.slice(span.end),
      spans: [span],
      confidence: 0.2,
      rationale: "The stale claim remains incorrect.",
      agent_id: "system-memory-curator",
    })!;
    store.updateMemoryCorrectionWork({
      id: source.id,
      snapshot_digest: claimed.snapshot_digest,
      claim_attempt: claimed.attempt_count,
      patch: { status: "proposal_pending", proposal_id: nextProposal.id },
    });

    const approved = store.approveMemoryCorrectionProposal({
      proposal_id: nextProposal.id,
      shelf_id: "shelf-1",
      agent_id: "dashboard-admin",
    });

    expect(approved).toMatchObject({ id: nextProposal.id, status: "active" });
    expect(store.getMemory(source.id)).toMatchObject({ status: "archived", flags: [] });
    expect(store.getMemory(earlierProposal.id)).toMatchObject({
      status: "archived",
      curator_note: { resolution: `superseded_by_approval:${nextProposal.id}` },
    });
  });

  it("blocks correction approval after source or proposal content drift", () => {
    const { store, seed } = setup();
    const { proposal, source } = createReadyCorrectionProposal(store, seed);
    store.updateMemory(source.id, { body: "Changed after proposal creation." });

    expect(
      store.inspectMemoryCorrectionProposal({ proposal_id: proposal.id, shelf_id: "shelf-1" }),
    ).toMatchObject({ status: "blocked", reason_code: "correction_content_drifted" });
    expect(() =>
      store.approveMemoryCorrectionProposal({ proposal_id: proposal.id, shelf_id: "shelf-1" }),
    ).toThrow(/cannot be approved/);
    expect(store.getMemory(source.id)).toMatchObject({
      status: "active",
      flags: [{ reason: expect.any(String) }],
    });
    expect(store.getMemory(proposal.id)?.status).toBe("proposed");
  });

  it("rejecting a correction proposal leaves the flagged source for manual review", () => {
    const { store, seed } = setup();
    const { proposal, source } = createReadyCorrectionProposal(store, seed);

    expect(
      store.rejectMemoryCorrectionProposal({
        proposal_id: proposal.id,
        shelf_id: "shelf-1",
        agent_id: "dashboard-admin",
      }),
    ).toMatchObject({ status: "archived" });
    expect(store.getMemory(source.id)).toMatchObject({
      status: "active",
      flags: [{ reason: expect.any(String) }],
    });
    expect(store.getMemory(source.id)?.correction_work?.[0]).toMatchObject({
      status: "manual_review",
      reason_code: "correction_proposal_rejected",
      proposal_id: proposal.id,
    });
  });

  it("recovers approval when the proposal write lands but source finalization is interrupted", () => {
    const { vault, store, seed } = setup();
    const { proposal, source } = createReadyCorrectionProposal(store, seed);
    const originalWrite = vault.writeText.bind(vault);
    let writes = 0;
    const writeSpy = vi.spyOn(vault, "writeText").mockImplementation((relativePath, text) => {
      writes += 1;
      if (writes === 2) throw new Error("source write interrupted");
      return originalWrite(relativePath, text);
    });

    expect(() =>
      store.approveMemoryCorrectionProposal({
        proposal_id: proposal.id,
        shelf_id: "shelf-1",
        agent_id: "dashboard-admin",
      }),
    ).toThrow("source write interrupted");
    writeSpy.mockRestore();

    expect(store.getMemory(proposal.id)).toMatchObject({
      status: "active",
      curator_note: { correction: { review_outcome: "approved", reviewed_at: NOW } },
    });
    expect(store.getMemory(source.id)).toMatchObject({
      status: "active",
      flags: [{ reason: expect.any(String) }],
      correction_work: [{ status: "proposal_pending", proposal_id: proposal.id }],
    });

    const recoveredStore = createMarkdownMemoryStore({
      vault: createVault({ dataDir }),
      now: () => NOW,
    });
    expect(recoveredStore.listDueMemoryCorrections(NOW)).toHaveLength(1);
    expect(
      recoveredStore.reconcileMemoryCorrectionProposalResolution({
        source_memory_id: source.id,
        proposal_id: proposal.id,
        snapshot_digest: source.correction_work![0]!.snapshot_digest,
        shelf_id: "shelf-1",
        agent_id: "system-memory-curator",
      }),
    ).toMatchObject({ status: "applied", applied_at: NOW });
    expect(recoveredStore.getMemory(source.id)).toMatchObject({ status: "archived", flags: [] });
  });

  it("leaves an interrupted approval flagged for manual review if its source drifts before recovery", () => {
    const { vault, store, seed } = setup();
    const { proposal, source } = createReadyCorrectionProposal(store, seed);
    const originalWrite = vault.writeText.bind(vault);
    let writes = 0;
    const writeSpy = vi.spyOn(vault, "writeText").mockImplementation((relativePath, text) => {
      writes += 1;
      if (writes === 2) throw new Error("source write interrupted");
      return originalWrite(relativePath, text);
    });

    expect(() =>
      store.approveMemoryCorrectionProposal({
        proposal_id: proposal.id,
        shelf_id: "shelf-1",
        agent_id: "dashboard-admin",
      }),
    ).toThrow("source write interrupted");
    writeSpy.mockRestore();
    store.updateMemory(source.id, { body: "The source changed after approval was recorded." });

    const recoveredStore = createMarkdownMemoryStore({
      vault: createVault({ dataDir }),
      now: () => NOW,
    });
    expect(
      recoveredStore.reconcileMemoryCorrectionProposalResolution({
        source_memory_id: source.id,
        proposal_id: proposal.id,
        snapshot_digest: source.correction_work![0]!.snapshot_digest,
        shelf_id: "shelf-1",
        agent_id: "system-memory-curator",
      }),
    ).toMatchObject({
      status: "manual_review",
      reason_code: "correction_proposal_resolution_drifted",
    });
    expect(recoveredStore.getMemory(source.id)).toMatchObject({
      status: "active",
      body: "The source changed after approval was recorded.",
      flags: [{ reason: expect.any(String) }],
    });
  });

  it("recovers rejection when the proposal write lands but source finalization is interrupted", () => {
    const { vault, store, seed } = setup();
    const { proposal, source } = createReadyCorrectionProposal(store, seed);
    const originalWrite = vault.writeText.bind(vault);
    let writes = 0;
    const writeSpy = vi.spyOn(vault, "writeText").mockImplementation((relativePath, text) => {
      writes += 1;
      if (writes === 2) throw new Error("source write interrupted");
      return originalWrite(relativePath, text);
    });

    expect(() =>
      store.rejectMemoryCorrectionProposal({
        proposal_id: proposal.id,
        shelf_id: "shelf-1",
        agent_id: "dashboard-admin",
      }),
    ).toThrow("source write interrupted");
    writeSpy.mockRestore();

    expect(store.getMemory(proposal.id)).toMatchObject({
      status: "archived",
      curator_note: { correction: { review_outcome: "rejected", reviewed_at: NOW } },
    });
    expect(store.getMemory(source.id)?.correction_work?.[0]?.status).toBe("proposal_pending");

    const recoveredStore = createMarkdownMemoryStore({
      vault: createVault({ dataDir }),
      now: () => NOW,
    });
    expect(recoveredStore.listDueMemoryCorrections(NOW)).toHaveLength(1);
    expect(
      recoveredStore.reconcileMemoryCorrectionProposalResolution({
        source_memory_id: source.id,
        proposal_id: proposal.id,
        snapshot_digest: source.correction_work![0]!.snapshot_digest,
        shelf_id: "shelf-1",
        agent_id: "system-memory-curator",
      }),
    ).toMatchObject({ status: "manual_review", reason_code: "correction_proposal_rejected" });
    expect(recoveredStore.getMemory(source.id)).toMatchObject({
      status: "active",
      flags: [{ reason: expect.any(String) }],
    });
  });

  it("refuses to approve after dismiss cancels the proposal's source snapshot", () => {
    const { store, seed } = setup();
    const { proposal, source } = createReadyCorrectionProposal(store, seed);
    store.resolveFlags(source.id, "dashboard-admin");

    expect(
      store.inspectMemoryCorrectionProposal({ proposal_id: proposal.id, shelf_id: "shelf-1" }),
    ).toMatchObject({ status: "blocked" });
    expect(() =>
      store.approveMemoryCorrectionProposal({ proposal_id: proposal.id, shelf_id: "shelf-1" }),
    ).toThrow(/cannot be approved/);
    expect(store.getMemory(source.id)).toMatchObject({
      status: "active",
      flags: [],
      correction_work: [{ status: "cancelled", reason_code: "cancelled_by_dismiss" }],
    });
  });

  it("reclaims only expired processing work and refuses a changed source snapshot", () => {
    let currentTime = NOW;
    const { store, seed } = setup({ now: () => currentTime });
    seed({ id: "m", body: "original" });
    const flagged = store.flagMemoryForCorrection({
      id: "m",
      reason: "outdated",
      agent_id: "codex",
      principal_id: "p",
      shelf_id: "s",
    });
    const snapshot = flagged!.correction_work![0].snapshot_digest;

    expect(
      store.claimMemoryCorrection({
        id: "m",
        snapshot_digest: snapshot,
        lease_ms: 1_000,
        agent_id: "worker",
      }),
    ).toMatchObject({ status: "processing", attempt_count: 1 });
    expect(store.listDueMemoryCorrections(NOW)).toEqual([]);

    store.updateMemory("m", { body: "changed while inference was running" });
    expect(
      store.updateMemoryCorrectionWork({
        id: "m",
        snapshot_digest: snapshot,
        claim_attempt: 1,
        patch: { status: "manual_review" },
      }),
    ).toBeNull();
    expect(store.getMemory("m")!.correction_work![0].status).toBe("processing");

    currentTime = "2026-07-01T00:00:02.000Z";
    expect(store.listDueMemoryCorrections(currentTime)).toHaveLength(1);
    expect(
      store.claimMemoryCorrection({
        id: "m",
        snapshot_digest: snapshot,
        lease_ms: 1_000,
        agent_id: "worker",
      }),
    ).toBeNull();
    expect(store.getMemory("m")!.body).toBe("changed while inference was running");
    expect(store.getMemory("m")!.correction_work![0].status).toBe("manual_review");
  });
});

describe("markdown MemoryStore — resolveFlags", () => {
  it("clears the flags list and leaves status unchanged", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "active" });
    store.flagMemory("m", "wrong", "codex");
    store.flagMemory("m", "stale", "claude");
    const resolved = store.resolveFlags("m", "dashboard");
    expect(resolved!.flags).toEqual([]);
    expect(resolved!.status).toBe("active");
  });

  it("is a fail-soft no-op returning null for an unknown id", () => {
    const { store } = setup();
    expect(store.resolveFlags("ghost", "dashboard")).toBeNull();
  });
});

describe("markdown MemoryStore — listMemories has_open_flags filter", () => {
  it("returns only memories with at least one open flag when has_open_flags is true", () => {
    const { store, seed } = setup();
    seed({ id: "flagged", status: "active" });
    seed({ id: "clean", status: "active" });
    store.flagMemory("flagged", "wrong", "codex");

    const ids = store.listMemories({ has_open_flags: true }).memories.map((m) => m.id);
    expect(ids).toEqual(["flagged"]);
  });

  it("returns only memories with no open flags when has_open_flags is false", () => {
    const { store, seed } = setup();
    seed({ id: "flagged", status: "active" });
    seed({ id: "clean", status: "active" });
    store.flagMemory("flagged", "wrong", "codex");

    const ids = store.listMemories({ has_open_flags: false }).memories.map((m) => m.id);
    expect(ids).toEqual(["clean"]);
  });

  it("excludes a memory once its flags are resolved", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "active" });
    store.flagMemory("m", "wrong", "codex");
    expect(store.listMemories({ has_open_flags: true }).memories.map((m) => m.id)).toEqual(["m"]);
    store.resolveFlags("m", "dashboard");
    expect(store.listMemories({ has_open_flags: true }).memories).toEqual([]);
  });
});

describe("markdown MemoryStore — approveProposal", () => {
  it("approves a proposed memory to active, applying a patch", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "proposed", body: "draft" });
    const approved = store.approveProposal("m", "approve", { body: "reviewed" });
    expect(approved!.status).toBe("active");
    expect(approved!.body).toBe("reviewed");
  });

  it("rejects a proposed memory to archived", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "proposed" });
    expect(store.approveProposal("m", "reject")!.status).toBe("archived");
  });

  it("strips protected fields smuggled through an approve patch", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "proposed", requires_approval: true });
    const approved = store.approveProposal("m", "approve", {
      body: "reviewed",
      is_global: true,
      requires_approval: false,
    });
    expect(approved!.status).toBe("active");
    expect(approved!.body).toBe("reviewed");
    expect(approved!.is_global).toBe(false); // smuggled value dropped
    expect(approved!.requires_approval).toBe(true); // unchanged by the patch
  });

  it("throws when the memory is not proposed", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "active" });
    expect(() => store.approveProposal("m")).toThrow(/not proposed/);
  });

  it("throws for an unknown id", () => {
    const { store } = setup();
    expect(() => store.approveProposal("ghost")).toThrow(/No memory found/);
  });

  it("archives the superseded source when approving a proposed update", () => {
    const { store, seed } = setup();
    seed({ id: "t", status: "active", title: "fact", body: "old value" });
    seed({
      id: "p",
      status: "proposed",
      title: "fact",
      body: "new value",
      curator_note: { proposed_action: "update", supersedes: ["t"] },
    });
    const approved = store.approveProposal("p", "approve");
    expect(approved!.status).toBe("active");
    expect(store.getMemory("t")!.status).toBe("archived");
    // exactly one active memory remains for that fact
    expect(store.listMemories({ status: "active" }).total).toBe(1);
  });

  it("archives every source when approving a proposed merge", () => {
    const { store, seed } = setup();
    seed({ id: "a", status: "active" });
    seed({ id: "b", status: "active" });
    seed({ id: "c", status: "active" });
    seed({
      id: "p",
      status: "proposed",
      curator_note: { proposed_action: "merge", supersedes: ["a", "b", "c"] },
    });
    const approved = store.approveProposal("p", "approve");
    expect(approved!.status).toBe("active");
    expect(store.getMemory("a")!.status).toBe("archived");
    expect(store.getMemory("b")!.status).toBe("archived");
    expect(store.getMemory("c")!.status).toBe("archived");
  });

  it("archives the source when approving a proposed supersede", () => {
    const { store, seed } = setup();
    seed({ id: "s", status: "active" });
    seed({
      id: "p",
      status: "proposed",
      curator_note: { proposed_action: "supersede", supersedes: ["s"] },
    });
    store.approveProposal("p", "approve");
    expect(store.getMemory("s")!.status).toBe("archived");
  });

  it("leaves the source active when approving a proposed split replacement", () => {
    const { store, seed } = setup();
    seed({ id: "s", status: "active" });
    seed({
      id: "p",
      status: "proposed",
      curator_note: { proposed_action: "split", supersedes: ["s"] },
    });
    const approved = store.approveProposal("p", "approve");
    expect(approved!.status).toBe("active");
    expect(store.getMemory("s")!.status).toBe("active");
  });

  it("archives nothing when approving a proposed create with no supersedes", () => {
    const { store, seed } = setup();
    seed({ id: "o", status: "active" });
    seed({
      id: "p",
      status: "proposed",
      curator_note: { proposed_action: "create", source: "intake" },
    });
    const approved = store.approveProposal("p", "approve");
    expect(approved!.status).toBe("active");
    expect(store.getMemory("o")!.status).toBe("active");
  });

  it("is idempotent when a supersedes target is already archived", () => {
    const { store, seed } = setup();
    seed({ id: "t", status: "archived" });
    seed({
      id: "p",
      status: "proposed",
      curator_note: { proposed_action: "update", supersedes: ["t"] },
    });
    const approved = store.approveProposal("p", "approve");
    expect(approved!.status).toBe("active");
    expect(store.getMemory("t")!.status).toBe("archived");
  });

  it("threads the approving agent_id into the archive of the superseded source", () => {
    const { store, seed } = setup();
    seed({ id: "t", status: "active" });
    seed({
      id: "p",
      status: "proposed",
      curator_note: { proposed_action: "update", supersedes: ["t"] },
    });
    store.approveProposal("p", "approve", {}, "admin");
    expect(store.getMemory("t")!.status).toBe("archived");
  });

  it("leaves the superseded source untouched when rejecting", () => {
    const { store, seed } = setup();
    seed({ id: "t", status: "active" });
    seed({
      id: "p",
      status: "proposed",
      curator_note: { proposed_action: "update", supersedes: ["t"] },
    });
    expect(store.approveProposal("p", "reject")!.status).toBe("archived");
    expect(store.getMemory("t")!.status).toBe("active");
  });

  it("tolerates a non-array supersedes without throwing", () => {
    const { store, seed } = setup();
    seed({ id: "t", status: "active" });
    seed({
      id: "p",
      status: "proposed",
      curator_note: { proposed_action: "update", supersedes: "t" as unknown as string[] },
    });
    const approved = store.approveProposal("p", "approve");
    expect(approved!.status).toBe("active");
    expect(store.getMemory("t")!.status).toBe("active"); // bad shape → no archive
  });
});

// Proposal-review rework 2026-07-01 (D8/D9): resolving a proposal archives it
// AND stamps curator_note.resolution — how it left the queue ("applied_plan"
// when the persisted plan was executed, "resolved_via_chat" when a
// proposal-grounded chat action was confirmed). curator_note is not
// wire-patchable, so this is the one trusted seam that can write it.
describe("markdown MemoryStore — resolveProposal", () => {
  it("archives the proposal and stamps curator_note.resolution", () => {
    const { store, seed } = setup();
    seed({
      id: "p",
      status: "proposed",
      curator_note: { source: "intake", proposed_action: "augment", guessed_target_id: "t" },
    });
    const resolved = store.resolveProposal("p", "applied_plan");
    expect(resolved!.status).toBe("archived");
    expect(resolved!.curator_note).toMatchObject({
      source: "intake",
      proposed_action: "augment",
      resolution: "applied_plan",
    });
    // The stamp survives a re-read from disk.
    expect(store.getMemory("p")!.curator_note).toMatchObject({ resolution: "applied_plan" });
  });

  it("preserves a null curator_note by creating one holding only the resolution", () => {
    const { store, seed } = setup();
    seed({ id: "p", status: "proposed", curator_note: null });
    const resolved = store.resolveProposal("p", "resolved_via_chat");
    expect(resolved!.curator_note).toMatchObject({ resolution: "resolved_via_chat" });
  });

  it("throws when the memory is not proposed", () => {
    const { store, seed } = setup();
    seed({ id: "m", status: "active" });
    expect(() => store.resolveProposal("m", "applied_plan")).toThrow(/not proposed/);
  });

  it("throws for an unknown id", () => {
    const { store } = setup();
    expect(() => store.resolveProposal("ghost", "applied_plan")).toThrow(/No memory found/);
  });

  it("never archives supersedes sources (unlike approve — the plan mutation already happened)", () => {
    const { store, seed } = setup();
    seed({ id: "t", status: "active" });
    seed({
      id: "p",
      status: "proposed",
      curator_note: { proposed_action: "update", supersedes: ["t"] },
    });
    store.resolveProposal("p", "applied_plan");
    expect(store.getMemory("t")!.status).toBe("active");
  });
});
