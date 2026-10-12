// Provenance labels in the MCP `recall` TEXT output (spec 062 T5 — SC 5, the decided format).
//   - A MULTI-shelf recall renders each hit's shelf as a bracketed token an agent reads:
//     `[<label> (<id>)]` when the shelf has a label, `[<id>]` when not (spec 062 §6).
//   - A SINGLE-shelf (default-router) recall renders NO token — byte-identical to today. Asserted
//     explicitly here (not left to the existing formatting suites), per the T5 inertness rule.

import { type Shelf, type VaultRouter, createLibrarianStore } from "@librarian/core";
import { handleMcpPayload } from "@librarian/mcp-server";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../test/helpers.js";

// A LABELLED shelf (higher precedence) + an UNLABELLED shelf, both writable so the test can seed
// them. Writability is orthogonal to labels — the token rendering depends only on id/label.
const SARAH: Shelf = {
  id: "members/x",
  prefix: "members/x/",
  writable: true,
  label: "Sarah's shelf",
};
const TEAM: Shelf = { id: "team", prefix: "team/", writable: true };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function storeWith(router?: VaultRouter): ReturnType<typeof createLibrarianStore> {
  const dataDir = makeTempDir();
  dirs.push(dataDir);
  return createLibrarianStore({ dataDir, ...(router ? { vaultRouter: router } : {}) });
}

async function recallText(
  store: ReturnType<typeof createLibrarianStore>,
  query: string,
): Promise<string> {
  const res = (await handleMcpPayload(store, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "recall", arguments: { agent_id: "x", query, limit: 5 } },
  })) as { result: { content: { text: string }[] } };
  return res.result.content[0].text;
}

describe("MCP recall provenance labels (spec 062 SC 5)", () => {
  it("renders `[label (id)]` for a labelled shelf and `[id]` for an unlabelled one", async () => {
    const twoShelfRouter: VaultRouter = { shelves: () => [SARAH, TEAM], writeTarget: () => SARAH };
    const store = storeWith(twoShelfRouter);
    store
      .forShelf(SARAH)
      .createMemory({ title: "Sarah note", body: "piano tuning secrets", agent_id: "x" }, {});
    store
      .forShelf(TEAM)
      .createMemory({ title: "Team note", body: "piano tuning roster", agent_id: "x" }, {});

    const text = await recallText(store, "piano tuning");

    // The exact lines an agent reads — labelled shelf shows the label with its id in parentheses,
    // the unlabelled shelf shows the bare id.
    expect(text).toMatch(/^- \[Sarah's shelf \(members\/x\)\] Sarah note: piano tuning secrets$/m);
    expect(text).toMatch(/^- \[team\] Team note: piano tuning roster$/m);
  });

  it("adds NO shelf token under the default (single-shelf) router — byte-identical to today", async () => {
    const store = storeWith(); // default router — one shelf, prefix ""
    store.createMemory({ title: "Piano note", body: "tune the piano", agent_id: "x" }, {});

    const text = await recallText(store, "piano");

    expect(text).toMatch(/^- Piano note: tune the piano$/m); // plain line, no leading token
    expect(text).not.toMatch(/^- \[/m); // no bracketed provenance token anywhere
    expect(text).not.toContain("[main]"); // the default shelf's id never leaks into the text
  });

  it("labels an `ids` fetch the same way under a multi-shelf router (spec 075)", async () => {
    const twoShelfRouter: VaultRouter = { shelves: () => [SARAH, TEAM], writeTarget: () => SARAH };
    const store = storeWith(twoShelfRouter);
    const sarah = store
      .forShelf(SARAH)
      .createMemory(
        { title: "Sarah note", body: "piano tuning secrets", agent_id: "x" },
        {},
      ).memory;
    const team = store
      .forShelf(TEAM)
      .createMemory({ title: "Team note", body: "piano tuning roster", agent_id: "x" }, {}).memory;

    const res = (await handleMcpPayload(store, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "recall", arguments: { agent_id: "x", ids: [team.id, sarah.id] } },
    })) as { result: { content: { text: string }[] } };

    expect(res.result.content[0].text).toBe(
      "Relevant Memories\n\n" +
        "- [team] Team note: piano tuning roster\n" +
        "- [Sarah's shelf (members/x)] Sarah note: piano tuning secrets",
    );
  });
});
