// Self-healing repair (spec 075 §5): split memories over the size cap, and recover
// facts an archived merge source holds that its successors lost. Real store, fake
// model; every operation runs through the ordinary grooming pipeline.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type LlmClient,
  REPAIR_LEDGER_KEY,
  createLibrarianStore,
  readRepairLedger,
  runRepair,
  selectRepairItems,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir = "";
let store: LibrarianStore;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-repair-"));
  store = createLibrarianStore({ dataDir });
});
afterEach(() => {
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const NOW = new Date("2026-10-12T03:00:00.000Z");
const para = (topic: string, n = 60): string =>
  Array.from({ length: n }, (_, i) => `${topic}${i % 25}`).join(" ");

function create(title: string, body: string, note?: Record<string, unknown>) {
  return store.createMemory(
    { agent_id: "agent-a", title, body },
    note ? { curator_note: note } : {},
  ).memory;
}

/** A memory over the cap with two clearly separate halves. */
function oversized(): { id: string; halves: [string, string] } {
  const first = `Elaine: piano-1984 lessons. ${para("elaine", 280)}`;
  const second = `Bob: boat-7c at mooring-44. ${para("bob", 280)}`;
  const memory = create("Elaine and Bob", `${first}\n\n${second}`);
  expect(memory.body.length).toBeGreaterThan(4000);
  return { id: memory.id, halves: [first, second] };
}

/** An archived source whose ports never made it into its active successor. */
function lostFacts(): { sourceId: string; successorId: string } {
  const source = create(
    "Baruch ports",
    "baruch-server listens on 8034; the warmup app uses silent-wav.mp3 under pm2-warmup.",
  );
  const successor = create("Marvin services", "Marvin runs several services.", {
    supersedes: [source.id],
  });
  store.archiveMemory(source.id);
  return { sourceId: source.id, successorId: successor.id };
}

function client(replies: unknown[]): LlmClient & { calls: number } {
  const c = {
    calls: 0,
    complete: async () => {
      const reply = replies[c.calls] ?? { operations: [] };
      c.calls++;
      return { content: JSON.stringify(reply), model: "m", usage: null };
    },
  };
  return c;
}

const run = (llmClient: LlmClient, threshold = 0) =>
  runRepair({
    store,
    ledgerStore: store,
    shelfId: "main",
    llmClient,
    actorId: "system-memory-curator",
    confidenceThreshold: threshold,
    model: { provider: "p", name: "m" },
    splitPerRun: 3,
    recoverPerRun: 5,
    now: NOW,
  });

describe("selectRepairItems", () => {
  it("offers oversized memories largest first, skipping masked or huge ones", () => {
    const small = create("Small", "short");
    const big = create("Big", para("big", 900));
    const bigger = create("Bigger", para("bigger", 1100));
    create("Secret", `${para("s", 900)} api_key="${"0123456789abcdef".repeat(2)}"`);
    create("Huge", para("huge", 12000)); // over 60,000 chars
    const { oversized } = selectRepairItems(store, {
      shelfId: "main",
      ledger: {},
      splitPerRun: 3,
      recoverPerRun: 0,
      now: NOW,
    });
    expect(oversized.map((o) => o.memory.id)).toEqual([bigger.id, big.id]);
    expect(oversized.map((o) => o.memory.id)).not.toContain(small.id);
  });

  it("offers an archived merge source whose specific terms survive nowhere, paired with its active successor", () => {
    const { sourceId, successorId } = lostFacts();
    const { recovery } = selectRepairItems(store, {
      shelfId: "main",
      ledger: {},
      splitPerRun: 0,
      recoverPerRun: 5,
      now: NOW,
    });
    expect(recovery).toHaveLength(1);
    expect(recovery[0]?.source.id).toBe(sourceId);
    expect(recovery[0]?.successors.map((m) => m.id)).toEqual([successorId]);
  });

  it("follows the chain through an archived intermediate to the active successor", () => {
    const { successorId } = lostFacts();
    const final = create("Marvin infrastructure", "All of Marvin's services.", {
      supersedes: [successorId],
    });
    store.archiveMemory(successorId);
    const { recovery } = selectRepairItems(store, {
      shelfId: "main",
      ledger: {},
      splitPerRun: 0,
      recoverPerRun: 5,
      now: NOW,
    });
    expect(recovery[0]?.successors.map((m) => m.id)).toEqual([final.id]);
  });

  it("skips a source whose detail is still present in an active memory", () => {
    const source = create("Ports", "baruch-server 8034, grafana 9126, strata 5808");
    create("Ports now", "baruch-server 8034, grafana 9126, strata 5808 — all on Marvin", {
      supersedes: [source.id],
    });
    store.archiveMemory(source.id);
    expect(
      selectRepairItems(store, {
        shelfId: "main",
        ledger: {},
        splitPerRun: 0,
        recoverPerRun: 5,
        now: NOW,
      }).recovery,
    ).toEqual([]);
  });

  it("does not re-offer an item judged on the same content, but does once it changes", () => {
    const big = create("Big", para("big", 900));
    const first = selectRepairItems(store, {
      shelfId: "main",
      ledger: {},
      splitPerRun: 3,
      recoverPerRun: 0,
      now: NOW,
    }).oversized[0];
    const ledger = {
      [`main:${big.id}`]: {
        outcome: "noop" as const,
        at: NOW.toISOString(),
        fingerprint: first!.fingerprint,
      },
    };
    const opts = { shelfId: "main", ledger, splitPerRun: 3, recoverPerRun: 0, now: NOW };
    expect(selectRepairItems(store, opts).oversized).toEqual([]);
    store.updateMemory(big.id, { body: para("changed", 900) });
    expect(selectRepairItems(store, opts).oversized).toHaveLength(1);
  });

  it("re-offers a refused item only after 30 days", () => {
    const big = create("Big", para("big", 900));
    const fingerprint = selectRepairItems(store, {
      shelfId: "main",
      ledger: {},
      splitPerRun: 3,
      recoverPerRun: 0,
      now: NOW,
    }).oversized[0]!.fingerprint;
    const ledger = {
      [`main:${big.id}`]: { outcome: "refused" as const, at: NOW.toISOString(), fingerprint },
    };
    const at = (days: number) => new Date(NOW.getTime() + days * 86_400_000);
    const sel = (now: Date) =>
      selectRepairItems(store, { shelfId: "main", ledger, splitPerRun: 3, recoverPerRun: 0, now });
    expect(sel(at(29)).oversized).toEqual([]);
    expect(sel(at(31)).oversized).toHaveLength(1);
  });
});

describe("runRepair", () => {
  it("does nothing — no run, no model call — when nothing is due", async () => {
    const llm = client([]);
    expect(await run(llm)).toBeNull();
    expect(llm.calls).toBe(0);
  });

  it("applies a lossless split of an oversized memory at threshold 0, stamping split_from", async () => {
    const { id, halves } = oversized();
    const llm = client([
      {
        operations: [
          {
            type: "split",
            source_memory_id: id,
            replacements: [
              { title: "Elaine", body: halves[0], visibility: "common" },
              { title: "Bob", body: halves[1], visibility: "common" },
            ],
            rationale: "two people",
            confidence: 0.9,
          },
        ],
      },
    ]);
    const result = await run(llm);
    expect(result?.trigger).toBe("repair");
    expect(store.getMemory(id)?.status).toBe("archived");
    const replacements = store.listAll({ status: "active" }).filter((m) => m.id !== id);
    expect(replacements.map((m) => m.title).sort()).toEqual(["Bob", "Elaine"]);
    for (const m of replacements) expect(m.curator_note?.split_from).toBe(id);
    expect(readRepairLedger(store)[`main:${id}`]?.outcome).toBe("applied");
  });

  it("refuses a split that loses detail, leaving the memory as it was", async () => {
    const { id } = oversized();
    const llm = client([
      {
        operations: [
          {
            type: "split",
            source_memory_id: id,
            replacements: [
              { title: "Elaine", body: "Elaine has lessons.", visibility: "common" },
              { title: "Bob", body: "Bob has a boat.", visibility: "common" },
            ],
            rationale: "two people",
            confidence: 0.9,
          },
        ],
      },
    ]);
    await run(llm);
    expect(store.getMemory(id)?.status).toBe("active");
    expect(readRepairLedger(store)[`main:${id}`]?.outcome).toBe("refused");
  });

  it("recovers lost facts by appending them to the successor", async () => {
    const { successorId } = lostFacts();
    const current = store.getMemory(successorId)!.body;
    const llm = client([
      {
        operations: [
          {
            type: "update",
            source_memory_id: successorId,
            patch: { body: `${current}\n\nbaruch-server listens on 8034.` },
            rationale: "port lost in the merge",
            confidence: 0.9,
          },
        ],
      },
    ]);
    await run(llm);
    expect(store.getMemory(successorId)!.body).toContain("baruch-server listens on 8034.");
  });

  it("refuses a recovery update that rewrites rather than adds", async () => {
    const { sourceId, successorId } = lostFacts();
    const llm = client([
      {
        operations: [
          {
            type: "update",
            source_memory_id: successorId,
            patch: { body: "baruch-server listens on 8034." },
            rationale: "rewrite",
            confidence: 0.9,
          },
        ],
      },
    ]);
    await run(llm);
    expect(store.getMemory(successorId)!.body).toBe("Marvin runs several services.");
    expect(readRepairLedger(store)[`main:${sourceId}`]?.outcome).toBe("refused");
  });

  it("remembers a noop so the same stale source is not offered again", async () => {
    const { sourceId } = lostFacts();
    const first = client([
      {
        operations: [
          { type: "noop", source_memory_ids: [], rationale: "stale ports", confidence: 0.9 },
        ],
      },
    ]);
    await run(first);
    expect(readRepairLedger(store)[`main:${sourceId}`]?.outcome).toBe("noop");
    const second = client([]);
    expect(await run(second)).toBeNull();
    expect(second.calls).toBe(0);
    expect(store.getSetting(REPAIR_LEDGER_KEY)).toContain(sourceId);
  });

  it("follows the threshold: below it, a repair becomes a proposal", async () => {
    const { id, halves } = oversized();
    const llm = client([
      {
        operations: [
          {
            type: "split",
            source_memory_id: id,
            replacements: [
              { title: "Elaine", body: halves[0], visibility: "common" },
              { title: "Bob", body: halves[1], visibility: "common" },
            ],
            rationale: "two people",
            confidence: 0.5,
          },
        ],
      },
    ]);
    await run(llm, 0.8);
    expect(store.getMemory(id)?.status).toBe("active");
    expect(store.listAll({ status: "proposed" })).toHaveLength(2);
    expect(readRepairLedger(store)[`main:${id}`]?.outcome).toBe("proposed");
  });

  it("refuses an operation its mode does not allow (a merge during a split repair)", async () => {
    const { id } = oversized();
    const other = create("Other", "x");
    const llm = client([
      {
        operations: [
          {
            type: "archive",
            source_memory_ids: [id],
            rationale: "nope",
            confidence: 0.9,
          },
        ],
      },
    ]);
    const result = await run(llm);
    expect(store.getMemory(id)?.status).toBe("active");
    expect(store.getMemory(other.id)?.status).toBe("active");
    expect(readRepairLedger(store)[`main:${id}`]?.outcome).toBe("refused");
    expect(store.getCurationOperations(result!.id)[0]?.rationale).toBe(
      "repair: operation type not allowed in this mode",
    );
  });

  it("records nothing when the model returns no operation, so the item is offered again", async () => {
    const { id } = oversized();
    await run(client([{ operations: [] }]));
    expect(readRepairLedger(store)[`main:${id}`]).toBeUndefined();
  });

  it("waits while another grooming run on the slice is live", async () => {
    oversized();
    const live = store.createCurationRun({
      trigger: "schedule",
      project_key: null,
      input_hash: "h",
    });
    store.startCurationRun(live.id);
    const llm = client([]);
    expect(
      await runRepair({
        store,
        ledgerStore: store,
        shelfId: "main",
        llmClient: llm,
        actorId: "system-memory-curator",
        confidenceThreshold: 0,
        model: { provider: "p", name: "m" },
        splitPerRun: 3,
        recoverPerRun: 5,
      }),
    ).toBeNull();
    expect(llm.calls).toBe(0);
  });
});
