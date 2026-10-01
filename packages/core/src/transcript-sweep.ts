// Transcript settle-sweep + buffer lifecycle (spec 2026-06-16-harness-auto-capture,
// T2). This is the EXTRACTION clock (spec §4.3): a background tick — wired into the
// server scheduler exactly like the intake / grooming / backup ticks — that scans
// `<dataDir>/transcripts/` for SETTLED buffers and turns each into inbox facts.
//
// The lifecycle for one buffer:
//   1. SETTLE-DETECT — a buffer is settled when any of:
//        - idle: mtime older than `idleMs` (LIBRARIAN_TRANSCRIPT_IDLE_MS, 30 min),
//        - explicit-end: an `<conv_id>.ended` marker exists (T1's `ended:true`),
//        - size: the buffer is over `maxBytes` (LIBRARIAN_TRANSCRIPT_MAX_BYTES) —
//          the runaway safety valve.
//   2. ATOMIC CLAIM — rename `<conv_id>.md` → `<conv_id>.processing` (atomic on
//      one filesystem). A straggler T1 delta then starts a FRESH `<conv_id>.md`
//      instead of racing the delete (T1 appends to the `.md`).
//   3. EXTRACT — ONE LLM pass over the claimed buffer → N candidate facts
//      (transcript-extract.ts), using the intake consumer's own LLM client.
//   4. SUBMIT — each fact INDIVIDUALLY to the EXISTING inbox via submitToInbox,
//      tagged (source=auto_capture, harness) so it flows through the UNCHANGED
//      navigate→judge→apply with confidence bands. The judge/apply is untouched.
//   5. DELETE-AFTER — drop the `.processing` claim (and any `.ended` marker) on
//      success: zero trace; only extracted facts persist in the inbox→vault path.
//      A FAILED pass (the model call threw, or its reply was unusable) is not a
//      success: the claim is kept and its clock restarted, so the reaper returns
//      it after one window. The third failure drops it (review 2026-09-29 #10),
//      and a timeout / unavailable provider stops the rest of this tick.
//
// REAPER — an orphaned `.processing` (crash mid-extract) is recovered at the
// START of each tick: a `.processing` older than `reaperTtlMs` is renamed back to
// `<conv_id>.md` so the same tick re-claims and re-extracts it. Mirrors the
// inbox's `releaseStaleClaims` boot-reaper.
//
// GATE COHERENCE (spec Q-gate, locked) — the WHOLE tick self-gates on
// isIntakeEnabled(store), the SAME gate T1's endpoint refuses on and the SAME
// gate the intake tick reads. Disabled → nothing extracted, buffers untouched
// (the intake tick that would drain the inbox is also off, so we never feed a
// dead pipeline). Buffers simply wait for the gate to come back on.
//
// FAIL-SOFT (AGENTS.md) — a sweep / LLM / parse failure must NEVER crash the
// worker or block anything. Every per-buffer step is wrapped: a throw on one
// buffer logs and the sweep moves on to the next. The tick resolves with a
// summary; it never rejects.

import fs from "node:fs";
import path from "node:path";
import type { Principal } from "./caller-identity.js";
import {
  migrateLegacyCuratorLlm,
  readConsumerConfig,
  resolveConsumerToken,
  type ConsumerConnection,
  consumerConnection,
} from "./curator-consumers.js";
import {
  type LlmClient,
  createGroomingLlmClient,
  isProviderUnavailableError,
} from "./grooming-llm-client.js";
import { redactSecrets } from "./grooming-redaction.js";
import { isIntakeEnabled } from "./intake-config.js";
import type { InboxItemRef, InboxSubmissionHints } from "./store/corpus/index.js";
import type { LibrarianStore } from "./store/librarian-store.js";
import {
  endedMarkerPath,
  sanitizeConvId,
  transcriptBufferPath,
  transcriptHarnessMarkerPath,
  transcriptProcessingEndedMarkerPath,
  transcriptProcessingHarnessMarkerPath,
  transcriptProcessingPath,
  transcriptProcessingShelfMarkerPath,
  transcriptShelfMarkerPath,
  transcriptsDir,
} from "./transcript-buffer.js";
import { tryExtractTranscriptFacts } from "./transcript-extract.js";
import { type Shelf, validateShelfSet } from "./vault-router.js";

