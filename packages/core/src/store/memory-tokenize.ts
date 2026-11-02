// Recall/similarity tokenizer (plan 036 Phase 2). Lowercase, strip to a
// word/path-char alphabet, drop tokens ≤ 2 chars and a small stopword set.
// Shared by search + duplicate-detection so both score identically.

import { normalizeString } from "../constants.js";

const STOPWORDS = ["the", "and", "for", "with", "that", "this", "from", "into", "agent", "memory"];

export function tokenize(text: string): string[] {
  return (
    normalizeString(text)
      .toLowerCase()
      .replace(/[^a-z0-9_./-]+/g, " ")
      .split(/\s+/)
      // `.`, `/` and `-` are kept so `config.ts`, `docs/release.md` and `1.2.3` stay
      // whole — but at a token's EDGE they are sentence punctuation, and keeping them
      // made a sentence's last word ("importer.") unmatchable by "importer". Trim
      // them from both ends; inner ones survive.
      .map((term) => term.replace(/^[./-]+|[./-]+$/g, ""))
      .filter((term) => term.length > 2)
      .filter((term) => !STOPWORDS.includes(term))
  );
}
