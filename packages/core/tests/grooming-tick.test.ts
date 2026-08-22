// Curator tick (spec §12/§14) — the config-driven entrypoint. Verifies gating
// (disabled / incomplete / undecryptable token) and that an operational config
// builds the client from the GROOMING consumer's provider+model (042 2A) and runs
// due slices. Network-free via an injected client builder.

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
  runGroomingTick,
  setJobAddendum,
  writeConsumerConfig,
  writeGroomingConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Assemble the 64-hex key at runtime — no secret-shaped literal in source (GitGuardian).
const KEY = resolveSecretKey("0123456789abcdef".repeat(4));

let store: LibrarianStore | null = null;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-tick-"));
  store = createLibrarianStore({ dataDir, secretKey: KEY });
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

const noOpClient: LlmClient = {
  complete: async () => ({ content: JSON.stringify({ operations: [] }), model: "m", usage: null }),
};

function seedMemory() {
  store!.createMemory({
    agent_id: "agent-a",
    title: "t",
    body: "b",
    category: "lessons",
    visibility: "common",
    scope: "project",
    project_key: "proj-x",
    confidence: "working",
  });
}

// Point the grooming consumer at a provider (optionally with a token).
function configureGrooming(opts: { token?: string } = {}) {
  const provider = addProvider(store!, {
    name: "default",
    endpoint: "https://api.example.com/v1",
    ...(opts.token !== undefined ? { token: opts.token } : {}),
  });
  writeConsumerConfig(store!, "grooming", { providerId: provider.id, model: "gpt-x" });
}

describe("runGroomingTick — gating", () => {
  it("does nothing when curation is disabled (the default)", async () => {
    const result = await runGroomingTick({ store: store! });
    expect(result).toEqual({ ran: false, reason: "disabled" });
  });

  it("does nothing when the grooming LLM config is incomplete (no token)", async () => {
    writeGroomingConfig(store!, { enabled: true });
    configureGrooming(); // provider has no token
    const result = await runGroomingTick({ store: store! });
    expect(result).toEqual({ ran: false, reason: "incomplete_config" });
  });

  it("runs a disabled-but-configured job when allowDisabled is set (the run-now seam, spec 045 D-4)", async () => {
    // Grooming is disabled (the default), but allowDisabled bypasses the enable
    // gate so an admin run-now can groom on demand — the LLM-config/token gates
    // past the enable gate still apply, so a complete config means the pass runs.
    seedMemory();
    configureGrooming({ token: "dummy-decrypted-token" });
    const result = await runGroomingTick({
      store: store!,
      allowDisabled: true,
      buildClient: () => noOpClient,
    });
    expect(result.ran).toBe(true);
  });

  it("still gates on LLM config even when allowDisabled bypasses the enable gate", async () => {
    // allowDisabled skips ONLY the enable gate; an incomplete LLM connection still
    // refuses (it surfaces the reason the dashboard shows instead of running blind).
    configureGrooming(); // provider has no token
    const result = await runGroomingTick({ store: store!, allowDisabled: true });
    expect(result).toEqual({ ran: false, reason: "incomplete_config" });
  });
});

