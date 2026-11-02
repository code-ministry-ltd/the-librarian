// Transcript-intake: the harness-agnostic capture door (spec
// 2026-06-16-harness-auto-capture, T1; SC5, SC6, SC11).
//
// This is the server-side half of automatic capture's *ingestion* clock
// (spec §4.2/§4.3): a per-turn delta from any harness adapter lands here,
// is redacted, and is appended forward-only to a per-conversation sidecar
// buffer. The *extraction* clock (settle-sweep → curator) is T2 and reads
// the buffer this writes — it is deliberately NOT here.
//
// Contract design (spec SC11 "uniform contract"): the payload is
// harness-agnostic — the Claude adapter is the first consumer, but a Pi /
// Hermes / mock adapter validates against this same shape. Validation is
// strict + teaching (AGENTS.md "errors teach"); a malformed body is a 400,
// never a thrown 500.
//
// Privacy invariants (AGENTS.md "privacy is the product", spec §4.5):
//   - REDACT ON INTAKE, BEFORE the disk write. redactSecrets runs over each
//     turn's text and the REDACTED text is what's appended — no raw secret
//     ever reaches the sidecar (SC5).
//   - The buffer lives OUTSIDE the git vault, at `<data-dir>/transcripts/`,
//     sibling to `vault/` and to the other sidecars (`intake-runs.json`) —
//     never committed (SC6). `data/` is gitignored.
//   - `conv_id` is sanitized to a single safe path segment so a hostile
//     adapter can't path-traverse out of `transcripts/` (SC6).
//   - GATE COHERENCE: if nothing would use the buffer — curator intake AND the
//     journal both off (isCaptureEnabled) — this REFUSES and buffers NOTHING, so no
//     raw text sits at rest for a dead pipeline. The caller/hook is told capture is
//     disabled so it can log it; the sweep applies the same gate.
//
// Fail-soft (AGENTS.md): an internal error here returns a clean JSON result,
// never a 500 stack trace that could break an agent's turn.

import fs from "node:fs";
import path from "node:path";
import {
  TRANSCRIPTS_DIR,
  type LibrarianStore,
  type Principal,
  endedMarkerPath,
  isCaptureEnabled,
  redactSecrets,
  sanitizeConvId,
  transcriptBufferPath,
  transcriptHarnessMarkerPath,
  transcriptShelfMarkerPath,
} from "@librarian/core";
import { z } from "zod";
import { logger } from "../logging.js";

// The sidecar buffer path contract (dir, sanitisation, buffer + marker paths)
// lives in @librarian/core so the T1 ingestion half and the T2 settle-sweep can
// never drift on it. Re-exported here so existing T1 consumers/tests keep their
// import surface.
export {
  TRANSCRIPTS_DIR,
  endedMarkerPath,
  sanitizeConvId,
  transcriptBufferPath,
  transcriptHarnessMarkerPath,
};

// The literal private-mode marker (AGENTS.md "private mode … never bypass"). The
// adapter is supposed to strip private turns upstream; this is a cheap SERVER-SIDE
// BACKSTOP so a turn carrying the marker is never buffered even if the client
// failed to filter it. Kept as a plain substring check — exact, allocation-free,
// and the same literal the harness toggles in-conversation.
const PRIVATE_MARKER = "[librarian:private=on]";

// Hard append-time ceiling (DoS backstop). The sweep's size-cap only triggers a
// settle on its 5-min tick; between ticks the endpoint would otherwise append
// UNBOUNDED, so a hostile/runaway adapter could balloon a single buffer. This is a
// hard ceiling enforced PER APPEND, decoupled from the sweep: once the buffer is
// already over it, further appends are refused cleanly (accepted:false + reason).
// Defaults to LIBRARIAN_TRANSCRIPT_MAX_BYTES (the same generous safety valve the
// sweep uses, 5 MB) so a deployment tuning one tunes both; a buffer at the cap is
// already far larger than any real conversation delta.
export const TRANSCRIPT_HARD_MAX_BYTES = Number(
  process.env.LIBRARIAN_TRANSCRIPT_MAX_BYTES ?? 5_000_000,
);

// Strict runtime validation (the repo validates rich inputs with zod inside the
// handler; see schemas.ts note). strictObject so an unknown key is a 400 rather
// than silently ignored — a malformed adapter should hear about it. The TS
// payload types are inferred FROM these schemas so the contract has a single
// source of truth (and lines up with exactOptionalPropertyTypes).
const turnSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  ts: z.string().optional(),
});

const payloadSchema = z.strictObject({
  conv_id: z.string().min(1),
  harness: z.string().min(1),
  seq: z.number().int().nonnegative(),
  turns: z.array(turnSchema),
  ended: z.boolean().optional(),
  // Spec 077 §4.8: the project the conversation is about (the repo or folder name), shown
  // on its journal episode. Optional; adapters send it only to a server whose /healthz
  // advertises `journal` (older servers reject unknown keys).
  project: z.string().min(1).max(200).optional(),
});

