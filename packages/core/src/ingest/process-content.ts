// Process a `content` capture into a vault reference (ingest spec Task 4;
// criteria 11–15; decisions D5/D6/D8/D11/D13).
//
// This is the keystone WRITE path for the browser-extension capture: the body
// `{ content, url, title, via }` already carries pre-extracted markdown, so
// there is no fetch — we slug a path, dedup against the ingest log, write the
// reference (frontmatter + body) through the SAME committing vault-file store
// the dashboard uses, and flip the pending log row to success/failed.
//
// It runs in the BACKGROUND, after /ingest has already returned its 202 (D22),
// so it is written to be fail-soft and unit-testable in isolation: it never
// throws (every failure is caught and recorded via `markFailed`), and it takes
// a plain store + body + log-id with no HTTP in sight.

import { createHash } from "node:crypto";
import { stringifyFrontmatter } from "../safe-frontmatter.js";
import {
  type VaultFileStore,
  VaultFileExistsError,
  VaultFileNotFoundError,
} from "../store/vault-files.js";
import { type IngestVia, lookupByUrl, markFailed, markSuccess } from "./ingest-log.js";

/**
 * The slice of a `LibrarianStore` this processor needs: the committing
 * vault-file writer (create/write) and the settings-backed ingest-log methods
 * (`lookupByUrl`/`markSuccess`/`markFailed` read+write rows). A full
 * `LibrarianStore` satisfies it structurally, so the route passes its store
 * straight through; a unit test can pass a real temp-dir store.
 */
export interface ContentCaptureStore {
  vaultFiles: Pick<VaultFileStore, "createFile" | "writeFile">;
  setSetting: (key: string, value: string, options?: { secret?: boolean }) => void;
  getSetting: (key: string) => string | null;
  listSettings: () => { key: string }[];
}

/** A `content`-branch capture: pre-extracted markdown plus its source metadata. */
export interface ContentCaptureInput {
  /** The pre-extracted markdown body (the reference's content). */
  content: string;
  /** The source URL — the dedup key (D11) and the frontmatter `source` (D13). */
  url?: string;
  /** Human title; the slug + frontmatter `title` derive from it (D8/D13). */
  title?: string;
  /** Which client produced the capture (D13 frontmatter `via`). */
  via: IngestVia;
  /** Optional extracted metadata (D13) — included in frontmatter when present. */
  site?: string;
  byline?: string;
}

/** The outcome of a capture, returned for tests + the route's defensive logging. */
export interface ContentCaptureResult {
  status: "success" | "failed";
  /** The vault path written (success only). */
  path?: string;
  /** A teaching failure message (failed only). */
  error?: string;
}

/**
 * Derive a filesystem-safe slug from a title (D8): lowercase, accents folded,
 * any run of non-alphanumerics collapsed to a single `-`, trimmed, bounded.
 * An empty / unicode-only title (all-emoji, all-CJK) collapses to nothing and
 * MUST fall back to `untitled` (criterion 14) — never yield `web/<date>-.md`.
 */
export function slugifyTitle(title: string | undefined): string {
  const slug = (title ?? "")
    .normalize("NFKD") // fold accents: "café" → "cafe"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // every non-alphanumeric run → one hyphen
    .replace(/^-+|-+$/g, "") // trim leading/trailing hyphens
    .slice(0, 80);
  // A trailing hyphen can reappear after the slice; trim once more.
  return slug.replace(/-+$/, "") || "untitled";
}

/**
 * A short, DETERMINISTIC disambiguator for a same-day slug collision between
 * DIFFERENT sources (D8): 6 hex of a SHA-256 over the source string. Two
 * distinct URLs slug-colliding on the same day get distinct suffixes; the same
 * source always maps to the same suffix.
 */
function collisionSuffix(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 6);
}

/**
 * Render the reference's on-disk text: D13 frontmatter (`title`, `source`,
 * `captured_at`, `via`, plus optional `site`/`byline`) over the captured
 * markdown body. References carry no REQUIRED frontmatter and are chunk-searched
 * by body, so this is lenient gray-matter output, not the strict corpus schema.
 */
