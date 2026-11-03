// Primer vault file (rethink T11, spec §5.2 / D9–D11).
//
// The primer lives at `vault/primer.md` — operator-editable, git-committed,
// served via MCP initialize `instructions` + GET /primer.md. Under test:
//   - the shipped default: ≤2KB, critical-first content, injection-safe wording;
//   - seed-on-boot: absent file → default written (committed); present file →
//     untouched (no-clobber); legacy settings-key primer migrated once;
//   - the ≤2KB write cap (same rule/error style as curator addendums);
//   - the in-memory read cache refreshes on write;
//   - fail-soft reads (an unreadable vault degrades to "", never throws).

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
  PRIMER_MAX_BYTES,
  PRIMER_PATH,
  createLibrarianStore,
  isPreviousDefaultPrimer,
  readPrimer,
  seedPrimer,
  setPrimer,
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
  it("fits the ≤2KB budget with room for operator edits", () => {
    expect(Buffer.byteLength(DEFAULT_PRIMER, "utf8")).toBeLessThanOrEqual(PRIMER_MAX_BYTES);
  });

  it("carries every protocol, critical-first (spec §5.2)", () => {
    // (a) the behavioral loop leads — first sentence territory.
    const firstParagraph = DEFAULT_PRIMER.split("\n\n")[0]!;
    expect(firstParagraph).toMatch(/recall before answering/i);
    expect(firstParagraph).toMatch(/remember what you learn/i);
    // What to remember (spec 082): anything likely to be useful later that the working directory
    // doesn't already say, including answers the agent had to dig for.
    expect(DEFAULT_PRIMER).toMatch(
      /discover, learn or create something likely to be useful later/i,
    );
    expect(DEFAULT_PRIMER).toMatch(/isn't obvious from the working directory/i);
    expect(DEFAULT_PRIMER).toMatch(/answers you had to dig for/i);
    // (b) handoff protocol: store_handoff + the 5 sections; takeover chain.
    // Creation is explicit-request-only — the restraint that stops agents
    // from spontaneously handing off at session end.
    expect(DEFAULT_PRIMER).toContain("store_handoff");
    expect(DEFAULT_PRIMER).toMatch(/only when the user has explicitly asked/i);
    for (const heading of [
      "Start & intent",
      "Journey",
      "Current state",
      "What's left",
      "Open questions",
    ]) {
      expect(DEFAULT_PRIMER).toContain(heading);
    }
    expect(DEFAULT_PRIMER).toContain("list_handoffs");
    expect(DEFAULT_PRIMER).toContain("claim_handoff");
    // (c) learn protocol.
    expect(DEFAULT_PRIMER).toMatch(/once per durable lesson/i);
    // (c2) the journal verb (spec 077 / ADR 0016): named, and readable while private.
    expect(DEFAULT_PRIMER).toContain("call `journal` for what happened in past conversations");
    expect(DEFAULT_PRIMER).toContain("`recall`, `search_references` and `journal` stay available");
    // (d) private mode (D11): writes blocked, reads stay + logged server-side.
    expect(DEFAULT_PRIMER).toMatch(/private/i);
    expect(DEFAULT_PRIMER).toContain("flag_memory");
    expect(DEFAULT_PRIMER).toMatch(/logs/i);
    expect(DEFAULT_PRIMER).toMatch(/relay the returned status/i);
    expect(DEFAULT_PRIMER).toMatch(/server cannot verify its marker/i);
    expect(DEFAULT_PRIMER).toMatch(
      /queued by a flag from public context may still correct that memory after switching private/i,
    );
    expect(DEFAULT_PRIMER).toMatch(/toggle does not cancel queued work/i);
    // (e) fail-soft posture.
    expect(DEFAULT_PRIMER).toMatch(/unreachable/i);
    expect(DEFAULT_PRIMER).toMatch(/never block the user's work/i);
  });

  it("avoids prompt-injection-shaped wording (Hermes regex-screens MCP content)", () => {
    expect(DEFAULT_PRIMER).not.toMatch(/ignore|disregard|override/i);
  });
});

