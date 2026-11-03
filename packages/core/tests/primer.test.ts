// The primer (rethink T11, spec §5.2; reshaped by spec 083).
//
// Since spec 083 the primer is the shipped DEFAULT (code, always sent, never editable) followed
// by the operator's ADDENDUM (`vault/primer.md`, ≤2 KB, git-committed). Under test:
//   - the default: short, carries each protocol, injection-safe wording;
//   - composition: default alone, or default + blank line + trimmed addendum; never empty;
//   - the addendum write cap, cache refresh, and review-notice clearing;
//   - the one-time migration of a pre-083 primer.md and of the legacy settings primer;
//   - fail-soft reads (an unreadable vault degrades to the default, never throws).

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_PRIMER,
  LEGACY_AWARENESS_PRIMER_KEY,
  LEGACY_WORKING_STYLE_KEY,
  type LibrarianStore,
  PREVIOUS_DEFAULT_PRIMER_SHA256,
  PRIMER_ADDENDUM_MIGRATED_KEY,
  PRIMER_MAX_BYTES,
  PRIMER_PATH,
  composePrimer,
  createLibrarianStore,
  isPreviousDefaultPrimer,
  primerAddendumMaxBytes,
  primerReviewPending,
  readPrimer,
  readPrimerAddendum,
  seedPrimer,
  setPrimerAddendum,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir = "";
let store: LibrarianStore | null = null;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-primer-"));
  store = createLibrarianStore({ dataDir });
});

