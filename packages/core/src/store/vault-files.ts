// Vault file store (rethink T18/T19, spec §8 / D15) — the Obsidian-lite
// read/write surface the dashboard's vault explorer drives. One store over the
// WHOLE vault (memories/, handoffs/, references/, .curator/, primer.md), with:
//
//   - tree/read:   recursive listing + raw read (lenient frontmatter parse,
//                  content hash for the compare-and-swap, mtime);
//   - write/create/rename/delete: every mutation validates the document for
//                  its file type FIRST (never write invalid), then goes through
//                  the same commit-per-write + onWrite (index-invalidation)
//                  path every other vault write uses — never a raw fs write
//                  the store doesn't see.
//
// Path discipline: the explorer's paths come from an admin browser, so every
// entry point re-validates — relative, forward-slash, no dot-segments, no
// dotfiles outside `.curator/`, and the resolved realpath must stay inside the
// vault root (a symlink inside the vault must not read or write through it).
// `inbox/` (the intake's transient claim/queue files) and `.git`/`.index`
// internals are not part of the surface at all: hidden from the tree, and not
// addressable for reads or writes.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { actorTrailerValue } from "../caller-identity.js";
import { ADDENDUM_MAX_BYTES } from "../curator-addendum.js";
import { PRIMER_MAX_BYTES, PRIMER_PATH } from "../primer.js";
import { HANDOFF_REQUIRED_HEADINGS } from "../schemas/handoff.js";
import { commitSubject } from "./commit-message.js";
import { type VaultLinkIndex, buildVaultLinkIndex } from "./corpus/vault-links.js";
import type { Vault } from "./corpus/vault.js";
import { renameWikilinkTarget } from "./corpus/wikilink.js";
import type { FileCommit, GitHistory } from "./git/git-history.js";
import { parseHandoffDocument } from "./markdown/handoff-doc.js";
import { parseMemoryDocument, serializeMemoryDocument } from "./markdown/memory-doc.js";
import { parseProjectDocument } from "./markdown/project-doc.js";
import { parseProjectSuggestionDocument } from "./markdown/project-suggestion-doc.js";
import { parseProjectUpdateDocument } from "./markdown/project-update-doc.js";

/** What a vault path IS, deciding which validation rules a write must pass. */
export type VaultFileKind =
  | "memory"
  | "handoff"
  | "project"
  | "project-update"
  | "project-suggestion"
  | "reference"
  | "primer"
  | "curator"
  | "other";

export interface VaultTreeNode {
  /** Basename (e.g. "primer.md", "memories"). */
  name: string;
  /** Vault-relative posix path. */
  path: string;
  type: "dir" | "file";
  /** Last-modified time (ISO), files only. */
  mtime?: string;
  /** Sorted children (dirs first), dirs only. */
  children?: VaultTreeNode[];
}

export interface VaultFileRead {
  path: string;
  kind: VaultFileKind;
  /** The full on-disk text (frontmatter + body). */
  raw: string;
  /** Body without the frontmatter block (what the markdown renderer shows). */
  body: string;
  /** Leniently-parsed frontmatter (whatever is there), or null when absent/unparseable. */
  frontmatter: Record<string, unknown> | null;
  /** sha256 of `raw` — the compare-and-swap token for a later write. */
  hash: string;
  /** Last-modified time (ISO). */
  mtime: string;
}

