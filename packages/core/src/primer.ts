// The Librarian primer (rethink T11, spec §5.2 / D9–D11) — the one ≤2KB
// operator-editable document that teaches any harness how to use the system.
//
// The primer lives at `vault/primer.md` (plain markdown, git-committed like
// every vault write) and is served three ways from that one source: the MCP
// `initialize` result's `instructions` field, the unauthenticated
// `GET /primer.md` endpoint (OpenCode's remote-URL instructions config), and
// the Hermes/Pi adapters. It replaces the retired settings-key primer
// (`awareness.primer`, spec 041) whose per-turn conv_state delivery channel
// died with rethink T2 — `seedPrimer` migrates that key's value into the file
// once, then retires it.
//
// Wording constraint (spec §5.2): the shipped default must not pattern-match
// prompt-injection heuristics (no "ignore/disregard …instructions" phrasing) —
// Hermes regex-screens MCP-adjacent content before it reaches the model.

import type { SettingsStore } from "./store/settings-types.js";

/** Vault-relative path of the primer file (operator-editable, git-committed). */
export const PRIMER_PATH = "primer.md";

// The hard primer size cap (spec §5.2), measured in UTF-8 BYTES so a multi-byte
// body counts fully — the same rule as curator addendums (ADDENDUM_MAX_BYTES).
// Enforced at write time by setPrimer; the byte-for-byte legacy migration
// (seedPrimer) is deliberately exempt, mirroring the addendum migration.
export const PRIMER_MAX_BYTES = 2048;

/**
 * The shipped default primer (spec §5.2) — written to `vault/primer.md` on
 * first boot. Content is ordered critical-first so a harness that truncates
 * still delivers the recall/remember loop: (a) what The Librarian is + the
 * behavioral loop, (b) memory verbs, (c) handoff protocol, (d) learn protocol,
 * (e) references, (f) private mode (D11), (g) fail-soft posture.
 */
export const DEFAULT_PRIMER = `You are connected to The Librarian — durable, shared memory across sessions, agents, and harnesses; recall before answering anything that may have prior context, and remember durable facts, preferences, and decisions as you learn them.

Memory: you HAVE \`recall\` and \`remember\` — use them; do not rely on this window alone. Call \`recall\` before answering whenever prior context may exist, and ALWAYS after a compaction or context reset (earlier facts may be gone from your window but live in memory). Call \`remember\` whenever you learn a durable fact, preference, or decision — fire-and-forget; the curator files it. If a recalled memory proves wrong or outdated, call \`flag_memory\` with a reason.

Handoffs: create a handoff only when the user has explicitly asked for one — to hand work off, call \`store_handoff\` with a document carrying the five required sections — Start & intent, Journey, Current state, What's left, Open questions. To take over work, call \`list_handoffs\`, then \`claim_handoff\` the one you want.

Learning: when asked to extract lessons from a conversation, call \`remember\` once per durable lesson.

References: long-form background material is not auto-recalled — call \`search_references\` when the task needs depth.

Private mode: if the user asks to go private or off the record, acknowledge it and stop calling \`remember\`, \`store_handoff\`, and \`flag_memory\` until they toggle back. \`recall\` and \`search_references\` stay available, and those queries reach the server's logs — say so if asked.

If The Librarian is unreachable, continue without it — never block the user's work.
`;

/**
 * The store slice the primer helpers need: the committed-file read/write the
 * LibrarianStore implements over the vault + git (same shape as AddendumStore's
 * readAddendum/writeAddendum, minus the version — the dashboard history surface
 * is the primer's version trail).
 */
export interface PrimerStore {
  /**
   * Read `vault/primer.md`; null when the file is absent (pre-seed). Cached
   * in-memory by the store; the cache updates on writePrimer.
   */
  readPrimer: () => string | null;
  /**
   * Write `vault/primer.md` AND commit it (the primer is vault state). `actorId`
   * (optional-last, spec 064 SC 4) is the acting principal for the commit's trailer.
   */
  writePrimer: (content: string, actorId?: string) => void;
}