/** Idle window: a buffer untouched this long is settled (spec Q-settle = 30 min). */
export const DEFAULT_TRANSCRIPT_IDLE_MS = 30 * 60_000;
/** Runaway safety valve: a buffer over this size is settled regardless of idle. */
export const DEFAULT_TRANSCRIPT_MAX_BYTES = 5_000_000;
/**
 * Reaper TTL: a `.processing` claim older than this is treated as a CRASHED worker
 * and recovered. This is DELIBERATELY DECOUPLED from (and comfortably ABOVE) both
 * the idle window and any realistic extraction time — it must exceed the
 * worst-case single-extraction wall-clock (one LLM pass over up to MAX_BYTES of
 * transcript, including a slow/retried provider) by a wide margin, or a LIVE
 * in-flight `.processing` could be mis-reaped and re-extracted (double-extract).
 * It must NOT track the idle window: the idle window is when a buffer SETTLES; the
 * reaper TTL is how long a CLAIM may legitimately run. Conflating them (the old
 * 30-min value == the idle window) meant a tick overrunning the interval could
 * reap its own live claim. 60 min is far above any sane extraction yet still
 * recovers a genuinely crashed worker within an hour.
 */
export const DEFAULT_TRANSCRIPT_REAPER_TTL_MS = 60 * 60_000;
/**
 * Failed extraction passes a conversation gets before the sweep gives up on it
 * (review 2026-09-29 item #10). A failed pass keeps the claimed buffer and backs
 * off for one reaper window; the third failure deletes it, as every failure used
 * to: transcripts are private working data, so they are not parked forever.
 */
export const DEFAULT_TRANSCRIPT_MAX_ATTEMPTS = 3;

export interface TranscriptSweepOptions {
  store: LibrarianStore;
  /** Idle window in ms; defaults to LIBRARIAN_TRANSCRIPT_IDLE_MS / 30 min. */
  idleMs?: number;
  /** Size cap in bytes; defaults to LIBRARIAN_TRANSCRIPT_MAX_BYTES / 5 MB. */
  maxBytes?: number;
  /** Stale-claim TTL for the `.processing` reaper; defaults to 30 min. */
  reaperTtlMs?: number;
  /** Clock (epoch ms) for settle/reaper math; defaults to Date.now. Mostly tests. */
  now?: () => number;
  /**
   * Injectable LLM client builder (defaults to the OpenAI-compatible client built
   * from the intake consumer config) — mirrors runIntakeTick's `buildClient`, so
   * tests inject a fake `complete` with no network.
   */
  buildClient?: (conn: ConsumerConnection, token: string) => LlmClient;
}

export interface TranscriptSweepSummary {
  /** Buffers that were claimed + extracted this tick (settled). */
  extracted: number;
  /** Total candidate facts submitted to the inbox across all extractions. */
  facts: number;
  /** Buffers seen but NOT settled (left for a later tick). */
  skipped: number;
  /** Orphaned `.processing` claims reaped (renamed back to `.md`) this tick. */
  reaped: number;
  /** Extractions that failed and kept their buffer for a retry after the reaper window. */
  failed: number;
  /** Conversations dropped after their last allowed failed extraction. */
  abandoned: number;
  /** True when a provider failure stopped the sweep before every buffer was tried. */
  stoppedEarly: boolean;
  /** Why the tick did nothing wholesale, when applicable. */
  reason?: "disabled" | "no_dir" | "no_client";
}

/** A logger shim so the worker stays free of the mcp-server logger import. */
type Warn = (info: Record<string, unknown>, msg: string) => void;