export interface VaultFileStore {
  /** The explorer tree: every visible vault entry, dirs first, sorted. */
  tree(): VaultTreeNode[];
  readFile(relPath: string): VaultFileRead;
  /** Resolve a wikilink target to a vault path (same alias/slug logic as links). */
  resolveLink(target: string): string | null;
  /** Paths that wikilink to this file (sorted). */
  backlinks(relPath: string): string[];
  /** This file's outbound wikilink targets, resolved (null = dangling). */
  outboundLinks(relPath: string): { target: string; path: string | null }[];
  /**
   * Overwrite an existing file. Validates for the path's kind BEFORE writing;
   * when `expectedHash` is supplied, the write is compare-and-swap: a file whose
   * content changed since that hash was read is refused (never silent
   * last-write-wins). Commits + fires onWrite.
   *
   * `actorId` (optional-LAST, spec 064 SC 4 — here in position 4, after the existing
   * `options`) is the acting principal for the commit's `Librarian-Actor` trailer.
   */
  writeFile(
    relPath: string,
    raw: string,
    options?: { expectedHash?: string },
    actorId?: string,
  ): { hash: string };
  /** Create a new file (refused when the path exists). Validates, commits, fires onWrite. */
  createFile(relPath: string, raw: string, actorId?: string): { hash: string };
  /**
   * Move a file AND keep every wikilink pointing at it intact: links targeting
   * the old filename stem are rewritten to the new stem across the whole vault
   * (renameWikilinkTarget — the link-integrity engine); links by frontmatter
   * id/title/alias keep resolving unchanged. One commit covers the move +
   * rewrites.
   */
  renameFile(
    fromRel: string,
    toRel: string,
    actorId?: string,
  ): { path: string; changedLinks: string[] };
  /** Hard-delete a file (recoverable from git history). Commits, fires onWrite. */
  deleteFile(relPath: string, actorId?: string): void;
  /**
   * The file's commit history, newest first, following renames (rethink T20).
   * Each entry carries the path the file had AT that commit. Works for a
   * since-deleted file too — that's exactly the recovery path.
   */
  fileHistory(relPath: string): FileCommit[];
  /** The file's full content as of `hash` (rename-aware via the history). */
  fileAtCommit(relPath: string, hash: string): { path: string; hash: string; content: string };
  /**
   * Unified diff for one file between two commits — or from a commit to the
   * working tree when `to` is omitted, or from the file's birth (the empty
   * tree) when `from` is omitted. Rename-aware via the history.
   */
  fileDiff(relPath: string, range?: { from?: string; to?: string }): string;
  /**
   * Restore the file to its content at `hash` — written as a NEW commit
   * through the exact write path every other mutation uses (validate for the
   * path's kind, commit, fire onWrite); history is never rewritten. A version
   * whose content no longer passes the kind's CURRENT validation is refused
   * with the errors — edit the file manually instead.
   */
  restoreFileVersion(relPath: string, hash: string, actorId?: string): { hash: string };
}

export interface VaultFileStoreDeps {
  vault: Vault;
  /**
   * Sync commit-per-op — the ATTRIBUTED, pathspec-limited primitive (spec 064 SC 1):
   * `(paths, message, actorId?)`. Each verb names EXACTLY the paths it touched (a rename
   * also carries every relinked file) so the commit is scoped to them, and passes the
   * acting principal for the `Librarian-Actor` trailer. Paths are FULL vault-relative (the
   * store speaks full paths to git).
   */
  commit: (paths: string[], message: string, actorId?: string) => void;
  /** Fired per touched path after every successful mutation (index/primer invalidation). */
  onWrite?: (relPath: string) => void;
  /**
   * The vault's git history reader (rethink T20). Optional so plain
   * read/write tests need no repo; the history/diff/restore surface throws a
   * teaching error without it. The production store always wires it.
   */
  history?: GitHistory;
  /**
   * The shelf prefix this store is scoped to (spec 062 T3 / SC 3). Every path the store
   * validates, classifies, lists, and links is confined BENEATH `<prefix>` — the canonical
   * layout + depth-0 visibility rules apply shelf-relative (T2's `assertVaultFilePath` /
   * `vaultFileKind`), while the paths handed to git + the committer stay FULL vault-relative
   * (one repo). The EMPTY default is byte-for-byte today's whole-vault store.
   */
  prefix?: string;
}

// ── errors (each maps to a distinct admin-facing failure) ─────────────────────

/** The path is malformed or escapes the editable surface — never touches disk. */
export class VaultPathError extends Error {}

/** The document failed its kind's validation; `errors` lists every problem. */
export class VaultValidationError extends Error {
  readonly errors: string[];
  constructor(relPath: string, errors: string[]) {
    super(`'${relPath}' was not written: ${errors.join("; ")}`);
    this.errors = errors;
  }
}

/** Compare-and-swap failure: the file changed since the caller read it. */
export class VaultWriteConflictError extends Error {}

