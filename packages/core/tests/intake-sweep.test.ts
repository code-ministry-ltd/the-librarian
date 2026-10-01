// Intake inbox sweep (plan 036 Phase 4 / spec 035 §F5). Processes the
// whole inbox once over a real temp vault + fakes: reclaim stale claims, then
// FIFO over pending items via intakeInboxItem. Pins ordering, the reaper
// integration, and that one item's failure never aborts the rest.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type IntakeApplyStore,
  type LlmClient,
  LlmClientError,
  type LlmCompletionRequest,
  type Vault,
  claimInboxItem,
  createVault,
  listInbox,
  runIntakeSweep,
  writeInbox,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let vault: Vault;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-sweep-"));
  vault = createVault({ dataDir });
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const CREATE_JUDGMENT = JSON.stringify({
  action: "create",
  title: "T",
  body: "B",
  tags: [],
  rationale: "novel",
  confidence: 0.97,
});

function fakeStore(): IntakeApplyStore {
  let n = 0;
  return {
    createMemory: () => ({ memory: { id: `mem_${n++}` } }),
    updateMemory: () => null,
    archiveMemory: () => null,
    flagMemory: () => null,
    getMemory: () => null,
  };
}

/** A fake LLM that records the submission text from each prompt it's called with. */
function capturingClient(content: string): { client: LlmClient; submissions: string[] } {
  const submissions: string[] = [];
  return {
    client: {
      complete: async (req: LlmCompletionRequest) => {
        const user = req.messages[1]?.content ?? "";
        submissions.push(user.split("\n")[1] ?? ""); // the line under "SUBMISSION (...):"
        return { content, model: "gpt-x", usage: null };
      },
    },
    submissions,
  };
}

function deps(client: LlmClient, extra: Record<string, unknown> = {}) {
  return {
    vault,
    recall: async () => [],
    listActive: () => [],
    llmClient: client,
    store: fakeStore(),
    actorId: "system-consolidator",
    ...extra,
  };
}

function write(text: string, ms: number, id: string) {
  return writeInbox(vault, text, { now: () => ms, generateId: () => id });
}