describe("runGroomingTick — operational", () => {
  it("builds the client from the grooming consumer (with the decrypted token) and runs due slices", async () => {
    seedMemory();
    writeGroomingConfig(store!, { enabled: true });
    configureGrooming({ token: "dummy-decrypted-token" });
    const buildClient = vi.fn(() => noOpClient);

    const result = await runGroomingTick({ store: store!, buildClient });

    expect(result.ran).toBe(true);
    expect(buildClient).toHaveBeenCalledTimes(1);
    // The grooming connection + decrypted token flow into the builder.
    expect(buildClient).toHaveBeenCalledWith(
      { endpoint: "https://api.example.com/v1", model: "gpt-x", timeoutMs: 300_000 },
      "dummy-decrypted-token",
    );
    if (result.ran) expect(result.summary.ran).toBeGreaterThanOrEqual(1);
  });

  it("feeds the grooming addendum from the committed vault file into the prompt (spec 044 D-1)", async () => {
    seedMemory();
    writeGroomingConfig(store!, { enabled: true });
    configureGrooming({ token: "dummy-decrypted-token" });
    // The addendum lives in the committed vault file now, not a setting.
    setJobAddendum(store!, "grooming", "MARKER-ADDENDUM prefer merging over archiving");

    let capturedPrompt = "";
    const capturingClient: LlmClient = {
      complete: async (request: LlmCompletionRequest) => {
        capturedPrompt = request.messages.map((m) => m.content).join("\n");
        return { content: JSON.stringify({ operations: [] }), model: "m", usage: null };
      },
    };

    const result = await runGroomingTick({ store: store!, buildClient: () => capturingClient });

    expect(result.ran).toBe(true);
    // The file's content reached the grooming prompt (it's the OPERATOR GUIDANCE block).
    expect(capturedPrompt).toContain("MARKER-ADDENDUM prefer merging over archiving");
  });

  it("bounds a grooming run's evidence to curator.grooming.max_memories (ADR 0005)", async () => {
    // Three memories in ONE slice (same visibility + project). The configured cap
    // limits how many reach the prompt, so a single slice can't outgrow the timeout.
    const mk = (title: string) =>
      store!.createMemory({
        agent_id: "agent-a",
        title,
        body: "b",
        category: "lessons",
        visibility: "common",
        scope: "project",
        project_key: "proj-x",
        confidence: "working",
      });
    mk("MEM-ALPHA");
    mk("MEM-BETA");
    mk("MEM-GAMMA");

    let prompt = "";
    const capturing: LlmClient = {
      complete: async (request: LlmCompletionRequest) => {
        prompt = request.messages.map((m) => m.content).join("\n");
        return { content: JSON.stringify({ operations: [] }), model: "m", usage: null };
      },
    };
    const markers = ["MEM-ALPHA", "MEM-BETA", "MEM-GAMMA"];

    // Cap of 2 over a 3-memory slice → EXACTLY two survive into the evidence. This
    // proves both that the three share one slice (else each would be its own run of
    // one) AND that the configured cap value is honoured (not just "1 per slice").
    writeGroomingConfig(store!, { enabled: true, maxMemoriesPerRun: 2 });
    configureGrooming({ token: "dummy-decrypted-token" });
    const capped = await runGroomingTick({ store: store!, buildClient: () => capturing });
    expect(capped.ran).toBe(true);
    expect(markers.filter((m) => prompt.includes(m))).toHaveLength(2);
  });

  it("omits the operator-guidance block when the grooming addendum file is absent", async () => {
    seedMemory();
    writeGroomingConfig(store!, { enabled: true });
    configureGrooming({ token: "dummy-decrypted-token" });
    // No addendum file written → fail-soft empty → today's behaviour (no guidance).

    let capturedPrompt = "";
    const capturingClient: LlmClient = {
      complete: async (request: LlmCompletionRequest) => {
        capturedPrompt = request.messages.map((m) => m.content).join("\n");
        return { content: JSON.stringify({ operations: [] }), model: "m", usage: null };
      },
    };

    const result = await runGroomingTick({ store: store!, buildClient: () => capturingClient });

    expect(result.ran).toBe(true);
    expect(capturedPrompt).not.toContain("OPERATOR GUIDANCE");
  });
});

describe("runGroomingTick — token undecryptable without the master key", () => {
  it("does not run when the configured token can't be decrypted", async () => {
    writeGroomingConfig(store!, { enabled: true });
    configureGrooming({ token: "dummy-secret" });
    store!.close();

    // Reopen WITHOUT the master key: the provider still reads as having a token
    // (presence is metadata), but it can't be decrypted → not runnable.
    store = createLibrarianStore({ dataDir });
    const result = await runGroomingTick({ store: store!, buildClient: () => noOpClient });
    expect(result).toEqual({ ran: false, reason: "no_token" });
  });
});
