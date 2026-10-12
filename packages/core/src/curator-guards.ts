// Curator guards (spec 075 §4, ADR 0015). Deterministic checks that run after
// the threshold has said "apply": a curator write that fails one is REFUSED —
// nothing is written and nothing is queued — and the curator gets the reason so
// it can choose a different operation. They never turn a refusal into an apply,
// and they never add a proposal (ADR 0014 stands: at threshold 0 nothing
// reaches a review queue).
//
// Why these two: on a real corpus, memories only grew (append-only augment, no
// cap — the largest reached 36,461 chars) and grooming merges kept only 41% of
// their sources' specific terms. A grab-bag past the grooming evidence window
// can never be split again (ADR 0013 refuses rewriting a body it can't see in
// full), so the size cap is the window itself.

/** The largest body a curator write may produce — grooming's evidence window. */
export const MAX_MEMORY_BODY_CHARS = 4000;

/** Intake marks a candidate `at_size_cap` from here (90% of the cap), so the judge routes first. */
export const AT_SIZE_CAP_CHARS = 3600;

export const GUARD_SIZE_REASON = "guard: result exceeds the memory size cap";
export const GUARD_DETAIL_REASON_PREFIX = "guard: would lose detail";

// Identifiers that change without carrying meaning: memory/inbox/run/handoff
// ids, ISO dates, UUIDs.
const NOISE = /^(mem_|inbox_|run_|hdo_)|^\d{4}-\d{2}-\d{2}|^[0-9a-f]{8}-[0-9a-f]{4}-/;

/**
 * The specific terms a text commits to: tokens of 4+ chars that carry a digit,
 * an underscore, a slash, a camelCase boundary, an inner hyphen or an inner dot — ports,
 * versions, paths, file and model names, identifiers. Lowercased. Ordinary words
 * are excluded on purpose: a rewrite may reword prose, but it may not quietly
 * lose `8034` or `run-strata.sh`.
 */
export function distinctiveTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.match(/[A-Za-z0-9_][A-Za-z0-9_.:/-]*/g) ?? []) {
    const token = raw.replace(/[.:/-]+$/, "");
    if (token.length < 4) continue;
    if (!/\d|_|\/|[a-z][A-Z]|\w-\w|\w\.\w/.test(token)) continue;
    const lower = token.toLowerCase();
    if (NOISE.test(lower)) continue;
    out.add(lower);
  }
  return out;
}

/**
 * Size guard. A new body (create, merge or split replacement) must fit the cap.
 * An existing memory that is already over it (`currentLength`) may shrink or stay
 * the same — so corrections still apply — but may never grow.
 */
export function checkSizeGuard(body: string, currentLength?: number): string | null {
  const limit = Math.max(MAX_MEMORY_BODY_CHARS, currentLength ?? 0);
  return body.length > limit ? GUARD_SIZE_REASON : null;
}

/**
 * How much specific detail an operation may drop:
 *  - "restructure" (merge, split): these only reorganise memories, so they must be
 *    lossless — at most `max(3, 10%)` of the sources' terms may go;
 *  - "rewrite" (an update or supersede with a new body): corrections and the
 *    prompt's de-brittling legitimately drop paths and identifiers, so only gutting
 *    is refused — losing more than half of them.
 */
export type DetailGuardMode = "restructure" | "rewrite";

/**
 * Detail guard. Counts the sources' distinctive terms (pass `title\nbody` on both
 * sides) missing from every result, ignoring terms that `named` mentions — a
 * submission or flag reason may legitimately remove what it corrects.
 */
export function checkDetailGuard(
  sources: readonly string[],
  results: readonly string[],
  named: readonly string[] = [],
  mode: DetailGuardMode = "restructure",
): string | null {
  const wanted = distinctiveTokens(sources.join("\n"));
  if (wanted.size === 0) return null;
  const haystack = results.join("\n").toLowerCase();
  const excused = distinctiveTokens(named.join("\n"));
  let lost = 0;
  for (const token of wanted) {
    if (!haystack.includes(token) && !excused.has(token)) lost++;
  }
  const allowed =
    mode === "restructure"
      ? Math.max(3, Math.ceil(wanted.size * 0.1))
      : Math.max(3, Math.floor(wanted.size * 0.5));
  return lost > allowed
    ? `${GUARD_DETAIL_REASON_PREFIX} (${lost} distinctive terms dropped)`
    : null;
}
