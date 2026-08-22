// OpenAI-compatible chat-completions client for the memory curator (spec §10.4:
// "the LLM produces structured JSON only. No prose parsing."). This is the
// curator's ONLY network egress.
//
// Hard invariant: the bearer token must never appear in a thrown error or any
// serialisable field — it travels solely in the Authorization header to the
// configured endpoint. Error messages are built only from the response status
// or the underlying fetch error's own message, never from the request we sent.
//
// The client is intentionally thin: a fetch-injectable POST with an
// AbortController timeout. Validation of the *content* the LLM returns lives in
// the pipeline's parse/validate stage (§10.5), not here — this layer only
// guarantees a well-formed transport result (a string content payload).

export interface LlmClientConfig {
  /** Base URL, e.g. `https://api.openai.com/v1` (a trailing slash is tolerated). */
  endpoint: string;
  /** Bearer token (secret). Never logged or surfaced in errors. */
  token: string;
  model: string;
  /**
   * Default request timeout in ms applied when `complete()` is called without
   * an explicit `timeoutMs`. Falls back to 5 min (300_000) when unset.
   * Operator-configurable
   * on the curator path so a slow self-hosted model doesn't time out mid-batch.
   */
  timeoutMs?: number;
}

export type LlmRole = "system" | "user" | "assistant";

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface LlmCompletionRequest {
  messages: LlmMessage[];
  /** Request a JSON-object response (OpenAI `response_format`). Default `true`. */
  jsonResponse?: boolean;
  /** Sampling temperature; omitted from the request when undefined. */
  temperature?: number;
  /** Cap on completion tokens; omitted when undefined. */
  maxTokens?: number;
  /** Overall request timeout in ms. Default 300_000 (5 min). */
  timeoutMs?: number;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmCompletion {
  /** Raw assistant message content (a JSON string when `jsonResponse` is set). */
  content: string;
  /** Model reported by the provider, falling back to the configured model. */
  model: string;
  usage: LlmUsage | null;
}

/** Discriminates transport failures so the worker can decide what to retry. */
export type LlmErrorKind = "http" | "timeout" | "network" | "malformed";

export class LlmClientError extends Error {
  readonly kind: LlmErrorKind;
  readonly status: number | undefined;
  constructor(kind: LlmErrorKind, message: string, status?: number) {
    super(message);
    this.name = "LlmClientError";
    this.kind = kind;
    this.status = status;
  }
}

export interface LlmClient {
  complete(request: LlmCompletionRequest): Promise<LlmCompletion>;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface LlmClientDeps {
  /** Injectable fetch for testing; defaults to the global. */
  fetch?: FetchFn;
}

// 5 min default (was 60 s) — slow self-hosted models run 1–4 min per call.
const DEFAULT_TIMEOUT_MS = 300_000;

export function createGroomingLlmClient(
  config: LlmClientConfig,
  deps: LlmClientDeps = {},
): LlmClient {
  const endpoint = config.endpoint.trim();
  const { token, model: rawModel } = config;
  const model = rawModel.trim();
  const configuredTimeoutMs = config.timeoutMs;
  if (!endpoint) throw new Error("LLM client requires a non-empty endpoint");
  if (!token) throw new Error("LLM client requires a non-empty token");
  if (!model) throw new Error("LLM client requires a non-empty model");

  const fetchFn: FetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
  const url = `${endpoint.replace(/\/+$/, "")}/chat/completions`;

  return {
    async complete(request) {
      const {
        messages,
        jsonResponse = true,
        temperature,
        maxTokens,
        timeoutMs = configuredTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      } = request;
      if (!(timeoutMs > 0)) throw new Error("LLM client timeoutMs must be a positive number");

      const body: Record<string, unknown> = { model, messages };
      if (jsonResponse) body.response_format = { type: "json_object" };
      if (temperature !== undefined) body.temperature = temperature;
      if (maxTokens !== undefined) body.max_tokens = maxTokens;

      // One controller guards the whole exchange — connect AND body read. The
      // timer stays armed until the body is fully parsed (a provider can stall
      // the body after sending headers), and is always cleared in `finally`.
      // There is no caller-supplied signal in v1, so any AbortError is ours.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response: Response;
        try {
          response = await fetchFn(url, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (err) {
          throw fetchFailure(err, timeoutMs);
        }

        if (!response.ok) {
          // Status only — the response body may echo provider detail but never our token.
          throw new LlmClientError(
            "http",
            `LLM request failed: HTTP ${response.status}`,
            response.status,
          );
        }

        let parsed: unknown;
        try {
          parsed = await response.json();
        } catch (err) {
          // A stalled body read aborts via the same signal → timeout; bad JSON → malformed.
          if (isAbortError(err)) {
            throw new LlmClientError("timeout", `LLM request timed out after ${timeoutMs}ms`);
          }
          throw new LlmClientError("malformed", "LLM response was not valid JSON");
        }

        const content = extractContent(parsed);
        if (content === null) {
          throw new LlmClientError("malformed", "LLM response had no message content");
        }
        return { content, model: extractModel(parsed) ?? model, usage: extractUsage(parsed) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Classify a fetch rejection. An AbortError means our timeout fired (no
 * caller-supplied signal exists in v1); anything else is a transport failure.
 * Discriminating on the error — not `controller.signal.aborted` — avoids a race
 * where a real network error settling after the timer would be mislabelled.
 */
function fetchFailure(err: unknown, timeoutMs: number): LlmClientError {
  if (isAbortError(err)) {
    return new LlmClientError("timeout", `LLM request timed out after ${timeoutMs}ms`);
  }
  return new LlmClientError("network", `LLM request failed: ${networkMessage(err)}`);
}

// Node's `fetch` rejects with a DOMException on abort, which does NOT extend
// Error — so match on `.name` rather than `instanceof`.
function isAbortError(err: unknown): boolean {
  return isRecord(err) && err.name === "AbortError";
}

function networkMessage(err: unknown): string {
  // The fetch error's own message (e.g. "ECONNREFUSED") — never our request.
  return err instanceof Error ? err.message : "unknown network error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractContent(parsed: unknown): string | null {
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) return null;
  const first = parsed.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return null;
  const content = first.message.content;
  return typeof content === "string" ? content : null;
}

function extractModel(parsed: unknown): string | null {
  if (isRecord(parsed) && typeof parsed.model === "string" && parsed.model) return parsed.model;
  return null;
}

function extractUsage(parsed: unknown): LlmUsage | null {
  if (!isRecord(parsed) || !isRecord(parsed.usage)) return null;
  const usage = parsed.usage;
  return {
    promptTokens: numberOr(usage.prompt_tokens),
    completionTokens: numberOr(usage.completion_tokens),
    totalTokens: numberOr(usage.total_tokens),
  };
}

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
