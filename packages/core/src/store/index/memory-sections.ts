// Memory sections (spec 075 §3.1.1). Recall indexes each memory as a handful of
// ~180-word sections instead of one blob, so a fact deep inside a long memory
// is matched on its own words rather than diluted by everything else the
// memory says (measured on a real corpus: long memories ranked their target
// first 40% of the time whole, 93% sectioned). The best-matching section is
// also what an agent receives as the excerpt.

/** Upper bound on a packed section, in words. A longer paragraph stands alone. */
export const MAX_SECTION_WORDS = 180;

const HEADING = /^#{1,6} /;
const FENCE = /^\s*(```|~~~)/;

const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/**
 * Split a memory body into paragraphs: at blank lines, and before a markdown
 * heading line — except inside fenced code, where `#` lines are comments.
 */
function paragraphs(body: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inFence = false;
  const flush = (): void => {
    const text = current.join("\n").trim();
    if (text) out.push(text);
    current = [];
  };
  for (const line of body.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      current.push(line);
      continue;
    }
    if (!inFence && line.trim() === "") {
      flush();
      continue;
    }
    if (!inFence && HEADING.test(line)) flush();
    current.push(line);
  }
  flush();
  return out;
}

/**
 * The memory's sections, in body order: paragraphs packed greedily up to
 * {@link MAX_SECTION_WORDS}. Always at least one entry (an empty body gives
 * `[""]`), so every memory is indexable.
 */
export function splitMemorySections(body: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  let words = 0;
  for (const paragraph of paragraphs(body)) {
    const count = wordCount(paragraph);
    if (current.length > 0 && words + count > MAX_SECTION_WORDS) {
      sections.push(current.join("\n\n"));
      current = [];
      words = 0;
    }
    current.push(paragraph);
    words += count;
  }
  if (current.length > 0) sections.push(current.join("\n\n"));
  return sections.length > 0 ? sections : [""];
}
