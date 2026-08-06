// Vault-set routing seam (spec 062, ADR 0011 Decision 3/5) — the "which shelves does
// this principal see, and where do writes land?" contract.
//
// A SHELF is a rooted prefix inside the ONE vault git repo (ADR 0011 Decision 5): the
// OSS default is the empty prefix (the vault root); a member-aware overlay maps a
// principal to an ordered set (a personal shelf + a read-only team shelf, say). This
// module owns the seam TYPES (Shelf / ShelfOp / VaultRouter), the inert OSS DEFAULT
// router, and the prefix rules (validateShelfSet). It lives in core — next to
// caller-identity, whose Principal it consumes and which the store also consumes —
// because the STORE is the consumer of routing; mcp-server re-exports the types through
// the `@librarian/mcp-server/extension` entrypoint (mirroring Principal's placement).
//
// This module is pure: no I/O, no store access — the same posture as caller-identity.
//
// At spec 062 T1 the store STORES a router but reads it for NO decision yet (everything
// still hard-paths internally); the shelf-scoped routing behaviour lands in later 062
// tasks.

import type { Principal } from "./caller-identity.js";
import { CANONICAL_TOP_LEVEL } from "./store/vault-files.js";

/**
 * One shelf: a rooted prefix inside the single vault repo (ADR 0011 Decision 5), plus its
 * identity and write-eligibility. `prefix` is vault-relative, forward-slash, and — when
 * non-empty — ends in a trailing slash (`members/x/`); the EMPTY prefix is the vault root
 * (the OSS default). `id` is a stable, non-empty handle (recall labels every hit with it,
 * spec 062 SC 5). `writable` gates principal-attributed writes (a read-only team shelf sets
 * it false; the write-time refusal is spec 062 T3). `label` is optional plugin-authored
 * display text — the id is always present because labels are renamable.
 *
 * Field / `readonly` idioms mirror {@link Principal}: individual fields are NOT `readonly`;
 * immutability is expressed at the seam via `readonly Shelf[]` returns on {@link VaultRouter}.
 */
export interface Shelf {
  id: string;
  prefix: string;
  writable: boolean;
  label?: string;
}

/**
 * The operation a shelf set is being resolved FOR (spec 062 SC 2). A router MAY return a
 * different, ordered set per op — e.g. a principal recalls across [personal, team] but
 * writes only to personal. {@link SHELF_OPS} enumerates the set.
 */
export type ShelfOp = "recall" | "search" | "write" | "groom";

/** The canonical {@link ShelfOp} set (the "default op set", spec 062 SC 2). */
export const SHELF_OPS: readonly ShelfOp[] = ["recall", "search", "write", "groom"];

/**
 * The vault-routing seam (spec 062 SC 2, ADR 0011 Decision 3). One router answers, for a
 * {@link Principal}: which shelves does it see (ordered, first = highest precedence) for a
 * given {@link ShelfOp}, and where do its principal-attributed writes land? A plugin
 * REPLACES the OSS {@link defaultVaultRouter} through the 060 factory; two plugins supplying
 * one is a boot error (providers replace, registrations add — ADR 0011 Decision 3).
 *
 * `writeTarget` governs PRINCIPAL-ATTRIBUTED writes ONLY — the system pipelines (grooming,
 * intake) get shelf scope a different way (a shelf-scoped store handle, spec 062 SC 7-8), NOT
 * through `writeTarget`. A router that forced both jobs through one function could not satisfy
 * SC 6 and SC 7 together (spec 062 §4 key decision).
 */
export interface VaultRouter {
  /** The shelves this principal sees for `op`, ordered (first = highest precedence). */
  shelves(principal: Principal, op: ShelfOp): readonly Shelf[];
  /** Where this principal's new, self-attributed material lands. */
  writeTarget(principal: Principal): Shelf;
}

/**
 * A principal-attributed write was routed to a shelf that forbids it (spec 062 SC 6). Thrown
 * when {@link VaultRouter.writeTarget} resolves to a `writable: false` shelf, and when a write
 * is attempted through a shelf-scoped store handle bound to a read-only shelf. Named export so
 * the MCP / tRPC boundaries can recognise it and surface a clean error rather than a crash.
 */
