// Self-healing repair (spec 075 §5). Grooming's nightly pass can't fix two kinds
// of damage on its own:
//
//   - memories over the size cap: grooming sees bodies cut to the cap and, per
//     ADR 0013, refuses to rewrite a body it can't see whole — so a grab-bag past
//     the cap could never be split;
//   - facts lost in past merges: they live only in archived memories, which
//     grooming never revisits.
//
// Repair runs after a scheduled or run-now pass, per shelf, on a small budget:
// it offers the largest oversized memories for splitting (full body, one per
// call) and the most recently archived merge sources whose specific terms appear
// in no active memory for recovery (source + successors, one per call). Every
// operation then goes through the ordinary grooming pipeline — validation, the
// threshold (ADR 0014), the guards (ADR 0015), the audit record — so at
// threshold 0 a repair applies itself, and an unsafe one is refused.
//
// A ledger in settings records each offer, so a memory isn't offered again
// until it changes (or, after a refusal, for 30 days).

import { createHash } from "node:crypto";
import { buildRepairPrompt } from "./curator-repair-prompt.js";
import { MAX_MEMORY_BODY_CHARS, distinctiveTokens } from "./curator-guards.js";
import { applyOperations } from "./grooming-apply.js";
import { DEFAULT_LOCK_TTL_MS } from "./grooming-enqueue.js";
import type { EvidenceSlice, MemoryEvidenceItem } from "./grooming-evidence.js";
import { LlmClientError, type LlmClient } from "./grooming-llm-client.js";
import { type GroomingOperation, parseGroomingOutput } from "./grooming-output.js";
import { redactSecrets } from "./grooming-redaction.js";
import { type ValidatedOperation, validateOperations } from "./grooming-validate.js";
import type { GroomingStore } from "./grooming-worker.js";
import { preservesOriginal } from "./intake/edit.js";
import type { CurationRun } from "./store/curation-store.js";
import type { Memory } from "./store/memory-types.js";

/** A memory body larger than this is not offered for splitting (too big for one call). */
export const MAX_REPAIR_BODY_CHARS = 60_000;
/** Settings key holding the repair ledger (JSON). */
export const REPAIR_LEDGER_KEY = "curator.grooming.repair_ledger";
const REFUSAL_RETRY_DAYS = 30;
const MAX_SUCCESSORS = 3;
const MIN_LOST_TOKENS = 3;
const MIN_LOST_FRACTION = 0.3;

export type RepairOutcome = "applied" | "proposed" | "noop" | "refused";

export interface RepairLedgerEntry {
  outcome: RepairOutcome;
  /** ISO time the item was last offered. */
  at: string;
  /** Hash of the content the offer was judged on; a change re-offers it. */
  fingerprint: string;
}

/** The ledger, keyed `<shelf id>:<memory id>`. */
export type RepairLedger = Record<string, RepairLedgerEntry>;

export interface RepairLedgerStore {
  getSetting: (key: string) => string | null;
  setSetting: (key: string, value: string) => void;
}

/** Read the ledger; a missing or corrupt value is an empty ledger (fail-soft). */
export function readRepairLedger(store: RepairLedgerStore): RepairLedger {
  const raw = store.getSetting(REPAIR_LEDGER_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as RepairLedger)
      : {};
  } catch {
    return {};
  }
}

export interface OversizedItem {
  memory: Memory;
  fingerprint: string;
}

export interface RecoveryItem {
  source: Memory;
  successors: Memory[];
  fingerprint: string;
}

export interface RepairSelection {
  oversized: OversizedItem[];
  recovery: RecoveryItem[];
}

export interface SelectRepairOptions {
  shelfId: string;
  ledger: RepairLedger;
  splitPerRun: number;
  recoverPerRun: number;
  now: Date;
}

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function ledgerAllows(
  entry: RepairLedgerEntry | undefined,
  fingerprint: string,
  now: Date,
): boolean {
  if (!entry) return true;
  if (entry.fingerprint !== fingerprint) return true; // something changed since
  if (entry.outcome !== "refused") return false; // judged as it stands — leave it
  const age = now.getTime() - new Date(entry.at).getTime();
  return !(age < REFUSAL_RETRY_DAYS * 24 * 60 * 60 * 1000);
}

const supersedesOf = (memory: Memory): string[] => {
  const value = memory.curator_note?.supersedes;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
};

