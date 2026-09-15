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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_PRIMER,
  LEGACY_AWARENESS_PRIMER_KEY,
  LEGACY_WORKING_STYLE_KEY,
  type LibrarianStore,
  PRIMER_MAX_BYTES,
  PRIMER_PATH,
  createLibrarianStore,
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

describe("the shipped default primer", () => {
  it("fits the ≤2KB budget with room for operator edits", () => {
    expect(Buffer.byteLength(DEFAULT_PRIMER, "utf8")).toBeLessThanOrEqual(PRIMER_MAX_BYTES);
  });

  it("carries every protocol, critical-first (spec §5.2)", () => {
    // (a) the behavioral loop leads — first sentence territory.
    const firstParagraph = DEFAULT_PRIMER.split("\n\n")[0]!;
    expect(firstParagraph).toMatch(/recall before answering/i);
    expect(firstParagraph).toMatch(/remember durable facts, preferences, and decisions/i);
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
    // (d) private mode (D11): writes blocked, reads stay + logged server-side.
    expect(DEFAULT_PRIMER).toMatch(/private/i);
    expect(DEFAULT_PRIMER).toContain("flag_memory");
    expect(DEFAULT_PRIMER).toMatch(/logs/i);
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
