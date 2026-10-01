// Transcript settle-sweep + lifecycle (spec 2026-06-16-harness-auto-capture, T2).
// The EXTRACTION clock: a background tick scans <dataDir>/transcripts/ for
// SETTLED buffers (idle / explicit-end / size-cap), atomically CLAIMS each
// (→ .processing), makes ONE extractor pass (mocked LLM), submits each fact to
// the EXISTING inbox via submitToInbox, then DELETES the claimed buffer. An
// orphaned .processing is reaped. The whole tick SELF-GATES on
// isIntakeEnabled(store) — the same gate T1's endpoint and the intake tick read.
//
// Network-free: the extractor LLM client is injected (buildClient), mirroring
// runIntakeTick's injectable builder; the inbox submission is observed by
// spying the store's submitToInbox.
//
//   - SC1 (server half): a settled, substantive buffer → claim → extract → N
//     facts reach the inbox; the buffer is then deleted.
//   - SC3 (settle-by-idle): an idle buffer is extracted with NO end event; a
//     fresh buffer is left alone.
//   - SC6 (hygiene): atomic claim to .processing; delete-after; reaper recovers
//     an orphaned .processing; nothing escapes transcripts/.
//   - SC7 (gate coherence): intake disabled → nothing extracted, buffers
//     untouched.
//   - size-cap settle path; trivial buffer → no-op (no facts) but still deleted.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  INTAKE_ENABLED_KEY,
  type LibrarianStore,
  type LlmClient,
  LlmClientError,
  type Shelf,
  type VaultRouter,
  addProvider,
  createLibrarianStore,
  endedMarkerPath,
  resolveSecretKey,
  runTranscriptSweepTick,
  transcriptBufferPath,
  transcriptHarnessMarkerPath,
  transcriptProcessingHarnessMarkerPath,
  transcriptProcessingPath,
  transcriptsDir,
  writeConsumerConfig,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 32-byte master key assembled at runtime (AGENTS.md GitGuardian note).
const KEY = resolveSecretKey("0123456789abcdef".repeat(4));

let store: LibrarianStore | null = null;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-tsweep-"));
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
  dataDir = "";
});

/** Enable intake + point its consumer at a tokened provider (the sweep reuses it). */
function enableCapture(): void {
  store!.setSetting(INTAKE_ENABLED_KEY, "true");
  const provider = addProvider(store!, {
    name: "default",
    endpoint: "https://e/v1",
    token: "dummy-decrypted-token",
  });
  writeConsumerConfig(store!, "intake", { providerId: provider.id, model: "gpt-x" });
}

/** A fake extractor LLM returning a fixed candidate-facts payload. */
function factsClient(facts: string[]): LlmClient {
  return {
    complete: async () => ({ content: JSON.stringify({ facts }), model: "m", usage: null }),
  };
}

/** Write a buffer file for a conv_id with the given content + mtime age (ms ago). */
function writeBuffer(convId: string, content: string, ageMs = 0): string {
  const p = transcriptBufferPath(dataDir, convId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(p, when, when);
  }
  return p;
}

const IDLE_MS = 30 * 60_000;