export class ShelfNotWritableError extends Error {
  /** The offending (read-only) shelf. */
  readonly shelf: Shelf;
  constructor(shelf: Shelf) {
    super(
      `shelf "${shelf.id}" (prefix "${shelf.prefix}") is read-only — principal-attributed ` +
        `writes are refused`,
    );
    this.name = "ShelfNotWritableError";
    this.shelf = shelf;
  }
}

/**
 * {@link VaultRouter.writeTarget} returned a shelf that is NOT a member of the principal's
 * `shelves(principal, "write")` set (spec 062 SC 6, the honest write-routing semantics decided
 * at T3). `writeTarget` answers "where does this principal's new material land?" — that shelf
 * MUST be one the principal may write to for the `write` op, or the two axes disagree and the
 * router is mis-specified. Named export for boundary recognition.
 */
export class ShelfNotInWriteSetError extends Error {
  /** The writeTarget shelf that was absent from the write-op set. */
  readonly shelf: Shelf;
  /** The `shelves(principal, "write")` set it should have belonged to. */
  readonly writeShelves: readonly Shelf[];
  constructor(shelf: Shelf, writeShelves: readonly Shelf[]) {
    super(
      `writeTarget shelf "${shelf.id}" (prefix "${shelf.prefix}") is not among the principal's ` +
        `write shelves [${writeShelves.map((s) => s.id).join(", ")}] — writeTarget must be one of ` +
        `shelves(principal, "write")`,
    );
    this.name = "ShelfNotInWriteSetError";
    this.shelf = shelf;
    this.writeShelves = writeShelves;
  }
}

/** The single shelf the OSS default maps every principal + op to: the vault root, writable. */
export const DEFAULT_SHELF: Shelf = { id: "main", prefix: "", writable: true };

// The default router's static shelf set — principal- AND op-independent, so it is
// well-defined with no principal (unlike a supplied router). Frozen so the shared reference
// cannot be mutated by a consumer.
const DEFAULT_SHELVES: readonly Shelf[] = Object.freeze([DEFAULT_SHELF]);

/**
 * The inert OSS default router (spec 062 SC 2/T1): ONE writable shelf at the vault root, for
 * every principal and every op; `writeTarget` returns it. This reproduces today's
 * single-vault behaviour byte-for-byte — nothing about it makes a memory cross a shelf
 * boundary.
 */
export const defaultVaultRouter: VaultRouter = {
  shelves: () => DEFAULT_SHELVES,
  writeTarget: () => DEFAULT_SHELF,
};

/**
 * Validate a materialised shelf set against the prefix rules (spec 062 SC 2). Throws a
 * boot / first-use `Error` naming the offending shelf(s) on any violation; returns void on a
 * clean set. Pure + deterministic.
 *
 * WHERE this runs (the honest validation point, spec 062 T1): a {@link VaultRouter} is a
 * FUNCTION of the principal, so its result cannot be validated at boot without inventing a
 * representative principal — which would validate a fiction. So the 060 factory applies this to
 * the OSS DEFAULT router's static (principal-independent) result at boot, and the store applies
 * it to whatever a SUPPLIED router materialises at runtime — cheap, deterministic, catching a
 * violation at first use. (The store's runtime application arrives with the shelf-scoped
 * read/write paths in later 062 tasks; at T1 the store holds a router inert.)
 *
 * Per-shelf rules: `id` non-empty; and, for a NON-empty `prefix` — forward-slash, no leading
 * slash / drive letter, a required trailing slash, no empty / `.` / `..` segments, NFC-normalised
 * (a non-NFC prefix is REFUSED, never silently rewritten — this validator returns void, so
 * rewriting would desync the prefix the router declared from the one the store uses), and a first
 * segment that does not shadow a canonical top-level name (the real {@link CANONICAL_TOP_LEVEL}
 * list, including memories, handoffs, projects, project evidence, references and vault
 * plumbing). The EMPTY prefix is the vault root and is exempt from the syntax rules.
 *
 * Cross-set rules: prefixes are DISJOINT — no duplicates and no nesting (`team/` vs `team/sub/`,
 * and the empty root prefix nests every other) — and the ids of WRITABLE shelves are unique (so
 * {@link VaultRouter.writeTarget}'s shelf is unambiguously identifiable). A NON-writable shelf is
 * a legal set member; whether `writeTarget` may return one is a runtime write-semantics concern
 * (spec 062 T3), not a shelf-set rule, so it is not checked here.
 */