/** Deterministic selection for one shelf (spec 075 §5.1). */
export function selectRepairItems(
  store: Pick<GroomingStore, "listAll">,
  options: SelectRepairOptions,
): RepairSelection {
  const active = store.listAll({ status: "active" });
  const archived = store.listAll({ status: "archived" });
  const key = (id: string) => `${options.shelfId}:${id}`;

  const oversized = active
    .filter(
      (m) =>
        m.body.length > MAX_MEMORY_BODY_CHARS &&
        m.body.length <= MAX_REPAIR_BODY_CHARS &&
        redactSecrets(m.body).count === 0, // a masked body can't be rewritten whole (ADR 0013)
    )
    .sort((a, b) => b.body.length - a.body.length || (a.id < b.id ? -1 : 1))
    .map((memory) => ({ memory, fingerprint: sha(memory.body) }))
    .filter((item) =>
      ledgerAllows(options.ledger[key(item.memory.id)], item.fingerprint, options.now),
    )
    .slice(0, Math.max(0, options.splitPerRun));

  // Successor graph: source id → the memories whose curator_note.supersedes names it.
  const byId = new Map([...active, ...archived].map((m) => [m.id, m]));
  const successorsOf = new Map<string, string[]>();
  for (const memory of byId.values()) {
    for (const sourceId of supersedesOf(memory)) {
      successorsOf.set(sourceId, [...(successorsOf.get(sourceId) ?? []), memory.id]);
    }
  }
  const activeText = active
    .map((m) => `${m.title}\n${m.body}`)
    .join("\n")
    .toLowerCase();

  const activeSuccessors = (sourceId: string): Memory[] => {
    const found = new Map<string, Memory>();
    const seen = new Set<string>([sourceId]);
    const queue = [...(successorsOf.get(sourceId) ?? [])];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      const memory = byId.get(id);
      if (!memory) continue;
      if (memory.status === "active") found.set(id, memory);
      else queue.push(...(successorsOf.get(id) ?? [])); // an archived intermediate: follow on
    }
    return [...found.values()];
  };

  const recovery: RecoveryItem[] = [];
  const candidates = archived
    .filter((m) => successorsOf.has(m.id))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  for (const source of candidates) {
    if (recovery.length >= Math.max(0, options.recoverPerRun)) break;
    const tokens = [...distinctiveTokens(source.body)];
    const lost = tokens.filter((t) => !activeText.includes(t));
    if (lost.length < MIN_LOST_TOKENS || lost.length / tokens.length < MIN_LOST_FRACTION) continue;
    const overlap = (m: Memory): number => {
      const text = m.body.toLowerCase();
      return tokens.filter((t) => text.includes(t)).length;
    };
    const successors = activeSuccessors(source.id)
      .sort((a, b) => overlap(b) - overlap(a) || (a.id < b.id ? -1 : 1))
      .slice(0, MAX_SUCCESSORS);
    if (successors.length === 0) continue;
    const fingerprint = sha([source.body, ...successors.map((m) => m.body)].join("\u0000"));
    if (!ledgerAllows(options.ledger[key(source.id)], fingerprint, options.now)) continue;
    recovery.push({ source, successors, fingerprint });
  }

  return { oversized, recovery };
}

export interface RunRepairOptions {
  store: GroomingStore;
  ledgerStore: RepairLedgerStore;
  shelfId: string;
  llmClient: LlmClient;
  actorId: string;
  confidenceThreshold: number;
  promptAddendum?: string;
  model: { provider: string; name: string };
  splitPerRun: number;
  recoverPerRun: number;
  now?: Date;
}

/** An evidence item with the WHOLE body (redacted); marked incomplete if a secret was masked. */
function fullItem(memory: Memory): MemoryEvidenceItem {
  const body = redactSecrets(memory.body);
  const splitFrom = memory.curator_note?.split_from;
  return {
    id: memory.id,
    title: redactSecrets(memory.title).redacted,
    body: body.redacted,
    agentId: memory.agent_id ?? null,
    status: "active",
    createdAt: String(memory.created_at ?? memory.updated_at),
    updatedAt: String(memory.updated_at),
    isGlobal: memory.is_global === true,
    ...(body.count > 0 ? { body_incomplete: true as const } : {}),
    ...(typeof splitFrom === "string" ? { split_from: splitFrom } : {}),
  };
}

/** The operation types each repair kind may return; anything else is refused. */
const ALLOWED: Record<"split" | "recover", ReadonlySet<GroomingOperation["type"]>> = {
  split: new Set(["split", "noop"]),
  recover: new Set(["update", "create", "noop"]),
};

/**
 * Run one repair pass over a shelf. Returns the curation run (trigger "repair"),
 * or null when nothing was due — no run is created and no model is called.
 */