describe("runIntakeSweep", () => {
  it("processes every pending item in FIFO order and empties the inbox", async () => {
    write("first", 1000, "a");
    write("second", 1001, "b");
    write("third", 1002, "c");
    const { client, submissions } = capturingClient(CREATE_JUDGMENT);

    const summary = await runIntakeSweep(deps(client));

    expect(summary.consolidated).toBe(3);
    expect(submissions).toEqual(["first", "second", "third"]); // FIFO
    expect(listInbox(vault)).toEqual([]);
    expect(vault.listMarkdown("inbox/.processing")).toEqual([]);
  });

  it("reclaims a stale claim, then processes it", async () => {
    const ref = write("stranded", 1000, "a");
    claimInboxItem(vault, ref.relPath, { now: () => 10_000 }); // claimed long ago

    const { client } = capturingClient(CREATE_JUDGMENT);
    const summary = await runIntakeSweep(
      deps(client, { lockTtlMs: 60_000, now: () => 10_000 + 30 * 60_000 }),
    );

    expect(summary.reclaimed).toBe(1);
    expect(summary.consolidated).toBe(1);
    expect(listInbox(vault)).toEqual([]);
  });

  it("does nothing on an empty inbox", async () => {
    const { client } = capturingClient(CREATE_JUDGMENT);
    expect(await runIntakeSweep(deps(client))).toMatchObject({
      reclaimed: 0,
      consolidated: 0,
    });
  });

  it("tallies a judge error and leaves that item's claim for retry", async () => {
    write("bad", 1000, "a");
    const { client } = capturingClient("not json");
    const summary = await runIntakeSweep(deps(client));
    expect(summary.judgeErrors).toBe(1);
    expect(summary.consolidated).toBe(0);
    expect(vault.listMarkdown("inbox/.processing").length).toBe(1);
  });

  it("tallies a mixed batch (consolidated + judge_error + errored) correctly", async () => {
    write("good", 1000, "a");
    write("bad", 1001, "b");
    write("boom", 1002, "c");
    const client: LlmClient = {
      complete: async (req: LlmCompletionRequest) => {
        const sub = req.messages[1]?.content ?? "";
        if (sub.includes("boom")) throw new Error("llm down");
        if (sub.includes("bad")) return { content: "not json", model: "x", usage: null };
        return { content: CREATE_JUDGMENT, model: "x", usage: null };
      },
    };

    const summary = await runIntakeSweep(deps(client));

    expect(summary).toMatchObject({ consolidated: 1, judgeErrors: 1, errored: 1, reclaimed: 0 });
    // "good" completed; "bad" + "boom" left claimed for the reaper.
    expect(vault.listMarkdown("inbox/.processing").length).toBe(2);
  });

  it("a thrown error is caught (errored) and the rest of the batch still runs", async () => {
    write("boom", 1000, "a");
    write("fine", 1001, "b");
    // Throw on the first submission, succeed on the rest.
    const client: LlmClient = {
      complete: async (req: LlmCompletionRequest) => {
        if ((req.messages[1]?.content ?? "").includes("boom")) throw new Error("llm down");
        return { content: CREATE_JUDGMENT, model: "x", usage: null };
      },
    };
    const errors: unknown[] = [];

    const summary = await runIntakeSweep(deps(client, { onError: (e: unknown) => errors.push(e) }));

    expect(summary.errored).toBe(1);
    expect(summary.consolidated).toBe(1); // "fine" still processed
    expect(errors).toHaveLength(1);
    // The thrown item stays claimed for the reaper; the good one is gone.
    expect(vault.listMarkdown("inbox/.processing").length).toBe(1);
  });

  it("stops after a provider timeout instead of sending the next item to a struggling model", async () => {
    write("slow", 1000, "a");
    write("next", 1001, "b");
    write("last", 1002, "c");
    const sent: string[] = [];
    const client: LlmClient = {
      complete: async (req: LlmCompletionRequest) => {
        const sub = req.messages[1]?.content ?? "";
        sent.push(sub);
        if (sub.includes("slow")) throw new LlmClientError("timeout", "timed out after 300000ms");
        return { content: CREATE_JUDGMENT, model: "x", usage: null };
      },
    };

    const summary = await runIntakeSweep(deps(client, { onError: () => {} }));

    expect(sent).toHaveLength(1); // "next" and "last" never reached the model
    expect(summary).toMatchObject({ errored: 1, consolidated: 0, stoppedEarly: true });
    // The untouched items wait in the queue for the next tick.
    expect(listInbox(vault)).toHaveLength(2);
  });

  it.each([
    ["a dropped connection", "network", undefined],
    ["a 429 rate limit", "http", 429],
    ["a 503", "http", 503],
  ] as const)("also stops on %s from the provider", async (_label, kind, status) => {
    write("first", 1000, "a");
    write("second", 1001, "b");
    let calls = 0;
    const client: LlmClient = {
      complete: async () => {
        calls++;
        throw new LlmClientError(kind, "provider unavailable", status);
      },
    };
    const summary = await runIntakeSweep(deps(client, { onError: () => {} }));
    expect(calls).toBe(1);
    expect(summary.stoppedEarly).toBe(true);
  });

  it("keeps going after a reply that was cut off, because the provider already stopped", async () => {
    write("long", 1000, "a");
    write("fine", 1001, "b");
    const client: LlmClient = {
      complete: async (req: LlmCompletionRequest) => {
        if ((req.messages[1]?.content ?? "").includes("long")) {
          throw new LlmClientError("truncated", "hit the output limit");
        }
        return { content: CREATE_JUDGMENT, model: "x", usage: null };
      },
    };
    const summary = await runIntakeSweep(deps(client, { onError: () => {} }));
    expect(summary).toMatchObject({ errored: 1, consolidated: 1, stoppedEarly: false });
  });

  it("parks an item in inbox/.failed after its third failed attempt instead of retrying it forever", async () => {
    write("doomed", 1000, "a");
    const client: LlmClient = {
      complete: async () => {
        throw new LlmClientError("timeout", "timed out");
      },
    };
    const hour = 60 * 60_000;
    let summary = await runIntakeSweep(deps(client, { onError: () => {}, now: () => 10_000 }));
    expect(summary.errored).toBe(1);
    // Two more reaped-and-retried attempts.
    for (const at of [1, 2]) {
      summary = await runIntakeSweep(
        deps(client, { onError: () => {}, now: () => 10_000 + at * (hour + 1) }),
      );
      expect(summary.errored).toBe(1);
    }
    // The reaper sees the third failure and parks the item rather than queueing it again.
    summary = await runIntakeSweep(
      deps(client, { onError: () => {}, now: () => 10_000 + 3 * (hour + 1) }),
    );
    expect(summary).toMatchObject({ reclaimed: 0, parked: 1, errored: 0 });
    expect(listInbox(vault)).toEqual([]);
    expect(vault.listMarkdown("inbox/.processing")).toEqual([]);
    expect(vault.listMarkdown("inbox/.failed")).toHaveLength(1);
  });
});