describe("runTranscriptSweepTick — settle + extract → inbox (SC1)", () => {
  it("claims a settled substantive buffer, extracts N facts to the inbox, then deletes it", async () => {
    enableCapture();
    const bufferPath = writeBuffer(
      "conv-1",
      "### user\n\nWe decided to standardise on pnpm.\n\n### assistant\n\nNoted.\n",
      IDLE_MS + 60_000, // idle → settled
    );
    const submitSpy = vi.spyOn(store!, "submitToInbox");

    const summary = await runTranscriptSweepTick({
      store: store!,
      buildClient: () =>
        factsClient([
          "The repo standardises on pnpm.",
          "Test runner is invoked from the repo root.",
        ]),
    });

    // Each candidate fact was submitted INDIVIDUALLY to the existing inbox.
    expect(submitSpy).toHaveBeenCalledTimes(2);
    expect(submitSpy.mock.calls.map((c) => c[0])).toEqual([
      "The repo standardises on pnpm.",
      "Test runner is invoked from the repo root.",
    ]);
    expect(summary).toMatchObject({ extracted: 1, facts: 2 });

    // The buffer (and its claim) are gone — zero trace; only inbox facts persist.
    expect(fs.existsSync(bufferPath)).toBe(false);
    expect(fs.existsSync(transcriptProcessingPath(dataDir, "conv-1"))).toBe(false);
  });

  it("tags each submission with auto-capture hints (source + harness)", async () => {
    enableCapture();
    writeBuffer("conv-h", "### user\n\nsubstantive content here\n", IDLE_MS + 1);
    fs.writeFileSync(
      transcriptHarnessMarkerPath(dataDir, "conv-h"),
      JSON.stringify({ harness: "codex" }),
      "utf8",
    );
    const submitSpy = vi.spyOn(store!, "submitToInbox");

    await runTranscriptSweepTick({
      store: store!,
      buildClient: () => factsClient(["a durable fact"]),
    });

    expect(submitSpy).toHaveBeenCalledTimes(1);
    const hints = submitSpy.mock.calls[0]?.[1];
    expect(hints?.tags).toEqual(
      expect.arrayContaining(["auto_capture", "source:auto_capture", "harness:codex"]),
    );
    expect(fs.existsSync(transcriptHarnessMarkerPath(dataDir, "conv-h"))).toBe(false);
  });

  it("keeps harness attribution generation-safe when a late delta arrives during extraction", async () => {
    enableCapture();
    writeBuffer("conv-race", "### user\n\nfirst generation\n", IDLE_MS + 1);
    fs.writeFileSync(
      transcriptHarnessMarkerPath(dataDir, "conv-race"),
      JSON.stringify({ harness: "codex" }),
      "utf8",
    );
    const submitSpy = vi.spyOn(store!, "submitToInbox");
    const firstClient: LlmClient = {
      complete: async () => {
        // The buffer and its marker have already been claimed when extraction awaits the model.
        writeBuffer("conv-race", "### user\n\nlate generation\n");
        fs.writeFileSync(
          transcriptHarnessMarkerPath(dataDir, "conv-race"),
          JSON.stringify({ harness: "claude" }),
          "utf8",
        );
        return {
          content: JSON.stringify({ facts: ["first fact"] }),
          model: "m",
          usage: null,
        };
      },
    };

    await runTranscriptSweepTick({ store: store!, buildClient: () => firstClient });

    expect(submitSpy.mock.calls[0]?.[1]?.tags).toContain("harness:codex");
    expect(fs.existsSync(transcriptBufferPath(dataDir, "conv-race"))).toBe(true);
    expect(fs.existsSync(transcriptHarnessMarkerPath(dataDir, "conv-race"))).toBe(true);
    expect(fs.existsSync(transcriptProcessingHarnessMarkerPath(dataDir, "conv-race"))).toBe(false);

    await runTranscriptSweepTick({
      store: store!,
      idleMs: 0,
      buildClient: () => factsClient(["late fact"]),
    });

    expect(submitSpy.mock.calls[1]?.[1]?.tags).toContain("harness:claude");
  });
});

