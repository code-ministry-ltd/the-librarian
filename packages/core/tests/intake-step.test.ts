// Intake per-item orchestrator (plan 036 Phase 4 / spec 035 §F5). Drives
// the whole pipeline over one inbox item against a REAL temp vault + fakes:
// claim → parse → navigate → judge → apply → complete. No network (fake LLM),
// no real index (fake recall/listActive).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type IntakeApplyStore,
  type LlmClient,
  type Vault,
  claimInboxItem,
  intakeInboxItem,
  createVault,
  listInbox,
  writeInbox,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let vault: Vault;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-file-"));
  vault = createVault({ dataDir });
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function fakeStore(seed: Record<string, { title: string; body: string }> = {}) {
  const docs = new Map(Object.entries(seed));
  const calls = {
    create: [] as Record<string, unknown>[],
    update: [] as { id: string; patch?: Record<string, unknown> }[],
    archive: [] as string[],
  };
  let n = 0;
  const store: IntakeApplyStore = {
    createMemory: (input) => {
      calls.create.push(input);
      return { memory: { id: `mem_${n++}` } };
    },
    updateMemory: (id, patch) => {
      calls.update.push({ id, ...(patch ? { patch } : {}) });
      return null;
    },
    archiveMemory: (id) => {
      calls.archive.push(id);
      return null;
    },
    flagMemory: () => null,
    getMemory: (id) => docs.get(id) ?? null,
  };
  return { store, calls };
}

function fakeClient(content: string): LlmClient {
  return { complete: async () => ({ content, model: "gpt-x", usage: null }) };
}

function baseDeps(store: IntakeApplyStore, llmClient: LlmClient) {
  return {
    vault,
    recall: async () => [],
    listActive: () => [],
    llmClient,
    store,
    actorId: "system-consolidator",
  };
}

