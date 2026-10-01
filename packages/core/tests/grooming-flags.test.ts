// ADR 0013 — flagged memories are corrected by grooming.
//
// A flag on a cumulative memory used to go to a separate worker that could only
// delete exact quoted text, so most flags ended in manual review. Now a targeted
// groom shows the curator the flagged memory, its flag reasons and its nearest
// neighbours, and the curator corrects the memory with an ordinary `update`
// under the shared auto-apply threshold. Network-free: the model is scripted.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type LlmClient,
  type LlmCompletionRequest,
  LEGACY_CORRECTION_RESOLUTION,
  addProvider,
  askCuratorAgain,
  createLibrarianStore,
  hasFlagsAwaitingCurator,
  withdrawLegacyCorrectionProposals,
  resolveSecretKey,
  runGroomingTick,
  writeConsumerConfig,
  writeGroomingConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Assemble the 64-hex key at runtime — no secret-shaped literal in source (GitGuardian).
const KEY = resolveSecretKey("0123456789abcdef".repeat(4));

let store: LibrarianStore;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-flag-groom-"));
  store = createLibrarianStore({ dataDir, secretKey: KEY });
  writeGroomingConfig(store, { enabled: true });
  const provider = addProvider(store, {
    name: "default",
    endpoint: "https://api.example.com/v1",
    token: "dummy-decrypted-token",
  });
  writeConsumerConfig(store, "grooming", { providerId: provider.id, model: "gpt-x" });
});
afterEach(() => {
  try {
    store.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const CUMULATIVE_BODY = [
  "Atlas is the internal billing service.",
  "",
  "- It runs on port 8080.",
  "- Deploys go out every Tuesday.",
  "- On-call is owned by the payments team.",
].join("\n");

function seed(title: string, body: string): string {
  return store.createMemory({ agent_id: "codex", title, body, confidence: "working" }).memory.id;
}

/** A scripted model: records each prompt and answers with the given operations. */
function scripted(answer: (prompt: string) => unknown[]): {
  client: LlmClient;
  prompts: string[];
} {
  const prompts: string[] = [];
  return {
    prompts,
    client: {
      complete: async (request: LlmCompletionRequest) => {
        const prompt = request.messages.map((m) => m.content).join("\n");
        prompts.push(prompt);
        return {
          content: JSON.stringify({ operations: answer(prompt) }),
          model: "m",
          usage: null,
        };
      },
    },
  };
}

function flagGroom(client: LlmClient) {
  return runGroomingTick({ store, focus: "flagged", buildClient: () => client });
}

describe("targeted flag groom (ADR 0013)", () => {
  it("corrects the one stale statement in a flagged cumulative memory and clears the flag", async () => {
    const id = seed("Atlas", CUMULATIVE_BODY);
    store.flagMemory(id, "Deploys moved to Thursdays in September.", "claude");
    const corrected = CUMULATIVE_BODY.replace("every Tuesday", "every Thursday");
    const { client, prompts } = scripted(() => [
      {
        type: "update",
        source_memory_id: id,
        patch: { body: corrected },
        resolves_flags: true,
        rationale: "The flag says deploys moved to Thursdays.",
        confidence: 0.95,
      },
    ]);

    const result = await flagGroom(client);

    expect(result.ran).toBe(true);
    expect(prompts).toHaveLength(1);
    // The curator saw the flag reason.
    expect(prompts[0]).toContain('"open_flags"');
    expect(prompts[0]).toContain("Deploys moved to Thursdays in September.");
    const memory = store.getMemory(id)!;
    expect(memory.body).toBe(corrected);
    expect(memory.body).toContain("On-call is owned by the payments team.");
    expect(memory.flags).toEqual([]);
    expect(memory.status).toBe("active");
    expect(hasFlagsAwaitingCurator(store)).toBe(false);
  });

  it("shows each flagged memory with its related memories, not the whole corpus", async () => {
    const id = seed("Atlas", CUMULATIVE_BODY);
    seed("Atlas deploy calendar", "Atlas deploys are coordinated with the finance freeze.");
    seed("Garden", "The tomatoes are planted along the south fence.");
    store.flagMemory(id, "Atlas deploys moved to Thursdays.", "claude");
    const { client, prompts } = scripted(() => []);

    await flagGroom(client);

    expect(prompts[0]).toContain("Atlas deploy calendar");
    expect(prompts[0]).not.toContain("tomatoes");
  });

  it("files a below-threshold fix as a proposal; approving it yields the fixed memory without flags", async () => {
    const id = seed("Atlas", CUMULATIVE_BODY);
    store.flagMemory(id, "Port is 9090 now.", "claude");
    const corrected = CUMULATIVE_BODY.replace("8080", "9090");
    const { client } = scripted(() => [
      {
        type: "update",
        source_memory_id: id,
        patch: { body: corrected },
        resolves_flags: true,
        rationale: "The flag reports a port change.",
        confidence: 0.4,
      },
    ]);

    await flagGroom(client);

    const source = store.getMemory(id)!;
    expect(source.body).toBe(CUMULATIVE_BODY); // nothing applied yet
    const review = source.flags[0]!.review!;
    expect(review.outcome).toBe("proposed");
    const proposal = store.getMemory(review.proposal_id!)!;
    expect(proposal.status).toBe("proposed");
    expect(proposal.body).toBe(corrected);
    expect(proposal.curator_note).toMatchObject({ resolves_flags: true, supersedes: [id] });

    const approved = store.approveProposal(proposal.id, "approve")!;
    expect(approved.status).toBe("active");
    expect(approved.flags).toEqual([]);
    expect(store.getMemory(id)!.status).toBe("archived");
  });

  it("rejecting the proposed fix marks the flag declined, and the curator does not propose it again", async () => {
    const id = seed("Atlas", CUMULATIVE_BODY);
    store.flagMemory(id, "Port is 9090 now.", "claude");
    const { client, prompts } = scripted(() => [
      {
        type: "update",
        source_memory_id: id,
        patch: { body: CUMULATIVE_BODY.replace("8080", "9090") },
        resolves_flags: true,
        rationale: "Port change.",
        confidence: 0.4,
      },
    ]);
    await flagGroom(client);
    const proposalId = store.getMemory(id)!.flags[0]!.review!.proposal_id!;

    store.approveProposal(proposalId, "reject");

    expect(store.getMemory(id)!.flags[0]!.review!.outcome).toBe("declined");
    expect(hasFlagsAwaitingCurator(store)).toBe(false);
    await flagGroom(client);
    expect(prompts).toHaveLength(1); // nothing left for a targeted groom
  });

  it("records the curator's reason when it changes nothing, and leaves the flag for a person", async () => {
    const id = seed("Atlas", CUMULATIVE_BODY);
    store.flagMemory(id, "This is all wrong.", "claude");
    const { client } = scripted(() => [
      {
        type: "noop",
        source_memory_ids: [id],
        rationale: "Nothing in the evidence says what is true now.",
        confidence: 0.9,
      },
    ]);

    await flagGroom(client);

    const flag = store.getMemory(id)!.flags[0]!;
    expect(flag.review).toMatchObject({
      outcome: "no_change",
      rationale: "Nothing in the evidence says what is true now.",
    });
    expect(hasFlagsAwaitingCurator(store)).toBe(false);
  });

  it("never rewrites a memory it could not see in full", async () => {
    const long = `${"Atlas detail. ".repeat(2_000)}\n- It runs on port 8080.`;
    const id = seed("Atlas", long);
    store.flagMemory(id, "Port is 9090 now.", "claude");
    const { client, prompts } = scripted(() => [
      {
        type: "update",
        source_memory_id: id,
        patch: { body: "Atlas runs on port 9090." },
        resolves_flags: true,
        rationale: "Port change.",
        confidence: 0.99,
      },
    ]);

    await flagGroom(client);

    expect(prompts[0]).toContain('"body_incomplete": true');
    const memory = store.getMemory(id)!;
    expect(memory.body).toBe(long);
    expect(memory.flags[0]!.review!.outcome).toBe("too_long");
  });

  it("a merge that consumes a flagged memory counts as dealing with its flags", async () => {
    const id = seed("Atlas", CUMULATIVE_BODY);
    const twin = seed("Atlas notes", "Atlas is the internal billing service.");
    store.flagMemory(id, "Duplicate of the Atlas notes.", "claude");
    const { client } = scripted(() => [
      {
        type: "merge",
        source_memory_ids: [id, twin],
        replacement: { title: "Atlas", body: CUMULATIVE_BODY, visibility: "common" },
        rationale: "Same service.",
        confidence: 0.95,
      },
    ]);

    await flagGroom(client);

    const source = store.getMemory(id)!;
    expect(source.status).toBe("archived");
    expect(source.flags[0]!.review).toBeUndefined(); // not stamped "no change"
  });

  it("does not call the model when no flag is waiting", async () => {
    seed("Atlas", CUMULATIVE_BODY);
    const { client, prompts } = scripted(() => []);
    const result = await flagGroom(client);
    expect(result.ran).toBe(true);
    expect(prompts).toHaveLength(0);
  });

  it("a scheduled groom puts flagged memories first, so the newest-first cap never starves them", async () => {
    const id = seed("Old flagged memory", "Atlas runs on port 8080.");
    store.flagMemory(id, "Port changed.", "claude");
    // The flag bumps updated_at; make the flagged memory the oldest again.
    for (let i = 0; i < 3; i++) seed(`Newer ${i}`, `Unrelated fact number ${i}.`);
    const { client, prompts } = scripted(() => []);

    await runGroomingTick({
      store,
      caps: { maxMemories: 2 },
      bypassSkip: true,
      buildClient: () => client,
    });

    expect(prompts[0]).toContain("Old flagged memory");
  });
});

describe("asking the curator again", () => {
  it("clears the last review so the next targeted groom looks again", async () => {
    const id = seed("Atlas", CUMULATIVE_BODY);
    store.flagMemory(id, "Port is 9090 now.", "claude");
    await flagGroom(scripted(() => []).client); // reviewed: no change
    expect(hasFlagsAwaitingCurator(store)).toBe(false);

    expect(askCuratorAgain(store, id, "dashboard-admin")).toBe(true);

    expect(store.getMemory(id)!.flags[0]!.review).toBeUndefined();
    expect(hasFlagsAwaitingCurator(store)).toBe(true);
  });

  it("does nothing for an unknown or unflagged memory", () => {
    const id = seed("Atlas", CUMULATIVE_BODY);
    expect(askCuratorAgain(store, id, "dashboard-admin")).toBe(false);
    expect(askCuratorAgain(store, "mem_missing", "dashboard-admin")).toBe(false);
  });
});

describe("upgrading from the retired correction worker", () => {
  it("withdraws its open proposals and hands the flags back to the curator", () => {
    const id = seed("Atlas", CUMULATIVE_BODY);
    store.flagMemory(id, "Port is 9090 now.", "claude");
    const legacy = store.createMemory(
      {
        agent_id: "system-memory-curator",
        title: "Atlas",
        body: "corrected",
        confidence: "working",
      },
      {
        requires_approval: true,
        curator_note: { source: "flagged_correction", supersedes: [id], correction: {} },
      },
    ).memory;
    const ordinary = store.createMemory(
      { agent_id: "system-memory-curator", title: "Other", body: "x", confidence: "working" },
      { requires_approval: true, curator_note: { source: "grooming", supersedes: [] } },
    ).memory;

    expect(withdrawLegacyCorrectionProposals(store)).toBe(1);
    expect(withdrawLegacyCorrectionProposals(store)).toBe(0); // idempotent

    const withdrawn = store.getMemory(legacy.id)!;
    expect(withdrawn.status).toBe("archived");
    expect(withdrawn.curator_note).toMatchObject({ resolution: LEGACY_CORRECTION_RESOLUTION });
    expect(store.getMemory(ordinary.id)!.status).toBe("proposed");
    expect(store.getMemory(id)!.status).toBe("active");
    expect(hasFlagsAwaitingCurator(store)).toBe(true);
  });
});