describe("runTranscriptSweepTick — settle by idle, no end event (SC3)", () => {
  it("extracts an idle buffer and leaves a fresh one alone", async () => {
    enableCapture();
    const idle = writeBuffer("conv-idle", "### user\n\nold but substantive\n", IDLE_MS + 60_000);
    const fresh = writeBuffer("conv-fresh", "### user\n\njust happened\n", 1_000); // 1s old

    const summary = await runTranscriptSweepTick({
      store: store!,
      buildClient: () => factsClient(["a fact from the idle conversation"]),
    });

    // The idle buffer settled + was consumed; the fresh one is untouched.
    expect(fs.existsSync(idle)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(summary.extracted).toBe(1);
    expect(summary.skipped).toBe(1);
  });

  it("respects a custom idle window", async () => {
    enableCapture();
    const buf = writeBuffer("conv-x", "### user\n\ncontent\n", 5_000); // 5s old
    // With a 1s idle window, 5s-old IS settled.
    await runTranscriptSweepTick({
      store: store!,
      idleMs: 1_000,
      buildClient: () => factsClient(["fact"]),
    });
    expect(fs.existsSync(buf)).toBe(false);
  });
});

describe("runTranscriptSweepTick — explicit-end accelerator", () => {
  it("extracts a FRESH buffer immediately when an end marker is present", async () => {
    enableCapture();
    // Fresh (not idle), but the harness signalled ended:true (T1 wrote the marker).
    const buf = writeBuffer("conv-end", "### user\n\nwrap-up content\n", 1_000);
    fs.writeFileSync(endedMarkerPath(dataDir, "conv-end"), "", "utf8");

    const summary = await runTranscriptSweepTick({
      store: store!,
      buildClient: () => factsClient(["a fact"]),
    });

    expect(summary.extracted).toBe(1);
    expect(fs.existsSync(buf)).toBe(false);
    // The marker is cleaned up with the buffer.
    expect(fs.existsSync(endedMarkerPath(dataDir, "conv-end"))).toBe(false);
  });
});

describe("runTranscriptSweepTick — size-cap settle path", () => {
  it("extracts an over-size buffer even when fresh", async () => {
    enableCapture();
    const big = "x".repeat(2_000);
    const buf = writeBuffer("conv-big", `### user\n\n${big}\n`, 1_000); // fresh
    const summary = await runTranscriptSweepTick({
      store: store!,
      maxBytes: 1_000, // tiny cap → settled by size
      buildClient: () => factsClient(["fact from the runaway buffer"]),
    });
    expect(summary.extracted).toBe(1);
    expect(fs.existsSync(buf)).toBe(false);
  });
});

describe("runTranscriptSweepTick — trivial buffer", () => {
  it("a settled buffer that yields no facts is still deleted (no inbox writes)", async () => {
    enableCapture();
    const buf = writeBuffer("conv-trivial", "### user\n\nhi\n", IDLE_MS + 1);
    const submitSpy = vi.spyOn(store!, "submitToInbox");

    const summary = await runTranscriptSweepTick({
      store: store!,
      buildClient: () => factsClient([]), // model finds nothing durable
    });

    expect(submitSpy).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ extracted: 1, facts: 0 });
    // Still deleted — zero trace.
    expect(fs.existsSync(buf)).toBe(false);
  });
});

describe("runTranscriptSweepTick — re-redaction before submit (defense-in-depth)", () => {
  it("re-redacts a secret-shaped extracted fact before it reaches the inbox", async () => {
    enableCapture();
    writeBuffer("conv-secret", "### user\n\nsubstantive content\n", IDLE_MS + 1);
    const submitSpy = vi.spyOn(store!, "submitToInbox");

    // Assemble a secret-shaped string at RUNTIME from sub-threshold parts so the
    // literal is never in committed source (AGENTS.md GitGuardian note). It matches
    // the redactor's `key = "value"` assignment rule. A fact carrying it (e.g. the
    // extractor passed through a secret T1's redactor missed) must be re-redacted
    // before it is committed to the git vault path.
    const kw = ["api", "key"].join("_");
    const val = `${"ABCDEF0123456789".toLowerCase()}${"ABCDEF0123456789".toLowerCase()}`;
    const secretVal = val;
    const factWithSecret = `The deploy uses ${kw} = "${secretVal}" for auth.`;

    await runTranscriptSweepTick({
      store: store!,
      buildClient: () => factsClient([factWithSecret]),
    });

    expect(submitSpy).toHaveBeenCalledTimes(1);
    const submittedText = String(submitSpy.mock.calls[0]?.[0]);
    // The raw secret value never reaches the inbox; the redaction marker is there.
    expect(submittedText).not.toContain(secretVal);
    expect(submittedText).toContain("[REDACTED:secret]");
  });
});

