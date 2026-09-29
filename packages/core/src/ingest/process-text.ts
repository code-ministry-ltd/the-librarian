// Process a `text` capture into a vault note reference (ingest spec Task 5;
// criterion 14-text; decisions D12/D15).
//
// A `text` capture is the share-sheet "raw note" path: the body is just
// `{ text: "<raw markdown/plain text>", via }` — no url, no title. So unlike the
// `content` branch (process-content.ts) there is:
//   - NO source URL → NO `source` frontmatter and NO dedup key, so a text note
//     is NEVER deduped — every capture mints a NEW file (D15);
//   - NO supplied title → the title (and slug) are DERIVED from the first
//     non-empty line of the text, with a `note-<date>` fallback when the text is
//     empty/whitespace or slugs to nothing (emoji/punctuation only).
//
// Like the content branch it runs in the BACKGROUND, after /ingest has returned
// its 202 (D22): fail-soft (never throws — every failure is caught and recorded
// via `markFailed`) and directly unit-testable (a plain store + body + log-id,
// no HTTP in sight).

import { randomBytes } from "node:crypto";
import { stringifyFrontmatter } from "../safe-frontmatter.js";
import { type VaultFileStore, VaultFileExistsError } from "../store/vault-files.js";
import { type IngestVia, markFailed, markSuccess } from "./ingest-log.js";
import { slugifyTitle } from "./process-content.js";

/**
 * The slice of a `LibrarianStore` this processor needs: the committing
 * vault-file CREATOR (a text note is only ever minted, never overwritten, so
 * `createFile` alone) plus the settings-backed ingest-log methods that
 * `markSuccess`/`markFailed` read+write. A full `LibrarianStore` satisfies it
 * structurally, so the route passes its store straight through; a unit test can
 * pass a real temp-dir store.
 */
export interface TextCaptureStore {
  vaultFiles: Pick<VaultFileStore, "createFile">;
  setSetting: (key: string, value: string, options?: { secret?: boolean }) => void;
  getSetting: (key: string) => string | null;
  listSettings: () => { key: string }[];
}

/** A `text`-branch capture: a raw note body plus which client produced it. */
export interface TextCaptureInput {
  /** The raw markdown / plain text — the note's body AND the title source. */
  text: string;
  /** Which client produced the capture (D13 frontmatter `via`). */
  via: IngestVia;
}

/** The outcome of a capture, returned for tests + the route's defensive logging. */
export interface TextCaptureResult {
  status: "success" | "failed";
  /** The vault path written (success only). */
  path?: string;
  /** A teaching failure message (failed only). */
  error?: string;
}

/** Max characters of the first line we keep as a title — long enough to be useful, short enough to stay a sane filename + heading. */
const MAX_TITLE_CHARS = 80;

/** Upper bound on same-day same-first-line collision retries before we give up (the random suffix space is 24-bit, so this is effectively unreachable — it only stops a pathological infinite loop). */
const MAX_COLLISION_RETRIES = 20;

/**
 * Derive a title from a raw text capture (D15): the FIRST non-empty line, with
 * leading markdown heading markers (`#`) stripped and truncated to a sane length.
 * Returns null when the text is empty/whitespace — the caller substitutes the
 * `note-<date>` fallback. Only the first line is used; the rest is the body.
 */
export function deriveTextTitle(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Strip a leading markdown ATX heading marker ("# ", "## ", …) so a note
    // pasted as "# My heading" titles as "My heading", not "# My heading".
    const stripped = trimmed.replace(/^#+\s*/, "").trim();
    const title = (stripped || trimmed).slice(0, MAX_TITLE_CHARS).trim();
    return title || null;
  }
  return null;
}

/**
 * Render the note's on-disk text: D13 frontmatter (`title`, `captured_at`,
 * `via`) over the raw text body. NO `source` field — a text capture has no URL
 * (the key difference from a `content` capture). References carry no REQUIRED
 * frontmatter and are chunk-searched by body, so this is lenient gray-matter
 * output, not the strict corpus schema.
 */
function renderNote(title: string, text: string, via: IngestVia, capturedAt: string): string {
  const data: Record<string, unknown> = {
    title,
    captured_at: capturedAt,
    via,
  };
  return stringifyFrontmatter(`\n${text.trim()}\n`, data);
}

/**
 * Write a `text` capture to the vault as a note reference and record the outcome
 * on its ingest-log row. Pure enough to unit-test directly (no HTTP). Fail-soft:
 * any error is caught, recorded via `markFailed`, and returned — never thrown.
 *
 * Naming + uniqueness (D15, criterion 14-text):
 *   - the title/slug come from the first non-empty line (heading markers
 *     stripped, truncated); empty/whitespace text or an all-emoji/punctuation
 *     first line falls back to `note-<YYYY-MM-DD>` — never a bare `<date>-.md`;
 *   - a text note is NEVER deduped (no URL key): every capture mints a NEW file
 *     at `references/web/<YYYY-MM-DD>-<slug>.md`. On a same-day slug collision —
 *     e.g. two notes whose first line is identical — append a short RANDOM
 *     suffix and retry the ATOMIC create, so the two notes get distinct paths
 *     and neither clobbers the other (the create CONFLICT is the guard).
 */
export async function processTextCapture(
  store: TextCaptureStore,
  input: TextCaptureInput,
  id: string,
): Promise<TextCaptureResult> {
  try {
    const capturedAt = new Date().toISOString();
    const date = capturedAt.slice(0, 10); // YYYY-MM-DD

    // Title/slug from the first non-empty line; fall back to `note-<date>` when
    // the text is empty/whitespace OR slugs to nothing (emoji/punctuation only),
    // so we never mint `references/web/<date>-.md`.
    const derived = deriveTextTitle(input.text);
    const fallback = `note-${date}`;
    const slugCandidate = derived ? slugifyTitle(derived) : fallback;
    // `slugifyTitle` returns "untitled" for an all-unicode/punctuation stem; for
    // a text note the agreed fallback is `note-<date>`, not "untitled".
    const useFallback = !derived || slugCandidate === "untitled";
    const title = useFallback ? fallback : derived;
    const slug = useFallback ? fallback : slugCandidate;

    const raw = renderNote(title, input.text, input.via, capturedAt);

    // Mint a fresh file — text captures NEVER dedup. On a same-day slug
    // collision, append a short random suffix and retry the atomic create; the
    // CONFLICT thrown by create-over-existing is what guarantees two same-day
    // notes with the same first line land on DISTINCT paths instead of one
    // silently overwriting the other.
    let target = `references/web/${date}-${slug}.md`;
    for (let attempt = 0; ; attempt++) {
      try {
        store.vaultFiles.createFile(target, raw);
        break;
      } catch (error) {
        if (!(error instanceof VaultFileExistsError)) throw error;
        if (attempt >= MAX_COLLISION_RETRIES) {
          throw new Error(
            `Could not mint a unique note path under references/web/${date}-${slug}- ` +
              `after ${MAX_COLLISION_RETRIES} attempts; too many same-day notes share this first line.`,
          );
        }
        const suffix = randomBytes(3).toString("hex"); // 6 hex chars
        target = `references/web/${date}-${slug}-${suffix}.md`;
      }
    }

    markSuccess(store, id, target);
    return { status: "success", path: target };
  } catch (error) {
    // Fail-soft (D22): record a redacted failure (markFailed redacts) and return
    // it; the background caller never sees a throw.
    const message = error instanceof Error ? error.message : String(error);
    markFailed(store, id, message);
    return { status: "failed", error: message };
  }
}
