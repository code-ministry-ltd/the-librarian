// Vault-wide wikilink resolution + backlinks (rethink T18, spec §8 / D15).
// The recall index keeps its own link graph (memory-ids only, index-internal);
// the dashboard's vault explorer needs the same idea over FILES: given a
// document, which vault paths does a wikilink target resolve to, and which
// documents link back to it. Built fresh from the markdown on demand — like
// everything else derived from the vault, it is disposable and rebuildable.
//
// A wikilink can address a document by any of its names (the same convention
// the wikilink machinery + curator prompt use — link "by its title/alias"):
//   - the filename stem (link-integrity's bare-slug convention),
//   - the frontmatter `id` / `handoff_id`,
//   - the frontmatter `title`,
//   - any frontmatter `aliases` entry.
// Matching is case-insensitive (Obsidian's behaviour); the first file claiming
// a name wins (vault.listMarkdown is sorted, so ties are deterministic).

import { parseFrontmatter } from "../../safe-frontmatter.js";
import type { Vault } from "./vault.js";
import { parseWikilinks } from "./wikilink.js";

export interface VaultLinkIndex {
  /** Resolve a wikilink target to a vault-relative path, or null when dangling. */
  resolve(target: string): string | null;
  /** Paths whose body wikilinks to this file (sorted, excluding the file itself). */
  backlinks(relPath: string): string[];
  /** This file's outbound wikilink targets, each resolved (null = dangling). */
  outbound(relPath: string): { target: string; path: string | null }[];
}

export interface VaultLinkIndexOptions {
  /** Restrict the scanned files (e.g. the explorer hides inbox internals). */
  include?: (relPath: string) => boolean;
}

/** The names a wikilink may use to address the file at `relPath`. */
function linkNames(relPath: string, raw: string): string[] {
  const stem = relPath.split("/").pop()?.replace(/\.md$/, "") ?? "";
  const names = new Set<string>(stem ? [stem] : []);
  try {
    const data = parseFrontmatter(raw).data as Record<string, unknown>;
    for (const key of ["id", "handoff_id", "title"]) {
      const value = data[key];
      if (typeof value === "string" && value.trim()) names.add(value.trim());
    }
    if (Array.isArray(data.aliases)) {
      for (const alias of data.aliases) {
        if (typeof alias === "string" && alias.trim()) names.add(alias.trim());
      }
    }
  } catch {
    // Malformed frontmatter: the file is still addressable by its stem.
  }
  return [...names];
}

export function buildVaultLinkIndex(
  vault: Vault,
  options: VaultLinkIndexOptions = {},
): VaultLinkIndex {
  const include = options.include ?? (() => true);
  // name (lowercased) → path; first claimant wins (sorted listing → deterministic).
  const nameToPath = new Map<string, string>();
  // path → its outbound wikilink targets (raw, in document order, deduped).
  const targetsByFile = new Map<string, string[]>();
  // path → its own names (lowercased) for the backlink reverse lookup.
  const namesByFile = new Map<string, string[]>();

  for (const relPath of vault.listMarkdown()) {
    if (!include(relPath)) continue;
    const raw = vault.tryReadText(relPath);
    if (raw === null) continue; // raced a delete — skip
    const names = linkNames(relPath, raw).map((name) => name.toLowerCase());
    namesByFile.set(relPath, names);
    for (const name of names) {
      if (!nameToPath.has(name)) nameToPath.set(name, relPath);
    }
    // Wikilinks live in the body; gray-matter's content excludes frontmatter.
    // A file whose frontmatter won't parse still gets a raw-text scan (the
    // wikilink scanner is frontmatter-agnostic anyway).
    let body = raw;
    try {
      body = parseFrontmatter(raw).content;
    } catch {
      // keep raw
    }
    const targets: string[] = [];
    const seen = new Set<string>();
    for (const link of parseWikilinks(body)) {
      const key = link.target.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(link.target);
    }
    targetsByFile.set(relPath, targets);
  }

  const resolve = (target: string): string | null =>
    nameToPath.get(target.trim().toLowerCase()) ?? null;

  return {
    resolve,
    backlinks: (relPath) => {
      const names = new Set(namesByFile.get(relPath) ?? []);
      if (names.size === 0) return [];
      const out: string[] = [];
      for (const [path, targets] of targetsByFile) {
        if (path === relPath) continue; // a self-link is not a backlink
        // A target counts only when it resolves to THIS file — a name another
        // file claimed first (resolve precedence) must not produce a backlink here.
        if (targets.some((t) => names.has(t.toLowerCase()) && resolve(t) === relPath)) {
          out.push(path);
        }
      }
      return out.sort();
    },
    outbound: (relPath) =>
      (targetsByFile.get(relPath) ?? []).map((target) => ({ target, path: resolve(target) })),
  };
}
