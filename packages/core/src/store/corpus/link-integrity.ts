// Vault-wide link integrity (spec 035 §F12). When a document is renamed,
// every wikilink that points at it — in any form, in any document — must be
// rewritten so no link dangles. This is the link-integrity half of F12; the
// move of the document's own file is the caller's `vault.moveFile`, and
// persisting the result is the caller's `git.commitAll` (commit-per-op).
//
// Link targets are bare ids (the intake's convention — slugs unique
// across the vault, matching Obsidian's shortest-unique-path default), so
// relinking matches `[[id]]` rather than path-form links.

import type { Vault } from "./vault.js";
import { renameWikilinkTarget, repointWikilinkTargets } from "./wikilink.js";

/**
 * Rewrite every wikilink whose target equals `from` to `to` across the
 * whole vault (all forms), writing back only the documents that changed.
 * Returns the changed file paths (posix-relative to the vault root, sorted).
 */
export function relinkVault(vault: Vault, from: string, to: string): string[] {
  const changed: string[] = [];
  for (const relPath of vault.listMarkdown()) {
    const document = vault.readDocument(relPath);
    const body = renameWikilinkTarget(document.body, from, to);
    if (body === document.body) continue;
    vault.writeDocument(relPath, { ...document, body });
    changed.push(relPath);
  }
  return changed;
}

/** The memory surface {@link repointMemoryLinks} reads and writes through. */
export interface RepointLinksStore {
  /** The active memories whose links may need repointing. */
  listActive: () => { id: string; title: string; body: string }[];
  /** Persist one memory's new body (one write, attributed by the caller). */
  updateBody: (id: string, body: string) => void;
}

/**
 * Links follow a merge (spec 076 §4). When `replacement` supersedes `sources`,
 * every other active memory that links to a source's title is rewritten to link
 * to the replacement's title instead. Returns the ids rewritten. A source whose
 * title equals the replacement's needs nothing; the replacement itself is left
 * alone (its links to its own sources are the curator's to write).
 */
export function repointMemoryLinks(
  store: RepointLinksStore,
  sources: readonly { title: string }[],
  replacement: { id: string; title: string },
): string[] {
  const from = sources
    .map((source) => source.title)
    .filter((title) => title.trim().toLowerCase() !== replacement.title.trim().toLowerCase());
  if (from.length === 0) return [];
  const changed: string[] = [];
  for (const memory of store.listActive()) {
    if (memory.id === replacement.id) continue;
    const body = repointWikilinkTargets(memory.body, from, replacement.title);
    if (body === memory.body) continue;
    store.updateBody(memory.id, body);
    changed.push(memory.id);
  }
  return changed;
}
