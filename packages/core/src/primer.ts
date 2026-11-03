// The Librarian primer (rethink T11, spec §5.2; reshaped by spec 083): the text that teaches any
// harness how to use the system.
//
// Since spec 083 the primer has two parts. The DEFAULT lives in code (below), the same on every
// install, and cannot be edited or disabled, so a changed default reaches everyone on upgrade.
// The ADDENDUM is the operator's optional addition: `vault/primer.md`, plain markdown,
// git-committed on every save, capped at 2 KB, empty by default. Agents receive the default
// followed by the addendum (`readPrimer`), through the MCP `initialize` result's `instructions`
// field, the unauthenticated `GET /primer.md` endpoint (OpenCode's remote-URL instructions
// config), and the Hermes/Pi adapters. The addendum is therefore public: no secrets.
//
// Before 083, `vault/primer.md` held a whole primer, seeded from whichever default was current
// at first boot and replaced outright by the dashboard. `seedPrimer` migrates that file once:
// an untouched old default clears to an empty addendum, an edited one is kept as the addendum
// and flagged for the owner to review.
//
// Wording constraint (spec §5.2): the shipped default must not pattern-match prompt-injection
// heuristics (no "ignore/disregard …instructions" phrasing). Hermes regex-screens MCP-adjacent
// content before it reaches the model.

import { createHash } from "node:crypto";
import type { SettingsStore } from "./store/settings-types.js";

/** Vault-relative path of the primer addendum (operator-editable, git-committed). */
export const PRIMER_PATH = "primer.md";

// The hard cap on the COMPLETE primer (default plus addendum), measured in UTF-8 BYTES so a
// multi-byte body counts fully. It is the whole primer that is capped because harnesses truncate
// server instructions at about 2 KB (Claude Code does). Enforced at write time by
// setPrimerAddendum; the one-time migration (seedPrimer) is exempt, so an old primer moves
// intact and the owner trims it.
export const PRIMER_MAX_BYTES = 2048;

/**
 * The shipped default primer (spec 083). It lives here, in code, and is sent to every agent on
 * every install: it cannot be edited or disabled, so a changed default reaches everyone on
 * upgrade. Operators add to it with the primer addendum (`vault/primer.md`). Kept short and
 * neutral on `remember`: transcript harvesting files routine facts where capture is on.
 */
export const DEFAULT_PRIMER = `You are connected to The Librarian, memory shared across sessions and agents.

- Call \`recall\` before answering when earlier context may exist, and after a compaction or context reset. If \`recall\` doesn't answer your question but you find the answer another way, \`remember\` what you found.
- Otherwise call \`remember\` only for something that will matter later and isn't obvious from the working directory. Conversations may be harvested automatically, so don't save routine facts.
- If a recalled memory is factually wrong or outdated, call \`flag_memory\` and say what's true now.
- \`search_references\` searches long documents; \`journal\` covers past conversations.
- Use handoffs (\`store_handoff\`, \`list_handoffs\`, \`claim_handoff\`) only when the user asks.
- If the user asks to go private or off the record, stop calling \`remember\`, \`store_handoff\` and \`flag_memory\` until they switch back. Recall and search still work, and are logged.
- If The Librarian is unreachable, carry on without it.
`;

/**
 * The store slice the primer helpers need: the committed-file read/write the LibrarianStore
 * implements over the vault + git. The file is the ADDENDUM since spec 083; the store methods
 * keep their names because the file and its cache did not change.
 */
export interface PrimerStore {
  /** Read `vault/primer.md` (the addendum); null when absent. Cached by the store. */
  readPrimer: () => string | null;
  /**
   * Write `vault/primer.md` AND commit it. `actorId` (optional-last, spec 064 SC 4) is the
   * acting principal for the commit's trailer.
   */
  writePrimer: (content: string, actorId?: string) => void;
}

// The pre-rethink settings-key primer (spec 041) and the working-style preamble that rode it.
// Read ONLY by seedPrimer's one-time migration; both keys are retired once observed.
export const LEGACY_AWARENESS_PRIMER_KEY = "awareness.primer";
export const LEGACY_WORKING_STYLE_KEY = "working_style";

/** Set once seedPrimer has moved a pre-083 `primer.md` to the addendum model (spec 083). */
export const PRIMER_ADDENDUM_MIGRATED_KEY = "awareness.primerAddendumMigrated";
/**
 * Set when the migration kept an edited pre-083 primer as the addendum: the owner should review
 * it, because it now follows the default and probably repeats some of it. Cleared when the
 * addendum is next saved or the notice is dismissed.
 */
export const PRIMER_REVIEW_PENDING_KEY = "awareness.primerReviewPending";

/** The complete primer for a given addendum: the default, then the trimmed addendum if any. */
export function composePrimer(addendum: string): string {
  const extra = addendum.trim();
  return extra ? `${DEFAULT_PRIMER.trimEnd()}\n\n${extra}\n` : DEFAULT_PRIMER;
}

/** The most bytes an addendum can have while the complete primer stays within the cap. */
export function primerAddendumMaxBytes(): number {
  // composePrimer adds the trimmed default, a blank line, and a trailing newline.
  return PRIMER_MAX_BYTES - Buffer.byteLength(DEFAULT_PRIMER.trimEnd(), "utf8") - 3;
}

/**
 * The operator's addendum, FAIL-SOFT: an absent or unreadable file reads as "".
 */
export function readPrimerAddendum(store: Pick<PrimerStore, "readPrimer">): string {
  try {
    return store.readPrimer() ?? "";
  } catch {
    return "";
  }
}

/**
 * The complete primer agents receive: the default, then the addendum. Never empty, and never
 * throws: an unreadable addendum degrades to the default alone, so `initialize` and
 * `GET /primer.md` always carry it.
 */
