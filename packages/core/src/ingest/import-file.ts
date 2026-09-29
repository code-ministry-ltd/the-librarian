// Render an existing Markdown file as a vault reference — spec 073 (D4).
//
// The web-capture path (`process-content.ts` → `renderReference`) builds
// frontmatter from scratch, which is correct for a scraped page: everything
// known about it comes from the capture. It is wrong for a file the operator
// already wrote. Importing a folder of notes must not silently discard `tags`,
// `aliases` or a hand-chosen title — that metadata is usually the reason those
// files were worth keeping.
//
// Hence: ADD, NEVER CLOBBER. Existing keys win; we only fill in gaps. That also
// makes re-importing idempotent, which matters because `refs import` is
// explicitly re-runnable.

import { parseFrontmatter, stringifyFrontmatter } from "../safe-frontmatter.js";
import type { IngestVia } from "./ingest-log.js";

export interface ImportedReferenceInput {
  /** The source file's raw text — frontmatter + body, or just a body. */
  raw: string;
  /** Which path filed it; recorded as `via` only when the file has none. */
  via: IngestVia;
  /** ISO timestamp, recorded as `captured_at` only when the file has none. */
  capturedAt: string;
  /** Where it came from (a path or URL), recorded only when absent. */
  source?: string;
  /** Used as `title` when the file has neither a frontmatter title nor an H1. */
  fallbackTitle?: string;
}

/** The first line's `# Heading`, or null. Deliberately only the FIRST line: a
 *  `# ` further down is a section, not the document's title. */
function firstH1(markdown: string): string | null {
  const [line] = markdown.trimStart().split("\n");
  const match = /^#\s+(.+?)\s*$/.exec(line ?? "");
  return match?.[1] ?? null;
}

/**
 * Merge ingest provenance into a Markdown file's own frontmatter, without
 * overwriting anything it already carries. Returns the full document text.
 */
export function renderImportedReference(input: ImportedReferenceInput): string {
  const parsed = parseFrontmatter(input.raw);
  const data: Record<string, unknown> = { ...parsed.data };

  if (!data.title) {
    data.title = firstH1(parsed.content) ?? input.fallbackTitle?.trim() ?? "Untitled";
  }
  if (input.source && !data.source) data.source = input.source;
  if (!data.captured_at) data.captured_at = input.capturedAt;
  if (!data.via) data.via = input.via;

  return stringifyFrontmatter(`\n${parsed.content.trim()}\n`, data);
}