/**
 * Run ONE settle-sweep tick. Resolves with a summary; never rejects (fail-soft).
 * Self-gates on the intake gate first, then reaps orphaned claims, then extracts
 * every settled buffer.
 */
export async function runTranscriptSweepTick(
  options: TranscriptSweepOptions & { warn?: Warn },
): Promise<TranscriptSweepSummary> {
  const { store } = options;
  const warn: Warn = options.warn ?? (() => {});
  const now = options.now ?? (() => Date.now());
  const idleMs = options.idleMs ?? DEFAULT_TRANSCRIPT_IDLE_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_TRANSCRIPT_MAX_BYTES;
  const reaperTtlMs = options.reaperTtlMs ?? DEFAULT_TRANSCRIPT_REAPER_TTL_MS;

  const summary: TranscriptSweepSummary = {
    extracted: 0,
    facts: 0,
    skipped: 0,
    reaped: 0,
    failed: 0,
    abandoned: 0,
    stoppedEarly: false,
  };

  // GATE COHERENCE: the whole tick is gated on the intake gate that would drain
  // the inbox these facts land in (spec Q-gate). Disabled → leave every buffer
  // exactly where it is; it waits for the gate to come back on.
  if (!isIntakeEnabled(store)) {
    summary.reason = "disabled";
    return summary;
  }

  const dir = transcriptsDir(store.dataDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // No transcripts/ dir yet (nothing ever buffered) — a clean no-op.
    summary.reason = "no_dir";
    return summary;
  }

  // REAPER (run first): an orphaned `.processing` older than the TTL is a crashed
  // worker — rename it back to `<conv_id>.md` so THIS tick re-claims it below.
  for (const name of entries) {
    if (!name.endsWith(".processing")) continue;
    const procPath = path.join(dir, name);
    try {
      const stat = fs.statSync(procPath);
      if (now() - stat.mtimeMs < reaperTtlMs) continue; // a live, in-flight claim — leave it
      const recovered = procPath.replace(/\.processing$/, ".md");
      // If a fresh `<conv_id>.md` already exists (T1 started a new segment after
      // the claim), don't clobber it — drop the stale orphan instead.
      if (fs.existsSync(recovered)) {
        fs.rmSync(procPath, { force: true });
        removeClaimedMarkers(store.dataDir, name.slice(0, -".processing".length));
        clearAttempts(store.dataDir, name.slice(0, -".processing".length));
      } else {
        fs.renameSync(procPath, recovered);
        recoverClaimedMarkers(store.dataDir, name.slice(0, -".processing".length));
      }
      summary.reaped += 1;
    } catch (err) {
      warn({ file: name, err: (err as Error).message }, "transcript reaper failed for a claim");
    }
  }

  // A successful extraction deletes the claimed buffer before its claimed
  // sidecars. If the process crashes between those synchronous removals, the
  // marker remains without a `.processing` owner and blocks the next generation
  // from claiming the same conversation. Remove such ownerless claimed markers
  // eagerly; a live extraction always still has its `.processing` file.
  const processingMarkersDir = path.dirname(
    transcriptProcessingHarnessMarkerPath(store.dataDir, "marker-directory-probe"),
  );
  let processingMarkers: string[] = [];
  try {
    processingMarkers = fs.readdirSync(processingMarkersDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warn(
        { err: (error as Error).message },
        "transcript claimed-marker reaper could not list markers",
      );
    }
  }
  for (const name of processingMarkers) {
    const suffix = markerSuffix(name);
    if (suffix === null) continue;
    const convBase = name.slice(0, -suffix.length);
    if (fs.existsSync(path.join(dir, `${convBase}.processing`))) continue;
    try {
      fs.rmSync(path.join(processingMarkersDir, name), { force: true });
      summary.reaped += 1;
    } catch (err) {
      warn(
        { file: name, err: (err as Error).message },
        "transcript orphaned claimed-marker reap failed",
      );
    }
  }

  // STRAY-MARKER REAPER: a lone sidecar marker (`<conv_id>.ended` — the explicit-end accelerator —
  // `<conv_id>.shelf` — the spec 062 SC 8a shelf-routing marker — or
  // `<conv_id>.harness` — capture provenance) with NO matching buffer.
  // Review note (accepted as-is): the `.shelf` suffix handling here operates purely on the
  // system-managed transcripts/ dir (T1 writes the markers, the sweep owns their lifecycle), so
  // dropping a genuinely orphaned `.shelf` alongside `.ended` is correct and needs no marker parsing —
  // an orphan has no buffer to route anyway.
  // `.md`/`.processing` is unreachable by the extraction loop (it consumes a marker only alongside
  // its buffer) and would otherwise linger forever. It is reachable in a claim/delete race: a buffer
  // is claimed+deleted while a late delta drops a fresh marker. Drop these orphans so they don't
  // accumulate (the buffer-path comment in transcript-buffer.ts promises the sweep reaps a marker
  // without a buffer).
  for (const name of entries) {
    const suffix = markerSuffix(name);
    if (suffix === null) continue;
    const convBase = name.slice(0, -suffix.length);
    const hasBuffer =
      entries.includes(`${convBase}.md`) || entries.includes(`${convBase}.processing`);
    if (hasBuffer) continue; // a normal marker — leave it for the extraction loop
    try {
      fs.rmSync(path.join(dir, name), { force: true });
      summary.reaped += 1;
    } catch (err) {
      warn({ file: name, err: (err as Error).message }, "transcript stray-marker reap failed");
    }
  }

  // Re-list after reaping so reaped `<conv_id>.md` files are considered this tick.
  let buffers: string[];
  try {
    buffers = fs.readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    summary.reason = "no_dir";
    return summary;
  }
  if (buffers.length === 0) return summary;

  // Build the extractor LLM client ONCE per tick from the intake consumer config
  // (the sweep reuses the curator's existing client/config — spec T2). If the
  // config isn't operational, there is nothing to extract WITH: leave buffers be.
  const client = buildExtractorClient(store, options.buildClient, warn);
  if (!client) {
    summary.reason = "no_client";
    return summary;
  }

  for (const name of buffers) {
    const bufferPath = path.join(dir, name);
    // The conv_id base (already sanitized on disk by T1); used to derive sibling paths.
    const convBase = name.slice(0, -".md".length);
    try {
      const stat = fs.statSync(bufferPath);
      const ended = fs.existsSync(siblingMarker(dir, convBase));
      const idle = now() - stat.mtimeMs >= idleMs;
      const oversize = stat.size >= maxBytes;
      if (!ended && !idle && !oversize) {
        summary.skipped += 1;
        continue; // not settled yet — a later tick will revisit it
      }

      // ATOMIC CLAIM: rename to `.processing`. A straggler T1 delta then starts a
      // fresh `<conv_id>.md` (T1 appends to the `.md`), never racing the delete.
      const procPath = path.join(dir, `${convBase}.processing`);
      try {
        fs.renameSync(bufferPath, procPath);
        claimMarkers(store.dataDir, convBase);
      } catch (err) {
        // Lost the claim (a concurrent tick / a delete) — skip, no double-extract.
        warn({ file: name, err: (err as Error).message }, "transcript claim failed; skipping");
        continue;
      }

      summary.extracted += 1;
      const text = readClaimed(procPath, warn);
      const extraction = text
        ? await tryExtractTranscriptFacts(text, { llmClient: client })
        : { ok: true as const, facts: [] };
      if (!extraction.ok) {
        // A failed pass is not "nothing worth keeping" (review #10): keep the
        // claimed buffer and its markers, and restart its reaper clock so the
        // retry waits a full window instead of hitting a struggling model again
        // on the next tick. The last allowed failure drops it.
        const attempts = recordFailedAttempt(store.dataDir, convBase);
        const err = (extraction.error as Error | undefined)?.message ?? String(extraction.error);
        if (attempts >= DEFAULT_TRANSCRIPT_MAX_ATTEMPTS) {
          fs.rmSync(procPath, { force: true });
          removeClaimedMarkers(store.dataDir, convBase);
          clearAttempts(store.dataDir, convBase);
          summary.abandoned += 1;
          warn(
            { file: name, attempts, err },
            "transcript extraction failed too often; conversation dropped",
          );
        } else {
          const at = new Date(now());
          fs.utimesSync(procPath, at, at);
          summary.failed += 1;
          warn({ file: name, attempts, err }, "transcript extraction failed; kept for a retry");
        }
        if (isProviderUnavailableError(extraction.error)) {
          // Same rule as the intake sweep: a timed-out request may still be
          // running on a serial local model, so don't queue the next one behind it.
          summary.stoppedEarly = true;
          break;
        }
        continue;
      }
      const facts = extraction.facts;

      // SHELF ROUTING (spec 062 SC 8a): submit this conversation's facts into the write-target
      // shelf's inbox recorded by T1's `<conv_id>.shelf` marker. Absent marker (the DEFAULT router,
      // or a pre-062 buffer) → the vault-root inbox, byte-identical to before.
      const submit = shelfSubmit(
        store,
        transcriptProcessingShelfMarkerPath(store.dataDir, convBase),
        convBase,
        warn,
      );
      const hints = autoCaptureHints(readHarnessMarker(store.dataDir, convBase, warn));

      for (const fact of facts) {
        try {
          // PRIVACY DEFENSE-IN-DEPTH (AGENTS.md "privacy is the product"): T1's
          // redaction on intake is the primary guard, but redactSecrets has
          // documented gaps and the extracted fact is about to be committed VERBATIM
          // to the git vault path (inbox → curator → vault). Re-redact each fact
          // here (idempotent — already-redacted text is a no-op) so a secret that
          // slipped past T1 never reaches durable git history.
          const { redacted } = redactSecrets(fact);
          submit(redacted, hints);
          summary.facts += 1;
        } catch (err) {
          // One fact failing to submit must not lose the others — log + move on.
          warn({ err: (err as Error).message }, "auto-capture inbox submit failed (fail-soft)");
        }
      }

      // DELETE-AFTER removes only sidecars CLAIMED with this generation. A late delta may already
      // have created a fresh `.md` plus active markers; those belong to the next generation.
      fs.rmSync(procPath, { force: true });
      removeClaimedMarkers(store.dataDir, convBase);
      clearAttempts(store.dataDir, convBase);
    } catch (err) {
      // Per-buffer fail-soft: an unexpected error on one buffer never aborts the
      // rest of the sweep. The claim (if made) stays as `.processing` for the
      // reaper to retry next tick.
      warn({ file: name, err: (err as Error).message }, "transcript sweep failed for a buffer");
    }
  }

  return summary;
}

