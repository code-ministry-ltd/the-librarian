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
// AbortController timeout. Replies are STREAMED so that the timeout really ends the
// request: when we abort, the connection closes and the provider notices on its
// next write and stops generating. A non-streamed request keeps running on the
// server until it finishes, however long a looping model takes. A reply that stops
// because it hit the output limit (`finish_reason: "length"`) is an error, never an
// answer, so a cut-off reply can never be parsed or stored. Validation of the
// *content* the LLM returns lives in the pipeline's parse/validate stage (§10.5),
// not here — this layer only guarantees a well-formed transport result (a string
// content payload).

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
  /**
   * Default output cap (`max_tokens`) for every call that does not set its own.
   * Thinking counts towards it on reasoning models. Unset → no cap sent.
   */
  maxOutputTokens?: number;
  /** Thinking level sent as `reasoning_effort`; unset → not sent (provider default). */
  reasoningEffort?: ReasoningEffort;
}

/** OpenAI-style `reasoning_effort` values. */
export type ReasoningEffort = "none" | "low" | "medium" | "high";

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
  /** Cap on completion tokens; falls back to the client's `maxOutputTokens`. */
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
export type LlmErrorKind = "http" | "timeout" | "network" | "malformed" | "truncated";

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

/**
 * True when a failure says the provider, not this one request, is the problem: a
 * timeout, a dropped connection, a 429 or 5xx (or any other refusal not tied to
 * the request's content). A batch job should stop there rather than send its next
 * request into the same struggling queue. A reply cut off at the output limit,
 * an unusable reply, or a 400 / 413 / 422 rejection of this request is about the
 * request, so the batch can carry on after those.
 */
export function isProviderUnavailableError(error: unknown): boolean {
  if (!(error instanceof LlmClientError)) return false;
  if (error.kind === "timeout" || error.kind === "network") return true;
  if (error.kind !== "http") return false;
  return error.status === undefined || ![400, 413, 422].includes(error.status);
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

      const outputLimit = maxTokens ?? config.maxOutputTokens;
      const body: Record<string, unknown> = {
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (jsonResponse) body.response_format = { type: "json_object" };
      if (temperature !== undefined) body.temperature = temperature;
      if (outputLimit !== undefined) body.max_tokens = outputLimit;
      if (config.reasoningEffort !== undefined) body.reasoning_effort = config.reasoningEffort;

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
            // Never follow a redirect with the bearer and the memory-bearing
            // prompt attached (AGENTS.md); fetch rejects, reported as "network".
            redirect: "error",
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

        let reply: ParsedReply;
        try {
          reply = isEventStream(response)
            ? await readEventStream(response)
            : parseCompletionBody(await response.json());
        } catch (err) {
          // A stalled body read aborts via the same signal → timeout; bad data → malformed.
          if (isAbortError(err)) {
            throw new LlmClientError("timeout", `LLM request timed out after ${timeoutMs}ms`);
          }
          if (err instanceof LlmClientError) throw err;
          throw new LlmClientError("malformed", "LLM response was not valid JSON");
        }

        if (reply.finishReason === "length") {
          throw new LlmClientError(
            "truncated",
            `LLM reply hit the output limit${outputLimit === undefined ? "" : ` (${outputLimit} tokens)`} ` +
              "before it finished, so it was discarded. If the model needs more room (thinking " +
              "counts too), raise this job's output limit in Curator settings.",
          );
        }
        if (reply.content === null) {
          throw new LlmClientError("malformed", "LLM response had no message content");
        }
        return { content: reply.content, model: reply.model ?? model, usage: reply.usage };
      } finally {
        clearTimeout(timer);
        // Hang up whatever happened. After a complete reply this is a no-op; after
        // a reply we rejected partway (a bad event, a mid-stream error) it closes
        // the connection, so the provider stops generating instead of finishing
        // an answer nobody will read.
        controller.abort();
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

interface ParsedReply {
  content: string | null;
  model: string | null;
  usage: LlmUsage | null;
  finishReason: string | null;
}

function parseCompletionBody(parsed: unknown): ParsedReply {
  const choice = firstChoice(parsed);
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : null;
  return {
    content: message && typeof message.content === "string" ? message.content : null,
    model: extractModel(parsed),
    usage: extractUsage(parsed),
    finishReason: finishReasonOf(choice),
  };
}

function isEventStream(response: Response): boolean {
  // A provider that ignores `stream: true` answers with plain JSON; handle both.
  return (response.headers?.get("content-type") ?? "").includes("text/event-stream");
}

/**
 * Assemble a streamed chat completion from its server-sent events. Content deltas
 * are concatenated; reasoning deltas are ignored (thinking never becomes the
 * answer). A stream that ends without `[DONE]` or a finish reason is incomplete
 * and therefore malformed.
 */
async function readEventStream(response: Response): Promise<ParsedReply> {
  const reader = response.body?.getReader();
  if (!reader) throw new LlmClientError("malformed", "LLM response had no body");
  const decoder = new TextDecoder();
  const reply: ParsedReply = { content: null, model: null, usage: null, finishReason: null };
  let buffered = "";
  let done = false;
  const handleLine = (line: string): void => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      done = true;
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      throw new LlmClientError("malformed", "LLM stream sent an event that was not valid JSON");
    }
    if (isRecord(event) && event.error !== undefined) {
      throw new LlmClientError("http", "LLM provider reported an error mid-stream");
    }
    reply.model = reply.model ?? extractModel(event);
    reply.usage = extractUsage(event) ?? reply.usage;
    const choice = firstChoice(event);
    if (isRecord(choice) && isRecord(choice.delta) && typeof choice.delta.content === "string") {
      reply.content = (reply.content ?? "") + choice.delta.content;
    }
    reply.finishReason = finishReasonOf(choice) ?? reply.finishReason;
  };
  for (;;) {
    const { value, done: streamEnded } = await reader.read();
    if (streamEnded) break;
    buffered += decoder.decode(value, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      handleLine(buffered.slice(0, newline).replace(/\r$/, ""));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
    }
  }
  handleLine((buffered + decoder.decode()).trim());
  if (!done && reply.finishReason === null) {
    throw new LlmClientError("malformed", "LLM stream ended before the reply was complete");
  }
  return reply;
}

function firstChoice(parsed: unknown): unknown {
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) return undefined;
  return parsed.choices[0];
}

function finishReasonOf(choice: unknown): string | null {
  return isRecord(choice) && typeof choice.finish_reason === "string" ? choice.finish_reason : null;
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
