// `journal` MCP tool (spec 077 §4.5, ADR 0016) through the real tools/call dispatch:
// gated on the journal switch, teaching on bad input, and reading the caller's shelf.

import {
  DEFAULT_SHELF,
  INTAKE_ENABLED_KEY,
  JOURNAL_ENABLED_KEY,
  type LibrarianStore,
  appendEpisode,
  localDate,
} from "@librarian/core";
import { handleMcpPayload } from "@librarian/mcp-server";
import { describe, expect, it } from "vitest";
import { withStore } from "../../../../test/helpers.js";

type CallResult = { result: { content: { text: string }[] } };

async function call(store: unknown, args: Record<string, unknown>): Promise<string> {
  const res = (await handleMcpPayload(store as never, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "journal", arguments: args },
  })) as CallResult;
  return res.result.content[0]!.text;
}

function enable(store: LibrarianStore): void {
  store.setSetting(INTAKE_ENABLED_KEY, "true");
  store.setSetting(JOURNAL_ENABLED_KEY, "true");
}

describe("journal MCP tool", () => {
  it("tells the agent the journal is off, as a normal reply rather than an error", async () => {
    await withStore(async (store: LibrarianStore) => {
      const text = await call(store, {});
      expect(text).toContain("The journal is turned off on this Librarian server");
      expect(text).toContain("Settings → Curator → Intake → Journal");
    });
  });

  it("retrieves recent entries from the caller's shelf", async () => {
    await withStore(async (store: LibrarianStore) => {
      enable(store);
      appendEpisode(store.systemJournal(DEFAULT_SHELF), localDate(new Date()), {
        key: "conv#s1",
        time: "10:00",
        harness: "claude",
        project: "the-librarian",
        bullets: ["Decided the journal gets its own verb."],
      });
      const text = await call(store, {});
      expect(text).toContain("Decided the journal gets its own verb.");
      expect(text).toContain("· claude · the-librarian");
    });
  });

  it("searches when given a query", async () => {
    await withStore(async (store: LibrarianStore) => {
      enable(store);
      appendEpisode(store.systemJournal(DEFAULT_SHELF), localDate(new Date()), {
        key: "conv#s1",
        time: "10:00",
        harness: "claude",
        project: "x",
        bullets: ["Chose BM25 over embeddings for journal search."],
      });
      const text = await call(store, { query: "embeddings" });
      expect(text).toContain('# Journal search: "embeddings"');
      expect(text).toContain("Chose BM25 over embeddings");
    });
  });

  it("rejects malformed input with a message the agent can act on", async () => {
    await withStore(async (store: LibrarianStore) => {
      enable(store);
      expect(await call(store, { from: "last week" })).toBe(
        "journal rejected: Expected `from` as YYYY-MM-DD, got 'last week'",
      );
    });
  });
});