function markerSuffix(name: string): ".ended" | ".shelf" | ".harness" | null {
  if (name.endsWith(".ended")) return ".ended";
  if (name.endsWith(".shelf")) return ".shelf";
  if (name.endsWith(".harness")) return ".harness";
  return null;
}

/** The `<conv_id>.ended` marker path for a conv base already on disk. */
function siblingMarker(dir: string, convBase: string): string {
  return path.join(dir, `${convBase}.ended`);
}

/**
 * Resolve the inbox-submit function for a settled buffer (spec 062 SC 8a). A `<conv_id>.shelf` marker
 * records the capturing principal's write-target shelf; a VALID marker routes submissions into that
 * shelf's inbox through the store's SYSTEM-PIPELINE seam (`store.systemSubmitToInbox`).
 *
 * SYSTEM PIPELINE, NOT A PRINCIPAL WRITE (spec 062 §4 / review A1 + F). Every submit on BOTH marker
 * paths goes through `systemSubmitToInbox` — shelf-scoped, UN-gated by `writable` — never through the
 * write-gated `store.forShelf(shelf).submitToInbox`. These facts are `system-consolidator`-bound
 * material (the intake sweep drains them as `INTAKE_ACTOR_ID`), not new principal-attributed material,
 * and `writable` gates the latter only — the same rule A1 applied to grooming. The gated view here was
 * a capture-loss bug: a read-only shelf threw `ShelfNotWritableError` per fact, the per-fact fail-soft
 * swallowed it, and the buffer was then deleted. Which shelf is chosen is a routing decision (below);
 * whether that shelf is writable is NOT a gate on it.
 *
 * Fail-soft with NO fact loss (review E):
 *   - NO marker → the DEFAULT router (which never writes a marker) or a pre-062 buffer: the vault-root
 *     inbox IS the groom set, so route there, byte-identical to before.
 *   - A marker EXISTS but is MALFORMED — bad JSON, wrong shape, or `writable !== true` (a marker records
 *     what `resolveWriteTarget` returned, which is ALWAYS writable, so a non-writable/absent flag means
 *     the marker did NOT come from T1: corrupt, untrusted data — an INTEGRITY check on the marker, not a
 *     write gate on the submit) — the buffer was captured under a router that writes markers (a Teams
 *     router), whose groom set typically EXCLUDES the vault root. Falling back to the root inbox would
 *     drop the facts into an inbox no sweep ever drains (a silent black hole). Instead route to the FIRST
 *     groom shelf's inbox (`shelves(system,"groom")[0]` — guaranteed swept, and accepted even when that
 *     shelf is read-only), and only to the root inbox when the groom set is empty/unavailable. Log loudly.
 */
