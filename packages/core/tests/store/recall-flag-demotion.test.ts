// Flagged memories rank lower in hybrid recall (spec 076 §3): `flag_memory`
// promises a flag demotes the memory; until now only the keyword fallback did.
// A flagged hit moves down three places — lower, never excluded.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  buildCorpusIndex,
  createHashEmbedder,
  createLibrarianStore,
  createVault,
  recallMemories,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir = "";
let store: LibrarianStore;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-flag-demotion-"));
  store = createLibrarianStore({ dataDir });
});
afterEach(() => {
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function recallIds(query: string): Promise<string[]> {
  const index = await buildCorpusIndex(createVault({ dataDir }), {
    embedder: createHashEmbedder(),
  });
  const hits = await recallMemories({ index, getMemory: (id) => store.getMemory(id) }, query, {
    limit: 8,
  });
  return hits.map((m) => m.id);
}

// Five memories about the same thing, from most to least on-topic.
function seed(): string[] {
  const bodies = [
    "zigzag proxy port caddy tls",
    "zigzag proxy port caddy",
    "zigzag proxy port",
    "zigzag proxy",
    "zigzag",
  ];
  return bodies.map(
    (body, i) => store.createMemory({ agent_id: "a", title: `Note ${i}`, body }).memory.id,
  );
}

describe("recallMemories — flag demotion", () => {
  it("moves a flagged hit down three places", async () => {
    const ids = seed();
    const before = await recallIds("zigzag proxy port caddy tls");
    expect(before[0]).toBe(ids[0]);
    store.flagMemory(ids[0]!, "outdated", "agent-b");
    const after = await recallIds("zigzag proxy port caddy tls");
    expect(after.indexOf(ids[0]!)).toBe(3);
    // Everything else keeps its relative order.
    expect(after.filter((id) => id !== ids[0])).toEqual(before.filter((id) => id !== ids[0]));
  });

  it("still returns a flagged memory when it is the only match", async () => {
    const only = store.createMemory({
      agent_id: "a",
      title: "Lone",
      body: "quokka habitat",
    }).memory;
    store.flagMemory(only.id, "outdated", "agent-b");
    expect(await recallIds("quokka habitat")).toContain(only.id);
  });
});
