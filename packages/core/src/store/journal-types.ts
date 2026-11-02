// The journal's store seam types (spec 077 §4.1). Kept in the store layer so
// librarian-store.ts can expose the seam without importing the journal module's
// LLM / compaction code.

import type { Shelf } from "../vault-router.js";

/** The journal folder, relative to a shelf's root. */
export const JOURNAL_DIR = "journal";

/**
 * One shelf's journal files. Paths are journal-relative (`days/2026-11-02.md`,
 * `weeks/2026-W44.md`, `months/2026-10.md`); any other shape is refused.
 */
export interface JournalFileStore {
  readonly shelf: Shelf;
  /** Every canonical journal file on this shelf (journal-relative, sorted). */
  list(): string[];
  /** A file's content, or null when absent. */
  read(relPath: string): string | null;
  /** Write a file and commit it with `subject`. */
  write(relPath: string, content: string, subject: string): void;
  /** Delete files (absent ones are skipped) and commit the deletion with `subject`. */
  remove(relPaths: string[], subject: string): void;
}