function shelfSubmit(
  store: LibrarianStore,
  markerPath: string,
  convBase: string,
  warn: Warn,
): (text: string, hints: InboxSubmissionHints) => InboxItemRef {
  // No marker → default router / pre-062 buffer → the vault-root inbox is correct and swept.
  if (!fs.existsSync(markerPath)) return (text, hints) => store.submitToInbox(text, hints);
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Shelf).prefix === "string" &&
      typeof (parsed as Shelf).id === "string" &&
      (parsed as Shelf).writable === true // the writeTarget is always writable — absent/false ⇒ corrupt
    ) {
      const shelf = parsed as Shelf;
      // EAGER prefix validation, INSIDE the try (load-bearing): the returned closure is invoked once
      // PER FACT inside the sweep's per-fact fail-soft, so ANY throw from resolving the target there is
      // swallowed — and the buffer is deleted regardless: capture loss. Validate the marker's prefix
      // HERE (the same rule the store applies when it first materialises a shelf), so a malformed
      // prefix falls back to the groom set below instead of throwing per fact.
      validateShelfSet([shelf]);
      // The SYSTEM seam, not the gated view — see this function's doc comment. A marker's shelf is a
      // system-pipeline TARGET; the marker's `writable === true` above is a marker-integrity check.
      return (text, hints) => store.systemSubmitToInbox(shelf, text, hints);
    }
    warn(
      { file: `${convBase}.shelf` },
      "transcript shelf-marker is malformed (bad shape / not writable); routing to the first groom " +
        "shelf's inbox (fail-soft)",
    );
  } catch (err) {
    warn(
      { file: `${convBase}.shelf`, err: (err as Error).message },
      "transcript shelf-marker read/parse/validation failed; routing to the first groom shelf's inbox " +
        "(fail-soft)",
    );
  }
  return groomFallbackSubmit(store, warn);
}

