// Import past conversations (spec 079 §5): the server side of `librarian import`.
//
//   GET  /import/policy → which steps are on, the frozen cutoffs, and the limits.
//   POST /import/plan   → a dry run over a batch of {conv_id, harness, ended_at}: what
//                         would happen to each, with NO conversation text sent.
//   POST /import        → one whole conversation. The SERVER decides the steps (§2) and
//                         applies the allowance; a client that ignores the policy can't
//                         get past it.
//
// An accepted conversation is written as an ordinary, already-settled transcript
// buffer whose harness marker carries the agreed step plan, so the existing settle-sweep
// does the work — after every live buffer, a few per tick. Redaction and the private-mode
// backstop are the same as /transcript's.

import fs from "node:fs";
import path from "node:path";
import {
  type ImportPlan,
  type LibrarianStore,
  type Principal,
  QUEUED,
  acceptImport,
  endedMarkerPath,
  importPolicy,
  isCaptureEnabled,
  planImport,
  planQueuesAnything,
  readImportConfig,
  transcriptBufferPath,
  transcriptHarnessMarkerPath,
  transcriptProcessingPath,
  transcriptShelfMarkerPath,
} from "@librarian/core";
import { z } from "zod";
import { logger } from "../logging.js";
import { TRANSCRIPT_HARD_MAX_BYTES, dropPrivateTurns, renderTurns } from "./transcript-intake.js";

/** Body cap for POST /import: a whole conversation, up to the buffer ceiling. */
export const IMPORT_MAX_BODY_BYTES = TRANSCRIPT_HARD_MAX_BYTES + 1024 * 1024;
/** Most conversations one /import/plan call may ask about. */
export const IMPORT_PLAN_MAX_BATCH = 1000;

const harnessSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "expected a lowercase harness name such as 'claude'");
const stepsSchema = z
  .array(z.enum(["memories", "journal"]))
  .min(1)
  .optional();
const isoSchema = z.string().refine((v) => Number.isFinite(Date.parse(v)), {
  message: "expected an ISO-8601 timestamp",
});

const planSchema = z.strictObject({
  conversations: z
    .array(
      z.strictObject({ conv_id: z.string().min(1), harness: harnessSchema, ended_at: isoSchema }),
    )
    .max(IMPORT_PLAN_MAX_BATCH),
  only: stepsSchema,
});

const importSchema = z.strictObject({
  conv_id: z.string().min(1),
  harness: harnessSchema,
  project: z.string().min(1).max(200).optional(),
  ended_at: isoSchema,
  turns: z
    .array(
      z.strictObject({
        role: z.enum(["user", "assistant"]),
        text: z.string(),
        ts: isoSchema,
      }),
    )
    .min(1),
  only: stepsSchema,
});

export interface ImportResult {
  status: number;
  body: Record<string, unknown>;
}

function teach(error: z.ZodError, what: string): ImportResult {
  const issue = error.issues[0];
  const where = issue?.path.length ? issue.path.join(".") : "(root)";
  return {
    status: 400,
    body: {
      accepted: false,
      error: `Malformed ${what} at "${where}": ${issue?.message ?? "invalid"}`,
    },
  };
}

const BUSY =
  "already queued, or being captured right now; it is processed shortly and then recorded";

/** Is there a buffer for this conversation waiting or in progress? */
function isBusy(store: LibrarianStore, convId: string): boolean {
  return (
    fs.existsSync(transcriptBufferPath(store.dataDir, convId)) ||
    fs.existsSync(transcriptProcessingPath(store.dataDir, convId))
  );
}

export function handleImportPolicy(store: LibrarianStore): ImportResult {
  return { status: 200, body: { ...importPolicy(store) } };
}