/** A single already-non-private turn (the adapter filtered private turns upstream). */
export type TranscriptTurn = z.infer<typeof turnSchema>;

/**
 * The uniform, harness-agnostic delta payload (spec SC11). `conv_id` keys the
 * per-conversation buffer (= the harness's conversation/session id — never
 * `$USER` or `cwd`, spec §4.11); `harness` names the adapter; `seq` is the
 * adapter's monotonic delta counter; `turns` are already-non-private; `ended`
 * is the explicit-end accelerator hint (consumed by the T2 settle-sweep).
 */
export type TranscriptIntakePayload = z.infer<typeof payloadSchema>;

/** A validated-and-handled intake outcome, folded into an HTTP response by the route. */
export interface TranscriptIntakeResult {
  /** HTTP status the route should send. */
  status: number;
  /** JSON body the route should send. */
  body: Record<string, unknown>;
}

/**
 * Drop any turn carrying the private-mode marker (AGENTS.md: never bypass private
 * mode). The adapter SHOULD have stripped these upstream; this is the server-side
 * backstop so a marked turn is never buffered even if the client failed to.
 */
export function dropPrivateTurns(turns: TranscriptTurn[]): TranscriptTurn[] {
  return turns.filter((turn) => !turn.text.includes(PRIVATE_MARKER));
}

/**
 * Render redacted turns as a forward-only markdown append. Each turn is a small
 * block carrying its role, optional timestamp, and the REDACTED text. The format
 * is deliberately simple + greppable; the T2 extractor reads it back whole.
 */
export function renderTurns(turns: TranscriptTurn[], seq: number): string {
  return turns
    .map((turn) => {
      const stamp = turn.ts ? ` ts=${turn.ts}` : "";
      const { redacted } = redactSecrets(turn.text);
      return `### ${turn.role} (seq=${seq}${stamp})\n\n${redacted}\n`;
    })
    .join("\n");
}

/**
 * Validate, gate-check, redact, and append a transcript delta to its sidecar
 * buffer. Pure over the store + raw body; returns the outcome the route folds
 * into a response. Never throws — every failure path returns a clean result and
 * logs a warning (fail-soft, AGENTS.md).
 *
 * Outcomes:
 *   - malformed body → 400 with a teaching `error` (SC11).
 *   - intake gate off → 200 `{ accepted: false, disabled: true }`, NOTHING
 *     written (spec Q-gate / gate-refuse).
 *   - buffer already over the hard cap → 200 `{ accepted: false, reason }`, NOTHING
 *     appended (DoS backstop, independent of the sweep's size-cap).
 *   - well-formed + gate on → 200 `{ accepted: true, buffered: <n> }`, redacted
 *     turns appended (SC5, SC6, SC11); `<n>` counts only the non-private turns
 *     (any turn carrying `[librarian:private=on]` is skipped — server backstop).
 *   - unexpected internal error → 200 `{ accepted: false }` + a logged warning
 *     (fail-soft; never a 500 into the agent's turn).
 */
