// Intake tick (plan 036 Phase 4 / spec 035 §F5) — the config-driven
// entrypoint the scheduler calls. Verifies gating (incomplete config / no
// token / unsupported backend) and that an operational config builds the client
// + runs one inbox sweep. Network-free via an injected client builder.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type LlmClient,
  type LlmCompletionRequest,
  addProvider,
  createLibrarianStore,
  resolveSecretKey,
  runIntakeTick,
  setIntakeEnabled,
  setIntakeExamples,
  setJobAddendum,
  writeConsumerConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Build the 32-byte master key at runtime from a short, sub-threshold literal so
// no 64-hex string (which GitGuardian reads as a high-entropy secret) sits in the
// committed source. Varied bytes — resolveSecretKey rejects a constant-byte key.
const KEY = resolveSecretKey("0123456789abcdef".repeat(4));

let store: LibrarianStore | null = null;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-consol-tick-"));
  store = createLibrarianStore({ dataDir, backend: "markdown", secretKey: KEY });
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

function createJudgmentClient(): LlmClient {
  return {
    complete: async () => ({
      content: JSON.stringify({
        action: "create",
        title: "Elaine",
        body: "Elaine lives in Berlin.",
        tags: [],
        rationale: "novel",
        confidence: 0.97,
      }),
      model: "m",
      usage: null,
    }),
  };
}

// Point the intake consumer at a provider with a token (042 2A) AND enable intake
// (the tick self-gates on curator.intake.enabled — D-1 — so the operational paths
// must turn it on, mirroring how the grooming tests call writeGroomingConfig).
function configureLlm() {
  setIntakeEnabled(store!, true);
  const provider = addProvider(store!, {
    name: "default",
    endpoint: "https://e/v1",
    token: "dummy-decrypted-token",
  });
  writeConsumerConfig(store!, "intake", { providerId: provider.id, model: "gpt-x" });
}

describe("runIntakeTick — gating", () => {
  it("does nothing when intake is disabled (the default)", async () => {
    // Self-gate first (spec 045 D-1): a disabled intake never sweeps, even with a
    // complete LLM config — exactly mirroring grooming's curator.enabled gate.
    const provider = addProvider(store!, {
      name: "default",
      endpoint: "https://e/v1",
      token: "dummy-decrypted-token",
    });
    writeConsumerConfig(store!, "intake", { providerId: provider.id, model: "gpt-x" });
    const result = await runIntakeTick({ store: store! });
    expect(result).toEqual({ ran: false, reason: "disabled" });
  });

  it("does not run when the LLM connection is incomplete (no model/token)", async () => {
    setIntakeEnabled(store!, true);
    const result = await runIntakeTick({ store: store! });
    expect(result).toEqual({ ran: false, reason: "incomplete_config" });
  });

  it("does not run when the configured token can't be decrypted", async () => {
    configureLlm();
    store!.close();
    // Reopen WITHOUT the master key: config reads complete (token presence is
    // metadata), but the token can't be decrypted → not runnable.
    store = createLibrarianStore({ dataDir, backend: "markdown" });
    const result = await runIntakeTick({
      store: store!,
      buildClient: () => createJudgmentClient(),
    });
    expect(result).toEqual({ ran: false, reason: "no_token" });
  });
});

