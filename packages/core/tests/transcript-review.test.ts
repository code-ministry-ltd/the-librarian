// Spec 086: the reviewer's verdicts, reply validation and quote check.
import { type LlmClient, MIN_REVIEW_QUOTE_CHARS, reviewTranscriptFacts } from "@librarian/core";
import { describe, expect, it, vi } from "vitest";

const TRANSCRIPT = `### user (seq=1)

We **chose** queues because retries must survive a restart.

### assistant (seq=2)

Understood, I’ll keep the “durable retries” design.
`;
const QUOTE = "We chose queues because retries must survive";

function replying(content: string): LlmClient {
  return { complete: vi.fn(async () => ({ content, model: "m", usage: null })) };
}
const review = (facts: string[], reviews: unknown[]) =>
  reviewTranscriptFacts(TRANSCRIPT, facts, {
    llmClient: replying(JSON.stringify({ reviews })),
  });

describe("reviewTranscriptFacts", () => {
  it("keeps, rewrites and drops facts according to their verdicts", async () => {
    const result = await review(
      ["kept fact", "weak fact", "code description"],
      [
        { index: 2, verdict: "drop", reason: "the code says this" },
        { index: 0, verdict: "keep", quote: QUOTE },
        { index: 1, verdict: "fix", text: "better fact", quote: QUOTE },
      ],
    );
    expect(result).toEqual({
      ok: true,
      facts: ["kept fact", "better fact"],
      counts: { reviewed: 3, kept: 1, fixed: 1, dropped: 1, quoteFailures: 0 },
    });
  });

  it("never calls the model when there are no facts", async () => {
    const llmClient = replying("{}");
    const result = await reviewTranscriptFacts(TRANSCRIPT, [], { llmClient });
    expect(result.ok).toBe(true);
    expect(llmClient.complete).not.toHaveBeenCalled();
  });

  it("frames the transcript and the numbered facts for the model", async () => {
    const llmClient = replying(
      JSON.stringify({
        reviews: [
          { index: 0, verdict: "drop" },
          { index: 1, verdict: "drop" },
        ],
      }),
    );
    await reviewTranscriptFacts(TRANSCRIPT, ["first", "second"], { llmClient });
    const [{ messages }] = vi.mocked(llmClient.complete).mock.calls[0]!;
    expect(messages[0]!.content).toContain("untrusted DATA");
    expect(messages[1]!.content).toContain(TRANSCRIPT);
    expect(messages[1]!.content).toContain("0. first\n1. second");
  });

  it("accepts a quote that differs only in markdown, whitespace or curly quotes", async () => {
    const result = await review(
      ["a", "b"],
      [
        { index: 0, verdict: "keep", quote: "We chose  queues because\nretries" },
        { index: 1, verdict: "keep", quote: `I'll keep the "durable retries" design` },
      ],
    );
    expect(result).toMatchObject({ ok: true, facts: ["a", "b"] });
  });

  it.each([
    ["is not in the transcript", "We chose kafka because it was fashionable"],
    ["is too short to mean anything", "We chose"],
    ["is missing", undefined],
  ])("drops a fact whose quote %s and counts it", async (_label, quote) => {
    for (const verdict of [
      { verdict: "keep" },
      { verdict: "fix", text: "an invented improvement" },
    ]) {
      const result = await review(["fact"], [{ index: 0, ...verdict, quote }]);
      expect(result).toMatchObject({
        ok: true,
        facts: [],
        counts: { dropped: 1, quoteFailures: 1 },
      });
    }
  });

  it("needs a quote of the minimum length, and no longer", async () => {
    const exact = QUOTE.slice(0, MIN_REVIEW_QUOTE_CHARS);
    const short = QUOTE.slice(0, MIN_REVIEW_QUOTE_CHARS - 1);
    expect(await review(["f"], [{ index: 0, verdict: "keep", quote: exact }])).toMatchObject({
      facts: ["f"],
    });
    expect(await review(["f"], [{ index: 0, verdict: "keep", quote: short }])).toMatchObject({
      facts: [],
    });
  });

  it("keeps the original when a rewrite is over the memory size limit", async () => {
    const result = await review(
      ["original"],
      [{ index: 0, verdict: "fix", text: "x".repeat(4001), quote: QUOTE }],
    );
    expect(result).toMatchObject({ facts: ["original"], counts: { kept: 1, fixed: 0 } });
  });

  it("tolerates a reply wrapped in a code fence", async () => {
    const reply =
      "```json\n" + JSON.stringify({ reviews: [{ index: 0, verdict: "drop" }] }) + "\n```";
    const result = await reviewTranscriptFacts(TRANSCRIPT, ["f"], { llmClient: replying(reply) });
    expect(result).toMatchObject({ ok: true, facts: [] });
  });

  it.each([
    ["is not JSON", "no"],
    ["has no reviews", "{}"],
    ["misses a fact", JSON.stringify({ reviews: [{ index: 0, verdict: "drop" }] })],
    [
      "repeats an index",
      JSON.stringify({
        reviews: [
          { index: 0, verdict: "drop" },
          { index: 0, verdict: "drop" },
        ],
      }),
    ],
    [
      "has an index out of range",
      JSON.stringify({
        reviews: [
          { index: 0, verdict: "drop" },
          { index: 2, verdict: "drop" },
        ],
      }),
    ],
    [
      "has an unknown verdict",
      JSON.stringify({
        reviews: [
          { index: 0, verdict: "drop" },
          { index: 1, verdict: "maybe" },
        ],
      }),
    ],
    [
      "has a fix with no text",
      JSON.stringify({
        reviews: [
          { index: 0, verdict: "drop" },
          { index: 1, verdict: "fix", text: "  ", quote: QUOTE },
        ],
      }),
    ],
  ])("treats a reply that %s as a failure, not as dropping everything", async (_label, reply) => {
    const result = await reviewTranscriptFacts(TRANSCRIPT, ["a", "b"], {
      llmClient: replying(reply),
    });
    expect(result.ok).toBe(false);
  });

  it("reports a thrown model call as a failure and does not throw", async () => {
    const boom = new Error("model unavailable");
    const llmClient: LlmClient = {
      complete: async () => {
        throw boom;
      },
    };
    expect(await reviewTranscriptFacts(TRANSCRIPT, ["a"], { llmClient })).toEqual({
      ok: false,
      error: boom,
    });
  });
});
