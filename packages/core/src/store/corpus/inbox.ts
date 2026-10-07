// Inbox queue — the durable submission queue for the intake (spec 035
// §F5 inbox / Open-Q #2 RESOLVED). A submission is stored instantly as
// `inbox/<ts>-<id>.md` (fire-and-forget, off the hot path); intake
// happens later, async. Processing is once-only via an ATOMIC CLAIM: the item
// is renamed into `inbox/.processing/`, and the rename winner owns the job —
// a second claim of the same item finds nothing to move and returns null. A
// boot reaper (`releaseStaleClaims`) returns claims a crashed worker left
// behind. One item at a time; the serial FIFO run-chain + scheduler wire on top
// in a follow-on increment.
//
// These are pure vault operations with an injected clock, so FIFO ordering and
// claim age are deterministic. Filenames carry zero-padded epoch-ms prefixes:
// the pending name sorts chronologically (FIFO via the vault's sorted listing);
// the claimed name additionally prefixes the CLAIM time so the reaper can age a
// claim from its filename alone — no mtime reliance (rename preserves mtime).

import { parseFrontmatter } from "../../safe-frontmatter.js";
import { makeId } from "../../constants.js";
import type { Vault } from "./vault.js";

const INBOX_DIR = "inbox";
const PROCESSING_DIR = "inbox/.processing";
// Items that failed too often to keep retrying (review 2026-09-29 item #28). Parked,
// never deleted: the operator can read them and move one back to inbox/ to retry.
const FAILED_DIR = "inbox/.failed";
/**
 * How many failed attempts an inbox item gets before the reaper parks it in
 * `inbox/.failed/` instead of queueing it again. Each reclaim of a stale claim is
 * one failed attempt (a timeout, a provider error or an unusable reply).
 */
export const DEFAULT_MAX_INBOX_ATTEMPTS = 3;
// Zero-padded width for epoch-ms prefixes: 13 digits today, 14 by ~2286 — 15
// leaves headroom and keeps lexicographic order == chronological order.
const TS_WIDTH = 15;

/** Clock + id injection so FIFO order, claim age, and filenames are deterministic. */
export interface InboxDeps {
  /** Epoch ms. Defaults to `Date.now()`. */
  now?: () => number;
  /** Item id generator. Defaults to `makeId("inbox")`. */
  generateId?: () => string;
}

/**
 * Filing/ownership hints from the original submission (the `remember` input),
 * carried on the inbox item so the intake can preserve the submitter's
 * scope + ownership when it files the memory — rather than attributing every
 * consolidated memory to the system actor with no project scope.
 */
export interface InboxSubmissionHints {
  agentId?: string;
  tags?: string[];
  /**
   * The submission's caller-asserted targeting (`applies_to`) — which entities
   * the note is about. Unlike tags it can't be re-derived from the text, so it's
   * carried through and applied to a NEW consolidated memory.
   */
  appliesTo?: string[];
}

/** Write options: clock/id injection (for determinism) + the submission hints to persist. */
export interface WriteInboxOptions extends InboxDeps {
  hints?: InboxSubmissionHints;
}

export interface InboxItemRef {
  /** Vault-relative path of the pending item (`inbox/<ts>-<id>.md`). */
  relPath: string;
  id: string;
}

/** A parsed inbox submission: identity + creation time + the raw text + hints. */
export interface InboxItem {
  id: string;
  created: string;
  text: string;
  /** Filing/ownership hints from the original submission (possibly empty). */
  hints: InboxSubmissionHints;
  /** Failed processing attempts so far (absent / 0 on a fresh submission). */
  attempts?: number;
}

function pad(ms: number): string {
  return String(ms).padStart(TS_WIDTH, "0");
}

function basename(relPath: string): string {
  const file = relPath.slice(relPath.lastIndexOf("/") + 1);
  return file.endsWith(".md") ? file.slice(0, -3) : file;
}

