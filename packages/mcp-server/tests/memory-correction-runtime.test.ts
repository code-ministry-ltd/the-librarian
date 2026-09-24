import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createLibrarianStore,
  parseMemoryDocument,
  serializeMemoryDocument,
  type Principal,
} from "@librarian/core";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryCorrectionRuntime } from "../dist/memory-correction-runtime.js";

const dataDirs: string[] = [];
const stores: ReturnType<typeof createLibrarianStore>[] = [];
const runtimes: Array<ReturnType<typeof createMemoryCorrectionRuntime>> = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.drain();
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      /* ignore cleanup errors */
    }
  }
  for (const dataDir of dataDirs.splice(0)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

function setup(pollMs = 60_000) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-correction-runtime-"));
  dataDirs.push(dataDir);
  const store = createLibrarianStore({ dataDir });
  stores.push(store);
  const runtime = createMemoryCorrectionRuntime(store, pollMs);
  runtimes.push(runtime);
  return { store, runtime };
}

describe("flagged-memory correction runtime", () => {
  it("recovers an approved proposal whose source write was interrupted, even when Grooming is disabled", async () => {
    const { store, runtime } = setup();
    const principal: Principal = { kind: "agent", actorId: "claude", roles: ["agent"] };
    const { memory } = store.createMemory({
      agent_id: principal.actorId,
      title: "Mixed fact",
      body: "Useful fact. Stale fact.",
    });
    const flagged = store.flagMemoryForCorrection({
      id: memory.id,
      reason: "The second claim is outdated.",
      agent_id: principal.actorId,
      principal_id: principal.actorId,
      shelf_id: "main",
    });
    const work = flagged!.correction_work!.at(-1)!;
    const claimed = store.claimMemoryCorrection({
      id: memory.id,
      snapshot_digest: work.snapshot_digest,
    })!;
    const source = store.getMemory(memory.id)!;
    const start = source.body.indexOf("Stale fact.");
    const span = { start, end: start + "Stale fact.".length, quote: "Stale fact." };
    const proposal = store.createMemoryCorrectionProposal({
      source_memory_id: source.id,
      snapshot_digest: claimed.snapshot_digest,
      source_digest: claimed.source_digest,
      flags_digest: claimed.flags_digest,
      claim_attempt: claimed.attempt_count,
      shelf_id: "main",
      proposed_body: source.body.slice(0, start) + source.body.slice(span.end),
      spans: [span],
      confidence: 0.2,
      rationale: "The second claim may be stale.",
      agent_id: "system-memory-curator",
    })!;
    store.updateMemoryCorrectionWork({
      id: source.id,
      snapshot_digest: claimed.snapshot_digest,
      claim_attempt: claimed.attempt_count,
      patch: { status: "proposal_pending", proposal_id: proposal.id },
    });
    const sourceBeforeApproval = store.getMemory(source.id)!;
    store.approveMemoryCorrectionProposal({
      proposal_id: proposal.id,
      shelf_id: "main",
      agent_id: "dashboard-admin",
    });

    // Simulate restart after the proposal's terminal write but before the
    // source document's finalization write.
    const memoriesDir = path.join(dataDirs.at(-1)!, "vault", "memories");
    const sourcePath = fs
      .readdirSync(memoriesDir)
      .map((file) => path.join(memoriesDir, file))
      .find((file) => parseMemoryDocument(fs.readFileSync(file, "utf8")).id === source.id);
    expect(sourcePath).toBeTruthy();
    fs.writeFileSync(sourcePath!, serializeMemoryDocument(sourceBeforeApproval));

    runtime.scheduler.start();
    runtime.wake({
      memory_id: source.id,
      snapshot_digest: claimed.snapshot_digest,
      principal,
    });

    await expect
      .poll(() => store.getMemory(source.id)?.correction_work?.at(-1)?.status)
      .toBe("applied");
    expect(store.getMemory(source.id)).toMatchObject({ status: "archived", flags: [] });
  });

  it("polls a persisted flag marker when the post-persist wake was missed", async () => {
    const { store, runtime } = setup(5);
    const principal: Principal = { kind: "agent", actorId: "claude", roles: ["agent"] };
    const { memory } = store.createMemory({
      agent_id: principal.actorId,
      title: "Old fact",
      body: "The old fact is no longer true.",
    });
    const flagged = store.flagMemoryForCorrection({
      id: memory.id,
      reason: "this is outdated",
      agent_id: principal.actorId,
      principal_id: principal.actorId,
      shelf_id: "main",
    });
    const work = flagged?.correction_work?.at(-1);
    expect(work?.status).toBe("pending");

    // A handler may catch a commit error after the marker lands and return before
    // issuing its wake; the durable poll must still discover and process the work.
    runtime.scheduler.start();

    await expect
      .poll(() => store.getMemory(memory.id)?.correction_work?.at(-1)?.status)
      .toBe("manual_review");
    expect(store.getMemory(memory.id)?.correction_work?.at(-1)).toMatchObject({
      status: "manual_review",
      reason_code: "grooming_disabled",
    });
    expect(store.getMemory(memory.id)?.status).toBe("active");
  });
});