describe("runTranscriptSweepTick — hygiene + reaper (SC6)", () => {
  it("reaps an orphaned .processing (crash mid-extract) and re-extracts it", async () => {
    enableCapture();
    // Simulate a crash: a .processing claim left behind, older than the reaper TTL.
    const proc = transcriptProcessingPath(dataDir, "conv-orphan");
    fs.mkdirSync(path.dirname(proc), { recursive: true });
    fs.writeFileSync(proc, "### user\n\nstranded but substantive\n", "utf8");
    const old = new Date(Date.now() - 60 * 60_000); // 1h old
    fs.utimesSync(proc, old, old);
    const submitSpy = vi.spyOn(store!, "submitToInbox");

    const summary = await runTranscriptSweepTick({
      store: store!,
      reaperTtlMs: 10 * 60_000, // 10 min TTL → the 1h-old claim is reaped
      buildClient: () => factsClient(["the rescued fact"]),
    });

    expect(submitSpy).toHaveBeenCalledWith("the rescued fact", expect.anything());
    expect(summary.reaped).toBeGreaterThanOrEqual(1);
    // The orphan is consumed + deleted — nothing stranded.
    expect(fs.existsSync(proc)).toBe(false);
  });

  it("does NOT reap a .processing aged past the idle window (reaper TTL decoupled from idle)", async () => {
    enableCapture();
    // A claim older than the 30-min idle window but younger than the default reaper
    // TTL. With the old reaper TTL == idle window, this would have been mis-reaped
    // as crashed (double-extract risk). The decoupled, larger default leaves it be.
    const proc = transcriptProcessingPath(dataDir, "conv-slow");
    fs.mkdirSync(path.dirname(proc), { recursive: true });
    fs.writeFileSync(proc, "### user\n\na slow but live extraction\n", "utf8");
    const aged = new Date(Date.now() - (IDLE_MS + 5 * 60_000)); // 35 min — past idle, under TTL
    fs.utimesSync(proc, aged, aged);
    const submitSpy = vi.spyOn(store!, "submitToInbox");

    const summary = await runTranscriptSweepTick({
      store: store!,
      // No reaperTtlMs override → uses DEFAULT_TRANSCRIPT_REAPER_TTL_MS (60 min).
      buildClient: () => factsClient(["must not be re-extracted"]),
    });

    // 35 min < 60 min default TTL → the live claim is neither reaped nor re-extracted.
    expect(summary.reaped).toBe(0);
    expect(submitSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(proc)).toBe(true);
  });

  it("leaves a RECENT .processing alone (an in-flight claim is not stolen)", async () => {
    enableCapture();
    const proc = transcriptProcessingPath(dataDir, "conv-inflight");
    fs.mkdirSync(path.dirname(proc), { recursive: true });
    fs.writeFileSync(proc, "### user\n\nbeing processed right now\n", "utf8"); // fresh mtime

    const summary = await runTranscriptSweepTick({
      store: store!,
      reaperTtlMs: 10 * 60_000,
      buildClient: () => factsClient(["should not be touched"]),
    });

    // A fresh claim is younger than the TTL → not reaped, not consumed.
    expect(fs.existsSync(proc)).toBe(true);
    expect(summary.reaped).toBe(0);
  });

  it("reaps a stray .ended marker that has no buffer (claim/delete race)", async () => {
    enableCapture();
    // A lone `.ended` with NO matching `.md`/`.processing` — reachable in a
    // claim/delete race (the buffer was claimed+deleted while a late ended:true
    // delta dropped a fresh marker). It must not linger forever.
    const stray = endedMarkerPath(dataDir, "conv-stray-ended");
    fs.mkdirSync(path.dirname(stray), { recursive: true });
    fs.writeFileSync(stray, "", "utf8");

    const summary = await runTranscriptSweepTick({
      store: store!,
      buildClient: () => factsClient(["unused"]),
    });

    // The orphan marker is gone, and it didn't trigger a phantom extraction.
    expect(fs.existsSync(stray)).toBe(false);
    expect(summary.extracted).toBe(0);
  });

  it("reaps a claimed sidecar whose processing buffer was deleted before a crash", async () => {
    enableCapture();
    const convId = "conv-marker-crash";
    writeBuffer(convId, "### user\n\na fresh generation after the crash\n", IDLE_MS + 1);
    const claimedHarness = transcriptProcessingHarnessMarkerPath(dataDir, convId);
    fs.mkdirSync(path.dirname(claimedHarness), { recursive: true });
    fs.writeFileSync(claimedHarness, JSON.stringify({ harness: "codex" }), "utf8");
    fs.writeFileSync(
      transcriptHarnessMarkerPath(dataDir, convId),
      JSON.stringify({ harness: "claude" }),
      "utf8",
    );
    const submitSpy = vi.spyOn(store!, "submitToInbox");

    const summary = await runTranscriptSweepTick({
      store: store!,
      buildClient: () => factsClient(["the next generation fact"]),
    });

    expect(summary).toMatchObject({ extracted: 1, facts: 1 });
    expect(summary.reaped).toBeGreaterThanOrEqual(1);
    expect(submitSpy.mock.calls[0]?.[1]?.tags).toContain("harness:claude");
    expect(fs.existsSync(claimedHarness)).toBe(false);
  });

  it("keeps an .ended marker that DOES have a matching buffer (not stray)", async () => {
    enableCapture();
    // A marker WITH a buffer is the normal explicit-end accelerator — it must be
    // consumed via extraction, never reaped out from under a live buffer.
    const buf = writeBuffer("conv-has-buf", "### user\n\nwrap-up\n", 1_000); // fresh
    fs.writeFileSync(endedMarkerPath(dataDir, "conv-has-buf"), "", "utf8");

    const summary = await runTranscriptSweepTick({
      store: store!,
      buildClient: () => factsClient(["a fact"]),
    });

    // The buffer settled via the marker and was extracted+deleted (not reaped).
    expect(summary.extracted).toBe(1);
    expect(fs.existsSync(buf)).toBe(false);
    expect(fs.existsSync(endedMarkerPath(dataDir, "conv-has-buf"))).toBe(false);
  });

  it("never writes outside transcripts/ (claim + delete stay contained)", async () => {
    enableCapture();
    writeBuffer("conv-contained", "### user\n\ncontent\n", IDLE_MS + 1);
    // Scope the containment check to THIS test's UNIQUE data dir — never its
    // shared parent (os.tmpdir()). The parent is shared by every parallel test's
    // temp dir, so other suites creating siblings there is normal churn, not a
    // sweep escape — snapshotting it made this assertion flaky. We instead snapshot
    // the data dir's OWN entries and prove the sweep added nothing alongside
    // transcripts/ (the only place it is allowed to touch).
    const ownBefore = new Set(fs.readdirSync(dataDir));

    await runTranscriptSweepTick({
      store: store!,
      buildClient: () => factsClient(["fact"]),
    });

    // The transcripts/ dir survives; the sweep created NO new artifact anywhere in
    // the data dir outside transcripts/ (it only ever writes under transcripts/).
    expect(fs.existsSync(transcriptsDir(dataDir))).toBe(true);
    const ownAfter = fs.readdirSync(dataDir);
    for (const entry of ownAfter) {
      expect(ownBefore.has(entry)).toBe(true);
    }
  });
});