export function handleImportPlan(store: LibrarianStore, raw: unknown, now: Date): ImportResult {
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) return teach(parsed.error, "import plan request");
  importPolicy(store); // freezes any cutoff that now has evidence
  let allowance = readImportConfig(store).allowanceRemaining;
  const plans = parsed.data.conversations.map((c) => {
    if (isBusy(store, c.conv_id)) {
      return { conv_id: c.conv_id, harness: c.harness, memories: BUSY, journal: BUSY };
    }
    const plan = planImport(
      store,
      { ...c, ...(parsed.data.only ? { only: parsed.data.only } : {}) },
      now,
      allowance,
    );
    if (planQueuesAnything(plan)) allowance -= 1;
    return { conv_id: c.conv_id, harness: c.harness, ...plan };
  });
  return { status: 200, body: { plans } };
}

export function handleImport(
  store: LibrarianStore,
  raw: unknown,
  principal: Principal | undefined,
  now: Date,
): ImportResult {
  const parsed = importSchema.safeParse(raw);
  if (!parsed.success) return teach(parsed.error, "import payload");
  const payload = parsed.data;
  try {
    if (!isCaptureEnabled(store)) {
      return {
        status: 200,
        body: {
          accepted: false,
          reason:
            "Curator intake and the journal are both off, so there is nothing to import into. " +
            "Turn either on in the dashboard (Settings → Curator → Intake).",
        },
      };
    }
    importPolicy(store);
    const plan: ImportPlan = planImport(
      store,
      {
        conv_id: payload.conv_id,
        harness: payload.harness,
        ended_at: payload.ended_at,
        ...(payload.only ? { only: payload.only } : {}),
      },
      now,
    );
    if (!planQueuesAnything(plan)) {
      return { status: 200, body: { accepted: false, conv_id: payload.conv_id, steps: plan } };
    }

    const bufferPath = transcriptBufferPath(store.dataDir, payload.conv_id);
    if (isBusy(store, payload.conv_id)) {
      return { status: 200, body: { accepted: false, conv_id: payload.conv_id, reason: BUSY } };
    }

    const turns = dropPrivateTurns(payload.turns);
    const text = turns.length ? `${renderTurns(turns, 0)}\n` : "";
    if (Buffer.byteLength(text, "utf8") > TRANSCRIPT_HARD_MAX_BYTES) {
      return {
        status: 200,
        body: {
          accepted: false,
          conv_id: payload.conv_id,
          reason: `This conversation is larger than the server's ${TRANSCRIPT_HARD_MAX_BYTES}-byte transcript limit, so it can't be imported.`,
        },
      };
    }

    // Markers first, the buffer last: the sweep only ever sees a buffer whose plan is
    // already beside it, so an import can never be processed as if it were live.
    fs.mkdirSync(path.dirname(bufferPath), { recursive: true });
    fs.writeFileSync(
      transcriptHarnessMarkerPath(store.dataDir, payload.conv_id),
      JSON.stringify({
        harness: payload.harness,
        ...(payload.project ? { project: payload.project } : {}),
        import: { facts: plan.memories === QUEUED, journal: plan.journal === QUEUED },
      }),
      "utf8",
    );
    if (principal) {
      try {
        const shelf = store.resolveWriteTarget(principal);
        if (shelf.prefix !== "") {
          fs.writeFileSync(
            transcriptShelfMarkerPath(store.dataDir, payload.conv_id),
            JSON.stringify(shelf),
            "utf8",
          );
        }
      } catch (shelfError) {
        logger.warn(
          { err: (shelfError as Error).message },
          "import shelf-marker write failed; facts route to the default inbox (fail-soft)",
        );
      }
    }
    // Already settled: the sweep picks it up on its next tick (after live buffers).
    fs.writeFileSync(endedMarkerPath(store.dataDir, payload.conv_id), "", "utf8");
    acceptImport(store, plan, now);
    fs.writeFileSync(bufferPath, text, "utf8");

    return {
      status: 200,
      body: { accepted: true, conv_id: payload.conv_id, buffered: turns.length, steps: plan },
    };
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "import failed; nothing queued (fail-soft)");
    return { status: 200, body: { accepted: false, conv_id: payload.conv_id } };
  }
}
