// OpenAI-compatible chat-completions client for the memory curator (spec §10.4:
// "the LLM produces structured JSON only"). This is the curator's only network
// egress, so the load-bearing invariant is that the bearer token NEVER appears
// in a thrown error or anywhere serialisable. The client is otherwise a thin,
// fetch-injectable POST to {endpoint}/chat/completions.

import { type LlmClientError, createGroomingLlmClient } from "@librarian/core";
import { describe, expect, it, vi } from "vitest";

const TOKEN = "dummy-llm-token-DO-NOT-LEAK";
const CONFIG = { endpoint: "https://api.example.com/v1", token: TOKEN, model: "gpt-x" };

/** Build a real Response with an OpenAI-shaped chat-completion body. */
function completion(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const OK_BODY = {
  model: "gpt-x-2026",
  choices: [{ message: { role: "assistant", content: '{"operations":[]}' } }],
  usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
};

/** Run `complete` and return whatever it throws (so we can inspect the error). */
async function failure(run: () => Promise<unknown>): Promise<LlmClientError> {
  try {
    await run();
  } catch (err) {
    return err as LlmClientError;
  }
  throw new Error("expected complete() to reject, but it resolved");
}

/**
 * The token must never surface in ANY observable field of a thrown error.
 * `JSON.stringify` alone is insufficient — it skips the non-enumerable
 * `message`/`stack`/`cause`, which are exactly where a leak would hide.
 */
function expectNoTokenLeak(err: LlmClientError): void {
  expect(err.message).not.toContain(TOKEN);
  expect(String(err.stack)).not.toContain(TOKEN);
  expect(err.cause).toBeUndefined(); // fails loudly if a refactor attaches the raw fetch error
  expect(JSON.stringify(err)).not.toContain(TOKEN);
}

describe("createGroomingLlmClient", () => {
  it("POSTs to {endpoint}/chat/completions with bearer auth and a JSON body", async () => {
    const fetchMock = vi.fn(async () => completion(OK_BODY));
    const client = createGroomingLlmClient(CONFIG, { fetch: fetchMock });

    await client.complete({
      messages: [
        { role: "system", content: "curate" },
        { role: "user", content: "evidence" },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init!.method).toBe("POST");
    const headers = new Headers(init!.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("content-type")).toBe("application/json");
    const sent = JSON.parse(init!.body as string);
    expect(sent.model).toBe("gpt-x");
    expect(sent.messages).toHaveLength(2);
    expect(sent.response_format).toEqual({ type: "json_object" });
  });

  // AGENTS.md / review 2026-09-29 #23: a credentialed call never follows a
  // redirect, or a 307/308 would replay the bearer and the memory-bearing prompt.
  it("refuses to follow redirects on the credentialed request", async () => {
    const fetchMock = vi.fn(async () => completion(OK_BODY));
    const client = createGroomingLlmClient(CONFIG, { fetch: fetchMock });

    await client.complete({ messages: [{ role: "user", content: "x" }] });

    expect(fetchMock.mock.calls[0]![1]!.redirect).toBe("error");
  });

  it("strips a trailing slash from the endpoint", async () => {
    const fetchMock = vi.fn(async () => completion(OK_BODY));
    const client = createGroomingLlmClient(
      { ...CONFIG, endpoint: "https://api.example.com/v1/" },
      { fetch: fetchMock },
    );
    await client.complete({ messages: [{ role: "user", content: "x" }] });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.example.com/v1/chat/completions");
  });

  it("returns content, model, and usage from the response", async () => {
    const client = createGroomingLlmClient(CONFIG, { fetch: async () => completion(OK_BODY) });
    const result = await client.complete({ messages: [{ role: "user", content: "x" }] });
    expect(result.content).toBe('{"operations":[]}');
    expect(result.model).toBe("gpt-x-2026");
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 3, totalTokens: 15 });
  });

  it("returns null usage when the provider omits it, falling back to the configured model", async () => {
    const body = { choices: [{ message: { content: "{}" } }] };
    const client = createGroomingLlmClient(CONFIG, { fetch: async () => completion(body) });
    const result = await client.complete({ messages: [{ role: "user", content: "x" }] });
    expect(result.usage).toBeNull();
    expect(result.model).toBe("gpt-x");
  });

  it("throws an http error carrying the status — and never the token", async () => {
    const client = createGroomingLlmClient(CONFIG, {
      fetch: async () => completion({ error: { message: "bad request" } }, 400),
    });
    const err = await failure(() =>
      client.complete({ messages: [{ role: "user", content: "x" }] }),
    );
    expect(err.kind).toBe("http");
    expect(err.status).toBe(400);
    expectNoTokenLeak(err);
  });

  it("throws a malformed error when choices/content are missing", async () => {
    const client = createGroomingLlmClient(CONFIG, {
      fetch: async () => completion({ choices: [] }),
    });
    const err = await failure(() =>
      client.complete({ messages: [{ role: "user", content: "x" }] }),
    );
    expect(err.kind).toBe("malformed");
    expectNoTokenLeak(err);
  });

  it("throws a timeout error when the request exceeds timeoutMs", async () => {
    // fetch never resolves on its own; it only rejects when its signal aborts.
    const hangingFetch = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const client = createGroomingLlmClient(CONFIG, { fetch: hangingFetch });
    const err = await failure(() =>
      client.complete({ messages: [{ role: "user", content: "x" }], timeoutMs: 10 }),
    );
    expect(err.kind).toBe("timeout");
    expectNoTokenLeak(err);
  });

  it("times out a stalled response-body read, not just the connect", async () => {
    // Headers arrive immediately, but reading the body hangs until the signal
    // aborts — the timer must still cover the body read.
    const stalledBodyFetch = vi.fn((_url: string | URL, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      } as unknown as Response),
    );
    const client = createGroomingLlmClient(CONFIG, { fetch: stalledBodyFetch });
    const err = await failure(() =>
      client.complete({ messages: [{ role: "user", content: "x" }], timeoutMs: 10 }),
    );
    expect(err.kind).toBe("timeout");
  });

  it("wraps a network failure without leaking the token", async () => {
    const client = createGroomingLlmClient(CONFIG, {
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const err = await failure(() =>
      client.complete({ messages: [{ role: "user", content: "x" }] }),
    );
    expect(err.kind).toBe("network");
    expectNoTokenLeak(err);
  });

  it("rejects a non-positive timeoutMs", async () => {
    const client = createGroomingLlmClient(CONFIG, { fetch: async () => completion(OK_BODY) });
    await expect(
      client.complete({ messages: [{ role: "user", content: "x" }], timeoutMs: 0 }),
    ).rejects.toThrow(/timeout/i);
  });

  it("rejects an incomplete configuration at construction", () => {
    expect(() => createGroomingLlmClient({ ...CONFIG, endpoint: "" })).toThrow(/endpoint/i);
    expect(() => createGroomingLlmClient({ ...CONFIG, token: "" })).toThrow(/token/i);
    expect(() => createGroomingLlmClient({ ...CONFIG, model: "" })).toThrow(/model/i);
  });
});
