// The recall verb's excerpts and `ids` fetch (spec 075 §3.1.6–7): a long
// memory comes back as its best-matching section with a footer, and `ids`
// returns whole memories — active ones only, in the order asked.

import { handleMcpPayload } from "@librarian/mcp-server";
import { describe, expect, it } from "vitest";
import { withStore } from "../../../../test/helpers.js";

type Store = Parameters<Parameters<typeof withStore>[0]>[0];

const paragraph = (topic: string): string =>
  Array.from({ length: 175 }, (_, i) => `${topic}${i % 30}`).join(" ");

async function recall(store: Store, args: Record<string, unknown>): Promise<string> {
  const response = (await handleMcpPayload(store, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "recall", arguments: { agent_id: "codex", ...args } },
  })) as { result: { content: { text: string }[] } };
  return response.result.content[0]?.text ?? "";
}

function longMemory(store: Store): { id: string; body: string; fact: string } {
  const fact = "The zigzag proxy listens on port 9431 behind caddy.";
  const body = [paragraph("alpha"), paragraph("beta"), fact].join("\n\n");
  const { memory } = store.createMemory({ agent_id: "codex", title: "Workstation notes", body });
  return { id: memory.id, body, fact };
}

describe("recall excerpts", () => {
  it("returns a long memory as its matching section with a footer for fetching the rest", async () => {
    await withStore(async (store) => {
      const { id, fact } = longMemory(store);
      const text = await recall(store, { query: "zigzag proxy port caddy" });
      expect(text).toContain(`- Workstation notes: ${fact}\n`);
      expect(text).toContain(
        `(excerpt — 350 more words in this memory; recall with ids ["${id}"] for all of it)`,
      );
      expect(text).not.toContain("alpha1 ");
    });
  });

  it("returns a short memory whole, as before", async () => {
    await withStore(async (store) => {
      store.createMemory({ agent_id: "codex", title: "Port", body: "the api listens on 3838" });
      expect(await recall(store, { query: "api port" })).toBe(
        "Relevant Memories\n\n- Port: the api listens on 3838",
      );
    });
  });
});

describe("recall ids", () => {
  it("returns whole memories in the order asked, ignoring the query", async () => {
    await withStore(async (store) => {
      const long = longMemory(store);
      const short = store.createMemory({ agent_id: "codex", title: "Port", body: "3838" }).memory;
      const text = await recall(store, { ids: [short.id, long.id], query: "nothing matches" });
      expect(text).toBe(`Relevant Memories\n\n- Port: 3838\n- Workstation notes: ${long.body}`);
    });
  });

  it("omits archived and unknown ids without saying which", async () => {
    await withStore(async (store) => {
      const kept = store.createMemory({
        agent_id: "codex",
        title: "Kept",
        body: "still true",
      }).memory;
      const gone = store.createMemory({ agent_id: "codex", title: "Gone", body: "stale" }).memory;
      store.archiveMemory(gone.id);
      const text = await recall(store, {
        ids: [gone.id, "mem_00000000-0000-4000-8000-000000000000", kept.id, kept.id],
      });
      expect(text).toBe("Relevant Memories\n\n- Kept: still true");
      expect(await recall(store, { ids: [gone.id] })).toBe(
        "Relevant Memories\n\nNo relevant memories found.",
      );
    });
  });

  it("uses at most the first ten ids", async () => {
    await withStore(async (store) => {
      const ids = Array.from(
        { length: 12 },
        (_, i) =>
          store.createMemory({ agent_id: "codex", title: `Note ${i}`, body: `fact ${i}` }).memory
            .id,
      );
      const text = await recall(store, { ids });
      expect(text).toContain("- Note 9: fact 9");
      expect(text).not.toContain("Note 10");
      expect(text).not.toContain("Note 11");
    });
  });
});
