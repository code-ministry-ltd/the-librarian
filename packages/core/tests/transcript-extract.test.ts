// Transcript extractor (spec 2026-06-16-harness-auto-capture, T2; Q-extract =
// Option A). ONE LLM pass over a settled buffer → N discrete candidate facts.
// The LLM is INJECTED + mocked here exactly like the intake judge tests
// (createGroomingLlmClient is never built — a fake `complete` returns a known
// JSON payload), so there is no network. Covers: the prompt carries the buffer
// text; N facts are parsed; a trivial/empty buffer yields zero facts; an
// unusable model response yields zero facts (fail-soft, never throws).

import type { LlmClient, LlmCompletionRequest } from "@librarian/core";
import { extractTranscriptFacts, tryExtractTranscriptFacts } from "@librarian/core";
import { describe, expect, it } from "vitest";

/** A fake LLM returning a fixed candidate-facts JSON payload. */
function factsClient(facts: string[]): LlmClient {
  return {
    complete: async () => ({
      content: JSON.stringify({ facts }),
      model: "m",
      usage: null,
    }),
  };
}

describe("extractTranscriptFacts — one LLM pass → N candidate facts", () => {
  it("returns each discrete fact the model emits", async () => {
    const client = factsClient([
      "The user prefers pnpm over npm for this repo.",
      "Tests run with `pnpm test` from the repo root.",
    ]);
    const facts = await extractTranscriptFacts("### user\n\nhow do I run tests?\n", {
      llmClient: client,
    });
    expect(facts).toEqual([
      "The user prefers pnpm over npm for this repo.",
      "Tests run with `pnpm test` from the repo root.",
    ]);
  });

  it("passes the buffer content into the prompt the model sees", async () => {
    let captured = "";
    const client: LlmClient = {
      complete: async (request: LlmCompletionRequest) => {
        captured = request.messages.map((m) => m.content).join("\n");
        return { content: JSON.stringify({ facts: ["x"] }), model: "m", usage: null };
      },
    };
    await extractTranscriptFacts("MARKER-BUFFER-CONTENT the whole conversation", {
      llmClient: client,
    });
    expect(captured).toContain("MARKER-BUFFER-CONTENT the whole conversation");
  });

  it("prioritises high-value memory and rejects facts cheaply recoverable from a repository", async () => {
    let captured = "";
    const client: LlmClient = {
      complete: async (request: LlmCompletionRequest) => {
        captured = request.messages[0]?.content ?? "";
        return { content: JSON.stringify({ facts: [] }), model: "m", usage: null };
      },
    };

    await extractTranscriptFacts("### user\n\nWe chose queues because retries must be durable.\n", {
      llmClient: client,
    });

    expect(captured).toMatch(/intent.*learning.*history.*direction/is);
    expect(captured).toMatch(/recoverable.*code.*config/is);
    expect(captured).toMatch(/package manager.*commands.*paths.*branches.*ports/is);
    expect(captured).toMatch(/decision.*rationale.*one coherent candidate/is);
    expect(captured).toMatch(/smallest set/i);
    expect(captured).toMatch(/when in doubt.*empty/i);
  });

  it("audits every distinct high-value claim instead of stopping at a small fixed set", async () => {
    let captured = "";
    const client: LlmClient = {
      complete: async (request: LlmCompletionRequest) => {
        captured = request.messages[0]?.content ?? "";
        return { content: JSON.stringify({ facts: [] }), model: "m", usage: null };
      },
    };

    await extractTranscriptFacts(
      "### user\n\nWe rejected the login gate. Elena owns campaign content. Escalation ownership remains open.\n",
      { llmClient: client },
    );

    expect(captured).toMatch(/does not mean.*stop after a fixed number/i);
    expect(captured).toMatch(/rejected option.*why/i);
    expect(captured).toMatch(/responsibility.*ambigu/i);
    expect(captured).toMatch(/condition.*exception/i);
    expect(captured).toMatch(/open question.*unresolved/i);
    expect(captured).toMatch(/smallest set.*deduplicat.*not.*omit/is);
    expect(captured).toMatch(/group related roles/i);
    expect(captured).toMatch(/explicit retention boundaries.*omit/is);
    expect(captured).toMatch(/one candidate per durable topic/i);
    expect(captured).toMatch(/do not emit both.*incident.*broader rule/is);
    expect(captured).toMatch(/retention boundary example/i);
    expect(captured).toMatch(/good candidate.*team.*bad candidates.*forbidden identifier/is);
  });

  it("repeats the owner-specific selection check after the transcript", async () => {
    let captured: LlmCompletionRequest | undefined;
    const client: LlmClient = {
      complete: async (request: LlmCompletionRequest) => {
        captured = request;
        return { content: JSON.stringify({ facts: [] }), model: "m", usage: null };
      },
    };

    await extractTranscriptFacts(
      "### user\n\nI own Northwind and want to change its direction.\n\n### assistant\n\nI recommend a 30-day sales plan.\n",
      { llmClient: client },
    );

    const system = captured?.messages[0]?.content ?? "";
    const transcript = captured?.messages[1]?.content ?? "";
    expect(system).toMatch(/owner\/project-specific.*reject general knowledge.*recommendations/is);
    expect(transcript).toContain("I own Northwind and want to change its direction.");
    expect(transcript).toMatch(
      /END TRANSCRIPT.*preserve the user's own durable history.*reject unadopted assistant advice/is,
    );
    expect(transcript).toMatch(
      /preserve every high-value project decision.*role.*exception.*scope boundary.*rationale.*lesson/is,
    );
    expect(transcript).toMatch(/Return only the required JSON\.\s*$/);
  });

  it("returns no facts for an empty/whitespace buffer (no LLM call)", async () => {
    let called = false;
    const client: LlmClient = {
      complete: async () => {
        called = true;
        return { content: JSON.stringify({ facts: ["nope"] }), model: "m", usage: null };
      },
    };
    const facts = await extractTranscriptFacts("   \n  \n", { llmClient: client });
    expect(facts).toEqual([]);
    // A trivial buffer is a cheap no-op — the model is never even called.
    expect(called).toBe(false);
  });

  it("returns no facts when the model emits an empty list (a trivial conversation)", async () => {
    const facts = await extractTranscriptFacts("### user\n\nhi\n", { llmClient: factsClient([]) });
    expect(facts).toEqual([]);
  });

  it("fail-soft: an unusable model response yields no facts, never throws", async () => {
    const bad: LlmClient = {
      complete: async () => ({ content: "this is not json", model: "m", usage: null }),
    };
    await expect(
      extractTranscriptFacts("### user\n\nsubstantive turn\n", { llmClient: bad }),
    ).resolves.toEqual([]);
  });

  it("fail-soft: a thrown LLM/transport error yields no facts, never throws", async () => {
    const throwing: LlmClient = {
      complete: async () => {
        throw new Error("network down");
      },
    };
    await expect(
      extractTranscriptFacts("### user\n\nsubstantive turn\n", { llmClient: throwing }),
    ).resolves.toEqual([]);
  });

  it("drops blank / non-string entries the model might emit", async () => {
    const client: LlmClient = {
      complete: async () => ({
        content: JSON.stringify({ facts: ["good fact", "   ", 42, "another fact"] }),
        model: "m",
        usage: null,
      }),
    };
    const facts = await extractTranscriptFacts("### user\n\nq\n", { llmClient: client });
    expect(facts).toEqual(["good fact", "another fact"]);
  });
});

describe("tryExtractTranscriptFacts — a failed pass is not an empty conversation", () => {
  it("reports a thrown model call as a failure, not as zero facts", async () => {
    const outcome = await tryExtractTranscriptFacts("### user\n\nsubstantive\n", {
      llmClient: {
        complete: async () => {
          throw new Error("network down");
        },
      },
    });
    expect(outcome.ok).toBe(false);
  });

  it("reports an unusable reply as a failure", async () => {
    const outcome = await tryExtractTranscriptFacts("### user\n\nsubstantive\n", {
      llmClient: { complete: async () => ({ content: "nope", model: "m", usage: null }) },
    });
    expect(outcome.ok).toBe(false);
  });

  it("reports an answered pass with nothing worth keeping as success with no facts", async () => {
    const outcome = await tryExtractTranscriptFacts("### user\n\nhi\n", {
      llmClient: { complete: async () => ({ content: '{"facts": []}', model: "m", usage: null }) },
    });
    expect(outcome).toEqual({ ok: true, facts: [] });
  });
});