describe("runTranscriptSweepTick — gate coherence (SC7)", () => {
  it("extracts nothing and leaves buffers untouched when intake is disabled", async () => {
    // Intake gate OFF (do NOT call enableCapture).
    store!.setSetting(INTAKE_ENABLED_KEY, "false");
    const buf = writeBuffer("conv-gated", "### user\n\nwould-be content\n", IDLE_MS + 60_000);
    const submitSpy = vi.spyOn(store!, "submitToInbox");

    const summary = await runTranscriptSweepTick({
      store: store!,
      buildClient: () => factsClient(["nope"]),
    });

    expect(submitSpy).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ extracted: 0, facts: 0 });
    // The buffer is left exactly where it was — no claim, no delete.
    expect(fs.existsSync(buf)).toBe(true);
    expect(fs.existsSync(transcriptProcessingPath(dataDir, "conv-gated"))).toBe(false);
  });
});

describe("runTranscriptSweepTick — fail-soft", () => {
  it("a missing transcripts/ dir is a clean no-op (never throws)", async () => {
    enableCapture();
    // No buffers written at all.
    await expect(runTranscriptSweepTick({ store: store! })).resolves.toMatchObject({
      extracted: 0,
    });
  });

  it("an extractor failure on one buffer never aborts the rest of the sweep", async () => {
    enableCapture();
    writeBuffer("conv-a-fails", "### user\n\nfirst\n", IDLE_MS + 1);
    writeBuffer("conv-b-ok", "### user\n\nsecond\n", IDLE_MS + 1);
    let call = 0;
    const flaky: LlmClient = {
      complete: async () => {
        call += 1;
        if (call === 1) throw new Error("boom");
        return { content: JSON.stringify({ facts: ["recovered fact"] }), model: "m", usage: null };
      },
    };

    const summary = await runTranscriptSweepTick({ store: store!, buildClient: () => flaky });

    // One buffer's extractor threw (kept for a retry), the other still ran.
    expect(summary.extracted).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.facts).toBe(1);
  });
});