export function handleTranscriptIntake(
  store: LibrarianStore,
  raw: unknown,
  principal?: Principal,
): TranscriptIntakeResult {
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) {
    // Teaching error: name the first offending field + reason (AGENTS.md).
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "(root)";
    return {
      status: 400,
      body: {
        accepted: false,
        error: `Malformed transcript payload at "${where}": ${issue?.message ?? "invalid"}`,
      },
    };
  }
  const payload = parsed.data;

  try {
    // GATE COHERENCE: refuse + buffer nothing when neither intake nor the journal
    // would use it — no raw text at rest for a dead pipeline.
    if (!isCaptureEnabled(store)) {
      return {
        status: 200,
        body: {
          accepted: false,
          disabled: true,
          reason:
            "Capture is disabled: curator intake and the journal are both off. Turn either " +
            "on in the dashboard (Settings → Curator → Intake) to capture conversations. " +
            "Nothing was buffered.",
        },
      };
    }

    const bufferPath = transcriptBufferPath(store.dataDir, payload.conv_id);

    // HARD APPEND CAP (DoS backstop, independent of the sweep): if the existing
    // buffer is ALREADY over the hard ceiling, refuse this append cleanly instead
    // of growing it unbounded between 5-min sweep ticks. Returns accepted:false +
    // a reason so the adapter can log it and back off; never throws. A missing
    // buffer is size 0 (statSync throws → treated as below the cap).
    let existingSize = 0;
    try {
      existingSize = fs.statSync(bufferPath).size;
    } catch {
      existingSize = 0; // no buffer yet
    }
    if (existingSize > TRANSCRIPT_HARD_MAX_BYTES) {
      return {
        status: 200,
        body: {
          accepted: false,
          conv_id: payload.conv_id,
          reason:
            `Capture buffer for this conversation is over the hard size cap ` +
            `(${TRANSCRIPT_HARD_MAX_BYTES} bytes); not appending. It will be extracted + rotated ` +
            `by the next settle-sweep. Re-ship after it settles.`,
        },
      };
    }

    // SERVER-SIDE PRIVATE BACKSTOP (AGENTS.md: never bypass private mode): drop any
    // turn carrying the marker before it can be buffered, even if the adapter
    // failed to strip it upstream.
    const turns = dropPrivateTurns(payload.turns);

    // REDACT ON INTAKE, then append forward-only. The dir is created lazily and
    // lives OUTSIDE the git vault (sibling to vault/, like intake-runs.json).
    fs.mkdirSync(path.dirname(bufferPath), { recursive: true });
    const block = renderTurns(turns, payload.seq);
    // Always end the append with a trailing newline so successive deltas don't
    // run together; an empty `turns[]` (or an all-private delta) is a valid no-op.
    fs.appendFileSync(bufferPath, turns.length ? `${block}\n` : "", "utf8");

    // HARNESS PROVENANCE: record the adapter beside the buffer so
    // the settle-sweep can stamp `harness:<name>` on every extracted fact. The
    // marker is write-once for one BUFFER GENERATION: a later caller cannot relabel
    // existing turns. The sweep claims it with the `.md` before awaiting extraction,
    // so a late delta starts a fresh marker for the next generation. Fail-soft —
    // losing attribution must not lose the turns.
    try {
      const harnessPath = transcriptHarnessMarkerPath(store.dataDir, payload.conv_id);
      if (!fs.existsSync(harnessPath)) {
        fs.writeFileSync(
          harnessPath,
          JSON.stringify({
            harness: payload.harness,
            ...(payload.project ? { project: payload.project } : {}),
          }),
          "utf8",
        );
      }
    } catch (harnessError) {
      logger.warn(
        { harness: payload.harness, err: (harnessError as Error).message },
        "transcript harness-marker write failed; facts will omit harness attribution (fail-soft)",
      );
    }

    // SHELF ROUTING (spec 062 SC 8a): record the capturing principal's write-target shelf beside
    // the buffer so the T2 settle-sweep submits this conversation's extracted facts into THAT
    // shelf's inbox. A NEW sidecar (never a buffer-format change → no migration), written ONLY when
    // the target shelf is NON-default: the DEFAULT router resolves to the vault-root shelf (prefix
    // ""), so it writes nothing and the transcript flow stays byte-identical. Written write-once (it
    // is absent until the first delta of a fresh buffer generation). Fail-soft — a resolve/write failure loses
    // only the routing (facts still land in the vault-root inbox), never the buffered delta.
    if (principal) {
      try {
        const shelf = store.resolveWriteTarget(principal);
        const markerPath = transcriptShelfMarkerPath(store.dataDir, payload.conv_id);
        if (shelf.prefix !== "" && !fs.existsSync(markerPath)) {
          fs.writeFileSync(markerPath, JSON.stringify(shelf), "utf8");
        }
      } catch (shelfError) {
        logger.warn(
          { harness: payload.harness, err: (shelfError as Error).message },
          "transcript shelf-marker write failed; facts will route to the default inbox (fail-soft)",
        );
      }
    }

    // EXPLICIT-END ACCELERATOR (spec §4.4): when the adapter signals the
    // conversation ended (`ended:true`), drop a sibling `<conv_id>.ended` marker so
    // the T2 settle-sweep extracts this buffer on its NEXT tick without waiting for
    // the idle window. The marker is a minimal sidecar (its mere presence is the
    // signal) and is deleted with the buffer after extraction. Touch is fail-soft:
    // a marker-write failure only loses the accelerator (idle still settles the
    // buffer), so it must not fail the delta that was already buffered.
    if (payload.ended) {
      try {
        fs.writeFileSync(endedMarkerPath(store.dataDir, payload.conv_id), "", "utf8");
      } catch (markerError) {
        logger.warn(
          { harness: payload.harness, err: (markerError as Error).message },
          "transcript end-marker write failed; falling back to idle settle (fail-soft)",
        );
      }
    }

    return {
      status: 200,
      body: {
        accepted: true,
        // Count the turns actually buffered (post private-skip), not the raw input.
        buffered: turns.length,
        conv_id: payload.conv_id,
        ...(payload.ended ? { ended: true } : {}),
      },
    };
  } catch (error) {
    // Fail-soft: never throw out of the request handler. Log + return a clean,
    // non-accepting result so the caller knows the delta did NOT land (and can
    // re-ship next turn) — without a stack trace reaching the agent.
    logger.warn(
      { harness: payload.harness, seq: payload.seq, err: (error as Error).message },
      "transcript intake failed; delta not buffered (fail-soft)",
    );
    return { status: 200, body: { accepted: false } };
  }
}
