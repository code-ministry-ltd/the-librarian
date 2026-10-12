// Memory-side recall formatter. The session handover formatters
// (renderHandover / renderHandoverMarkdown / renderHandoverProse and the
// HandoverPayload type) were retired with the rest of the session
// subsystem in sessions-rethink PR 7.

import { splitMemorySections } from "../store/index/memory-sections.js";

export interface RecallItem {
  id?: string;
  title: string;
  body: string;
  /**
   * Shelf provenance (spec 062 SC 5, T5). Present ONLY on a MULTI-shelf merged-recall hit — a
   * principal whose materialised recall shelf set has length > 1. Absent under the default /
   * single-shelf router, so this formatter's output stays BYTE-IDENTICAL to before. When set, the
   * hit renders a leading bracketed token: `[<label> (<id>)]` when the shelf carries a `shelfLabel`,
   * `[<id>]` otherwise (the decided "label with id in parentheses" format, spec 062 §6).
   */
  shelfId?: string;
  shelfLabel?: string;
  /** The best-matching section for the query (spec 075); absent for backlink hits. */
  matchedSection?: string;
}

export interface FormatRecallOptions {
  // When true, prefix each line with the memory's id in brackets so callers can
  // pass it to `flag_memory` after using a recalled item. Default off so the
  // existing prose-only output stays byte-identical for system-prompt injection
  // and other consumers that don't need ids.
  includeIds?: boolean;
  // When true, a long memory renders as its best-matching section plus a footer
  // telling the agent how to fetch the rest (spec 075). Only the agent-facing
  // `recall` verb turns this on; every other consumer keeps whole bodies.
  excerpts?: boolean;
}

/** Bodies at or under this length are always returned whole (spec 075 D2). */
export const EXCERPT_MIN_BODY_CHARS = 1500;

const countWords = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/** The body text an agent sees for one hit: the whole body, or an excerpt + footer. */
function recallBody(memory: RecallItem, excerpts: boolean): string {
  if (
    !excerpts ||
    memory.matchedSection === undefined ||
    memory.body.length <= EXCERPT_MIN_BODY_CHARS ||
    splitMemorySections(memory.body).length < 2
  ) {
    return memory.body;
  }
  const remaining = countWords(memory.body) - countWords(memory.matchedSection);
  const fetch = memory.id ? `; recall with ids ["${memory.id}"] for all of it` : "";
  return `${memory.matchedSection}\n(excerpt — ${remaining} more words in this memory${fetch})`;
}

export function formatRecall(
  memories: RecallItem[],
  heading: string = "Relevant Memories",
  options: FormatRecallOptions = {},
): string {
  if (!memories.length) return `${heading}\n\nNo relevant memories found.`;
  return `${heading}\n\n${memories
    .map((memory) => {
      // Shelf provenance token (spec 062 T5) leads the line so an agent reading a MERGED recall can
      // tell which shelf a hit came from. It renders ONLY when the hit carries shelf provenance —
      // i.e. a multi-shelf recall. A single-shelf recall omits it entirely, keeping the line
      // byte-identical to before (the inertness rule): `[<label> (<id>)]` labelled, else `[<id>]`.
      // Render safety (review G1): the label is plugin-authored, renamable text, so strip any `]` /
      // newline that would break the bracket token or inject a line (the id is already validated
      // free of both, but strip defensively — one code path).
      const safeToken = (value: string): string => value.replace(/[\]\r\n]/g, "");
      const shelfLabel = memory.shelfLabel ? safeToken(memory.shelfLabel) : undefined;
      const shelfId = memory.shelfId ? safeToken(memory.shelfId) : undefined;
      const shelfPrefix = shelfId
        ? `[${shelfLabel ? `${shelfLabel} (${shelfId})` : shelfId}] `
        : "";
      const idPrefix = options.includeIds && memory.id ? `[${memory.id}] ` : "";
      return `- ${shelfPrefix}${idPrefix}${memory.title}: ${recallBody(memory, options.excerpts === true)}`;
    })
    .join("\n")}`;
}
