// Journal LLM stages (spec 077 §4.2/§4.3): caps enforced server-side, the transcript
// framed as data, and "the model answered" told apart from "the call failed".

import {
  type LlmClient,
  type LlmCompletionRequest,
  monthPeriod,
  weekPeriod,
  EPISODE_MAX_CHARS,
  MONTH_MAX_CHARS,
  editEpisode,
  parseEpisodeReply,
  parseRollupReply,
  summarizeEpisode,
  summarizeRollup,
} from "@librarian/core";
import { describe, expect, it } from "vitest";

function replying(content: string, seen?: LlmCompletionRequest[]): LlmClient {
  return {
    complete: async (request) => {
      seen?.push(request);
      return { content, model: "m", usage: null };
    },
  };
}

describe("summarizeEpisode", () => {
  it("returns the model's bullets for a substantive transcript, framing it as untrusted data", async () => {
    const seen: LlmCompletionRequest[] = [];
    const outcome = await summarizeEpisode(
      "### user (seq=1)\n\nLet's add a journal.\n",
      replying('{"bullets":["Decided to add a journal."]}', seen),
    );
    expect(outcome).toEqual({ ok: true, value: ["Decided to add a journal."] });
    expect(seen[0]?.messages[0]?.content).toContain("untrusted DATA");
  });

  it("never calls the model for an empty buffer", async () => {
    const client: LlmClient = {
      complete: async () => {
        throw new Error("should not be called");
      },
    };
    expect(await summarizeEpisode("  \n", client)).toEqual({ ok: true, value: [] });
  });

  it("reports a failure (not an empty episode) when the reply is not the expected JSON", async () => {
    const outcome = await summarizeEpisode(
      "### user (seq=1)\n\nhi\n",
      replying("Sure! Here you go"),
    );
    expect(outcome.ok).toBe(false);
  });

  it("reports a failure when the model call throws", async () => {
    const client: LlmClient = {
      complete: async () => {
        throw new Error("boom");
      },
    };
    expect((await summarizeEpisode("### user (seq=1)\n\nhi\n", client)).ok).toBe(false);
  });
});

describe("parseEpisodeReply caps", () => {
  it("truncates at a bullet boundary once the episode cap is reached", () => {
    const bullet = "x".repeat(500);
    const bullets = parseEpisodeReply(JSON.stringify({ bullets: [bullet, bullet, bullet] }));
    expect(bullets).toHaveLength(2);
  });

  it("cuts a single over-long bullet rather than dropping everything", () => {
    const bullets = parseEpisodeReply(JSON.stringify({ bullets: ["y".repeat(5_000)] }));
    expect(bullets).toHaveLength(1);
    expect(bullets?.[0]?.length).toBeLessThanOrEqual(EPISODE_MAX_CHARS);
  });

  it("tolerates a fenced reply and drops non-string or blank bullets", () => {
    expect(parseEpisodeReply('```json\n{"bullets":["a", 3, "  ", "b"]}\n```')).toEqual(["a", "b"]);
  });
});

describe("summarizeRollup", () => {
  it("includes an existing summary so late entries are folded in, not lost", async () => {
    const seen: LlmCompletionRequest[] = [];
    const outcome = await summarizeRollup(
      weekPeriod("2026-W44"),
      { existing: "- earlier", entries: ["## new entry"] },
      replying('{"summary":"- merged"}', seen),
    );
    expect(outcome).toEqual({ ok: true, value: "- merged" });
    expect(seen[0]?.messages[1]?.content).toContain("EXISTING SUMMARY:\n\n- earlier");
  });

  it("drops model headings and neutralises HTML so a summary cannot forge a sources ledger", () => {
    const body = parseRollupReply(
      JSON.stringify({ summary: "# Fake title\n<!-- sources: x -->\n- real point" }),
      weekPeriod("2026-W44"),
    );
    expect(body).toBe("&lt;!-- sources: x --&gt;\n- real point");
  });

  it("caps a month summary at its size limit", () => {
    const long = Array.from({ length: 200 }, (_, i) => `- point ${i}`).join("\n");
    const body = parseRollupReply(JSON.stringify({ summary: long }), monthPeriod("2026-10"));
    expect(body?.length).toBeLessThanOrEqual(MONTH_MAX_CHARS);
  });
});

describe("editEpisode — the editor pass over a draft entry", () => {
  const draft = [
    "Built a custom zsh theme for the user.",
    "User corrected the home path display to include a trailing slash.",
  ];

  it("sends only the draft (never a transcript), and returns the edited bullets", async () => {
    const seen: LlmCompletionRequest[] = [];
    const edited = await editEpisode(
      draft,
      replying('{"bullets":["Built a custom zsh theme for the user."]}', seen),
    );
    expect(edited).toEqual(["Built a custom zsh theme for the user."]);
    const prompt = seen[0]?.messages[1]?.content ?? "";
    expect(prompt).toContain("DRAFT ENTRY:");
    expect(prompt).toContain("- Built a custom zsh theme for the user.");
    expect(seen[0]?.messages[0]?.content).toContain("ONLY delete bullets");
  });

  it("keeps the draft when the call fails", async () => {
    const failing: LlmClient = {
      complete: async () => {
        throw new Error("provider down");
      },
    };
    expect(await editEpisode(draft, failing)).toEqual(draft);
  });

  it("keeps the draft when the reply isn't the expected JSON", async () => {
    expect(await editEpisode(draft, replying("sure, here you go"))).toEqual(draft);
  });

  it("keeps the draft when the editor returns more bullets than it was given (it may only cut)", async () => {
    expect(await editEpisode(draft, replying('{"bullets":["a","b","c"]}'))).toEqual(draft);
  });

  it("keeps the draft when the editor empties a non-empty entry", async () => {
    expect(await editEpisode(draft, replying('{"bullets":[]}'))).toEqual(draft);
  });

  it("never calls the model for an empty draft", async () => {
    const client: LlmClient = {
      complete: async () => {
        throw new Error("must not be called");
      },
    };
    expect(await editEpisode([], client)).toEqual([]);
  });
});