/**
 * The malformed-marker fallback (review E): submit to the FIRST shelf of the intake sweep's groom set
 * (`shelves(system,"groom")[0]`) — the inbox that sweep is guaranteed to drain — and only to the
 * vault-root inbox when the groom set is empty or its resolution throws. The system principal mirrors
 * the intake sweep's own `system-consolidator` principal so the fallback lands in exactly a swept inbox.
 *
 * Routes through the store's UN-gated system seam (`systemSubmitToInbox`), NOT the write-gated
 * `forShelf` view (review F): router order is PLUGIN-chosen and system pipelines are shelf-scoped
 * rather than writability-gated (spec 062 §4 / review A1 legitimises `writable: false` shelves inside a
 * groom set), so a READ-ONLY FIRST groom shelf is a legal shape. Through the gated view every fact threw
 * `ShelfNotWritableError`, the per-fact fail-soft swallowed it, and the buffer + markers were then
 * deleted: `facts: 0`, every inbox empty, PERMANENT capture loss — worse than the root-inbox behaviour
 * this fallback replaced. The un-gated seam makes "no fact loss" true for every legal groom set.
 */
function groomFallbackSubmit(
  store: LibrarianStore,
  warn: Warn,
): (text: string, hints: InboxSubmissionHints) => InboxItemRef {
  try {
    const systemPrincipal: Principal = {
      kind: "system",
      actorId: "system-consolidator", // mirrors the intake sweep's INTAKE_ACTOR_ID principal
      roles: ["system"],
    };
    const groomShelves = store.vaultRouter.shelves(systemPrincipal, "groom");
    const first = groomShelves[0];
    if (first) {
      // Validate EAGERLY, inside this try (same reason as shelfSubmit): the closure runs per fact
      // inside the sweep's fail-soft, so a malformed groom-set prefix must divert to the root inbox
      // HERE rather than throw (and be swallowed) once per fact.
      validateShelfSet([first]);
      return (text, hints) => store.systemSubmitToInbox(first, text, hints);
    }
    warn(
      {},
      "transcript shelf-marker fallback: the groom set is empty; routing to the vault-root inbox",
    );
  } catch (err) {
    warn(
      { err: (err as Error).message },
      "transcript shelf-marker fallback: resolving the groom set failed; routing to the vault-root " +
        "inbox (fail-soft)",
    );
  }
  return (text, hints) => store.submitToInbox(text, hints);
}