export function readPrimer(store: Pick<PrimerStore, "readPrimer">): string {
  return composePrimer(readPrimerAddendum(store));
}

/**
 * Write the addendum to `vault/primer.md` AND commit it. An addendum that would take the complete
 * primer over 2 KB is REFUSED before any write. "" clears it (the default alone is sent). Saving
 * also clears the migration review notice: the owner has looked at it.
 */
export function setPrimerAddendum(
  store: Pick<PrimerStore, "writePrimer"> & Partial<Pick<SettingsStore, "deleteSetting">>,
  content: string,
  actorId?: string,
): string {
  const total = Buffer.byteLength(composePrimer(content), "utf8");
  if (total > PRIMER_MAX_BYTES) {
    const limit = primerAddendumMaxBytes();
    const bytes = Buffer.byteLength(content.trim(), "utf8");
    throw new Error(
      `the addendum must be ≤ ${limit} bytes, so the whole primer fits in ${PRIMER_MAX_BYTES} bytes (~2 KB); got ${bytes} bytes`,
    );
  }
  store.writePrimer(content, actorId);
  try {
    store.deleteSetting?.(PRIMER_REVIEW_PENDING_KEY);
  } catch {
    // fail-soft: a stale notice is harmless
  }
  return content;
}

/** Whether the owner still has to review an addendum the migration moved over (spec 083). */
export function primerReviewPending(store: Pick<SettingsStore, "getSetting">): boolean {
  return readLegacySetting(store, PRIMER_REVIEW_PENDING_KEY) === "true";
}

/**
 * Boot-time migration to the addendum model (spec 083). Runs once, marked by
 * PRIMER_ADDENDUM_MIGRATED_KEY; safe to call on every boot.
 *
 *  - `primer.md` holds a previously shipped default, or is blank: cleared to an empty addendum.
 *  - `primer.md` was edited: kept as the addendum, and the review notice is set.
 *  - `primer.md` absent but the legacy settings primer (spec 041) carries text that isn't a
 *    default: that text (plus the legacy working-style preamble) becomes the addendum.
 *  - Otherwise nothing is written: a fresh install has no addendum file.
 *
 * The legacy keys are retired once observed, so they can never re-seed a later edit. Legacy
 * reads are fail-soft (a locked settings store must never block boot).
 */
export function seedPrimer(
  store: PrimerStore & Pick<SettingsStore, "getSetting" | "setSetting" | "deleteSetting">,
): void {
  const legacyNote = readLegacySetting(store, LEGACY_AWARENESS_PRIMER_KEY);
  const legacyStyle = readLegacySetting(store, LEGACY_WORKING_STYLE_KEY);

  if (readLegacySetting(store, PRIMER_ADDENDUM_MIGRATED_KEY) !== "true") {
    const current = store.readPrimer();
    if (current !== null) {
      if (!current.trim() || isPreviousDefaultPrimer(current)) {
        if (current !== "") store.writePrimer("");
      } else {
        store.setSetting(PRIMER_REVIEW_PENDING_KEY, "true");
      }
    } else {
      const legacy = composeLegacyAddendum(legacyNote, legacyStyle);
      if (legacy) {
        store.writePrimer(legacy);
        store.setSetting(PRIMER_REVIEW_PENDING_KEY, "true");
      }
    }
    store.setSetting(PRIMER_ADDENDUM_MIGRATED_KEY, "true");
  }

  if (legacyNote !== null) store.deleteSetting(LEGACY_AWARENESS_PRIMER_KEY);
  if (legacyStyle !== null) store.deleteSetting(LEGACY_WORKING_STYLE_KEY);
}

/**
 * SHA-256 of every default primer shipped before spec 083, oldest first (from the git history of
 * DEFAULT_PRIMER, 1.46.0 last). A `primer.md` matching one was seeded and never edited, so the
 * migration clears it. The default no longer lives in the vault, so this list is closed.
 */
export const PREVIOUS_DEFAULT_PRIMER_SHA256: readonly string[] = [
  "9e746f4eb488866e93359b37f936d10ae94f8ac20cfbe2f250f3d5bc851625e4",
  "01b6fcbaa445322e6416f8e18165d10069ba45714457820672f2e2b1c6f00cb7",
  "92d10d040ebf539ab2d51855b428b5d9565487113a9026ce7affb8a47fbc8365",
  "af38415613a24cb426c2fb422d088da711974ccf5b0c24cf8fc64ee9bcc3adb3",
  "74a9ecb9f6ec38573adcb74cde58695c1617629a806fd14439ace571c7b074a0",
  "134ccaee77a1b84ff57ddda9498713151cdbabd8cc2b691e9a980c67f843152b",
  "ebc8d08d5b8405481cecbc8ae75cab41afe31c5493c27cbda610fdcef4f0ff85",
];

export function isPreviousDefaultPrimer(content: string): boolean {
  const hash = createHash("sha256").update(content).digest("hex");
  return PREVIOUS_DEFAULT_PRIMER_SHA256.includes(hash);
}

function readLegacySetting(store: Pick<SettingsStore, "getSetting">, key: string): string | null {
  try {
    return store.getSetting(key);
  } catch {
    return null;
  }
}

// The legacy settings primer as an addendum: the note (unless it was blank or a shipped
// default), then the working-style preamble. Null when there is nothing to keep.
function composeLegacyAddendum(note: string | null, styleRaw: string | null): string | null {
  const style = (styleRaw ?? "").trim();
  const keptNote = note && note.trim() && !isPreviousDefaultPrimer(note) ? note.trim() : "";
  const parts = [keptNote, style].filter(Boolean);
  return parts.length ? parts.join("\n\n") : null;
}