afterEach(() => {
  try {
    store?.close();
  } catch {
    /* ignore */
  }
  store = null;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const primerFile = (): string => path.join(dataDir, "vault", PRIMER_PATH);

// The default shipped immediately before spec 082, byte for byte.
const PREVIOUS_DEFAULT = `You are connected to The Librarian — durable, shared memory across sessions, agents, and harnesses; recall before answering anything that may have prior context, and remember durable facts, preferences, and decisions as you learn them.

Memory: you HAVE \`recall\` and \`remember\` — use them; do not rely on this window alone. Call \`recall\` before answering whenever prior context may exist, and ALWAYS after a compaction or context reset (earlier facts live on in memory). Call \`remember\` whenever you learn a durable fact, preference, or decision — fire-and-forget; the curator files it. If a recalled memory proves wrong or outdated, call \`flag_memory\` with a reason: what is wrong and, if known, what is true now. Relay the returned status: queued review is not completion, so do not claim a correction until its outcome is confirmed.

Handoffs: create a handoff only when the user has explicitly asked for one — to hand work off, call \`store_handoff\` with a document carrying the five required sections — Start & intent, Journey, Current state, What's left, Open questions. To take over work, call \`list_handoffs\`, then \`claim_handoff\` the one you want.

Learning: when asked to extract lessons from a conversation, call \`remember\` once per durable lesson.

References: long-form material is not auto-recalled — call \`search_references\` when the task needs depth. Journal: call \`journal\` for what happened in past conversations.

Private mode is an in-conversation instruction; the server cannot verify its marker. If the user asks to go private or off the record, acknowledge it and stop calling \`remember\`, \`store_handoff\`, and \`flag_memory\` until they toggle back. A curator review queued by a flag from public context may still correct that memory after switching private; the toggle does not cancel queued work. \`recall\`, \`search_references\` and \`journal\` stay available, and those queries reach the server's logs — say so if asked.

If The Librarian is unreachable, continue without it — never block the user's work.
`;

describe("the shipped default primer", () => {
  it("is short: well under half the old 2 KB budget", () => {
    expect(Buffer.byteLength(DEFAULT_PRIMER, "utf8")).toBeLessThan(1024);
  });

  it("carries each protocol (spec 083)", () => {
    expect(DEFAULT_PRIMER.split("\n")[0]).toMatch(/connected to The Librarian/);
    // The recall loop, including after a compaction or reset.
    expect(DEFAULT_PRIMER).toMatch(/Call `recall` before answering/);
    expect(DEFAULT_PRIMER).toMatch(/after a compaction or context reset/);
    // The miss rule (spec 082): remember what recall couldn't give you.
    expect(DEFAULT_PRIMER).toMatch(/If `recall` doesn't answer your question/);
    // Restraint on remember: harvesting covers routine facts.
    expect(DEFAULT_PRIMER).toMatch(/isn't obvious from the working directory/);
    expect(DEFAULT_PRIMER).toMatch(/don't save routine facts/);
    // "Factually" wrong: not merely unhelpful for the question at hand.
    expect(DEFAULT_PRIMER).toMatch(/factually wrong or outdated, call `flag_memory`/);
    expect(DEFAULT_PRIMER).toContain("search_references");
    expect(DEFAULT_PRIMER).toContain("`journal`");
    for (const verb of ["store_handoff", "list_handoffs", "claim_handoff"]) {
      expect(DEFAULT_PRIMER).toContain(verb);
    }
    expect(DEFAULT_PRIMER).toMatch(/only when the user asks/);
    // Private mode: the trigger, the blocked writes, and the logging disclosure.
    expect(DEFAULT_PRIMER).toMatch(/go private or off the record/);
    expect(DEFAULT_PRIMER).toMatch(/stop calling `remember`, `store_handoff` and `flag_memory`/);
    expect(DEFAULT_PRIMER).toMatch(/are logged/);
    // Fail-soft posture.
    expect(DEFAULT_PRIMER).toMatch(/unreachable, carry on without it/);
  });

  it("avoids prompt-injection-shaped wording (Hermes regex-screens MCP content)", () => {
    expect(DEFAULT_PRIMER).not.toMatch(/ignore|disregard|override/i);
  });
});

describe("composition (default + addendum)", () => {
  it("sends the default alone when there is no addendum", () => {
    expect(composePrimer("")).toBe(DEFAULT_PRIMER);
    expect(composePrimer("  \n ")).toBe(DEFAULT_PRIMER);
    expect(readPrimer(store!)).toBe(DEFAULT_PRIMER);
  });

  it("appends a trimmed addendum after a blank line", () => {
    expect(composePrimer("\nUse British English.\n\n")).toBe(
      `${DEFAULT_PRIMER.trimEnd()}\n\nUse British English.\n`,
    );
  });

  it("degrades to the default when the addendum can't be read, never throws", () => {
    const broken = {
      readPrimer(): string | null {
        throw new Error("vault unreadable");
      },
    };
    expect(readPrimer(broken)).toBe(DEFAULT_PRIMER);
    expect(readPrimerAddendum(broken)).toBe("");
  });
});

describe("setPrimerAddendum (the admin write path)", () => {
  it("round-trips an addendum and refreshes the cache", () => {
    expect(readPrimer(store!)).toBe(DEFAULT_PRIMER);
    setPrimerAddendum(store!, "Use British English.");
    expect(readPrimerAddendum(store!)).toBe("Use British English.");
    expect(readPrimer(store!)).toBe(composePrimer("Use British English."));
    expect(fs.readFileSync(primerFile(), "utf8")).toBe("Use British English.");
  });

  it("'' clears the addendum; the default is still sent", () => {
    setPrimerAddendum(store!, "Something.");
    setPrimerAddendum(store!, "");
    expect(readPrimer(store!)).toBe(DEFAULT_PRIMER);
  });

  it("caps the complete primer at 2 KB (harnesses truncate there), bytes not characters", () => {
    const limit = primerAddendumMaxBytes();
    expect(limit).toBeGreaterThan(1000);
    const multiByte = "é".repeat(Math.floor(limit / 2) + 1);
    expect(() => setPrimerAddendum(store!, multiByte)).toThrow(
      `the addendum must be ≤ ${limit} bytes, so the whole primer fits in ${PRIMER_MAX_BYTES} bytes`,
    );
    expect(fs.existsSync(primerFile())).toBe(false);
  });

  it("accepts an addendum that brings the primer to exactly the cap", () => {
    const exact = "x".repeat(primerAddendumMaxBytes());
    setPrimerAddendum(store!, exact);
    expect(Buffer.byteLength(readPrimer(store!), "utf8")).toBe(PRIMER_MAX_BYTES);
  });

  it("saving clears the migration review notice", () => {
    store!.writePrimer("My old custom primer.");
    seedPrimer(store!);
    expect(primerReviewPending(store!)).toBe(true);
    setPrimerAddendum(store!, "Trimmed.");
    expect(primerReviewPending(store!)).toBe(false);
  });
});

describe("seedPrimer (the one-time migration to the addendum model)", () => {
  it("a fresh install writes no file and sends the default", () => {
    seedPrimer(store!);
    expect(fs.existsSync(primerFile())).toBe(false);
    expect(readPrimer(store!)).toBe(DEFAULT_PRIMER);
    expect(primerReviewPending(store!)).toBe(false);
    expect(store!.getSetting(PRIMER_ADDENDUM_MIGRATED_KEY)).toBe("true");
  });

  it("clears an untouched previous default to an empty addendum, with no notice", () => {
    expect(isPreviousDefaultPrimer(PREVIOUS_DEFAULT)).toBe(true);
    store!.writePrimer(PREVIOUS_DEFAULT);
    seedPrimer(store!);
    expect(readPrimerAddendum(store!)).toBe("");
    expect(readPrimer(store!)).toBe(DEFAULT_PRIMER);
    expect(primerReviewPending(store!)).toBe(false);
  });

  it("knows every default shipped before 083, including 1.46.0's, and not the current one", () => {
    expect(PREVIOUS_DEFAULT_PRIMER_SHA256).toHaveLength(7);
    const current = createHash("sha256").update(DEFAULT_PRIMER).digest("hex");
    expect(PREVIOUS_DEFAULT_PRIMER_SHA256).not.toContain(current);
  });

  it("keeps an edited primer as the addendum and asks the owner to review it", () => {
    const edited = `${PREVIOUS_DEFAULT} `;
    store!.writePrimer(edited);
    seedPrimer(store!);
    expect(readPrimerAddendum(store!)).toBe(edited);
    expect(readPrimer(store!)).toBe(composePrimer(edited));
    expect(primerReviewPending(store!)).toBe(true);
  });

  it("an empty (formerly disabled) primer now sends the default", () => {
    store!.writePrimer("");
    seedPrimer(store!);
    expect(readPrimer(store!)).toBe(DEFAULT_PRIMER);
    expect(primerReviewPending(store!)).toBe(false);
  });

  it("runs once: a later addendum that happens to match an old default is left alone", () => {
    seedPrimer(store!);
    store!.writePrimer(PREVIOUS_DEFAULT);
    seedPrimer(store!);
    expect(readPrimerAddendum(store!)).toBe(PREVIOUS_DEFAULT);
  });

  it("moves the legacy settings primer into the addendum, then retires the key", () => {
    store!.setSetting(LEGACY_AWARENESS_PRIMER_KEY, "Legacy custom primer.");
    seedPrimer(store!);
    expect(readPrimerAddendum(store!)).toBe("Legacy custom primer.");
    expect(primerReviewPending(store!)).toBe(true);
    expect(store!.getSetting(LEGACY_AWARENESS_PRIMER_KEY)).toBeNull();
  });

  it("appends the legacy working-style preamble to the legacy note", () => {
    store!.setSetting(LEGACY_AWARENESS_PRIMER_KEY, "Legacy note.");
    store!.setSetting(LEGACY_WORKING_STYLE_KEY, "Be concise.");
    seedPrimer(store!);
    expect(readPrimerAddendum(store!)).toBe("Legacy note.\n\nBe concise.");
    expect(store!.getSetting(LEGACY_WORKING_STYLE_KEY)).toBeNull();
  });

  it("a lone working-style preamble becomes the addendum", () => {
    store!.setSetting(LEGACY_WORKING_STYLE_KEY, "Always answer in French.");
    seedPrimer(store!);
    expect(readPrimer(store!)).toBe(composePrimer("Always answer in French."));
  });

  it("a legacy explicitly-empty primer can no longer disable it", () => {
    store!.setSetting(LEGACY_AWARENESS_PRIMER_KEY, "");
    seedPrimer(store!);
    expect(readPrimer(store!)).toBe(DEFAULT_PRIMER);
    expect(store!.getSetting(LEGACY_AWARENESS_PRIMER_KEY)).toBeNull();
  });

  it("is durable across a fresh store on the same data dir", () => {
    store!.writePrimer("Kept.");
    seedPrimer(store!);
    store!.close();
    store = createLibrarianStore({ dataDir });
    seedPrimer(store!);
    expect(readPrimer(store!)).toBe(composePrimer("Kept."));
  });
});
