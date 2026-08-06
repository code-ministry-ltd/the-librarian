// Inbox queue primitives (plan 036 Phase 4 / spec 035 §F5 inbox, Open-Q #2).
//
// The inbox is the durable submission queue: instant fire-and-forget writes,
// FIFO ordering, a once-only atomic claim (rename inbox/X → inbox/.processing/X
// — the rename winner owns the job), and a boot reaper that returns stale
// claims left by a crashed worker. These are pure vault operations — no LLM,
// no scheduler — so they're fully unit-testable with an injected clock.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type Vault,
  claimInboxItem,
  completeInboxItem,
  createVault,
  listInbox,
  parseInboxItem,
  releaseStaleClaims,
  writeInbox,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let vault: Vault;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-inbox-"));
  vault = createVault({ dataDir });
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** A deterministic clock: each call advances by 1ms from the given start. */
function clockFrom(startMs: number): { now: () => number } {
  let t = startMs;
  return { now: () => t++ };
}

describe("writeInbox", () => {
  it("writes a fire-and-forget item under inbox/ and round-trips the text", () => {
    const ref = writeInbox(vault, "Elaine moved to Berlin", {
      now: () => 1000,
      generateId: () => "inbox_a",
    });
    expect(ref.relPath.startsWith("inbox/")).toBe(true);
    expect(ref.relPath.endsWith(".md")).toBe(true);
    expect(vault.exists(ref.relPath)).toBe(true);
    const parsed = parseInboxItem(vault.readText(ref.relPath));
    expect(parsed.id).toBe("inbox_a");
    expect(parsed.text).toBe("Elaine moved to Berlin");
    expect(parsed.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("does not place the item under inbox/.processing/", () => {
    const ref = writeInbox(vault, "x", { now: () => 1 });
    expect(ref.relPath).not.toContain(".processing");
  });

  it("round-trips submission hints (agent_id / tags / applies_to / project_keys)", () => {
    const ref = writeInbox(vault, "Elaine moved to Berlin", {
      now: () => 1000,
      generateId: () => "inbox_a",
      hints: {
        agentId: "agent-a",
        tags: ["person", "move"],
        appliesTo: ["Elaine", "Berlin"],
        projectKeys: ["the-librarian", "website"],
      },
    });
    expect(parseInboxItem(vault.readText(ref.relPath)).hints).toEqual({
      agentId: "agent-a",
      tags: ["person", "move"],
      appliesTo: ["Elaine", "Berlin"],
      projectKeys: ["the-librarian", "website"],
    });
  });

  it("round-trips a forceProposal routing directive (ADR 0004)", () => {
    const ref = writeInbox(vault, "Elaine moved to Berlin", {
      now: () => 1000,
      generateId: () => "inbox_a",
      hints: { agentId: "agent-a", forceProposal: true },
    });
    expect(parseInboxItem(vault.readText(ref.relPath)).hints).toEqual({
      agentId: "agent-a",
      forceProposal: true,
    });
  });

  it("round-trips an empty tag list", () => {
    const ref = writeInbox(vault, "global fact", {
      now: () => 1000,
      generateId: () => "inbox_a",
      hints: { agentId: "agent-a", tags: [] },
    });
    expect(parseInboxItem(vault.readText(ref.relPath)).hints).toEqual({
      agentId: "agent-a",
      tags: [],
    });
  });

  it("yields empty hints when none are supplied", () => {
    const ref = writeInbox(vault, "x", { now: () => 1, generateId: () => "inbox_a" });
    expect(parseInboxItem(vault.readText(ref.relPath)).hints).toEqual({});
  });

  it("round-trips hint values needing YAML escaping (quotes, colons, newlines)", () => {
    const hints = {
      agentId: 'agent "x": line1\nline2',
      tags: ['tag: with "quote"', "back\\slash"],
      // applies_to is caller-supplied + untrusted — pin its escaping directly.
      appliesTo: ['Elaine "the boss": x\nid: spoofed', "---\ninjected: pwned"],
      projectKeys: ["safe-project\nforged: true"],
    };
    const ref = writeInbox(vault, "x", { now: () => 1, generateId: () => "inbox_a", hints });
    // The escaping must not break the frontmatter or inject keys — values survive verbatim.
    expect(parseInboxItem(vault.readText(ref.relPath)).hints).toEqual(hints);
  });
});

describe("listInbox", () => {
  it("returns pending items in FIFO (write-order) order", () => {
    const clock = clockFrom(1000);
    const a = writeInbox(vault, "first", { ...clock, generateId: () => "inbox_a" });
    const b = writeInbox(vault, "second", { ...clock, generateId: () => "inbox_b" });
    const c = writeInbox(vault, "third", { ...clock, generateId: () => "inbox_c" });
    expect(listInbox(vault)).toEqual([a.relPath, b.relPath, c.relPath]);
  });

  it("excludes claimed items under inbox/.processing/", () => {
    const clock = clockFrom(1000);
    const a = writeInbox(vault, "first", { ...clock, generateId: () => "inbox_a" });
    const b = writeInbox(vault, "second", { ...clock, generateId: () => "inbox_b" });
    claimInboxItem(vault, a.relPath, { now: () => 5000 });
    expect(listInbox(vault)).toEqual([b.relPath]);
  });

  it("is empty when nothing has been submitted", () => {
    expect(listInbox(vault)).toEqual([]);
  });
});

describe("claimInboxItem", () => {
  it("atomically moves the item into inbox/.processing/ and returns its new path", () => {
    const ref = writeInbox(vault, "claim me", { now: () => 1000, generateId: () => "inbox_a" });
    const claimed = claimInboxItem(vault, ref.relPath, { now: () => 5000 });
    expect(claimed).not.toBeNull();
    expect(claimed!.startsWith("inbox/.processing/")).toBe(true);
    expect(vault.exists(claimed!)).toBe(true);
    expect(vault.exists(ref.relPath)).toBe(false); // moved, not copied
    // The submission survives the move.
    expect(parseInboxItem(vault.readText(claimed!)).text).toBe("claim me");
  });

  it("is once-only: a second claim of the same item returns null (the rename winner owns it)", () => {
    const ref = writeInbox(vault, "x", { now: () => 1000, generateId: () => "inbox_a" });
    const first = claimInboxItem(vault, ref.relPath, { now: () => 5000 });
    const second = claimInboxItem(vault, ref.relPath, { now: () => 5001 });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("returns null for an item that was never written", () => {
    expect(
      claimInboxItem(vault, "inbox/000000000001000-inbox_ghost.md", { now: () => 1 }),
    ).toBeNull();
  });
});

describe("releaseStaleClaims (boot reaper)", () => {
  it("returns a claim older than the TTL back to the pending queue", () => {
    const ref = writeInbox(vault, "stranded", { now: () => 1000, generateId: () => "inbox_a" });
    claimInboxItem(vault, ref.relPath, { now: () => 10_000 });

    // 30 min later, the claim is stale (crashed worker).
    const restored = releaseStaleClaims(vault, { olderThanMs: 60_000, now: 10_000 + 30 * 60_000 });

    expect(restored).toEqual([ref.relPath]); // restored to its original pending path
    expect(listInbox(vault)).toEqual([ref.relPath]);
    expect(vault.listMarkdown("inbox/.processing")).toEqual([]);
  });

  it("leaves a fresh claim in place", () => {
    const ref = writeInbox(vault, "in flight", { now: () => 1000, generateId: () => "inbox_a" });
    const claimed = claimInboxItem(vault, ref.relPath, { now: () => 10_000 });

    // Only 1s elapsed — well inside the TTL.
    const restored = releaseStaleClaims(vault, { olderThanMs: 60_000, now: 11_000 });

    expect(restored).toEqual([]);
    expect(vault.exists(claimed!)).toBe(true);
    expect(listInbox(vault)).toEqual([]);
  });

  it("leaves a malformed .processing file untouched (not a claim we wrote)", () => {
    vault.writeText("inbox/.processing/not-a-claim.md", "stray");
    const restored = releaseStaleClaims(vault, { olderThanMs: 0, now: 9_000_000 });
    expect(restored).toEqual([]);
    expect(vault.exists("inbox/.processing/not-a-claim.md")).toBe(true);
  });

  it("a reclaimed item can be claimed again", () => {
    const ref = writeInbox(vault, "retry me", { now: () => 1000, generateId: () => "inbox_a" });
    claimInboxItem(vault, ref.relPath, { now: () => 10_000 });
    releaseStaleClaims(vault, { olderThanMs: 60_000, now: 10_000 + 30 * 60_000 });
    const reclaimed = claimInboxItem(vault, ref.relPath, { now: () => 9_000_000 });
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.startsWith("inbox/.processing/")).toBe(true);
  });
});

describe("completeInboxItem", () => {
  it("removes a processed claim and is idempotent", () => {
    const ref = writeInbox(vault, "done", { now: () => 1000, generateId: () => "inbox_a" });
    const claimed = claimInboxItem(vault, ref.relPath, { now: () => 5000 })!;
    completeInboxItem(vault, claimed);
    expect(vault.exists(claimed)).toBe(false);
    // idempotent — a second completion is a no-op, not a throw.
    expect(() => completeInboxItem(vault, claimed)).not.toThrow();
  });
});