describe("seedPrimer (seed-on-boot)", () => {
  it("writes the default to vault/primer.md when absent, through the store (git-committed)", () => {
    expect(store!.readPrimer()).toBeNull();
    seedPrimer(store!);
    expect(fs.readFileSync(primerFile(), "utf8")).toBe(DEFAULT_PRIMER);
    expect(store!.readPrimer()).toBe(DEFAULT_PRIMER);
    // A fresh store on the same dataDir sees the committed file (durability).
    store!.close();
    store = createLibrarianStore({ dataDir });
    expect(store!.readPrimer()).toBe(DEFAULT_PRIMER);
  });

  it("never clobbers an existing primer (idempotent across boots)", () => {
    store!.writePrimer("Operator-authored primer.");
    seedPrimer(store!);
    seedPrimer(store!);
    expect(store!.readPrimer()).toBe("Operator-authored primer.");
  });

  it("upgrades an unedited previous default to the current one (spec 082)", () => {
    // The default shipped before spec 082, verbatim: what every untouched install holds.
    const previous = PREVIOUS_DEFAULT;
    expect(isPreviousDefaultPrimer(previous)).toBe(true);
    store!.writePrimer(previous);
    seedPrimer(store!);
    expect(store!.readPrimer()).toBe(DEFAULT_PRIMER);
  });

  it("leaves a primer alone if it differs from a past default by a single byte", () => {
    const edited = `${PREVIOUS_DEFAULT} `;
    store!.writePrimer(edited);
    seedPrimer(store!);
    expect(store!.readPrimer()).toBe(edited);
  });

  it("never lists the current default as a previous one (no upgrade loop)", () => {
    const current = createHash("sha256").update(DEFAULT_PRIMER).digest("hex");
    expect(PREVIOUS_DEFAULT_PRIMER_SHA256).not.toContain(current);
    expect(isPreviousDefaultPrimer(DEFAULT_PRIMER)).toBe(false);
  });

  it("seeds from the legacy settings-key primer instead of the default, then retires the key", () => {
    store!.setSetting(LEGACY_AWARENESS_PRIMER_KEY, "Legacy custom primer.");
    seedPrimer(store!);
    expect(store!.readPrimer()).toBe("Legacy custom primer.");
    expect(store!.getSetting(LEGACY_AWARENESS_PRIMER_KEY)).toBeNull();
  });

  it("a retired legacy key never re-seeds a later edit (one-time, no-clobber)", () => {
    store!.setSetting(LEGACY_AWARENESS_PRIMER_KEY, "Legacy custom primer.");
    seedPrimer(store!);
    store!.writePrimer("Edited after migration.");
    seedPrimer(store!);
    expect(store!.readPrimer()).toBe("Edited after migration.");
  });

  it("appends the legacy working-style preamble (it rode the old primer channel)", () => {
    store!.setSetting(LEGACY_AWARENESS_PRIMER_KEY, "Legacy note.");
    store!.setSetting(LEGACY_WORKING_STYLE_KEY, "Be concise.");
    seedPrimer(store!);
    expect(store!.readPrimer()).toBe("Legacy note.\n\nBe concise.");
    expect(store!.getSetting(LEGACY_WORKING_STYLE_KEY)).toBeNull();
  });

  it("keeps a lone working-style preamble on top of the new default", () => {
    store!.setSetting(LEGACY_WORKING_STYLE_KEY, "Always answer in French.");
    seedPrimer(store!);
    expect(store!.readPrimer()).toBe(`${DEFAULT_PRIMER}\n\nAlways answer in French.`);
  });

  it("honours a legacy explicitly-empty primer (the operator disabled it)", () => {
    store!.setSetting(LEGACY_AWARENESS_PRIMER_KEY, "");
    seedPrimer(store!);
    expect(store!.readPrimer()).toBe("");
    expect(readPrimer(store!)).toBe("");
  });
});

describe("setPrimer (the admin write path)", () => {
  it("round-trips a custom primer and refreshes the in-memory cache", () => {
    seedPrimer(store!);
    expect(readPrimer(store!)).toBe(DEFAULT_PRIMER); // warms the cache
    setPrimer(store!, "New primer text.");
    expect(readPrimer(store!)).toBe("New primer text."); // cache refreshed on write
  });

  it("'' is a valid write — it disables the primer", () => {
    seedPrimer(store!);
    setPrimer(store!, "");
    expect(readPrimer(store!)).toBe("");
  });

  it("refuses an over-cap primer before any write (bytes, not characters)", () => {
    seedPrimer(store!);
    // 1025 two-byte chars = 2050 bytes > 2048, but only 1025 characters.
    const multiByte = "é".repeat(PRIMER_MAX_BYTES / 2 + 1);
    expect(() => setPrimer(store!, multiByte)).toThrow(
      `primer must be ≤ ${PRIMER_MAX_BYTES} bytes (~2 KB); got ${PRIMER_MAX_BYTES + 2} bytes`,
    );
    // The refused write never touched the file.
    expect(readPrimer(store!)).toBe(DEFAULT_PRIMER);
  });

  it("accepts a primer of exactly the cap", () => {
    setPrimer(store!, "x".repeat(PRIMER_MAX_BYTES));
    expect(readPrimer(store!)).toBe("x".repeat(PRIMER_MAX_BYTES));
  });
});

describe("readPrimer (fail-soft)", () => {
  it("degrades to '' when the vault read throws — never blocks a connection", () => {
    const broken = {
      readPrimer(): string | null {
        throw new Error("vault unreadable");
      },
    };
    expect(() => readPrimer(broken)).not.toThrow();
    expect(readPrimer(broken)).toBe("");
  });

  it("reads '' (no primer) before the seed has run", () => {
    expect(readPrimer(store!)).toBe("");
  });
});
