// Vault → index bridge tests (plan 036 Phase 3/7 cutover / spec 035 §F2-F4,
// slimmed per the 2026-06-12 rethink D8). buildCorpusIndex reads the markdown
// vault's memories/ and builds the plain hybrid index recall runs over;
// searchReferences searches references/ separately. It's the disposable
// index: rebuildable from the vault at any time.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCorpusIndex,
  createHashEmbedder,
  createLibrarianStore,
  createVault,
  searchReferences,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-corpus-index-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

interface SeedIds {
  piano: string;
  sailing: string;
  archived: string;
}

function seed(): SeedIds {
  const store = createLibrarianStore({ dataDir, backend: "markdown" });
  try {
    const piano = store.createMemory({
      agent_id: "codex",
      title: "Piano tuning",
      body: "the grand piano needs tuning twice a year",
    }).memory;
    const sailing = store.createMemory({
      agent_id: "codex",
      title: "Sailing",
      body: "navigating boats across open water",
    }).memory;
    const archived = store.createMemory({
      agent_id: "codex",
      title: "Old note",
      body: "obsolete fact about widgets and sprockets",
    }).memory;
    store.archiveMemory(archived.id); // archived → must be excluded from the index
    return { piano: piano.id, sailing: sailing.id, archived: archived.id };
  } finally {
    store.close();
  }
}

function seedReference(): void {
  fs.mkdirSync(path.join(dataDir, "vault", "references"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "vault", "references", "piano-manual.md"),
    "## Tuning\nthe steinway grand piano regulation and voicing guide",
  );
}

describe("buildCorpusIndex", () => {
  it("indexes active memories (Tier 1) and recalls the matching one first, by memory id", async () => {
    const ids = seed();
    const index = await buildCorpusIndex(createVault({ dataDir }), {
      embedder: createHashEmbedder(),
    });
    const hits = await index.recall("piano tuning");
    expect(hits[0]?.id).toBe(ids.piano); // recall returns the memory id, top-ranked
    expect(hits[0]?.matchedDirectly).toBe(true);
  });

  it("ranks a long memory first when the query matches one section deep inside it (spec 075)", async () => {
    const store = createLibrarianStore({ dataDir, backend: "markdown" });
    let longId = "";
    try {
      // A long, many-topic memory whose LAST paragraph holds the fact. Whole-memory
      // ranking dilutes that paragraph under ~2,100 words of other material;
      // 175-word paragraphs keep the fact in a section of its own.
      const filler = Array.from(
        { length: 12 },
        (_, i) =>
          `Topic ${i}: ` +
          Array.from({ length: 175 }, (_, j) => `subject${i}word${j % 40}`).join(" "),
      );
      longId = store.createMemory({
        agent_id: "codex",
        title: "Workstation notes",
        body: [...filler, "The zigzag proxy listens on port 9431 behind caddy."].join("\n\n"),
      }).memory.id;
      // Short memories that share some of the query's words.
      store.createMemory({
        agent_id: "codex",
        title: "Caddy setup",
        body: "caddy terminates tls for the proxy and the dashboard",
      });
      store.createMemory({
        agent_id: "codex",
        title: "Port inventory",
        body: "the proxy and the dashboard each have a port",
      });
    } finally {
      store.close();
    }
    const index = await buildCorpusIndex(createVault({ dataDir }), {
      embedder: createHashEmbedder(),
    });
    const hits = await index.recall("which port does the zigzag proxy listen on behind caddy");
    expect(hits[0]?.id).toBe(longId);
    expect(hits[0]?.section).toBe("The zigzag proxy listens on port 9431 behind caddy.");
  });

  it("ranks identically across two builds of the same vault (spec 075)", async () => {
    seed();
    const build = () =>
      buildCorpusIndex(createVault({ dataDir }), { embedder: createHashEmbedder() });
    const [a, b] = await Promise.all([build(), build()]);
    expect(await a.recall("piano boats water")).toEqual(await b.recall("piano boats water"));
  });

  it("excludes archived memories from recall", async () => {
    const ids = seed();
    const index = await buildCorpusIndex(createVault({ dataDir }), {
      embedder: createHashEmbedder(),
    });
    const hits = await index.recall("obsolete widgets sprockets");
    expect(hits.map((h) => h.id)).not.toContain(ids.archived);
  });

  it("references/ are retrievable only via searchReferences, never recall", async () => {
    seed();
    seedReference();
    const vault = createVault({ dataDir });
    const index = await buildCorpusIndex(vault, {
      embedder: createHashEmbedder(),
    });
    const refs = await searchReferences(vault, createHashEmbedder(), "piano regulation voicing");
    expect(refs.some((r) => r.id === "references/piano-manual.md")).toBe(true);
    expect(refs[0]?.section).toContain("## Tuning");
    // the reference must NOT appear in memory recall (recall is memories-only)
    const recalled = await index.recall("piano regulation voicing");
    expect(recalled.map((h) => h.id)).not.toContain("references/piano-manual.md");
  });

  it("excludes proposed (pending-approval) memories from recall, matching searchMemories", async () => {
    const store = createLibrarianStore({ dataDir, backend: "markdown" });
    let proposedId = "";
    try {
      // a proposed (pending/protected) write — status=proposed
      proposedId = store.createMemory(
        {
          agent_id: "codex",
          title: "Pending secret plan",
          body: "draft proposal about quantum widgets awaiting approval",
          status: "proposed",
        },
        { status: "proposed" },
      ).memory.id;
    } finally {
      store.close();
    }
    const index = await buildCorpusIndex(createVault({ dataDir }), {
      embedder: createHashEmbedder(),
    });
    const hits = await index.recall("quantum widgets proposal");
    expect(hits.map((h) => h.id)).not.toContain(proposedId);
  });

  it("fail-soft: a foreign/malformed .md under memories/ is skipped, recall still works", async () => {
    const ids = seed();
    // drop a non-memory markdown file straight into memories/
    fs.writeFileSync(
      path.join(dataDir, "vault", "memories", "README.md"),
      "# not a memory\n\njust notes",
    );
    const index = await buildCorpusIndex(createVault({ dataDir }), {
      embedder: createHashEmbedder(),
    });
    const hits = await index.recall("piano tuning"); // must not throw; the good memory still recalls
    expect(hits[0]?.id).toBe(ids.piano);
  });

  it("returns an empty index for an empty vault", async () => {
    fs.mkdirSync(path.join(dataDir, "vault"), { recursive: true });
    const vault = createVault({ dataDir });
    const index = await buildCorpusIndex(vault, {
      embedder: createHashEmbedder(),
    });
    expect(await index.recall("anything")).toEqual([]);
    expect(await searchReferences(vault, createHashEmbedder(), "anything")).toEqual([]);
  });
});