/** The addressed file does not exist. */
export class VaultFileNotFoundError extends Error {}

/** A create/rename destination already exists. */
export class VaultFileExistsError extends Error {}

// ── path discipline ───────────────────────────────────────────────────────────

// Top-level entries that are vault plumbing, not documents: git internals, the
// disposable index, and the intake's transient inbox queue (claims/items move
// through it constantly; editing one from the dashboard would race the sweep).
const HIDDEN_TOP_LEVEL = new Set([".git", ".index", "inbox"]);

// Canonical top-level names, keyed by lowercase. On a case-insensitive
// filesystem (macOS/Windows) a case variant — "Inbox/x.md", "Memories/a.md",
// "PRIMER.MD" — would alias the canonical entry while skipping its rules
// (hidden surface, per-kind validation, byte caps), so any variant spelling
// of a canonical name is outside the surface on EVERY platform.
//
// Exported (visibility only — no behaviour change) so the vault-router prefix rules
// (spec 062, `validateShelfSet`) reject a shelf prefix whose first segment shadows a
// canonical name, reusing the SAME source-of-truth list instead of duplicating it.
export const CANONICAL_TOP_LEVEL = new Map(
  [
    ...HIDDEN_TOP_LEVEL,
    ".curator",
    "memories",
    "handoffs",
    "projects",
    "project-updates",
    "project-suggestions",
    "references",
    PRIMER_PATH,
  ].map((name) => [name.toLowerCase(), name] as const),
);

/** Is this tree entry part of the visible explorer surface? */
function isVisibleSegment(segment: string, depth: number): boolean {
  if (depth === 0) {
    if (HIDDEN_TOP_LEVEL.has(segment)) return false;
    const canonical = CANONICAL_TOP_LEVEL.get(segment.toLowerCase());
    if (canonical !== undefined && segment !== canonical) return false;
  }
  // Dot-entries are plumbing — except `.curator/`, the addendum folder.
  if (segment.startsWith(".") && !(depth === 0 && segment === ".curator")) return false;
  return true;
}

/**
 * Validate + normalise an explorer-supplied path: relative, forward-slash,
 * no dot-segments, every segment visible. Returns the normalised path.
 * Teaching errors — the admin sees these verbatim.
 *
 * SHELF-RELATIVE (spec 062 SC 2): the canonical-layout + visibility rules apply BENEATH the
 * given shelf `prefix`. The prefix — already validated as a legal shelf prefix at router boot
 * (`validateShelfSet`: forward-slash, trailing slash, no dot-segments, non-canonical first
 * segment) — is stripped, and the depth-0-anchored rules run on the remainder. So for a shelf
 * `members/x/`, `members/x/inbox` is hidden exactly as a depth-0 `inbox` is, `members/x/.curator`
 * is visible exactly as a depth-0 `.curator` is, and `members/x/memories/…` is the canonical
 * layout. The EMPTY prefix (the OSS default shelf = the vault root) strips nothing, so every rule
 * reduces to EXACTLY today's depth-0 behaviour — byte-for-byte (proven by the SC 1 golden test
 * and every existing suite). The vault-singular entries (`.git`, `.index`, `primer.md`) stay
 * depth-0-anchored regardless of shelf; `vaultFileKind` pins `primer.md` to the true root.
 */
export function assertVaultFilePath(relPath: string, prefix: string = ""): string {
  if (typeof relPath !== "string" || relPath.trim() === "") {
    throw new VaultPathError("vault path must be a non-empty string");
  }
  if (relPath.includes("\0")) throw new VaultPathError("vault path must not contain NUL bytes");
  if (relPath.includes("\\")) {
    throw new VaultPathError(`vault path '${relPath}' must use forward slashes`);
  }
  if (path.posix.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) {
    throw new VaultPathError(`vault path '${relPath}' must be relative to the vault root`);
  }
  if (prefix !== "" && !relPath.startsWith(prefix)) {
    throw new VaultPathError(`vault path '${relPath}' is outside the shelf prefix '${prefix}'`);
  }
  // Strip the prefix, then index the REMAINDER — so `index` is the shelf-relative depth the
  // depth-0-anchored visibility rules expect. The prefix's own segments are the shelf's
  // structural root (validated at boot), not part of the editable surface's rule domain.
  const relative = prefix === "" ? relPath : relPath.slice(prefix.length);
  const segments = relative.split("/");
  for (const [index, segment] of segments.entries()) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new VaultPathError(
        `vault path '${relPath}' must not contain empty, '.' or '..' segments`,
      );
    }
    if (!isVisibleSegment(segment, index)) {
      throw new VaultPathError(`vault path '${relPath}' is outside the editable vault surface`);
    }
  }
  return prefix + segments.join("/");
}

