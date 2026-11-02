// `journal` MCP tool (spec 077 §4.5, ADR 0016) — the 8th verb. Read or search the
// caller's journal: a dated history of past conversations, recent days in detail and
// older weeks/months summarised. Retrieve by date range (no `query`) or search with
// BM25 (`query`), optionally filtered by project and harness. Read-only, so it is
// allowed in private mode, like `recall`.

import {
  JournalQueryError,
  isJournalActive,
  localDate,
  parseJournalQueryArgs,
  queryJournal,
} from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";

const journal: ToolDefinition = {
  name: "journal",
  description:
    "Read or search your journal: a dated history of your past conversations with the " +
    "owner — recent days in detail, older weeks and months summarised. Your session may " +
    "already include the last ~6 weeks. Use this for anything older, or to find what " +
    "happened on a project or topic. Facts belong to `recall`; this is what happened and why.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        maxLength: 500,
        description:
          "Search terms. Omit to retrieve the journal for a date range instead, oldest first.",
      },
      from: {
        type: "string",
        description:
          "Inclusive start date, YYYY-MM-DD. Defaults to 30 days before `to` when retrieving, " +
          "365 days before `to` when searching.",
      },
      to: {
        type: "string",
        description: "Inclusive end date, YYYY-MM-DD. Defaults to today.",
      },
      project: {
        type: "string",
        maxLength: 200,
        description:
          "Only entries from this project (case-insensitive). Weekly and monthly summaries " +
          "match when they mention it.",
      },
      harness: {
        type: "string",
        maxLength: 50,
        description: "Only entries from this harness, e.g. claude or codex.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Search mode: the most matches to return (default 10).",
      },
      max_tokens: {
        type: "integer",
        minimum: 1000,
        maximum: 40000,
        description:
          "Response size cap (default 8,000). When retrieving, the oldest entries are left out " +
          "first and the reply says how to page back.",
      },
    },
  },
  handler(store, args, context) {
    if (!isJournalActive(store)) {
      return textResult(
        "The journal is turned off on this Librarian server, so there is no history to read. " +
          "The owner can enable it in the dashboard under Settings → Curator → Intake → Journal.",
      );
    }
    let input;
    try {
      input = parseJournalQueryArgs(args);
    } catch (error) {
      if (error instanceof JournalQueryError)
        return textResult(`journal rejected: ${error.message}`);
      throw error;
    }
    // The caller's own shelf — where its conversations' episodes were written (the same
    // shelf GET /journal.md serves).
    const shelf = store.resolveWriteTarget(context.principal);
    return textResult(queryJournal(store.systemJournal(shelf), input, localDate(new Date())));
  },
};

export default journal;
