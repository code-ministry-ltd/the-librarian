// Persistent embedding cache (rethink T23 / spec §9 D5) — a sidecar at
// `<data-dir>/embeddings-cache/` keyed by (relative file path, content hash,
// embedder model id) holding per-file chunk vectors. The point: a process
// restart must NOT re-embed unchanged files (the in-memory caching embedder
// dies with the process; this survives it). Invalidation is per file on
// content-hash mismatch; orphan entries for deleted files are pruned
// opportunistically; everything is fail-soft (a broken cache is a miss,
// never a throw).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type EmbedBacklogEvent,
  createEmbeddingCache,
  embedChunksWithCache,
  embedFilesWithCache,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let cacheDir: string;

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-embedding-cache-"));
});

afterEach(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

function countingEmbedder() {
  const calls = { embed: 0 };
  return {
    calls,
    embedder: {
      embed: (text: string) => {
        calls.embed += 1;
        return Promise.resolve([text.length, calls.embed]);
      },
    },
  };
}

describe("createEmbeddingCache", () => {
  it("serves cached vectors back across cache instances (survives a restart)", async () => {
    const first = countingEmbedder();
    const cacheA = createEmbeddingCache({ dir: cacheDir, modelId: "hash-test" });
    const vectorsA = await embedChunksWithCache(
      cacheA,
      first.embedder,
      "references/doc.md",
      "full file content",
      ["chunk one", "chunk two"],
    );
    expect(first.calls.embed).toBe(2);

    // a NEW cache instance over the same dir — i.e. the next server boot
    const second = countingEmbedder();
    const cacheB = createEmbeddingCache({ dir: cacheDir, modelId: "hash-test" });
    const vectorsB = await embedChunksWithCache(
      cacheB,
      second.embedder,
      "references/doc.md",
      "full file content",
      ["chunk one", "chunk two"],
    );
    expect(second.calls.embed).toBe(0); // nothing re-embedded
    expect(vectorsB).toEqual(vectorsA);
  });

  it("invalidates per file when the content hash changes", async () => {
    const cache = createEmbeddingCache({ dir: cacheDir, modelId: "hash-test" });
    const { embedder, calls } = countingEmbedder();
    await embedChunksWithCache(cache, embedder, "references/doc.md", "v1", ["v1"]);
    await embedChunksWithCache(cache, embedder, "references/doc.md", "v2 changed", ["v2 changed"]);
    expect(calls.embed).toBe(2); // changed content → fresh embed, no stale vector
  });

  it("misses when the chunk texts differ for the same content (chunker change guard)", async () => {
    const cache = createEmbeddingCache({ dir: cacheDir, modelId: "hash-test" });
    const { embedder, calls } = countingEmbedder();
    await embedChunksWithCache(cache, embedder, "references/doc.md", "same content", ["a", "b"]);
    // same file content, but a different chunking (e.g. new chunk bounds) →
    // the cached vectors no longer line up → full re-embed.
    await embedChunksWithCache(cache, embedder, "references/doc.md", "same content", ["a", "bc"]);
    expect(calls.embed).toBe(4);
  });

  it("keys different embedder/model identities separately (hash vs llama)", async () => {
    const hashCache = createEmbeddingCache({ dir: cacheDir, modelId: "hash-fnv1a-256" });
    const llamaCache = createEmbeddingCache({
      dir: cacheDir,
      modelId: "llama:embeddinggemma-300M-Q8_0.gguf",
    });
    const hash = countingEmbedder();
    const llama = countingEmbedder();
    await embedChunksWithCache(hashCache, hash.embedder, "references/doc.md", "content", ["c"]);
    await embedChunksWithCache(llamaCache, llama.embedder, "references/doc.md", "content", ["c"]);
    // the llama-keyed lookup must NOT have been satisfied by the hash entry
    expect(llama.calls.embed).toBe(1);
  });

  it("prunes orphan entries for deleted files under the prefix, keeping live + out-of-prefix entries", async () => {
    const cache = createEmbeddingCache({ dir: cacheDir, modelId: "hash-test" });
    const { embedder } = countingEmbedder();
    await embedChunksWithCache(cache, embedder, "references/alive.md", "a", ["a"]);
    await embedChunksWithCache(cache, embedder, "references/deleted.md", "d", ["d"]);
    await embedChunksWithCache(cache, embedder, "memories/mem.md", "m", ["m"]);

    cache.prune("references/", ["references/alive.md"]);

    const after = countingEmbedder();
    // live entry survives the prune…
    await embedChunksWithCache(cache, after.embedder, "references/alive.md", "a", ["a"]);
    // …and the out-of-prefix (memories/) entry is untouched…
    await embedChunksWithCache(cache, after.embedder, "memories/mem.md", "m", ["m"]);
    expect(after.calls.embed).toBe(0);
    // …while the orphan re-embeds (its entry is gone).
    await embedChunksWithCache(cache, after.embedder, "references/deleted.md", "d", ["d"]);
    expect(after.calls.embed).toBe(1);
  });

  it("fail-soft: a corrupt cache file is a miss, not a throw", async () => {
    const cache = createEmbeddingCache({ dir: cacheDir, modelId: "hash-test" });
    const seed = countingEmbedder();
    await embedChunksWithCache(cache, seed.embedder, "references/doc.md", "content", ["c"]);

    // corrupt every file in the sidecar (layout is an implementation detail —
    // smash whatever is there)
    const smash = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) smash(abs);
        else fs.writeFileSync(abs, "{not json");
      }
    };
    smash(cacheDir);

    const { embedder, calls } = countingEmbedder();
    const vectors = await embedChunksWithCache(cache, embedder, "references/doc.md", "content", [
      "c",
    ]);
    expect(calls.embed).toBe(1); // re-embedded, no crash
    expect(vectors).toHaveLength(1);
  });
});