/**
 * Symlink defence: the path's nearest existing ancestor must realpath-resolve
 * inside the vault root, and the file itself must not be a symlink — a link
 * planted inside the vault must never read or write outside it (or alias
 * another vault file).
 */
function assertResolvesInsideRoot(root: string, relPath: string): string {
  const abs = path.resolve(root, relPath);
  const realRoot = fs.realpathSync(root);
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break; // filesystem root — existsSync will be true there
    probe = parent;
  }
  const real = fs.realpathSync(probe);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new VaultPathError(`vault path '${relPath}' resolves outside the vault root`);
  }
  if (fs.existsSync(abs) && fs.lstatSync(abs).isSymbolicLink()) {
    throw new VaultPathError(`vault path '${relPath}' is a symlink — not an editable document`);
  }
  return abs;
}

// ── per-kind validation ───────────────────────────────────────────────────────

/**
 * Classify a (normalised) vault path into the kind whose rules govern it. SHELF-RELATIVE
 * (spec 062 SC 2): the per-shelf kinds (`memory`/`handoff`/`reference`/`curator`) are matched
 * BENEATH the shelf `prefix`. `primer.md` is a vault SINGLETON — recognised ONLY at the true
 * vault root, never `<prefix>primer.md` (a shelf has no primer of its own; "singletons pinned").
 * The EMPTY prefix strips nothing, so classification is byte-for-byte today's behaviour.
 */
export function vaultFileKind(relPath: string, prefix: string = ""): VaultFileKind {
  if (relPath === PRIMER_PATH) return "primer";
  const relative =
    prefix !== "" && relPath.startsWith(prefix) ? relPath.slice(prefix.length) : relPath;
  if (relative.startsWith(".curator/")) return "curator";
  if (relative.startsWith("memories/")) return "memory";
  if (relative.startsWith("handoffs/")) return "handoff";
  if (relative.startsWith("projects/")) return "project";
  if (relative.startsWith("project-updates/")) return "project-update";
  if (relative.startsWith("project-suggestions/")) return "project-suggestion";
  if (relative.startsWith("references/")) return "reference";
  return "other";
}

