// Drift guard: the Pi adapter's /transcript delta MUST match the server's FIXED
// contract (packages/mcp-server/src/http/transcript-intake.ts payloadSchema):
//   { conv_id: string, harness: string, seq: int>=0, turns: {role,text,ts?}[],
//     ended?: boolean }
// The server validates with `strictObject` (an unknown top-level OR turn key is a
// 400), so this pins the Pi payload to EXACTLY those keys. If the server contract
// changes, this fails until the Pi adapter (buildPayload / messagesToTurns) is
// re-synced — the same drift-guard posture as tests/schema-parity.test.ts for the
// 8 tools and the Hermes adapter's wire-shape tests.

import { describe, expect, it } from "vitest";
import {
  buildPayload,
  type CaptureTurn,
  messagesToTurns,
} from "../extensions/librarian/transcript-capture.js";

// The exact keys the server's payloadSchema accepts (strictObject). Kept as a
// literal here so a server-side rename/add surfaces as a failing assertion.
const ALLOWED_PAYLOAD_KEYS = new Set(["conv_id", "harness", "seq", "turns", "ended"]);
const ALLOWED_TURN_KEYS = new Set(["role", "text", "ts"]);

describe("/transcript payload contract (drift guard vs server payloadSchema)", () => {
  it("emits only the contract's top-level keys (strictObject would 400 on extras)", () => {
    const payload = buildPayload({
      convId: "s",
      seq: 1,
      turns: [{ role: "user", text: "hi" }],
      ended: true,
    });
    for (const key of Object.keys(payload)) {
      expect(ALLOWED_PAYLOAD_KEYS.has(key), `unexpected top-level key '${key}'`).toBe(true);
    }
  });

  it("conv_id is a non-empty string; harness is the literal 'pi'; seq is a non-negative int", () => {
    const payload = buildPayload({ convId: "sess-xyz", seq: 0, turns: [] });
    expect(typeof payload.conv_id).toBe("string");
    expect(payload.conv_id.length).toBeGreaterThan(0);
    expect(payload.harness).toBe("pi");
    expect(Number.isInteger(payload.seq)).toBe(true);
    expect(payload.seq).toBeGreaterThanOrEqual(0);
  });

  it("omits `ended` entirely unless true (server treats its presence as the end accelerator)", () => {
    expect("ended" in buildPayload({ convId: "s", seq: 1, turns: [] })).toBe(false);
    expect(buildPayload({ convId: "s", seq: 1, turns: [], ended: true }).ended).toBe(true);
  });

  it("every turn carries only {role,text,ts?}, role ∈ {user,assistant}, text a string", () => {
    const turns: CaptureTurn[] = messagesToTurns([
      { role: "user", content: "q", timestamp: 1_700_000_000_000 },
      { role: "assistant", content: [{ type: "text", text: "a" }], timestamp: 1_700_000_000_000 },
    ]);
    expect(turns.length).toBe(2);
    for (const turn of turns) {
      for (const key of Object.keys(turn)) {
        expect(ALLOWED_TURN_KEYS.has(key), `unexpected turn key '${key}'`).toBe(true);
      }
      expect(["user", "assistant"]).toContain(turn.role);
      expect(typeof turn.text).toBe("string");
      if (turn.ts !== undefined) expect(typeof turn.ts).toBe("string");
    }
  });

  it("the whole delta round-trips JSON (it goes on the wire to the server)", () => {
    const payload = buildPayload({
      convId: "s",
      seq: 2,
      turns: messagesToTurns([{ role: "user", content: "hi", timestamp: 1_700_000_000_000 }]),
    });
    expect(() => JSON.parse(JSON.stringify(payload))).not.toThrow();
  });

  it("a turn's ts (when present) is a valid ISO-8601 string the server's z.string() accepts", () => {
    const [turn] = messagesToTurns([{ role: "user", content: "hi", timestamp: 1_718_000_000_000 }]);
    expect(turn?.ts).toBeDefined();
    // ISO round-trips back to the same instant.
    expect(new Date(turn!.ts!).toISOString()).toBe(turn!.ts);
  });
});