/** Read a claimed buffer's text; fail-soft to "" so a read error is a no-fact extract. */
function readClaimed(procPath: string, warn: Warn): string {
  try {
    return fs.readFileSync(procPath, "utf8");
  } catch (err) {
    warn({ err: (err as Error).message }, "transcript claim read failed (fail-soft)");
    return "";
  }
}

/**
 * Hints stamped on every auto-captured candidate fact (spec T2): a `source` /
 * harness tag so the provenance is visible in the inbox and on the resulting
 * memory. (The Claude adapter's per-entry gitBranch is a T3 concern and rides in
 * the buffer; v1 tags the source + harness here.)
 */
function autoCaptureHints(harness: string | null): { tags: string[] } {
  return {
    tags: [
      "auto_capture",
      "source:auto_capture",
      ...(harness ? [`harness:${normalizeHarnessTag(harness)}`] : []),
    ],
  };
}

function readHarnessMarker(dataDir: string, convBase: string, warn: Warn): string | null {
  const markerPath = transcriptProcessingHarnessMarkerPath(dataDir, convBase);
  if (!fs.existsSync(markerPath)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("harness" in parsed) ||
      typeof parsed.harness !== "string" ||
      parsed.harness.trim() === ""
    ) {
      throw new Error("invalid harness marker");
    }
    return parsed.harness;
  } catch (err) {
    warn(
      { file: path.basename(markerPath), err: (err as Error).message },
      "transcript harness-marker read failed; omitting harness attribution (fail-soft)",
    );
    return null;
  }
}

/**
 * Move every active sidecar to the just-claimed buffer generation before the first async boundary.
 * The HTTP intake handler is synchronous, so a late delta cannot interleave between the buffer rename
 * and these marker renames in the server process. It therefore creates a fresh active marker instead
 * of inheriting one that the in-flight extraction will later delete.
 */