describe("intakeInboxItem", () => {
  it("files an item end-to-end: claim → judge → apply → complete", async () => {
    const ref = writeInbox(vault, "Elaine moved to Berlin.", {
      now: () => 1000,
      generateId: () => "inbox_a",
    });
    const { store, calls } = fakeStore();
    const client = fakeClient(
      JSON.stringify({
        action: "create",
        title: "Elaine",
        body: "Elaine lives in Berlin.",
        tags: ["person"],
        rationale: "novel topic",
        confidence: 0.97,
      }),
    );

    const result = await intakeInboxItem(ref.relPath, baseDeps(store, client));

    expect(result).toMatchObject({ status: "consolidated", outcome: { kind: "created" } });
    expect(calls.create[0]).toMatchObject({ title: "Elaine", body: "Elaine lives in Berlin." });
    // The item was completed — gone from the inbox, no stale claim left.
    expect(listInbox(vault)).toEqual([]);
    expect(vault.listMarkdown("inbox/.processing")).toEqual([]);
  });

  it("returns claimed_by_other when the item is already claimed", async () => {
    const ref = writeInbox(vault, "x", { now: () => 1000, generateId: () => "inbox_a" });
    claimInboxItem(vault, ref.relPath, { now: () => 2000 }); // someone else won it
    const { store } = fakeStore();
    const result = await intakeInboxItem(ref.relPath, baseDeps(store, fakeClient("{}")));
    expect(result).toEqual({ status: "claimed_by_other" });
  });

  it("leaves the claim for retry on an unusable model response (judge_error)", async () => {
    const ref = writeInbox(vault, "some fact", { now: () => 1000, generateId: () => "inbox_a" });
    const { store, calls } = fakeStore();
    const result = await intakeInboxItem(
      ref.relPath,
      baseDeps(store, fakeClient("not json at all")),
    );

    expect(result.status).toBe("judge_error");
    expect(calls.create.length).toBe(0); // nothing applied
    // Not completed — still claimed in .processing for the reaper to retry.
    expect(vault.listMarkdown("inbox/.processing").length).toBe(1);
    expect(listInbox(vault)).toEqual([]); // not back in pending yet (reaper's job)
  });

  it("routes a low-confidence augment to a proposed doc rather than touching the target (D13)", async () => {
    const ref = writeInbox(vault, "Maybe Elaine likes tea.", {
      now: () => 1000,
      generateId: () => "inbox_a",
    });
    const { store, calls } = fakeStore();
    // augment at 0.5 → below the single 0.8 threshold → PROPOSED (S12).
    const client = fakeClient(
      JSON.stringify({
        action: "augment",
        target_id: "mem_elaine",
        addition: "likes tea",
        rationale: "uncertain",
        confidence: 0.5,
      }),
    );

    const result = await intakeInboxItem(ref.relPath, baseDeps(store, client));

    expect(result).toMatchObject({ status: "consolidated", outcome: { kind: "proposed" } });
    expect(calls.create[0]).toMatchObject({ body: "Maybe Elaine likes tea." });
    expect(calls.update.length).toBe(0); // the target was NOT touched
  });

  it("applies a high-confidence augment via updateMemory (appended body) and completes", async () => {
    const ref = writeInbox(vault, "Elaine moved to Berlin", {
      now: () => 1000,
      generateId: () => "inbox_a",
    });
    const { store, calls } = fakeStore({
      mem_elaine: { title: "Elaine", body: "Lives in Paris." },
    });
    const client = fakeClient(
      JSON.stringify({
        action: "augment",
        target_id: "mem_elaine",
        addition: "Now in [[Berlin]].",
        rationale: "adds the move",
        confidence: 0.97,
      }),
    );

    const result = await intakeInboxItem(ref.relPath, baseDeps(store, client));

    expect(result).toMatchObject({
      status: "consolidated",
      outcome: { kind: "augmented", id: "mem_elaine" },
    });
    const body = String(calls.update[0]?.patch?.body ?? "");
    expect(body.startsWith("Lives in Paris.")).toBe(true); // no-clobber
    expect(body).toContain("[[Berlin]]");
    expect(listInbox(vault)).toEqual([]); // completed
  });

  it("threads a deps-supplied promptAddendum into the judge prompt (spec 044 D-2, once-per-sweep)", async () => {
    // The addendum is read ONCE at the sweep/tick and threaded down through deps;
    // intakeInboxItem passes it into judgeSubmission so it reaches the prompt
    // (the OPERATOR GUIDANCE block) — it is NOT re-read per item here.
    const ref = writeInbox(vault, "some fact", { now: () => 1000, generateId: () => "inbox_a" });
    const { store } = fakeStore();
    let capturedPrompt = "";
    const capturingClient: LlmClient = {
      complete: async (request) => {
        capturedPrompt = request.messages.map((m) => m.content).join("\n");
        return {
          content: JSON.stringify({
            action: "create",
            title: "X",
            body: "Y",
            tags: [],
            rationale: "novel",
            confidence: 0.97,
          }),
          model: "gpt-x",
          usage: null,
        };
      },
    };

    const result = await intakeInboxItem(ref.relPath, {
      ...baseDeps(store, capturingClient),
      promptAddendum: "MARKER-ADDENDUM steer the filing",
    });

    expect(result).toMatchObject({ status: "consolidated" });
    expect(capturedPrompt).toContain("MARKER-ADDENDUM steer the filing");
  });

  it("threads a deps-supplied intakeExamples doc into the judge prompt (F4, once-per-sweep)", async () => {
    // Same once-per-sweep threading as the addendum: read at the tick, passed
    // down through deps, never re-read per item.
    const ref = writeInbox(vault, "some fact", { now: () => 1000, generateId: () => "inbox_a" });
    const { store } = fakeStore();
    let capturedPrompt = "";
    const capturingClient: LlmClient = {
      complete: async (request) => {
        capturedPrompt = request.messages.map((m) => m.content).join("\n");
        return {
          content: JSON.stringify({
            action: "create",
            title: "X",
            body: "Y",
            tags: [],
            rationale: "novel",
            confidence: 0.97,
          }),
          model: "gpt-x",
          usage: null,
        };
      },
    };

    const result = await intakeInboxItem(ref.relPath, {
      ...baseDeps(store, capturingClient),
      intakeExamples: "MARKER-EXAMPLES one-off TODOs get noop",
    });

    expect(result).toMatchObject({ status: "consolidated" });
    expect(capturedPrompt).toContain("MARKER-EXAMPLES one-off TODOs get noop");
  });

  it("emits no operator-guidance block when no promptAddendum is supplied (today's behaviour)", async () => {
    const ref = writeInbox(vault, "some fact", { now: () => 1000, generateId: () => "inbox_a" });
    const { store } = fakeStore();
    let capturedPrompt = "";
    const capturingClient: LlmClient = {
      complete: async (request) => {
        capturedPrompt = request.messages.map((m) => m.content).join("\n");
        return {
          content: JSON.stringify({
            action: "create",
            title: "X",
            body: "Y",
            tags: [],
            rationale: "novel",
            confidence: 0.97,
          }),
          model: "gpt-x",
          usage: null,
        };
      },
    };

    await intakeInboxItem(ref.relPath, baseDeps(store, capturingClient));

    expect(capturedPrompt).not.toContain("OPERATOR GUIDANCE");
  });

  it("completes (removes) the item even when apply rejects — a rejection is terminal", async () => {
    const ref = writeInbox(vault, "augment that", { now: () => 1000, generateId: () => "inbox_a" });
    const { store } = fakeStore(); // empty → the augment target is missing → rejected
    const result = await intakeInboxItem(
      ref.relPath,
      baseDeps(
        store,
        fakeClient(
          JSON.stringify({
            action: "augment",
            target_id: "ghost",
            addition: "x",
            rationale: "r",
            confidence: 0.99,
          }),
        ),
      ),
    );

    expect(result).toMatchObject({ status: "consolidated", outcome: { kind: "rejected" } });
    // Terminal: removed, NOT left in .processing for retry (the documented v1 tradeoff).
    expect(listInbox(vault)).toEqual([]);
    expect(vault.listMarkdown("inbox/.processing")).toEqual([]);
  });
});
