// Tool-registry contract — the guardrail against agent-facing MCP surface
// drift (spec 047 / ADR 0006). The set of registered tool names is a contract
// the harness plugins depend on; this test pins it exactly, so adding or
// removing a tool fails here until the change is deliberate and the expected
// set is updated in the same commit.
//
// Imported from the built artifact: this package's vitest config externalizes
// packages/mcp-server/{src,dist} to Node's loader, which can't parse .ts — the
// same reason the other internal-module tests exercise dist/.
import { describe, expect, it } from "vitest";
import { toolsByName } from "../../dist/mcp/tools/index.js";

// The agent-facing tool surface (rethink spec §5.1, D8/D10): exactly the
// 7 memory/handoff/reference verbs. The skills subsystem (`list_skills` /
// `get_skill`) was deleted in rethink T1; the conv_state trio in rethink T2.
// Kept sorted so a diff reads cleanly when the contract intentionally changes.
const EXPECTED_TOOL_NAMES = [
  "claim_handoff",
  "flag_memory",
  "list_handoffs",
  "recall",
  "remember",
  "search_references",
  "store_handoff",
];

// Removed in PR-4 (ADR 0006) + rethink T1 (skills) + rethink T2 (conv_state).
// Pinned as a positive absence assertion so a re-add fails here until the
// contract is deliberately changed.
const REMOVED_TOOL_NAMES = [
  "start_context",
  "propose_memory",
  "update_memory",
  "archive_memory",
  "list_proposals",
  "approve_proposal",
  // rethink T1 — the skills subsystem is deleted entirely.
  "list_skills",
  "get_skill",
  // rethink T2 (D10) — conv_state is deleted, not hidden; the awareness
  // primer it carried moves to MCP initialize `instructions` (Phase 2 T11).
  "conv_state_get",
  "conv_state_upsert",
  "conv_state_clear",
];

describe("MCP tool registry contract", () => {
  it("registers exactly the expected set of tool names", () => {
    const actual = [...toolsByName.keys()].sort();
    expect(actual).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("registers exactly 7 tools", () => {
    expect(toolsByName.size).toBe(EXPECTED_TOOL_NAMES.length);
    expect(EXPECTED_TOOL_NAMES).toHaveLength(7);
  });

  it("no longer exposes the retired admin/skills/conv_state verbs", () => {
    for (const name of REMOVED_TOOL_NAMES) {
      expect(toolsByName.has(name)).toBe(false);
    }
  });

  it("exposes flag_memory and no longer exposes verify_memory", () => {
    expect(toolsByName.has("flag_memory")).toBe(true);
    expect(toolsByName.has("verify_memory")).toBe(false);
  });

  it("no longer exposes the retired skills/session discovery verbs", () => {
    expect(toolsByName.has("list_skills")).toBe(false);
    expect(toolsByName.has("get_skill")).toBe(false);
    expect(toolsByName.has("find_skills")).toBe(false);
    expect(toolsByName.has("session_manifest")).toBe(false);
  });

  it("exposes no internal/admin-only tools — all 7 verbs are agent-callable", () => {
    for (const tool of toolsByName.values()) {
      expect(tool.adminOnly, `${tool.name} must not be adminOnly`).not.toBe(true);
    }
  });
});

// Tool descriptions are a first-class deliverable (rethink T12, spec §5.1 /
// D9–D12): the only teaching surface guaranteed to render in EVERY harness, so
// each carries its protocol. Asserted as content MARKERS (a phrase per
// protocol), not full string-twins — wording may be tuned without breaking the
// contract, but a protocol silently dropped from a description fails here.
describe("MCP tool descriptions carry their protocols (rethink T12)", () => {
  const description = (name: string): string => toolsByName.get(name)!.description;

  it("every description fits the ≤1KB budget", () => {
    for (const tool of toolsByName.values()) {
      expect(
        Buffer.byteLength(tool.description, "utf8"),
        `${tool.name} description must be ≤1KB`,
      ).toBeLessThanOrEqual(1024);
    }
  });

  it("recall: call before answering when prior context may exist; memories only", () => {
    expect(description("recall")).toMatch(/before answering/i);
    expect(description("recall")).toMatch(/memories only/i);
    expect(description("recall")).toContain("search_references");
  });

  it("remember: durable fact/preference/decision, fire-and-forget to the curator", () => {
    expect(description("remember")).toMatch(/durable fact, preference, or decision/i);
    expect(description("remember")).toMatch(/fire-and-forget/i);
    expect(description("remember")).toMatch(/curator/i);
    // S2: the stale "routes to a review queue automatically" claim is gone —
    // the legacy direct write always lands active.
    expect(description("remember")).not.toMatch(/review queue/i);
  });

  it("flag_memory: wrong/outdated memory, reason required, routes to review + demotes", () => {
    expect(description("flag_memory")).toMatch(/wrong|incorrect/i);
    expect(description("flag_memory")).toMatch(/outdated/i);
    expect(description("flag_memory")).toMatch(/reason/i);
    expect(description("flag_memory")).toMatch(/review/i);
    expect(description("flag_memory")).toMatch(/demotes/i);
  });

  it("store_handoff: contains all five required section headings", () => {
    for (const heading of [
      "Start & intent",
      "Journey",
      "Current state",
      "What's left",
      "Open questions",
    ]) {
      expect(description("store_handoff")).toContain(heading);
    }
  });

  it("store_handoff: creation is explicit-request-only (no spontaneous handoffs)", () => {
    expect(description("store_handoff")).toMatch(
      /only call it when the user has explicitly asked/i,
    );
    expect(description("store_handoff")).toMatch(/never spontaneously/i);
    // The old spontaneous-use trigger is gone.
    expect(description("store_handoff")).not.toContain("Call it when pausing");
  });

  it("list_handoffs + claim_handoff: the takeover protocol, claim races → 409", () => {
    expect(description("list_handoffs")).toContain("claim_handoff");
    expect(description("claim_handoff")).toContain("list_handoffs");
    expect(description("claim_handoff")).toContain("409");
  });

  it("search_references: long-form background material, NOT auto-recalled", () => {
    expect(description("search_references")).toMatch(/long-form/i);
    expect(description("search_references")).toMatch(/NOT auto-recalled/);
  });
});