describe("runTranscriptSweepTick — a failed extraction keeps the conversation (review #10)", () => {
  const failing = (error: unknown = new Error("model unavailable")): LlmClient => ({
    complete: async () => {
      throw error;
    },
  });
  const HOUR = 60 * 60_000;

  it("keeps the claimed buffer when the model call fails, instead of deleting the conversation", async () => {
    enableCapture();
    writeBuffer("conv-1", "### user\n\nWe chose queues for durable retries.\n", IDLE_MS + 1);

    const summary = await runTranscriptSweepTick({ store: store!, buildClient: () => failing() });

    expect(summary).toMatchObject({ extracted: 1, failed: 1, facts: 0 });
    expect(fs.readFileSync(transcriptProcessingPath(dataDir, "conv-1"), "utf8")).toContain(
      "durable retries",
    );
  });

  it("an unusable reply is a failure too, not an empty conversation", async () => {
    enableCapture();
    writeBuffer("conv-1", "### user\n\nsubstantive\n", IDLE_MS + 1);
    const garbage: LlmClient = {
      complete: async () => ({ content: "not json at all", model: "m", usage: null }),
    };

    const summary = await runTranscriptSweepTick({ store: store!, buildClient: () => garbage });

    expect(summary.failed).toBe(1);
    expect(fs.existsSync(transcriptProcessingPath(dataDir, "conv-1"))).toBe(true);
  });

  it("waits a full reaper window before retrying, then extracts the kept buffer", async () => {
    enableCapture();
    writeBuffer("conv-1", "### user\n\nWe chose queues.\n", IDLE_MS + 1);
    await runTranscriptSweepTick({ store: store!, buildClient: () => failing() });

    // Five minutes later the failed claim is still backing off.
    const soon = await runTranscriptSweepTick({
      store: store!,
      now: () => Date.now() + 5 * 60_000,
      buildClient: () => factsClient(["queues chosen"]),
    });
    expect(soon).toMatchObject({ reaped: 0, extracted: 0 });

    // After the reaper window it is returned and extracted.
    const later = await runTranscriptSweepTick({
      store: store!,
      now: () => Date.now() + HOUR + 60_000,
      buildClient: () => factsClient(["queues chosen"]),
    });
    expect(later).toMatchObject({ reaped: 1, extracted: 1, facts: 1, failed: 0 });
    expect(fs.existsSync(transcriptProcessingPath(dataDir, "conv-1"))).toBe(false);
  });

  it("gives up on a conversation after three failed attempts and deletes it", async () => {
    enableCapture();
    writeBuffer("conv-1", "### user\n\nalways times out\n", IDLE_MS + 1);
    let summary = await runTranscriptSweepTick({ store: store!, buildClient: () => failing() });
    for (const at of [1, 2]) {
      summary = await runTranscriptSweepTick({
        store: store!,
        now: () => Date.now() + at * (HOUR + 60_000),
        buildClient: () => failing(),
      });
    }

    expect(summary).toMatchObject({ failed: 0, abandoned: 1 });
    expect(fs.existsSync(transcriptProcessingPath(dataDir, "conv-1"))).toBe(false);
    expect(fs.existsSync(transcriptBufferPath(dataDir, "conv-1"))).toBe(false);
  });

  it("stops the sweep after a provider timeout instead of sending the next conversation", async () => {
    enableCapture();
    writeBuffer("conv-a", "### user\n\nfirst\n", IDLE_MS + 1);
    writeBuffer("conv-b", "### user\n\nsecond\n", IDLE_MS + 1);
    let calls = 0;
    const timingOut: LlmClient = {
      complete: async () => {
        calls += 1;
        throw new LlmClientError("timeout", "timed out after 300000ms");
      },
    };

    const summary = await runTranscriptSweepTick({ store: store!, buildClient: () => timingOut });

    expect(calls).toBe(1);
    expect(summary).toMatchObject({ extracted: 1, failed: 1, stoppedEarly: true });
    // The untouched conversation is still waiting for the next tick.
    expect(
      [transcriptBufferPath(dataDir, "conv-a"), transcriptBufferPath(dataDir, "conv-b")].filter(
        (p) => fs.existsSync(p),
      ),
    ).toHaveLength(1);
  });
});

