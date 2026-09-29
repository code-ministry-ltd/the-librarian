// Corpus frontmatter — the minimal document metadata for the markdown
// rearchitecture (spec 035 §F1). A corpus document is Obsidian-flavoured
// markdown: a YAML frontmatter block followed by a markdown body. D16
// reduced the metadata to identity + filing hints only — no
// agent/source/confidence/scope/domain.
//
// The markdown is the source of truth, so serialization is deterministic
// and byte-stable: a fixed key order, double-quoted scalars, and
// block-style arrays. Double-quoting matters — js-yaml (via gray-matter)
// otherwise re-parses an unquoted ISO timestamp as a `Date`, which would
// break the round-trip and bloat git diffs. `parseDocument` is tolerant of
// hand edits (Obsidian / the dashboard): it coerces any YAML `Date` back to
// an ISO string before validating.

import { parseFrontmatter } from "../../safe-frontmatter.js";
import { z } from "zod";
import { IsoTimestampSchema } from "../../schemas/common.js";

export const CorpusFrontmatterSchema = z.object({
  /** Stable slug identity for the document (also its filename stem). */
  id: z.string().min(1),
  /** Alternate names the document is known by — used for wikilink resolution. */
  aliases: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  /** Topic-folder filing hint (people / projects / preferences / lessons / …). */
  category: z.string().min(1),
  created: IsoTimestampSchema,
  updated: IsoTimestampSchema,
});
export type CorpusFrontmatter = z.infer<typeof CorpusFrontmatterSchema>;

/** A parsed corpus document: validated frontmatter + the trimmed markdown body. */
export interface CorpusDocument {
  frontmatter: CorpusFrontmatter;
  body: string;
}

/**
 * Parse raw markdown (frontmatter + body) into a validated `CorpusDocument`.
 * Throws a teaching error naming the offending field when the frontmatter
 * doesn't satisfy the minimal schema.
 */
export function parseDocument(raw: string): CorpusDocument {
  const { data, content } = parseFrontmatter(raw);
  const result = CorpusFrontmatterSchema.safeParse(coerceDates(data));
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid corpus frontmatter: ${detail}`);
  }
  return { frontmatter: result.data, body: content.trim() };
}

/**
 * Serialize a `CorpusDocument` to its canonical on-disk form: deterministic
 * frontmatter (fixed key order, double-quoted scalars, block arrays) and a
 * trimmed body. `parseDocument(serializeDocument(doc))` deep-equals `doc`,
 * and `serializeDocument(parseDocument(x)) === x` for any canonical `x`.
 */
export function serializeDocument(doc: CorpusDocument): string {
  const fm = doc.frontmatter;
  const head = `---\n${[
    `id: ${quoteScalar(fm.id)}`,
    arrayLines("aliases", fm.aliases),
    arrayLines("tags", fm.tags),
    `category: ${quoteScalar(fm.category)}`,
    `created: ${quoteScalar(fm.created)}`,
    `updated: ${quoteScalar(fm.updated)}`,
  ].join("\n")}\n---\n`;
  const body = doc.body.trim();
  return body ? `${head}\n${body}\n` : head;
}

function quoteScalar(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

function arrayLines(key: string, items: string[]): string {
  if (items.length === 0) return `${key}: []`;
  return [`${key}:`, ...items.map((item) => `  - ${quoteScalar(item)}`)].join("\n");
}

function coerceDates(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}
