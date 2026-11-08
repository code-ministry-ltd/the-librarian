// Shelf-aware transcript capture + per-shelf intake sweep (spec 062 T6 — SC 8a). The full flow over
// a two-shelf router whose writeTarget is `members/x/`:
//   1. /transcript ingestion records the capturing principal's write-target shelf beside the buffer
//      (a `.shelf` sidecar), never touching the buffer's `.md` format;
//   2. the settle-sweep submits this conversation's extracted facts into THAT shelf's inbox
//      (`members/x/inbox/`), not the vault-root inbox, and the OTHER shelf's inbox stays empty;
//   3. the intake sweep drains every shelf's inbox and consolidates the members/x/ item into
//      `members/x/memories/…`, attributed `system-consolidator`.
// The default-router transcript flow stays byte-identical (pinned by the existing transcript tests).
//
// Imports the COMPILED transcript-intake module (dist), like the other transcript-intake tests.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  INTAKE_ENABLED_KEY,
  type LibrarianStore,
  type LlmClient,
  type Principal,
  type Shelf,
  type VaultRouter,
  addProvider,
  createLibrarianStore,
  resolveSecretKey,
  runTranscriptSweepTick,
  transcriptShelfMarkerPath,
  writeConsumerConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleTranscriptIntake } from "../../dist/http/transcript-intake.js";

// 32-byte master key assembled at runtime (AGENTS.md GitGuardian note).
const KEY = resolveSecretKey("0123456789abcdef".repeat(4));

/** Enable intake + point its consumer at a tokened provider — the settle-sweep reuses it. */
function enableCapture(store: LibrarianStore): void {
  store.setSetting(INTAKE_ENABLED_KEY, "true");
  const provider = addProvider(store, {
    name: "default",
    endpoint: "https://e/v1",
    token: "dummy-decrypted-token",
  });
  writeConsumerConfig(store, "intake", { providerId: provider.id, model: "gpt-x" });
}

const A: Shelf = { id: "members-x", prefix: "members/x/", writable: true, label: "Sarah's shelf" };
const B: Shelf = { id: "team", prefix: "team/", writable: true };
// writes/writeTarget → members/x; the system grooms both shelves (so intake drains both inboxes).
const router: VaultRouter = {
  shelves: (_p, op) => (op === "write" ? [A] : [A, B]),
  writeTarget: () => A,
};
const SARAH: Principal = { kind: "agent", actorId: "sarah", roles: ["agent"] };