// ── Shelf-marker routing + fail-soft (spec 062 SC 8a + review E) ─────────────────────────────────
// Under a router that WRITES markers (a Teams router), the vault root is typically NOT in the groom
// set, so a malformed marker falling back to the ROOT inbox would be a silent black hole (never
// swept). The fix: a malformed/non-writable/bad-prefix marker falls back to the FIRST groom shelf's
// inbox — guaranteed swept — with NO fact loss; a valid marker routes to its shelf.
describe("runTranscriptSweepTick — shelf-marker routing + fail-soft (spec 062 review E)", () => {
  const personal: Shelf = { id: "personal", prefix: "members/x/", writable: true };
  const team: Shelf = { id: "team", prefix: "team/", writable: false };
  // groom set = [personal (writable, first), team]; the vault root is NOT in it.
  const teamsRouter: VaultRouter = {
    shelves: (_p, op) => (op === "write" ? [personal] : [personal, team]),
    writeTarget: () => personal,
  };

  function withRouter(): void {
    store!.close();
    store = createLibrarianStore({
      dataDir,
      backend: "markdown",
      secretKey: KEY,
      vaultRouter: teamsRouter,
    });
    enableCapture();
  }

  function writeShelfMarker(convId: string, raw: string): void {
    fs.writeFileSync(path.join(transcriptsDir(dataDir), `${convId}.shelf`), raw, "utf8");
  }
  function inboxCount(prefix: string): number {
    const dir = path.join(dataDir, "vault", prefix, "inbox");
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length : 0;
  }

  // A groom set whose FIRST shelf is READ-ONLY — a LEGAL shape, and the one the writable-first set
  // above masked. Router order is PLUGIN-chosen, and spec 062 §4 / review A1 made system pipelines
  // SHELF-SCOPED rather than writability-gated (grooming composes `core.rawMemory`), which legitimises
  // `writable: false` shelves inside a groom set. Through the write-GATED `forShelf` view the malformed
  // -marker fallback then threw ShelfNotWritableError per fact → swallowed by the per-fact fail-soft →
  // the buffer + markers were deleted anyway: `facts: 0`, every inbox empty, PERMANENT capture loss.
  // The fallback (and the valid-marker path) now submit through the store's UN-gated system seam.
  const readOnlyFirstRouter: VaultRouter = {
    shelves: (_p, op) => (op === "write" ? [personal] : [team, personal]),
    writeTarget: () => personal,
  };

  function withReadOnlyFirstRouter(): void {
    store!.close();
    store = createLibrarianStore({
      dataDir,
      backend: "markdown",
      secretKey: KEY,
      vaultRouter: readOnlyFirstRouter,
    });
    enableCapture();
  }

  for (const [name, raw] of [
    ["malformed JSON", "not json{"],
    ["writable:false", JSON.stringify({ id: "team", prefix: "team/", writable: false })],
  ] as const) {
    it(`a ${name} marker with a READ-ONLY first groom shelf still lands every fact (no capture loss)`, async () => {
      withReadOnlyFirstRouter();
      writeBuffer("conv-ro", "### user\n\nsubstantive content\n", IDLE_MS + 1);
      writeShelfMarker("conv-ro", raw);

      const summary = await runTranscriptSweepTick({
        store: store!,
        buildClient: () => factsClient(["fact one", "fact two"]),
      });

      // ZERO fact loss: both facts landed in the FIRST groom shelf's inbox — even though that shelf is
      // `writable: false` (a system-pipeline write is shelf-scoped, not writability-gated).
      expect(summary.facts).toBe(2);
      expect(inboxCount("team")).toBe(2);
      expect(inboxCount("members/x")).toBe(0); // not the writable second shelf
      expect(inboxCount("")).toBe(0); // not the un-swept vault root
      // …and the buffer was consumed exactly once (the facts are durable, so the delete is safe).
      expect(fs.existsSync(transcriptBufferPath(dataDir, "conv-ro"))).toBe(false);
      expect(fs.existsSync(transcriptProcessingPath(dataDir, "conv-ro"))).toBe(false);
      expect(fs.existsSync(path.join(transcriptsDir(dataDir), "conv-ro.shelf"))).toBe(false);
    });
  }

  it("a VALID marker naming a READ-ONLY shelf's groom set still routes through the un-gated seam", async () => {
    // The marker's `writable === true` is a marker-INTEGRITY check (a marker records what
    // `resolveWriteTarget` returned, always writable) — not a write gate on the submit. Here the marker
    // is valid and names the writable personal shelf, while the groom set's FIRST shelf is read-only:
    // the happy path must be unaffected by the read-only member and land on the marker's shelf.
    withReadOnlyFirstRouter();
    writeBuffer("conv-ok-ro", "### user\n\nsubstantive content\n", IDLE_MS + 1);
    writeShelfMarker("conv-ok-ro", JSON.stringify(personal));

    const summary = await runTranscriptSweepTick({
      store: store!,
      buildClient: () => factsClient(["fact one"]),
    });

    expect(summary.facts).toBe(1);
    expect(inboxCount("members/x")).toBe(1);
    expect(inboxCount("team")).toBe(0);
    expect(inboxCount("")).toBe(0);
  });

  it("a VALID marker routes the facts to that shelf's inbox", async () => {
    withRouter();
    writeBuffer("conv-ok", "### user\n\nsubstantive content\n", IDLE_MS + 1);
    writeShelfMarker("conv-ok", JSON.stringify(personal));
    const summary = await runTranscriptSweepTick({
      store: store!,
      buildClient: () => factsClient(["fact one", "fact two"]),
    });
    expect(summary.facts).toBe(2);
    expect(inboxCount("members/x")).toBe(2); // routed to the marker's shelf
    expect(inboxCount("")).toBe(0); // NOT the vault root
  });

  for (const [name, raw] of [
    ["malformed JSON", "not json{"],
    ["writable:false", JSON.stringify({ id: "team", prefix: "team/", writable: false })],
    [
      "bad prefix (no trailing slash)",
      JSON.stringify({ id: "x", prefix: "members/x", writable: true }),
    ],
  ] as const) {
    it(`a ${name} marker falls back to the FIRST groom shelf's inbox with no fact loss`, async () => {
      withRouter();
      writeBuffer("conv-bad", "### user\n\nsubstantive content\n", IDLE_MS + 1);
      writeShelfMarker("conv-bad", raw);
      const summary = await runTranscriptSweepTick({
        store: store!,
        buildClient: () => factsClient(["fact one", "fact two"]),
      });
      // No fact loss — both facts landed, in the first groom shelf's (swept) inbox, NOT the root.
      expect(summary.facts).toBe(2);
      expect(inboxCount("members/x")).toBe(2);
      expect(inboxCount("")).toBe(0);
    });
  }
});