function renderReference(input: ContentCaptureInput, capturedAt: string): string {
  const data: Record<string, unknown> = {
    title: input.title?.trim() || "Untitled",
  };
  if (input.url?.trim()) data.source = input.url.trim();
  data.captured_at = capturedAt;
  data.via = input.via;
  if (input.site?.trim()) data.site = input.site.trim();
  if (input.byline?.trim()) data.byline = input.byline.trim();
  return stringifyFrontmatter(`\n${input.content.trim()}\n`, data);
}

/**
 * Write a `content` capture to the vault as a reference and record the outcome
 * on its ingest-log row. Pure enough to unit-test directly (no HTTP). Fail-soft:
 * any error is caught, recorded via `markFailed`, and returned — never thrown.
 *
 * Dedup + atomicity (D6/D11, criteria 12/13):
 *   - a known URL (prior success) overwrites that EXACT path, keeping its
 *     original date prefix and refreshing the content + `captured_at`;
 *   - an unknown URL mints `references/web/<YYYY-MM-DD>-<slug>.md`;
 *   - a same-day slug collision with a DIFFERENT source appends a deterministic
 *     `-<6hex>` suffix. Create is atomic (the store throws CONFLICT on
 *     create-over-existing), so two concurrent captures can't clobber.
 */
export async function processContentCapture(
  store: ContentCaptureStore,
  input: ContentCaptureInput,
  id: string,
): Promise<ContentCaptureResult> {
  try {
    const capturedAt = new Date().toISOString();
    const date = capturedAt.slice(0, 10); // YYYY-MM-DD
    const raw = renderReference(input, capturedAt);

    // Dedup-overwrite (D6/D11): a prior successful capture of the same
    // (normalized) URL → refresh that exact file in place.
    const existing = input.url?.trim() ? lookupByUrl(store, input.url.trim()) : null;
    if (existing) {
      writeOver(store, existing, raw);
      markSuccess(store, id, existing);
      return { status: "success", path: existing };
    }

    // Mint a fresh path; on a same-day slug collision with a different source,
    // append a deterministic suffix and retry. The create CONFLICT is the
    // concurrency guard — a racing capture that already took the base path makes
    // ours land on the suffixed path instead of silently overwriting it.
    const slug = slugifyTitle(input.title);
    const base = `references/web/${date}-${slug}.md`;
    try {
      store.vaultFiles.createFile(base, raw);
      markSuccess(store, id, base);
      return { status: "success", path: base };
    } catch (error) {
      if (!(error instanceof VaultFileExistsError)) throw error;
    }

    const suffix = collisionSuffix(input.url?.trim() || input.content);
    const suffixed = `references/web/${date}-${slug}-${suffix}.md`;
    try {
      store.vaultFiles.createFile(suffixed, raw);
    } catch (error) {
      // Same source colliding on the suffixed path too (e.g. a concurrent
      // re-capture of the exact same URL before its log row went green):
      // overwrite rather than fail — it is the same content.
      if (!(error instanceof VaultFileExistsError)) throw error;
      writeOver(store, suffixed, raw);
    }
    markSuccess(store, id, suffixed);
    return { status: "success", path: suffixed };
  } catch (error) {
    // Fail-soft (D22): record a redacted failure (markFailed redacts) and return
    // it; the background caller never sees a throw.
    const message = error instanceof Error ? error.message : String(error);
    markFailed(store, id, message);
    return { status: "failed", error: message };
  }
}

/**
 * Overwrite an existing reference, healing the rare case where the dedup index
 * points at a path whose file was deleted out from under us: `writeFile`
 * requires the file to exist, so fall back to `createFile` to recreate it at the
 * same path (keeping the original date prefix).
 */
function writeOver(store: ContentCaptureStore, relPath: string, raw: string): void {
  try {
    store.vaultFiles.writeFile(relPath, raw);
  } catch (error) {
    if (!(error instanceof VaultFileNotFoundError)) throw error;
    store.vaultFiles.createFile(relPath, raw);
  }
}