function quote(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

/** Serialize an inbox submission to its on-disk markdown (frontmatter + text). */
export function serializeInboxItem(item: InboxItem): string {
  const lines = [`id: ${quote(item.id)}`, `created: ${quote(item.created)}`];
  const { agentId, tags, appliesTo } = item.hints;
  // Hints are written only when present, so an inbox item with none stays minimal.
  if (agentId !== undefined) lines.push(`agent_id: ${quote(agentId)}`);
  if (tags !== undefined) {
    lines.push(
      tags.length ? `tags:\n${tags.map((t) => `  - ${quote(t)}`).join("\n")}` : "tags: []",
    );
  }
  if (appliesTo !== undefined) {
    lines.push(
      appliesTo.length
        ? `applies_to:\n${appliesTo.map((a) => `  - ${quote(a)}`).join("\n")}`
        : "applies_to: []",
    );
  }
  if (item.attempts) lines.push(`attempts: ${item.attempts}`);
  const head = `---\n${lines.join("\n")}\n---\n`;
  const body = item.text.trim();
  return body ? `${head}\n${body}\n` : head;
}

/** Parse an inbox submission; tolerant of hand edits (coerces a YAML Date back to ISO). */
export function parseInboxItem(raw: string): InboxItem {
  const { data, content } = parseFrontmatter(raw);
  const d = data as Record<string, unknown>;
  const createdRaw = d.created;
  const created = createdRaw instanceof Date ? createdRaw.toISOString() : String(createdRaw ?? "");
  const hints: InboxSubmissionHints = {};
  if (typeof d.agent_id === "string") hints.agentId = d.agent_id;
  if (Array.isArray(d.tags)) hints.tags = d.tags.filter((t): t is string => typeof t === "string");
  if (Array.isArray(d.applies_to)) {
    hints.appliesTo = d.applies_to.filter((a): a is string => typeof a === "string");
  }
  const attempts =
    typeof d.attempts === "number" && Number.isInteger(d.attempts) && d.attempts > 0
      ? d.attempts
      : 0;
  return { id: String(d.id ?? ""), created, text: content.trim(), hints, attempts };
}

/**
 * Store a submission in the inbox (instant, fire-and-forget) and return its
 * pending path + id. The filename's zero-padded ms prefix gives FIFO order;
 * `options.hints` persists the submission's filing/ownership hints.
 */
export function writeInbox(
  vault: Vault,
  text: string,
  options: WriteInboxOptions = {},
): InboxItemRef {
  const ms = (options.now ?? Date.now)();
  const id = (options.generateId ?? (() => makeId("inbox")))();
  const relPath = `${INBOX_DIR}/${pad(ms)}-${id}.md`;
  vault.writeText(
    relPath,
    serializeInboxItem({
      id,
      created: new Date(ms).toISOString(),
      text,
      hints: options.hints ?? {},
    }),
  );
  return { relPath, id };
}

/** Pending items, FIFO-ordered, excluding anything already claimed (`.processing/`). */
export function listInbox(vault: Vault): string[] {
  const prefix = `${INBOX_DIR}/`;
  return vault.listMarkdown(INBOX_DIR).filter((rel) => {
    if (!rel.startsWith(prefix) || rel.startsWith(`${PROCESSING_DIR}/`)) return false;
    // Direct children of inbox/ only (a pending item, not a nested file).
    return !rel.slice(prefix.length).includes("/");
  });
}

/**
 * Atomically claim a pending item: rename `inbox/<stem>.md` →
 * `inbox/.processing/<claimMs>-<stem>.md`. Returns the claimed path, or null if
 * the item was already claimed / never existed (the move finds nothing) — the
 * rename winner owns the job.
 */
export function claimInboxItem(vault: Vault, relPath: string, deps: InboxDeps = {}): string | null {
  const claimMs = (deps.now ?? Date.now)();
  // The claim name carries the claim time so the reaper can age it. Distinct
  // items never collide (unique id), and the single-process serial model means
  // the same item is never claimed twice concurrently — so the target is fresh.
  const target = `${PROCESSING_DIR}/${pad(claimMs)}-${basename(relPath)}.md`;
  try {
    vault.moveFile(relPath, target);
    return target;
  } catch (error) {
    // Source gone → already claimed (the rename winner owns it) or never
    // written: that's the only null. A real failure (path escape, perms) must
    // surface loudly rather than masquerade as a lost race.
    if (!vault.exists(relPath)) return null;
    throw error;
  }
}

export interface ReapStaleClaimsOptions {
  olderThanMs: number;
  now: number;
  /** Park an item once it reaches this many failed attempts (default 3). */
  maxAttempts?: number;
}

export interface ReapResult {
  /** Pending paths the stale claims were returned to. */
  restored: string[];
  /** `inbox/.failed/` paths of items that used up their attempts. */
  parked: string[];
}

/**
 * Deal with claims older than `olderThanMs` (a crashed worker, or an item whose
 * processing failed and left its claim behind). Each one counts as a failed
 * attempt, recorded on the item: below the cap it goes back to the pending
 * queue at its original path; at the cap it is parked in `inbox/.failed/` so a
 * reply that always times out stops costing a model call every hour. Claim age
 * comes from the `<claimMs>-` filename prefix; fresh claims are left in place.
 */
export function reapStaleClaims(vault: Vault, opts: ReapStaleClaimsOptions): ReapResult {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_INBOX_ATTEMPTS;
  const result: ReapResult = { restored: [], parked: [] };
  for (const claimed of vault.listMarkdown(PROCESSING_DIR)) {
    const name = basename(claimed);
    const dash = name.indexOf("-");
    if (dash <= 0) continue; // malformed — not a claim we wrote; leave it
    const claimMs = Number(name.slice(0, dash));
    if (Number.isNaN(claimMs) || opts.now - claimMs < opts.olderThanMs) continue;
    const stem = name.slice(dash + 1);

    let item: InboxItem | null = null;
    try {
      item = parseInboxItem(vault.readText(claimed));
    } catch {
      // Unparseable front matter: still return it to the queue (the old
      // behaviour) rather than strand it; it just can't carry a count.
    }
    if (!item) {
      const pendingPath = `${INBOX_DIR}/${stem}.md`;
      vault.moveFile(claimed, pendingPath);
      result.restored.push(pendingPath);
      continue;
    }

    const attempts = (item.attempts ?? 0) + 1;
    const target = attempts >= maxAttempts ? `${FAILED_DIR}/${stem}.md` : `${INBOX_DIR}/${stem}.md`;
    // Record the count on the claim first, then move it: the move is the one
    // atomic step, so a crash in between leaves a claim the next reaper retries.
    vault.writeText(claimed, serializeInboxItem({ ...item, attempts }));
    vault.moveFile(claimed, target);
    (attempts >= maxAttempts ? result.parked : result.restored).push(target);
  }
  return result;
}

/**
 * Return stale claims to the pending queue (see {@link reapStaleClaims}, which
 * also reports the items it parked). Returns the restored pending paths.
 */
export function releaseStaleClaims(vault: Vault, opts: ReapStaleClaimsOptions): string[] {
  return reapStaleClaims(vault, opts).restored;
}

/** Remove a processed claim from `.processing/`. Idempotent (a no-op if gone). */
export function completeInboxItem(vault: Vault, processingRelPath: string): void {
  vault.removeFile(processingRelPath);
}