function claimMarkers(dataDir: string, convBase: string): void {
  for (const [active, claimed] of markerPairs(dataDir, convBase)) {
    try {
      fs.mkdirSync(path.dirname(claimed), { recursive: true });
      if (fs.existsSync(claimed)) {
        throw new Error(`claimed transcript marker already exists: ${path.basename(claimed)}`);
      }
      fs.renameSync(active, claimed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function removeClaimedMarkers(dataDir: string, convBase: string): void {
  for (const [, claimed] of markerPairs(dataDir, convBase)) {
    fs.rmSync(claimed, { force: true });
  }
}

function recoverClaimedMarkers(dataDir: string, convBase: string): void {
  for (const [active, claimed] of markerPairs(dataDir, convBase)) {
    if (!fs.existsSync(claimed)) continue;
    if (fs.existsSync(active)) fs.rmSync(claimed, { force: true });
    else fs.renameSync(claimed, active);
  }
}

/**
 * Failed-extraction count for one conversation, kept beside its claimed markers
 * (the claimed-marker reaper only touches `.ended` / `.shelf` / `.harness`).
 */
function attemptsPath(dataDir: string, convBase: string): string {
  const markersDir = path.dirname(transcriptProcessingHarnessMarkerPath(dataDir, convBase));
  return path.join(markersDir, `${convBase}.attempts`);
}

/** Count one more failed extraction and return the new total. */
function recordFailedAttempt(dataDir: string, convBase: string): number {
  const file = attemptsPath(dataDir, convBase);
  let previous = 0;
  try {
    const parsed = Number.parseInt(fs.readFileSync(file, "utf8"), 10);
    if (Number.isInteger(parsed) && parsed > 0) previous = parsed;
  } catch {
    // No count yet: this is the first failure.
  }
  const attempts = previous + 1;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(attempts), "utf8");
  return attempts;
}

function clearAttempts(dataDir: string, convBase: string): void {
  fs.rmSync(attemptsPath(dataDir, convBase), { force: true });
}

function markerPairs(dataDir: string, convBase: string): Array<[string, string]> {
  return [
    [endedMarkerPath(dataDir, convBase), transcriptProcessingEndedMarkerPath(dataDir, convBase)],
    [
      transcriptShelfMarkerPath(dataDir, convBase),
      transcriptProcessingShelfMarkerPath(dataDir, convBase),
    ],
    [
      transcriptHarnessMarkerPath(dataDir, convBase),
      transcriptProcessingHarnessMarkerPath(dataDir, convBase),
    ],
  ];
}

function normalizeHarnessTag(harness: string): string {
  const normalized = harness
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 64);
  return normalized || "unknown";
}

/**
 * Build the extractor's LLM client from the intake consumer config — the SAME
 * provider/model/token the intake judge uses (spec T2: reuse the curator's
 * client). Returns null when the config isn't operational or the token can't be
 * decrypted; the caller then leaves buffers for a later tick. Honours an injected
 * builder (tests) exactly like runIntakeTick.
 */
function buildExtractorClient(
  store: LibrarianStore,
  inject: TranscriptSweepOptions["buildClient"],
  warn: Warn,
): LlmClient | null {
  try {
    migrateLegacyCuratorLlm(store);
    const llm = readConsumerConfig(store, "intake");
    if (!llm.isOperational) return null;
    let token: string | null;
    try {
      token = resolveConsumerToken(store, "intake");
    } catch {
      return null;
    }
    if (!token) return null;
    const build = inject ?? ((conn, secret) => createGroomingLlmClient({ ...conn, token: secret }));
    return build(consumerConnection(llm), token);
  } catch (err) {
    warn({ err: (err as Error).message }, "transcript extractor client build failed (fail-soft)");
    return null;
  }
}

// Re-export the path helpers so the buffer-path contract has ONE import surface
// for the sweep's consumers (the scheduler wiring + tests). They live in
// transcript-buffer.ts (shared with the T1 ingestion half).
export {
  endedMarkerPath,
  sanitizeConvId,
  transcriptBufferPath,
  transcriptProcessingPath,
  transcriptsDir,
};