describe("embedFilesWithCache", () => {
  const files = [
    { key: "references/a.md", content: "a content", chunkTexts: ["a1", "a2", "a3"] },
    { key: "references/b.md", content: "b content", chunkTexts: ["b1"] },
  ];

  it("reports the miss batch's size before embedding and its duration after, with no paths or text", async () => {
    const { embedder, calls } = countingEmbedder();
    const cache = createEmbeddingCache({ dir: cacheDir, modelId: "hash-test" });
    const events: EmbedBacklogEvent[] = [];
    let clock = 1_000;
    let embedsAtStart = -1;

    const vectors = await embedFilesWithCache(cache, embedder, files, {
      scope: "references",
      now: () => (clock += 250),
      onBacklog: (event) => {
        if (event.phase === "start") embedsAtStart = calls.embed;
        events.push(event);
      },
    });

    expect(embedsAtStart).toBe(0); // the size is known BEFORE any embedding runs
    expect(events).toEqual([
      { phase: "start", scope: "references", files: 2, chunks: 4 },
      { phase: "done", scope: "references", files: 2, chunks: 4, durationMs: 250, failed: false },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/a\.md|b\.md|a1|content/);
    expect(vectors.map((v) => v.length)).toEqual([3, 1]);
    expect(calls.embed).toBe(4);
  });

  it("returns the same vectors as per-file resolution, and embeds only the files that missed", async () => {
    const cache = createEmbeddingCache({ dir: cacheDir, modelId: "hash-test" });
    const warm = countingEmbedder();
    const expectedA = await embedChunksWithCache(
      cache,
      warm.embedder,
      files[0]!.key,
      files[0]!.content,
      files[0]!.chunkTexts,
    );

    const { embedder, calls } = countingEmbedder();
    const events: EmbedBacklogEvent[] = [];
    const vectors = await embedFilesWithCache(cache, embedder, files, {
      scope: "memories",
      onBacklog: (event) => events.push(event),
    });

    expect(vectors[0]).toEqual(expectedA); // served from the cache, in input order
    expect(calls.embed).toBe(1); // only b.md's single chunk
    expect(events.map((e) => [e.phase, e.files, e.chunks])).toEqual([
      ["start", 1, 1],
      ["done", 1, 1],
    ]);
  });

  it("stays silent when every file is cached", async () => {
    const cache = createEmbeddingCache({ dir: cacheDir, modelId: "hash-test" });
    await embedFilesWithCache(cache, countingEmbedder().embedder, files, { scope: "memories" });
    const events: EmbedBacklogEvent[] = [];
    await embedFilesWithCache(cache, countingEmbedder().embedder, files, {
      scope: "memories",
      onBacklog: (event) => events.push(event),
    });
    expect(events).toEqual([]);
  });

  it("reports a failed batch and still throws the embedder's error", async () => {
    const cache = createEmbeddingCache({ dir: cacheDir, modelId: "hash-test" });
    const events: EmbedBacklogEvent[] = [];
    const failing = { embed: () => Promise.reject(new Error("model unavailable")) };
    await expect(
      embedFilesWithCache(cache, failing, files, {
        scope: "references",
        onBacklog: (event) => events.push(event),
      }),
    ).rejects.toThrow("model unavailable");
    expect(events.at(-1)).toMatchObject({ phase: "done", failed: true });
  });

  it("a throwing backlog sink never fails the build", async () => {
    const cache = createEmbeddingCache({ dir: cacheDir, modelId: "hash-test" });
    const vectors = await embedFilesWithCache(cache, countingEmbedder().embedder, files, {
      scope: "references",
      onBacklog: () => {
        throw new Error("sink broke");
      },
    });
    expect(vectors).toHaveLength(2);
  });
});