export async function runRepair(options: RunRepairOptions): Promise<CurationRun | null> {
  const now = options.now ?? new Date();
  const ledger = readRepairLedger(options.ledgerStore);
  const selection = selectRepairItems(options.store, {
    shelfId: options.shelfId,
    ledger,
    splitPerRun: options.splitPerRun,
    recoverPerRun: options.recoverPerRun,
    now,
  });
  const items = [
    ...selection.oversized.map((item) => ({ kind: "split" as const, item })),
    ...selection.recovery.map((item) => ({ kind: "recover" as const, item })),
  ];
  if (items.length === 0) return null;

  const { store } = options;
  const slice: EvidenceSlice = store.listGroomingSlices()[0] ?? { kind: "common_global" };
  // Respect the slice lock (spec §12): while another grooming or repair run on this
  // slice is live, repairing the same memories could race it — a split archiving a
  // memory that run is about to update. Try again on the next pass instead.
  const lock = store.findRunningRun(slice);
  if (lock && now.getTime() - lock.startedAt.getTime() < DEFAULT_LOCK_TTL_MS) return null;
  const ids = items.map(({ kind, item }) => (kind === "split" ? item.memory.id : item.source.id));
  const run = store.createCurationRun({
    trigger: "repair",
    project_key: null,
    input_hash: sha(
      `repair\n${items
        .map(({ item }) => item.fingerprint)
        .sort()
        .join("\n")}`,
    ),
    input_memory_ids: ids,
    model_provider: options.model.provider,
    model_name: options.model.name,
  });

  try {
    store.startCurationRun(run.id);
    const totals = { applied: 0, proposed: 0, skipped: 0, failed: 0 };
    let inputTokens = 0;
    let outputTokens = 0;

    for (const { kind, item } of items) {
      const sourceId = kind === "split" ? item.memory.id : item.source.id;
      const evidence =
        kind === "split" ? [fullItem(item.memory)] : item.successors.map((m) => fullItem(m));
      const messages =
        kind === "split"
          ? buildRepairPrompt({
              kind: "split",
              memory: evidence[0] as MemoryEvidenceItem,
              ...(options.promptAddendum ? { promptAddendum: options.promptAddendum } : {}),
            })
          : buildRepairPrompt({
              kind: "recover",
              archivedSource: item.source,
              successors: evidence,
              ...(options.promptAddendum ? { promptAddendum: options.promptAddendum } : {}),
            });

      let outcome: RepairOutcome;
      try {
        const completion = await options.llmClient.complete({ messages });
        inputTokens += completion.usage?.promptTokens ?? 0;
        outputTokens += completion.usage?.completionTokens ?? 0;
        const parsed = parseGroomingOutput(completion.content);
        if (parsed.parseError || parsed.operations.length === 0) {
          // A bad or empty response isn't a judgment (the prompt asks for exactly one
          // operation, a noop included): no ledger entry, offered again next run.
          totals.failed++;
          continue;
        }
        const context = {
          slice,
          memory: {
            slice,
            activeMemories: evidence,
            proposedMemories: [],
            tombstones: [],
            truncatedMemories: false,
            truncatedFields: false,
            redactionCount: 0,
          },
          prepass: { findings: [] },
        };
        const validated: ValidatedOperation[] = validateOperations(parsed.operations, context).map(
          (v) => ({ operation: v.operation, outcome: repairOutcome(kind, v, store) }),
        );
        const summary = applyOperations(validated, context, {
          store,
          runId: run.id,
          actorId: options.actorId,
          confidenceThreshold: options.confidenceThreshold,
        });
        totals.applied += summary.applied;
        totals.proposed += summary.proposed;
        totals.skipped += summary.skipped;
        totals.failed += summary.failed;
        const judged = validated.filter((v) => v.operation.type !== "noop");
        outcome =
          summary.applied > 0
            ? "applied"
            : summary.proposed > 0
              ? "proposed"
              : judged.length === 0
                ? "noop"
                : "refused";
      } catch (error) {
        // One item's model failure doesn't stop the others; it is offered again next run.
        if (!(error instanceof LlmClientError)) throw error;
        totals.failed++;
        continue;
      }
      ledger[`${options.shelfId}:${sourceId}`] = {
        outcome,
        at: now.toISOString(),
        fingerprint: item.fingerprint,
      };
      options.ledgerStore.setSetting(REPAIR_LEDGER_KEY, JSON.stringify(ledger));
    }

    return store.completeCurationRun(run.id, {
      summary: `repair: applied ${totals.applied}, proposed ${totals.proposed}, skipped ${totals.skipped}, failed ${totals.failed} over ${items.length} items`,
      usage_input_tokens: inputTokens,
      usage_output_tokens: outputTokens,
    });
  } catch (error) {
    return store.failCurationRun(run.id, {
      error: error instanceof LlmClientError ? `llm_${error.kind}` : "error",
    });
  }
}

/**
 * Repair's own rules on top of grooming validation: only the operation types its
 * mode allows, and a recovery update that keeps every line of the successor's
 * current body (it may only add). A failure refuses the operation.
 */
function repairOutcome(
  kind: "split" | "recover",
  validated: ValidatedOperation,
  store: Pick<GroomingStore, "getMemory">,
): ValidatedOperation["outcome"] {
  if (validated.outcome.decision === "reject") return validated.outcome;
  const op = validated.operation;
  if (!ALLOWED[kind].has(op.type)) {
    return { decision: "reject", reason: "repair: operation type not allowed in this mode" };
  }
  if (kind === "recover" && op.type === "update") {
    const current = store.getMemory(op.source_memory_id)?.body ?? "";
    if (op.patch.body === undefined || !preservesOriginal(current, op.patch.body)) {
      return { decision: "reject", reason: "repair: a recovery update may only add" };
    }
  }
  return validated.outcome;
}