// The pre-rethink settings-key primer (spec 041) and the working-style preamble
// that rode it. Read ONLY by seedPrimer to seed `vault/primer.md` once; both
// keys are retired at migration time, exactly like the addendum migration.
export const LEGACY_AWARENESS_PRIMER_KEY = "awareness.primer";
export const LEGACY_WORKING_STYLE_KEY = "working_style";

/**
 * Read the primer FAIL-SOFT: the text is assembled into every MCP `initialize`
 * result and the `GET /primer.md` response, so an unreadable vault must never
 * throw — it degrades to "" (no primer). An absent file (pre-seed) also reads
 * as ""; an explicitly empty file means the operator DISABLED the primer.
 */
export function readPrimer(store: Pick<PrimerStore, "readPrimer">): string {
  try {
    return store.readPrimer() ?? "";
  } catch {
    return "";
  }
}

/**
 * Write the primer to `vault/primer.md` AND commit it. Enforces the hard 2 KB
 * cap (spec §5.2, same rule as setJobAddendum): an over-cap primer is REFUSED
 * before any write/commit. Bytes (not characters) so a multi-byte body is
 * measured fully. "" is a valid write — it disables the primer everywhere.
 */
export function setPrimer(
  store: Pick<PrimerStore, "writePrimer">,
  content: string,
  actorId?: string,
): string {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > PRIMER_MAX_BYTES) {
    throw new Error(`primer must be ≤ ${PRIMER_MAX_BYTES} bytes (~2 KB); got ${bytes} bytes`);
  }
  store.writePrimer(content, actorId);
  return content;
}

/**
 * Seed-on-boot (idempotent, no-clobber): guarantee `vault/primer.md` exists.
 *
 *  - File already present (operator-edited or previously seeded) → untouched.
 *  - File absent + the legacy settings-key primer (`awareness.primer`, spec
 *    041) was set → seed the file from it byte-for-byte (an explicitly-empty
 *    legacy primer stays a disabled "" primer), with the legacy working-style
 *    preamble appended when set — both rode the old primer channel. The
 *    migration write is exempt from the 2 KB cap, like the addendum migration.
 *  - File absent + no legacy value → seed the shipped DEFAULT_PRIMER.
 *
 * The legacy keys are retired unconditionally once observed, so they can never
 * re-seed a later edit (mirrors migrateCuratorAddendum). Safe to run on every
 * boot. The legacy reads are fail-soft (a locked settings store must never
 * block boot) — an unreadable key counts as unset.
 */
export function seedPrimer(
  store: PrimerStore & Pick<SettingsStore, "getSetting" | "deleteSetting">,
): void {
  const legacyNote = readLegacySetting(store, LEGACY_AWARENESS_PRIMER_KEY);
  const legacyStyle = readLegacySetting(store, LEGACY_WORKING_STYLE_KEY);

  if (store.readPrimer() === null) {
    store.writePrimer(composeLegacyPrimer(legacyNote, legacyStyle) ?? DEFAULT_PRIMER);
  }

  // Retire the legacy keys regardless — they must never re-seed an edited file.
  if (legacyNote !== null) store.deleteSetting(LEGACY_AWARENESS_PRIMER_KEY);
  if (legacyStyle !== null) store.deleteSetting(LEGACY_WORKING_STYLE_KEY);
}

function readLegacySetting(store: Pick<SettingsStore, "getSetting">, key: string): string | null {
  try {
    return store.getSetting(key);
  } catch {
    return null;
  }
}

// The legacy composition (mirrors the retired readAwarenessPrimer): the
// awareness note first, the working-style preamble appended. A never-set note
// with a set working-style keeps the style ON TOP OF the new default — the
// operator authored the style, not the note. Returns null when neither key
// carries anything to migrate (→ the caller seeds the default).
function composeLegacyPrimer(note: string | null, styleRaw: string | null): string | null {
  const style = (styleRaw ?? "").trim();
  if (note === null && !style) return null;
  const base = note ?? DEFAULT_PRIMER;
  if (base && style) return `${base}\n\n${style}`;
  return style || base;
}
