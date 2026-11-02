// The llama embedder must hand its thread cap to node-llama-cpp's embedding context —
// that is the whole of the CPU limit. node-llama-cpp is replaced through the embedder's
// loader seam, so no native binary or model loads (CI stays on the hash embedder).

import { type LlamaModule, createLlamaEmbedder } from "@librarian/core";
import { beforeEach, describe, expect, it } from "vitest";

const contextOptions: unknown[] = [];

const fakeLlamaModule = async (): Promise<LlamaModule> => ({
  LlamaLogLevel: { warn: "warn" },
  getLlama: async () => ({
    loadModel: async () => ({
      trainContextSize: 2048,
      tokenize: (text: string) => text.split(" "),
      detokenize: (tokens: string[]) => tokens.join(" "),
      createEmbeddingContext: async (options?: unknown) => {
        contextOptions.push(options);
        return { getEmbeddingFor: async () => ({ vector: [0.1, 0.2] }) };
      },
    }),
  }),
});

beforeEach(() => {
  contextOptions.length = 0;
});

describe("createLlamaEmbedder thread cap", () => {
  it("creates the embedding context with the configured thread count", async () => {
    const embedder = createLlamaEmbedder({
      modelPath: "/models/fake.gguf",
      threads: 3,
      loadLlamaModule: fakeLlamaModule,
    });
    expect(await embedder.embed("a document")).toEqual([0.1, 0.2]);
    expect(contextOptions).toEqual([{ threads: 3 }]);
  });

  it("leaves node-llama-cpp's own default in place when no cap is given", async () => {
    const embedder = createLlamaEmbedder({
      modelPath: "/models/fake.gguf",
      loadLlamaModule: fakeLlamaModule,
    });
    await embedder.embed("a document");
    expect(contextOptions).toEqual([{}]);
  });
});
