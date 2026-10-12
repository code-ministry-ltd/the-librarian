// Wikilink parsing + surgical link-integrity rewrites for the markdown
// corpus (spec 035 §F1 / §F12). Obsidian wikilink forms:
//   [[target]] · [[target|alias]] · [[target#heading]] · ![[embed]]
// (plus the heading+alias combo). The parser yields each link's exact
// source span so renames are surgical string edits — only the matched
// link tokens change, the rest of the file stays byte-identical (minimal
// git diffs; no full markdown re-stringify, which is why this is a focused
// scanner rather than a remark round-trip — remark/rehype rendering is a
// Phase-6 dashboard concern).
//
// Known simplification (MVP): matches occur anywhere, including inside
// inline-code / fenced blocks. The intake authors prose and ids are
// unique slugs, so this is low-risk; code-fence-aware skipping is a
// documented follow-up.

// (!?) embed flag · target (no [ ] | #) · optional #heading · optional |alias
const WIKILINK = /(!?)\[\[([^[\]|#]+)(#[^[\]|]+)?(\|[^[\]]+)?\]\]/g;

export interface Wikilink {
  /** The exact matched text, e.g. "![[doc#H|Alias]]". */
  raw: string;
  /** True for an embed / transclusion (`![[...]]`). */
  embed: boolean;
  /** The link target (note id / path), trimmed. */
  target: string;
  /** Heading anchor without the leading `#`, or null. */
  heading: string | null;
  /** Display alias without the leading `|`, or null. */
  alias: string | null;
  /** Start offset in the source string (inclusive). */
  start: number;
  /** End offset in the source string (exclusive). */
  end: number;
}

/** Extract every wikilink (with its source span) from a markdown string. */
export function parseWikilinks(markdown: string): Wikilink[] {
  const links: Wikilink[] = [];
  for (const match of markdown.matchAll(WIKILINK)) {
    const raw = match[0]!;
    const start = match.index!;
    const heading = match[3];
    const alias = match[4];
    links.push({
      raw,
      embed: match[1] === "!",
      target: (match[2] ?? "").trim(),
      heading: heading ? heading.slice(1).trim() : null,
      alias: alias ? alias.slice(1).trim() : null,
      start,
      end: start + raw.length,
    });
  }
  return links;
}

/**
 * Rewrite every wikilink whose target exactly equals `from` to point at
 * `to`, preserving its embed flag, heading anchor, and alias. Non-matching
 * links and all surrounding content are copied verbatim.
 */
export function renameWikilinkTarget(markdown: string, from: string, to: string): string {
  let out = "";
  let cursor = 0;
  for (const link of parseWikilinks(markdown)) {
    if (link.target !== from) continue;
    out += markdown.slice(cursor, link.start) + renderWikilink({ ...link, target: to });
    cursor = link.end;
  }
  return out + markdown.slice(cursor);
}

function renderWikilink(link: Wikilink): string {
  const heading = link.heading ? `#${link.heading}` : "";
  const alias = link.alias ? `|${link.alias}` : "";
  return `${link.embed ? "!" : ""}[[${link.target}${heading}${alias}]]`;
}

/**
 * Rewrite every wikilink whose target matches one of `from` — case-insensitively,
 * trimmed — to point at `to`, preserving embed flag, heading anchor and alias
 * (spec 076 §4: links follow a merge). Titles are how the curator links memories,
 * and Obsidian resolves them case-insensitively, so the match does too.
 */
export function repointWikilinkTargets(
  markdown: string,
  from: readonly string[],
  to: string,
): string {
  const wanted = new Set(from.map((target) => target.trim().toLowerCase()));
  let out = "";
  let cursor = 0;
  for (const link of parseWikilinks(markdown)) {
    if (!wanted.has(link.target.toLowerCase())) continue;
    out += markdown.slice(cursor, link.start) + renderWikilink({ ...link, target: to });
    cursor = link.end;
  }
  return out + markdown.slice(cursor);
}
