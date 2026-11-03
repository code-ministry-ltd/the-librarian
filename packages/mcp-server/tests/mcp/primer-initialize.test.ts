// MCP initialize → primer `instructions` (rethink T11, spec §5.2 / D10).
//
// The primer (vault/primer.md) rides the initialize result's `instructions`
// field — the connect-time channel every MCP harness renders into the system
// layer. Under test:
//   - the default comes back verbatim on initialize;
//   - an addendum edit is served FRESH to the next initialize (no process-start
//     snapshot — the store's cache refreshes on write);
//   - the default is always sent: an empty or absent addendum can't remove it (spec 083);
//   - both transports share this dispatch path (stdio + HTTP wrap
//     handleMcpPayload), so dispatch-level coverage covers both.

import { DEFAULT_PRIMER, composePrimer, seedPrimer } from "@librarian/core";
import { handleMcpPayload } from "@librarian/mcp-server";
import { describe, expect, it } from "vitest";
import { withStore } from "../../../../test/helpers.js";

interface InitializeResponse {
  result: { serverInfo: { name: string }; instructions?: string };
}

const initialize = (store: Parameters<typeof handleMcpPayload>[0]): Promise<unknown> =>
  handleMcpPayload(store, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

describe("MCP initialize carries the primer as instructions", () => {
  it("returns the seeded default primer verbatim (≤2KB by construction)", async () => {
    await withStore(async (store) => {
      seedPrimer(store);
      const response = (await initialize(store)) as InitializeResponse;
      expect(response.result.serverInfo.name).toBe("the-librarian");
      expect(response.result.instructions).toBe(DEFAULT_PRIMER);
      expect(Buffer.byteLength(response.result.instructions!, "utf8")).toBeLessThanOrEqual(2048);
    });
  });

  it("serves an edited addendum fresh on the next initialize (not process-cached stale)", async () => {
    await withStore(async (store) => {
      seedPrimer(store);
      const first = (await initialize(store)) as InitializeResponse;
      expect(first.result.instructions).toBe(DEFAULT_PRIMER);

      store.writePrimer("Addendum for the next session.");
      const second = (await initialize(store)) as InitializeResponse;
      expect(second.result.instructions).toBe(composePrimer("Addendum for the next session."));
    });
  });

  it("always sends the default, even when the addendum file is empty or absent (spec 083)", async () => {
    await withStore(async (store) => {
      const absent = (await initialize(store)) as InitializeResponse;
      expect(absent.result.instructions).toBe(DEFAULT_PRIMER);
      store.writePrimer("");
      const empty = (await initialize(store)) as InitializeResponse;
      expect(empty.result.instructions).toBe(DEFAULT_PRIMER);
    });
  });
});