export function validateShelfSet(shelves: readonly Shelf[]): void {
  for (const shelf of shelves) validateShelf(shelf);
  assertDisjointPrefixes(shelves);
  assertUniqueWritableIds(shelves);
}

/** Per-shelf id + prefix-syntax + canonical-shadowing rules (spec 062 SC 2). */
function validateShelf(shelf: Shelf): void {
  if (shelf.id.trim() === "") {
    throw new Error(`shelf id must be non-empty (prefix "${shelf.prefix}")`);
  }
  // Id charset (review G1): the id renders inside a bracketed recall provenance token —
  // `[<label> (<id>)]` — so a `]` or a newline in it could break the token or inject a line into
  // the recall text. Constrain it to printable, `]`-free, newline-free text; `/` stays legal (ids
  // like `members/x` are the specced shape). Labels are plugin-authored, renamable text and are NOT
  // constrained here — the recall formatter strips `]`/newlines from them at render instead.
  if (shelf.id.includes("]") || /\p{Cc}/u.test(shelf.id)) {
    throw new Error(
      `shelf id "${shelf.id}" must be printable with no ']' or newline — it renders inside a ` +
        `"[label (id)]" recall provenance token (prefix "${shelf.prefix}")`,
    );
  }
  if (shelf.label !== undefined && shelf.label.trim() === "") {
    throw new Error(
      `shelf "${shelf.id}" (prefix "${shelf.prefix}"): label must contain visible text when supplied`,
    );
  }
  const { prefix } = shelf;
  if (prefix === "") return; // the vault root (OSS default) — exempt from the syntax rules

  const where = `shelf "${shelf.id}" (prefix "${prefix}")`;
  if (prefix.includes("\\")) {
    throw new Error(`${where}: prefix must use forward slashes, not backslashes`);
  }
  if (prefix.startsWith("/") || /^[A-Za-z]:/.test(prefix)) {
    throw new Error(`${where}: prefix must be relative — no leading slash or drive letter`);
  }
  if (!prefix.endsWith("/")) {
    throw new Error(`${where}: a non-empty prefix must end with a trailing slash`);
  }
  if (prefix.normalize("NFC") !== prefix) {
    throw new Error(`${where}: prefix must be NFC-normalised`);
  }
  // Drop the (required) trailing slash before splitting, so a clean `team/` → ["team"] and a
  // double slash `team//sub/` → ["team", "", "sub"] surfaces the empty middle segment.
  const segments = prefix.slice(0, -1).split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error(`${where}: prefix must not contain empty, '.' or '..' segments`);
    }
  }
  // Depth cap (review B / new documented rule): shelf prefixes are capped at MAX_SHELF_PREFIX_SEGMENTS
  // segments. `members/x/` (two segments) is the deepest shape the spec names; a legal-but-deeper
  // prefix would back up fine yet be UNRESTORABLE, because the restore stager's vault-detection scan
  // is bounded to the same depth. Capping here keeps the two aligned BY CONSTRUCTION (widening later
  // is a deliberate, coordinated change to both).
  if (segments.length > MAX_SHELF_PREFIX_SEGMENTS) {
    throw new Error(
      `${where}: prefix is ${segments.length} segments deep — shelf prefixes are capped at ` +
        `${MAX_SHELF_PREFIX_SEGMENTS} segments ("members/x/" is the deepest specced shape; the ` +
        `restore stager's vault-detection scan is aligned to this cap)`,
    );
  }
  const first = segments[0];
  if (first !== undefined && CANONICAL_TOP_LEVEL.has(first.toLowerCase())) {
    const canonical = CANONICAL_TOP_LEVEL.get(first.toLowerCase()) ?? first;
    throw new Error(
      `${where}: prefix's first segment "${first}" shadows the canonical top-level name ` +
        `"${canonical}" (canonical document directories and vault plumbing are reserved)`,
    );
  }
}

