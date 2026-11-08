import type { LlmClient } from "@librarian/core";

type Messages = { content: string }[];

export function isReviewerCall(messages: Messages): boolean {
  return messages[0]?.content.includes("You are the Reviewer") ?? false;
}

/** A reviewer reply that keeps every fact, quoting the start of the real transcript. */
export function keepEverything(messages: Messages): {
  content: string;
  model: string;
  usage: null;
} {
  const user = messages[1]?.content ?? "";
  const conversation = user.slice(
    "CONVERSATION:\n\n".length,
    user.indexOf("\n\nEND CONVERSATION."),
  );
  const factLines = user.slice(user.indexOf("\n\nFACTS:\n")).match(/^\d+\. /gm) ?? [];
  const reviews = factLines.map((_, index) => ({
    index,
    verdict: "keep",
    quote: conversation.slice(0, 40),
  }));
  return { content: JSON.stringify({ reviews }), model: "m", usage: null };
}

/** Answer reviewer calls by keeping everything, so a test can focus on the rest of the sweep. */
export function withKeepingReviewer(client: LlmClient): LlmClient {
  return {
    ...client,
    complete: async (request) =>
      isReviewerCall(request.messages)
        ? keepEverything(request.messages)
        : client.complete(request),
  };
}