describe("runIntakeTick — operational", () => {
  it("builds the client from config and runs one inbox sweep", async () => {
    configureLlm();
    store!.submitToInbox("Elaine moved to Berlin.");
    const buildClient = vi.fn(() => createJudgmentClient());

    const result = await runIntakeTick({ store: store!, buildClient });

    expect(result).toMatchObject({ ran: true, summary: { consolidated: 1 } });
    expect(buildClient).toHaveBeenCalledTimes(1);
    // The decrypted token + the configured connection flow into the builder.
    expect(buildClient).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "https://e/v1", model: "gpt-x" }),
      "dummy-decrypted-token",
    );
    // It filed the submission as a recallable memory.
    expect(
      store!.searchMemories({ query: "Elaine", status: "active" }).map((m) => m.title),
    ).toContain("Elaine");
  });

  it("a Run now during a sweep in flight is refused instead of starting a second sweep", async () => {
    configureLlm();
    store!.submitToInbox("Elaine moved to Berlin.");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const slowClient: LlmClient = {
      complete: async (request: LlmCompletionRequest) => {
        calls++;
        await gate;
        return createJudgmentClient().complete(request);
      },
    };

    const first = runIntakeTick({ store: store!, buildClient: () => slowClient });
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = await runIntakeTick({
      store: store!,
      allowDisabled: true,
      buildClient: () => slowClient,
    });

    expect(second).toEqual({ ran: false, reason: "already_running" });
    release();
    expect(await first).toMatchObject({ ran: true, summary: { consolidated: 1 } });
    expect(calls).toBe(1);
    // Once the first sweep finishes, the next one runs normally.
    expect(await runIntakeTick({ store: store!, buildClient: () => slowClient })).toMatchObject({
      ran: true,
    });
  });

  it("an empty-inbox tick still RAN (cadence advances) but records NO run", async () => {
    // The noisy case: a scheduled tick over an empty inbox. It must report ran:true
    // (so the scheduler stamps curator.intake.last_sweep_at and the cadence advances
    // — no busy-loop), but it must NOT add a row to the intake-runs decision log.
    configureLlm();
    // No submitToInbox → the inbox is empty.
    const buildClient = vi.fn(() => createJudgmentClient());

    const result = await runIntakeTick({ store: store!, buildClient });

    // ran:true → http.ts's runIntakeSweepIfDue stamps writeLastIntakeSweepAt(now),
    // so isIntakeSweepDue advances and the poll doesn't busy-loop.
    expect(result).toMatchObject({ ran: true, summary: { consolidated: 0 } });
    // The empty no-op is quieted: no run lands in the dashboard's intake-runs list.
    expect(store!.listIntakeRuns()).toEqual([]);
  });

  it("a tick that processes ≥1 item DOES record a run (no regression)", async () => {
    configureLlm();
    store!.submitToInbox("Elaine moved to Berlin.");

    const result = await runIntakeTick({
      store: store!,
      buildClient: () => createJudgmentClient(),
    });

    expect(result).toMatchObject({ ran: true, summary: { consolidated: 1 } });
    const runs = store!.listIntakeRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "completed", consolidated: 1 });
  });

  it("feeds the intake addendum from the committed vault file into the prompt (spec 044 D-2)", async () => {
    configureLlm();
    store!.submitToInbox("Elaine moved to Berlin.");
    // The intake addendum lives in the committed vault file (spec 044 D-1); it is
    // read ONCE per sweep at the tick and threaded down into each item's judge call.
    setJobAddendum(store!, "intake", "MARKER-ADDENDUM prefer the lessons folder");

    let capturedPrompt = "";
    const capturingClient: LlmClient = {
      complete: async (request: LlmCompletionRequest) => {
        capturedPrompt = request.messages.map((m) => m.content).join("\n");
        return {
          content: JSON.stringify({
            action: "create",
            title: "Elaine",
            body: "Elaine lives in Berlin.",
            tags: [],
            rationale: "novel",
            confidence: 0.97,
          }),
          model: "m",
          usage: null,
        };
      },
    };

    const result = await runIntakeTick({ store: store!, buildClient: () => capturingClient });

    expect(result).toMatchObject({ ran: true });
    // The file's content reached the intake prompt (the OPERATOR GUIDANCE block).
    expect(capturedPrompt).toContain("MARKER-ADDENDUM prefer the lessons folder");
  });

  it("feeds the intake examples doc from its committed vault file into the prompt (F4)", async () => {
    configureLlm();
    store!.submitToInbox("TODO: fix the flaky test tomorrow.");
    // The examples doc (proposal-review rework D3) is a sibling of the addendum:
    // read ONCE per sweep at the tick and threaded into each item's judge call.
    setIntakeExamples(store!, "MARKER-EXAMPLES one-off TODOs were rejected before");

    let capturedPrompt = "";
    const capturingClient: LlmClient = {
      complete: async (request: LlmCompletionRequest) => {
        capturedPrompt = request.messages.map((m) => m.content).join("\n");
        return {
          content: JSON.stringify({ action: "noop", rationale: "transient", confidence: 0.9 }),
          model: "m",
          usage: null,
        };
      },
    };

    const result = await runIntakeTick({ store: store!, buildClient: () => capturingClient });

    expect(result).toMatchObject({ ran: true });
    expect(capturedPrompt).toContain("MARKER-EXAMPLES one-off TODOs were rejected before");
  });

  it("omits the operator-guidance block when the intake addendum file is absent (today's behaviour)", async () => {
    configureLlm();
    store!.submitToInbox("Elaine moved to Berlin.");
    // No intake addendum file written → fail-soft empty → byte-identical prompt to
    // before D2 (no OPERATOR GUIDANCE block).

    let capturedPrompt = "";
    const capturingClient: LlmClient = {
      complete: async (request: LlmCompletionRequest) => {
        capturedPrompt = request.messages.map((m) => m.content).join("\n");
        return {
          content: JSON.stringify({
            action: "create",
            title: "Elaine",
            body: "Elaine lives in Berlin.",
            tags: [],
            rationale: "novel",
            confidence: 0.97,
          }),
          model: "m",
          usage: null,
        };
      },
    };

    const result = await runIntakeTick({ store: store!, buildClient: () => capturingClient });

    expect(result).toMatchObject({ ran: true });
    expect(capturedPrompt).not.toContain("OPERATOR GUIDANCE");
  });
});