/**
 * The maximum number of path segments in a non-empty shelf prefix (review B). `members/x/` (2) is the
 * deepest specced shape; the restore stager's vault-detection scan is bounded to the same depth so a
 * backed-up shelf tree is always restorable. Widening this is a deliberate change that must move the
 * restore scan's bound with it.
 */
export const MAX_SHELF_PREFIX_SEGMENTS = 2;

/**
 * Is `segment` a legal shelf-prefix path segment (review B — the shared segment predicate the restore
 * stager reuses so its shelf-tree scan matches {@link validateShelf} exactly)? Empty / `.` / `..` /
 * non-NFC segments are always illegal; `isFirst` gates the canonical-shadow rule, which — matching
 * {@link validateShelf} — applies only to the FIRST segment (so `members/inbox/` is legal but a
 * top-level `inbox/` shelf is not).
 */
export function isLegalShelfSegment(segment: string, isFirst: boolean): boolean {
  if (segment === "" || segment === "." || segment === "..") return false;
  if (segment.normalize("NFC") !== segment) return false;
  if (isFirst && CANONICAL_TOP_LEVEL.has(segment.toLowerCase())) return false;
  return true;
}

/** No two shelf prefixes may duplicate or nest (spec 062 SC 2). */
function assertDisjointPrefixes(shelves: readonly Shelf[]): void {
  for (let i = 0; i < shelves.length; i++) {
    for (let j = i + 1; j < shelves.length; j++) {
      const a = shelves[i];
      const b = shelves[j];
      if (a === undefined || b === undefined) continue;
      // Compare CASE-INSENSITIVELY (review G3), mirroring the canonical-shadow precedent
      // (validateShelf lowercases before the CANONICAL_TOP_LEVEL check): on a case-insensitive
      // filesystem `Team/` and `team/` are the SAME directory, so a case-only difference is a
      // duplicate/nesting on disk and must be refused, not silently treated as disjoint.
      const ap = a.prefix.toLowerCase();
      const bp = b.prefix.toLowerCase();
      if (ap === bp) {
        throw new Error(
          `shelves "${a.id}" and "${b.id}" share the prefix "${a.prefix}" (case-insensitively) — ` +
            `shelf prefixes must be unique`,
        );
      }
      // Non-empty prefixes end in "/" and the empty prefix is the root, so a bare `startsWith`
      // is exactly path-subtree containment (`team/` vs `teams/` correctly does NOT nest).
      const nesting = ap.startsWith(bp)
        ? { outer: b, inner: a }
        : bp.startsWith(ap)
          ? { outer: a, inner: b }
          : null;
      if (nesting !== null) {
        throw new Error(
          `shelf "${nesting.inner.id}" (prefix "${nesting.inner.prefix}") is nested under shelf ` +
            `"${nesting.outer.id}" (prefix "${nesting.outer.prefix}") — shelf prefixes must be ` +
            `disjoint`,
        );
      }
    }
  }
}

/** Writable shelves must be unambiguously identifiable (spec 062 SC 2, for `writeTarget`). */
function assertUniqueWritableIds(shelves: readonly Shelf[]): void {
  const seen = new Set<string>();
  for (const shelf of shelves) {
    if (!shelf.writable) continue;
    if (seen.has(shelf.id)) {
      throw new Error(
        `two writable shelves share the id "${shelf.id}" — writable shelf ids must be unique ` +
          `(writeTarget must resolve to one identifiable shelf)`,
      );
    }
    seen.add(shelf.id);
  }
}