// The same anchored `## <heading>` rule schemas/handoff.ts enforces at the MCP
// boundary, reported per missing heading so the editor can show exactly what to add.
function missingHandoffHeadings(body: string): string[] {
  return HANDOFF_REQUIRED_HEADINGS.filter((heading) => {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp(`^## ${escaped}\\b`, "m").test(body);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function projectDocumentPathError(
  relPath: string,
  prefix: string,
  directory: string,
  id: string,
): string | null {
  const relative = prefix === "" ? relPath : relPath.slice(prefix.length);
  const expected = `${directory}/${id}.md`;
  if (relative === expected) return null;
  if (relative.split("/").length !== 2) {
    return `project documents must live directly under ${directory}/`;
  }
  return `project document filename must match immutable id '${id}' (expected '${expected}')`;
}

/**
 * Validate a document for its path's kind. Returns every problem found
 * ([] = valid). The write path REFUSES a document with any error — invalid
 * content never reaches the vault (spec §8: "reject with errors, never write
 * invalid").
 *
 *   memories/   must parse as a memory document (full frontmatter schema);
 *   handoffs/   must parse as a handoff document AND carry the five required
 *               `## ` headings in the body (the cross-repo contract);
 *   primer.md / .curator/*  must fit the 2 KB byte cap (spec §5.2 / 044 §7.1);
 *   references/ + anything else  lenient — any text is a valid document.
 *
 * SHELF-RELATIVE (spec 062 T3, the T2-flagged parameterisation): `prefix` classifies the path
 * BENEATH the shelf (via {@link vaultFileKind}), so `<prefix>memories/a.md` validates as a memory
 * and `<prefix>primer.md` is `other` (a shelf has no primer). The EMPTY prefix (default) is
 * byte-for-byte today's behaviour, so the existing 2-arg callers are unchanged.
 */
export function validateVaultFile(relPath: string, raw: string, prefix: string = ""): string[] {
  switch (vaultFileKind(relPath, prefix)) {
    case "memory": {
      try {
        parseMemoryDocument(raw);
        return [];
      } catch (error) {
        return [errorMessage(error)];
      }
    }
    case "handoff": {
      const errors: string[] = [];
      let body = raw;
      try {
        body = parseHandoffDocument(raw).document_md;
      } catch (error) {
        errors.push(errorMessage(error));
        try {
          body = matter(raw).content; // still report missing headings when only frontmatter is bad
        } catch {
          // keep raw — the heading scan tolerates frontmatter noise
        }
      }
      for (const heading of missingHandoffHeadings(body)) {
        errors.push(`document body is missing the required heading '## ${heading}'`);
      }
      return errors;
    }
    case "project": {
      try {
        const project = parseProjectDocument(raw);
        const pathError = projectDocumentPathError(relPath, prefix, "projects", project.id);
        return pathError === null ? [] : [pathError];
      } catch (error) {
        return [errorMessage(error)];
      }
    }
    case "project-update": {
      try {
        const update = parseProjectUpdateDocument(raw);
        const pathError = projectDocumentPathError(relPath, prefix, "project-updates", update.id);
        return pathError === null ? [] : [pathError];
      } catch (error) {
        return [errorMessage(error)];
      }
    }
    case "project-suggestion": {
      try {
        const suggestion = parseProjectSuggestionDocument(raw);
        const pathError = projectDocumentPathError(
          relPath,
          prefix,
          "project-suggestions",
          suggestion.id,
        );
        return pathError === null ? [] : [pathError];
      } catch (error) {
        return [errorMessage(error)];
      }
    }
    case "primer":
    case "curator": {
      const cap =
        vaultFileKind(relPath, prefix) === "primer" ? PRIMER_MAX_BYTES : ADDENDUM_MAX_BYTES;
      const bytes = Buffer.byteLength(raw, "utf8");
      return bytes > cap ? [`must be ≤ ${cap} bytes (~2 KB); got ${bytes} bytes`] : [];
    }
    default:
      return []; // references + plain files: any text is valid
  }
}

// ── the store ─────────────────────────────────────────────────────────────────

function sha256(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function stemOf(relPath: string): string {
  return (relPath.split("/").pop() ?? "").replace(/\.md$/, "");
}

export function createVaultFileStore(deps: VaultFileStoreDeps): VaultFileStore {
  const { vault } = deps;
  const onWrite = deps.onWrite ?? (() => {});
  // The shelf prefix this store is scoped to (spec 062 T3). "" = the whole vault (default):
  // every rule below reduces to today's depth-0 behaviour byte-for-byte.
  const prefix = deps.prefix ?? "";
  // The shelf's structural root + its full-path stem, for the scoped explorer tree. For the
  // empty prefix these are the true vault root + "" — the unchanged whole-vault tree.
  const shelfRoot = prefix === "" ? vault.root : path.join(vault.root, prefix);
  const shelfRelDir = prefix === "" ? "" : prefix.slice(0, -1);

  /** Is this listing-supplied path part of the visible explorer surface (within this shelf)? */
  function isVisiblePath(relPath: string): boolean {
    try {
      assertVaultFilePath(relPath, prefix);
      return true;
    } catch {
      return false;
    }
  }

  /** Validate the path AND its on-disk resolution; returns the normalised rel path. */
  function checkPath(relPath: string): string {
    const normalised = assertVaultFilePath(relPath, prefix);
    assertResolvesInsideRoot(vault.root, normalised);
    return normalised;
  }

  /** Mutations may only touch markdown documents. */
  function checkEditablePath(relPath: string): string {
    const normalised = checkPath(relPath);
    if (!normalised.endsWith(".md")) {
      throw new VaultPathError(`vault path '${relPath}' must be a .md document`);
    }
    return normalised;
  }

  function requireExisting(relPath: string): string {
    const abs = path.resolve(vault.root, relPath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new VaultFileNotFoundError(`vault: no document at '${relPath}'`);
    }
    return abs;
  }

  function assertValid(relPath: string, raw: string): void {
    const errors = validateVaultFile(relPath, raw, prefix);
    if (errors.length > 0) throw new VaultValidationError(relPath, errors);
  }

  /**
   * Re-stamp `updated_by` from the RESOLVED actor on a memory-file write (spec 064 F4). The vault
   * editor writes raw bytes, so a memory saved with `updated_by: "someone-else"` would otherwise
   * persist a false last-writer verbatim (the memory-VERB path already stamps it from the actor).
   * Runs only for memory-kind files (their content already parsed as a memory doc — `assertValid`
   * ran, so this never throws) and re-serialises canonically: a trailer-eligible actor overwrites
   * the claim, an anonymous write STRIPS it (a false name is worse than an honest null). Non-memory
   * files (references, curator, primer, plain) are returned untouched.
   */
  function restampMemoryWrite(relPath: string, raw: string, actorId?: string): string {
    if (vaultFileKind(relPath, prefix) !== "memory") return raw;
    const writer = actorTrailerValue(actorId);
    const memory = parseMemoryDocument(raw);
    const current = memory.updated_by;
    // Leave the caller's bytes UNTOUCHED unless `updated_by` must actually change: an anonymous
    // write with no claimed writer (nothing to forge), or a write whose claim already IS the
    // resolved actor. This keeps the vault editor a faithful round-trip for the common case and
    // re-serialises canonically only when it must overwrite (a false claim) or strip (an anonymous
    // write that carries one).
    if (writer === undefined && current === undefined) return raw;
    if (writer !== undefined && current === writer) return raw;
    const { updated_by: _dropped, ...rest } = memory;
    return serializeMemoryDocument(writer !== undefined ? { ...rest, updated_by: writer } : rest);
  }

  // The link index is rebuilt per query — same disposable posture as every
  // other vault-derived structure; the explorer's read volume is human-scale.
  function linkIndex(): VaultLinkIndex {
    return buildVaultLinkIndex(vault, { include: isVisiblePath });
  }

  function requireHistory(): GitHistory {
    if (!deps.history) {
      throw new Error(
        "vault history is unavailable: this store was created without a git history reader",
      );
    }
    return deps.history;
  }

  /**
   * The file's content at `hash`, rename-aware: address the blob directly
   * first, and when that misses (the commit predates a rename) look the
   * commit up in the file's --follow history and use the path it had there.
   */
  function contentAtCommit(rel: string, hash: string): { path: string; content: string } {
    const history = requireHistory();
    const direct = history.fileAtCommit(rel, hash);
    if (direct !== null) return { path: rel, content: direct };
    const entry = findHistoryEntry(history.fileHistory(rel), hash);
    if (entry && entry.path !== rel) {
      // Defensive: the historic path came out of git, but it still must be a
      // vault document path (within this shelf) before we address content by it.
      const pastRel = assertVaultFilePath(entry.path, prefix);
      const past = history.fileAtCommit(pastRel, hash);
      if (past !== null) return { path: pastRel, content: past };
    }
    throw new VaultFileNotFoundError(
      `'${rel}' has no content at commit ${hash} — pick a commit from the file's history`,
    );
  }

  function buildTree(absDir: string, relDir: string, depth: number): VaultTreeNode[] {
    const nodes: VaultTreeNode[] = [];
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (!isVisibleSegment(entry.name, depth)) continue;
      const abs = path.join(absDir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        nodes.push({
          name: entry.name,
          path: rel,
          type: "dir",
          children: buildTree(abs, rel, depth + 1),
        });
      } else if (entry.isFile()) {
        nodes.push({
          name: entry.name,
          path: rel,
          type: "file",
          mtime: fs.statSync(abs).mtime.toISOString(),
        });
      }
      // Symlinks and other specials are plumbing, not documents — skipped.
    }
    return nodes.sort(
      (a, b) =>
        Number(a.type === "file") - Number(b.type === "file") ||
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );
  }

  return {
    // Scoped to the shelf: the tree walks BENEATH `<prefix>` with depth-0 rules re-anchored at
    // the shelf root (so `<prefix>inbox` is hidden, `<prefix>.curator` visible), and node paths
    // stay FULL vault-relative. For the empty prefix this is the unchanged whole-vault tree.
    tree: () => (fs.existsSync(shelfRoot) ? buildTree(shelfRoot, shelfRelDir, 0) : []),

    readFile: (relPath) => {
      const rel = checkPath(relPath);
      const abs = requireExisting(rel);
      const raw = fs.readFileSync(abs, "utf8");
      // Lenient on read: the explorer must render whatever is there (a file the
      // dashboard can't parse is exactly the file the admin needs to open).
      let frontmatter: Record<string, unknown> | null = null;
      let body = raw;
      try {
        const parsed = matter(raw);
        frontmatter = Object.keys(parsed.data).length > 0 ? coerceDates(parsed.data) : null;
        body = parsed.content;
      } catch {
        // unparseable frontmatter — show the raw text as the body
      }
      return {
        path: rel,
        kind: vaultFileKind(rel, prefix),
        raw,
        body,
        frontmatter,
        hash: sha256(raw),
        mtime: fs.statSync(abs).mtime.toISOString(),
      };
    },

    resolveLink: (target) => linkIndex().resolve(target),
    backlinks: (relPath) => linkIndex().backlinks(checkPath(relPath)),
    outboundLinks: (relPath) => linkIndex().outbound(checkPath(relPath)),

    writeFile: (relPath, raw, options = {}, actorId) => {
      const rel = checkEditablePath(relPath);
      const abs = requireExisting(rel);
      assertValid(rel, raw);
      if (options.expectedHash !== undefined) {
        const current = sha256(fs.readFileSync(abs, "utf8"));
        if (current !== options.expectedHash) {
          throw new VaultWriteConflictError(
            `'${rel}' changed since you loaded it — reload the file and reapply your edit (its content no longer matches the version you started from)`,
          );
        }
      }
      // Re-stamp `updated_by` from the resolved actor for a memory write (spec 064 F4), then commit
      // the stamped bytes; the returned hash is of what was ACTUALLY written (the next
      // compare-and-swap reads it back).
      const written = restampMemoryWrite(rel, raw, actorId);
      vault.writeText(rel, written);
      deps.commit([rel], commitSubject.vaultEdit(rel), actorId);
      onWrite(rel);
      return { hash: sha256(written) };
    },

    createFile: (relPath, raw, actorId) => {
      const rel = checkEditablePath(relPath);
      if (vault.exists(rel)) {
        throw new VaultFileExistsError(`'${rel}' already exists — edit it instead`);
      }
      assertValid(rel, raw);
      const written = restampMemoryWrite(rel, raw, actorId); // spec 064 F4 (memory files only)
      vault.writeText(rel, written);
      deps.commit([rel], commitSubject.vaultCreate(rel), actorId);
      onWrite(rel);
      return { hash: sha256(written) };
    },

    renameFile: (fromRel, toRel, actorId) => {
      const from = checkEditablePath(fromRel);
      const to = checkEditablePath(toRel);
      requireExisting(from);
      if (vault.exists(to)) {
        throw new VaultFileExistsError(`'${to}' already exists — pick another name`);
      }
      vault.moveFile(from, to);
      // Wikilink integrity (spec §8): links addressing the file by its old
      // filename stem are rewritten to the new stem vault-wide (the surgical
      // renameWikilinkTarget — relinkVault's engine — applied to the raw text,
      // since explorer files need not satisfy the corpus-minimal frontmatter
      // relinkVault's document round-trip demands); id/title/alias links live
      // in the file's own frontmatter and keep resolving unchanged.
      const fromStem = stemOf(from);
      const toStem = stemOf(to);
      const changedLinks: string[] = [];
      if (fromStem !== toStem) {
        for (const rel of vault.listMarkdown()) {
          if (!isVisiblePath(rel)) continue;
          const raw = vault.readText(rel);
          const next = renameWikilinkTarget(raw, fromStem, toStem);
          if (next === raw) continue;
          vault.writeText(rel, next);
          changedLinks.push(rel);
        }
      }
      // The commit is scoped to EVERY path the rename touched — the source (deleted), the
      // destination (added), and every file whose wikilinks were rewritten — so a
      // concurrent foreign edit to any OTHER file cannot ride in (spec 064 SC 1).
      deps.commit([from, to, ...changedLinks], commitSubject.vaultRename(from, to), actorId);
      for (const touched of new Set([from, to, ...changedLinks])) onWrite(touched);
      return { path: to, changedLinks };
    },

    deleteFile: (relPath, actorId) => {
      const rel = checkEditablePath(relPath);
      requireExisting(rel);
      vault.removeFile(rel);
      deps.commit([rel], commitSubject.vaultDelete(rel), actorId);
      onWrite(rel);
    },

    // ── history / diff / restore (rethink T20, spec §8 / D16) ────────────────

    fileHistory: (relPath) => {
      // checkPath only (no existence check): a deleted file's history is the
      // recovery path, and restoreFileVersion below can resurrect it.
      return requireHistory().fileHistory(checkPath(relPath));
    },

    fileAtCommit: (relPath, hash) => {
      const rel = checkPath(relPath);
      const at = contentAtCommit(rel, hash);
      return { path: at.path, hash, content: at.content };
    },

    fileDiff: (relPath, range = {}) => {
      const rel = checkPath(relPath);
      const history = requireHistory();
      // Rename-awareness: when the older side predates a rename, hand the
      // diff the path the file had there so the change isn't a blind spot.
      const fromEntry =
        range.from === undefined ? null : findHistoryEntry(history.fileHistory(rel), range.from);
      // Defensive, mirroring contentAtCommit: the historic path came out of
      // git, but it must still be a vault document path before it reaches
      // argv (even pathspec position is not a place for plumbing paths).
      const fromPath =
        fromEntry && fromEntry.path !== rel ? assertVaultFilePath(fromEntry.path, prefix) : null;
      return history.fileDiff(rel, {
        ...(range.from !== undefined ? { from: range.from } : {}),
        ...(range.to !== undefined ? { to: range.to } : {}),
        ...(fromPath !== null ? { fromPath } : {}),
      });
    },

    restoreFileVersion: (relPath, hash, actorId) => {
      const rel = checkEditablePath(relPath);
      const { content } = contentAtCommit(rel, hash);
      const errors = validateVaultFile(rel, content, prefix);
      if (errors.length > 0) {
        // Teaching refusal (spec §8): an old version that predates the current
        // rules must be brought forward by hand, never written invalid.
        const refusal = new VaultValidationError(rel, errors);
        refusal.message =
          `'${rel}' was not restored: that version no longer passes ${vaultFileKind(rel, prefix)} ` +
          `validation (${errors.join("; ")}). Open the file in the editor and bring the old ` +
          `content forward manually instead.`;
        throw refusal;
      }
      // The same write path as every other mutation: a NEW commit at the head
      // of history (never a rewrite), index invalidated via onWrite. Also
      // resurrects a since-deleted file — writeText recreates it.
      // Re-stamp `updated_by` from the resolved actor (spec 064 F4): a restored memory file must not
      // resurrect a stale historical last-writer — the restorer is the last writer now (the commit
      // trailer already names them). Memory files only; a reference/curator file passes through
      // untouched. `content` already passed validation above, so this never throws.
      const written = restampMemoryWrite(rel, content, actorId);
      vault.writeText(rel, written);
      deps.commit([rel], commitSubject.vaultRestoreFile(rel, hash), actorId);
      onWrite(rel);
      return { hash: sha256(written) };
    },
  };
}

/** The --follow history entry for `hash` (full or unambiguous-prefix match). */
function findHistoryEntry(history: FileCommit[], hash: string): FileCommit | null {
  const needle = hash.toLowerCase();
  return history.find((entry) => entry.hash.toLowerCase().startsWith(needle)) ?? null;
}

function coerceDates(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}