let store: LibrarianStore | null = null;
let dataDir = "";
let vaultDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-tscript-shelf-"));
  store = createLibrarianStore({ dataDir, vaultRouter: router, secretKey: KEY });
  enableCapture(store); // the whole capture pipeline gates on intake being enabled + operational
  vaultDir = path.join(dataDir, "vault");
});
afterEach(() => {
  try {
    store?.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  store = null;
  dataDir = "";
  vaultDir = "";
});

/** A fake extractor LLM returning fixed candidate facts. */
function factsClient(facts: string[]): LlmClient {
  return {
    complete: async ({ messages }) => {
      if (messages[0]?.content.includes("You are the Reviewer")) {
        // Spec 086: keep every fact, quoting the real transcript.
        const user = messages[1]?.content ?? "";
        const quote = user.slice("CONVERSATION:\n\n".length).slice(0, 40);
        const reviews = facts.map((_, index) => ({ index, verdict: "keep", quote }));
        return { content: JSON.stringify({ reviews }), model: "m", usage: null };
      }
      return { content: JSON.stringify({ facts }), model: "m", usage: null };
    },
  };
}

/** The scripted intake JUDGE verdict — a clean create so the item fully consolidates. */
const CREATE_JUDGMENT = JSON.stringify({
  action: "create",
  title: "Sarah Chen",
  body: "Sarah Chen now leads the platform team.",
  tags: ["person"],
  rationale: "novel topic",
  confidence: 0.97,
});
function judgeClient(): LlmClient {
  return { complete: async () => ({ content: CREATE_JUDGMENT, model: "m", usage: null }) };
}

function inboxFiles(prefix: string): string[] {
  const dir = path.join(vaultDir, prefix, "inbox");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
}
function memoryFiles(prefix: string): string[] {
  const dir = path.join(vaultDir, prefix, "memories");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
}

describe("transcript capture routes to the write-target shelf's inbox (spec 062 SC 8a)", () => {
  it("records the shelf, submits into members/x/ inbox, and consolidates into members/x/memories", async () => {
    // 1. INGEST a transcript delta as Sarah (writeTarget members/x/), settled immediately (ended).
    const res = handleTranscriptIntake(
      store!,
      {
        conv_id: "conv-sarah",
        harness: "claude",
        seq: 0,
        turns: [{ role: "user", text: "Sarah now leads the platform team." }],
        ended: true,
      },
      SARAH,
    );
    expect(res.body.accepted).toBe(true);
    // The write-target shelf was recorded beside the buffer (a NEW sidecar, not a buffer change).
    const markerPath = transcriptShelfMarkerPath(dataDir, "conv-sarah");
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(markerPath, "utf8")).prefix).toBe("members/x/");

    // 2. SETTLE-SWEEP: extract → submit into the RECORDED shelf's inbox.
    const sweep = await runTranscriptSweepTick({
      store: store!,
      buildClient: () => factsClient(["Sarah Chen now leads the platform team."]),
    });
    expect(sweep).toMatchObject({ extracted: 1, facts: 1 });
    // The inbox item landed under members/x/ — NOT the vault root, NOT the team shelf.
    expect(inboxFiles("members/x")).toHaveLength(1);
    expect(inboxFiles("team")).toHaveLength(0);
    expect(fs.existsSync(path.join(vaultDir, "inbox"))).toBe(false); // no vault-root inbox
    // Zero trace of the buffer + its shelf marker after extraction.
    expect(fs.existsSync(markerPath)).toBe(false);

    // 3. INTAKE SWEEP: drains every shelf's inbox; the members/x/ item consolidates into that
    //    shelf's memories, attributed system-consolidator. The (empty) team inbox is a no-op.
    const summary = await store!.runIntakeSweep({ llmClient: judgeClient() });
    expect(summary).toMatchObject({ consolidated: 1, judgeErrors: 0, errored: 0 });
    expect(inboxFiles("members/x")).toHaveLength(0); // drained
    expect(memoryFiles("members/x")).toHaveLength(1);
    const memRaw = fs.readFileSync(
      path.join(vaultDir, "members/x/memories", memoryFiles("members/x")[0]!),
      "utf8",
    );
    expect(memRaw).toMatch(/^agent_id: system-consolidator$/m);
    expect(memRaw).toMatch(/^title: Sarah Chen$/m);
    // The team shelf never received anything.
    expect(memoryFiles("team")).toHaveLength(0);
    expect(fs.existsSync(path.join(vaultDir, "memories"))).toBe(false); // no vault-root memories
  });

  it("writes NO shelf marker under the default router — the transcript flow is byte-identical", async () => {
    const solo = createLibrarianStore({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "lib-solo-")),
    });
    try {
      solo.setSetting(INTAKE_ENABLED_KEY, "true");
      const res = handleTranscriptIntake(
        solo,
        { conv_id: "conv-solo", harness: "claude", seq: 0, turns: [{ role: "user", text: "hi" }] },
        SARAH, // default router resolves the write-target to the vault-root shelf (prefix "")
      );
      expect(res.body.accepted).toBe(true);
      // No `.shelf` sidecar is written for the vault-root shelf — the transcripts dir holds only the
      // buffer, exactly as before this task.
      expect(fs.existsSync(transcriptShelfMarkerPath(solo.dataDir, "conv-solo"))).toBe(false);
    } finally {
      const dir = solo.dataDir;
      solo.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
