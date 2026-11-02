// Real embedding model via node-llama-cpp (plan 036 Phase 3 / spec 035 §F2).
// CPU inference over a GGUF model — the production drop-in for the bundled
// deterministic hash embedder, behind the same `Embedder` interface.
//
// Default model: EmbeddingGemma-300M (Q8_0 GGUF), 768-dim, multilingual. It
// uses ASYMMETRIC prompts — a document prompt for indexed passages and a query
// prompt for searches — so this exposes both `embed` (document) and
// `embedQuery` (query). node-llama-cpp + the model are loaded lazily on the
// first embed, so importing this module costs nothing until it's used (tests
// and CI keep using the hash embedder and never load the native binary).
//
// node-llama-cpp ships CPU prebuilt binaries; the GPU (CUDA/Vulkan) variants
// are stripped at install by `.pnpmfile.cjs` to keep the footprint ~60 MB.

import type { Embedder } from "./hybrid-index.js";

export interface LlamaEmbedderOptions {
  /**
   * Absolute path to the GGUF model file, or a (lazy, possibly async) resolver
   * that produces it on first embed — e.g. a downloader/cache. Resolving lazily
   * keeps construction free of I/O and network until the model is actually used.
   */
  modelPath: string | (() => string | Promise<string>);
  /** Prompt wrapper for indexed documents (default: EmbeddingGemma's). */
  documentPrompt?: (text: string) => string;
  /** Prompt wrapper for search queries (default: EmbeddingGemma's). */
  queryPrompt?: (text: string) => string;
  /**
   * Stable model identity for the persistent embedding cache (`Embedder.modelId`).
   * Must be synchronously known (the lazy modelPath isn't), so the caller —
   * who knows which model it asked for — supplies it.
   */
  modelId?: string;
  /**
   * CPU threads the embedding context may use per inference. Absent ⇒ node-llama-cpp's
   * own default (6 in v3). A positive integer caps it, so a burst of embedding — a cold
   * cache, a large new reference — leaves cores free for everything else on the host.
   */
  threads?: number;
  /**
   * TEST SEAM — not part of the public API. Replaces the lazy `import("node-llama-cpp")`
   * so a test can observe the context options without loading the native binary or a
   * model. Absent ⇒ the real module, exactly as before.
   */
  loadLlamaModule?: () => Promise<LlamaModule>;
}

/** The slice of node-llama-cpp this embedder touches (see `loadLlamaModule`). */
export interface LlamaModule {
  getLlama(options: { logLevel: unknown }): Promise<{
    loadModel(options: { modelPath: string }): Promise<unknown>;
  }>;
  LlamaLogLevel: { warn: unknown };
}

// EmbeddingGemma's documented retrieval prompts.
const defaultDocumentPrompt = (text: string): string => `title: none | text: ${text}`;
const defaultQueryPrompt = (text: string): string => `task: search result | query: ${text}`;

type EmbeddingContext = { getEmbeddingFor(text: string): Promise<{ vector: readonly number[] }> };
/** The model surface we need beyond context creation: its tokenizer + train context. */
export interface EmbeddingModel {
  tokenize(text: string): number[];
  detokenize(tokens: number[]): string;
  trainContextSize: number;
}

// Headroom below the train context for the embedding's own special tokens (BOS/
// EOS): truncating to trainContextSize - this margin embeds cleanly (verified at
// 16; 32 is conservative).
const CONTEXT_MARGIN = 32;

/**
 * Truncate (a prompt-wrapped) input to the model's context window. EmbeddingGemma
 * throws "Input is longer than the context size" on overflow, which would fail the
 * whole index build / recall; a truncated embedding still captures the gist (recall
 * doesn't need every token of a long doc). Token-based so it's correct across
 * languages. Returns the text unchanged when it already fits.
 */
export function truncateToTokenLimit(text: string, model: EmbeddingModel): string {
  const limit = model.trainContextSize - CONTEXT_MARGIN;
  if (limit <= 0) return text;
  const tokens = model.tokenize(text);
  return tokens.length > limit ? model.detokenize(tokens.slice(0, limit)) : text;
}

export function createLlamaEmbedder(options: LlamaEmbedderOptions): Embedder {
  const documentPrompt = options.documentPrompt ?? defaultDocumentPrompt;
  const queryPrompt = options.queryPrompt ?? defaultQueryPrompt;

  // Lazily load node-llama-cpp + the model once, then reuse the context.
  let contextPromise: Promise<{ model: EmbeddingModel; ctx: EmbeddingContext }> | null = null;
  async function loadContext(): Promise<{ model: EmbeddingModel; ctx: EmbeddingContext }> {
    const { getLlama, LlamaLogLevel } = options.loadLlamaModule
      ? await options.loadLlamaModule()
      : ((await import("node-llama-cpp")) as unknown as LlamaModule);
    const llama = await getLlama({ logLevel: LlamaLogLevel.warn }); // quiet model-load spam
    const modelPath =
      typeof options.modelPath === "function" ? await options.modelPath() : options.modelPath;
    const model = (await llama.loadModel({ modelPath })) as unknown as EmbeddingModel & {
      createEmbeddingContext(contextOptions?: { threads?: number }): Promise<EmbeddingContext>;
    };
    const contextOptions = options.threads !== undefined ? { threads: options.threads } : {};
    return { model, ctx: await model.createEmbeddingContext(contextOptions) };
  }
  const context = (): Promise<{ model: EmbeddingModel; ctx: EmbeddingContext }> =>
    (contextPromise ??= loadContext().catch((error: unknown) => {
      contextPromise = null; // a failed load (bad path, OOM) must not poison the embedder forever
      throw error;
    }));

  // Serialize embeds to bound CPU/RAM (one inference at a time); callers — index
  // build and recall — embed sequentially anyway, so this never adds latency.
  let queue: Promise<unknown> = Promise.resolve();
  const embedWith = (text: string, wrap: (t: string) => string): Promise<number[]> => {
    const run = queue.then(async () => {
      const { model, ctx } = await context();
      const { vector } = await ctx.getEmbeddingFor(truncateToTokenLimit(wrap(text), model));
      return [...vector];
    });
    queue = run.catch(() => undefined); // keep the chain alive past a failure
    return run;
  };

  return {
    embed: (text) => embedWith(text, documentPrompt),
    embedQuery: (text) => embedWith(text, queryPrompt),
    ...(options.modelId ? { modelId: options.modelId } : {}),
  };
}
