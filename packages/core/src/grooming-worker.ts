// Curator worker (spec §10 pipeline + §12/§14). Composes the curator pieces into
// a single run over ONE slice:
//
//   gather evidence → deterministic pre-pass → build prompt → LLM → parse output
//   → validate → apply → record run summary.
//
// It owns the run lifecycle (create → start → complete/fail) and records token
// usage. The LLM client is injected (built from the admin config by the caller),
// so this is fully testable without network. The server-side scheduler that
// selects due slices, skips by input hash, and locks slices is separate (§12/§14).

import { createHash } from "node:crypto";
import { CURATOR_PROMPT_VERSION, buildCuratorPrompt } from "./curator-prompt.js";
import { applyOperations } from "./grooming-apply.js";
import type {
  EvidenceSlice,
  MemoryEvidenceBundle,
  MemoryEvidenceItem,
} from "./grooming-evidence.js";
import { LlmClientError, type LlmClient } from "./grooming-llm-client.js";
import { parseGroomingOutput } from "./grooming-output.js";
import { deterministicPrepass } from "./grooming-prepass.js";
import { redactSecrets } from "./grooming-redaction.js";
import { validateOperations } from "./grooming-validate.js";
import type { CurationRun, CurationStore } from "./store/curation-store.js";
import type { MemoryStore } from "./store/memory-types.js";

/**
 * The store surface ONE grooming run touches (spec 062 SC 7, T6) — the run/operation bookkeeping
 * ({@link CurationStore}, incl. the vault-backed evidence reads `gatherMemoryEvidence` /
 * `listGroomingSlices`) plus the full raw memory surface ({@link MemoryStore}) for direct and
 * targeted corrections. A full {@link LibrarianStore} satisfies it structurally,
 * so the pre-existing callers pass their store straight through — byte-identical. The narrower type
 * is what lets the store hand grooming a SHELF-SCOPED view (`groomingStoreForShelf`): the memory
 * reads/writes resolve beneath the shelf's prefix while the run bookkeeping stays vault-singular.
 */
export type GroomingStore = CurationStore & MemoryStore;

export interface RunCurationCaps {
  maxMemories?: number;
  maxBodyChars?: number;
  /**
   * Max active+proposed memories fed to the model in ONE LLM call. A slice with
   * more than this is split into consecutive chunks, each its own bounded
   * `complete()` call within the single run, so one oversized slice can't blow
   * the LLM timeout. ADR 0005's `maxMemories` caps the run's TOTAL evidence;
   * `chunkSize` caps each CALL. Default 30.
   */
  chunkSize?: number;
}

export interface RunCurationOptions {
  store: GroomingStore;
  llmClient: LlmClient;
  /** "schedule" | "manual" | "maintenance" (recorded on the run). */
  trigger: string;
  /** Curator actor for common-slice writes (e.g. "system-memory-curator"). */
  actorId: string;
  /** The single curator.apply.confidence_threshold knob (D13). */
  confidenceThreshold: number;
  promptAddendum?: string;
  /** Recorded on the run for observability. */
  model: { provider: string; name: string };
  caps?: RunCurationCaps;
  /** KEPT for run-now (spec §5.3): bypasses the input-hash idempotency skip (§10.2). */
  bypassSkip?: boolean;
}

const DEFAULT_MAX_MEMORIES = 200;
const DEFAULT_CHUNK_SIZE = 30;

/**
 * Run one curation pass over a slice. Returns the run record, or null when the
 * run was skipped by input-hash idempotency (an identical completed apply-run
 * already exists and the trigger didn't bypass it, §10.2) — no run is created
 * and no LLM call is made.
 */
export async function runCuration(
  slice: EvidenceSlice,
  options: RunCurationOptions,
): Promise<CurationRun | null> {
  const { store, caps = {} } = options;

  const memory = store.gatherMemoryEvidence(slice, {
    maxMemories: caps.maxMemories ?? DEFAULT_MAX_MEMORIES,
    ...(caps.maxBodyChars !== undefined ? { maxBodyChars: caps.maxBodyChars } : {}),
  });

  // §10.2 idempotency: skip if an identical completed apply-run exists, unless a
  // manual/maintenance trigger explicitly bypasses. Checked BEFORE creating a run
  // or calling the LLM, so a no-op tick costs nothing.
  const inputHash = computeInputHash(slice, memory, options.promptAddendum ?? "");
  if (!options.bypassSkip && store.findCompletedApplyRun(inputHash)) {
    return null;
  }

  const run = store.createCurationRun({
    trigger: options.trigger,
    // Memories are project-less (single global slice), so a run's project_key is
    // always null now; the column is retained for run-provenance back-compat.
    project_key: null,
    input_hash: inputHash,
    input_memory_ids: [
      ...memory.activeMemories,
      ...memory.proposedMemories,
      ...memory.tombstones,
    ].map((m) => m.id),
    model_provider: options.model.provider,
    model_name: options.model.name,
  });

  // startCurationRun onward is inside the try so any throw terminalizes the run
  // (fail) rather than leaving it dangling. createCurationRun is outside: if it
  // throws there is no run row to fail.
  try {
    store.startCurationRun(run.id);

    // Bound each LLM call: a slice larger than chunkSize is split into
    // consecutive sub-batches, each its own complete() call, so one oversized
    // slice can't exceed the LLM timeout (the production global-slice failure).
    // A slice at/under the bound is a single chunk == the prior behavior.
    const chunkSize = Math.max(1, Math.floor(caps.chunkSize ?? DEFAULT_CHUNK_SIZE));
    const chunks = chunkEvidence(memory, chunkSize);

    let applied = 0;
    let proposed = 0;
    let skipped = 0;
    let failed = 0;
    let rejectedCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let succeededChunks = 0;
    let lastError: string | null = null;

    for (const chunk of chunks) {
      try {
        // Pre-pass + prompt are PER CHUNK (the model only sees this chunk). Known
        // tradeoff: cross-chunk exact-duplicate detection is deferred to a later
        // run that re-chunks — see chunkEvidence().
        const prepass = deterministicPrepass(chunk);
        const messages = buildCuratorPrompt({
          mode: "grooming",
          memory: chunk,
          prepass,
          ...(options.promptAddendum !== undefined
            ? { promptAddendum: options.promptAddendum }
            : {}),
        });
        const completion = await options.llmClient.complete({ messages });
        inputTokens += completion.usage?.promptTokens ?? 0;
        outputTokens += completion.usage?.completionTokens ?? 0;

        const parsed = parseGroomingOutput(completion.content);
        if (parsed.parseError) {
          // Whole-output failure for THIS chunk (bad JSON / no operations array).
          // Record the reason and carry on — other chunks may still yield ops.
          lastError = "parse_error";
          continue;
        }
        // Schema-rejected operations are recorded as skipped (reason is value-free).
        for (const rejected of parsed.rejected) {
          store.recordCurationOperation({
            run_id: run.id,
            operation_type: "unknown",
            status: "skipped",
            confidence: 0,
            rationale: `schema: ${rejected.reason}`,
            proposed_payload: {},
          });
          rejectedCount += 1;
        }

        const context = { slice, memory: chunk, prepass };
        const validated = validateOperations(parsed.operations, context);
        const summary = applyOperations(validated, context, {
          store,
          runId: run.id,
          actorId: options.actorId,
          confidenceThreshold: options.confidenceThreshold,
        });
        applied += summary.applied;
        proposed += summary.proposed;
        skipped += summary.skipped;
        failed += summary.failed;
        succeededChunks += 1;
      } catch (error) {
        // Per-chunk fail-soft (e.g. one chunk's LLM timeout): isolate it so the
        // remaining chunks still run, rather than failing the whole slice.
        lastError = errorLabel(error);
      }
    }

    // No chunk produced a usable result → the run failed. Preserves the
    // single-chunk semantics: a lone parse_error / LLM error fails the run with
    // its value-free label.
    if (succeededChunks === 0) {
      return store.failCurationRun(run.id, { error: lastError ?? "error" });
    }

    const chunkNote = chunks.length > 1 ? ` across ${chunks.length} chunks` : "";
    return store.completeCurationRun(run.id, {
      summary: `applied ${applied}, proposed ${proposed}, skipped ${skipped + rejectedCount}, failed ${failed}${chunkNote}`,
      usage_input_tokens: inputTokens,
      usage_output_tokens: outputTokens,
    });
  } catch (error) {
    return store.failCurationRun(run.id, { error: errorLabel(error) });
  }
}

/**
 * Split a slice's evidence into consecutive chunks of at most `chunkSize`
 * active+proposed memories, so each chunk is one bounded LLM call. Tombstones
 * (metadata-only resurrection guards, no body) ride on EVERY chunk so the model
 * can still noop on a resurrection regardless of which memories a chunk carries.
 * A slice at or under the bound returns the original bundle unchanged (single
 * chunk == prior behavior).
 *
 * KNOWN LIMITATION: two duplicates that fall in different chunks won't merge in
 * one pass; ordering is stable (newest-first) so near-duplicates tend to
 * co-locate, and the next run re-chunks as the set changes.
 */
function chunkEvidence(bundle: MemoryEvidenceBundle, chunkSize: number): MemoryEvidenceBundle[] {
  const combined: Array<{ item: MemoryEvidenceItem; status: "active" | "proposed" }> = [
    ...bundle.activeMemories.map((item) => ({ item, status: "active" as const })),
    ...bundle.proposedMemories.map((item) => ({ item, status: "proposed" as const })),
  ];
  if (combined.length <= chunkSize) return [bundle];

  const chunks: MemoryEvidenceBundle[] = [];
  for (let i = 0; i < combined.length; i += chunkSize) {
    const group = combined.slice(i, i + chunkSize);
    chunks.push({
      slice: bundle.slice,
      activeMemories: group.filter((x) => x.status === "active").map((x) => x.item),
      proposedMemories: group.filter((x) => x.status === "proposed").map((x) => x.item),
      tombstones: bundle.tombstones,
      truncatedMemories: bundle.truncatedMemories,
      truncatedFields: bundle.truncatedFields,
      redactionCount: bundle.redactionCount,
    });
  }
  return chunks;
}

// Value-free error label for the run record — never the error message (which
// could carry store/content detail).
function errorLabel(error: unknown): string {
  return error instanceof LlmClientError ? `llm_${error.kind}` : "error";
}

// Input hash (§10.2): slice + ACTIVE memory ids/updated/status + tombstone
// fingerprints + a prompt version + the (redacted) admin addendum, so editing
// the addendum or any evidence permits a fresh run. Order-independent.
//
// Proposals are deliberately EXCLUDED (spec 072, D7). They remain evidence in
// the prompt — the curator must see what is already pending — but they must not
// re-trigger a run: a filed proposal used to perturb this hash, so the very next
// sweep looked novel and spent an LLM call re-deriving the judgment it had just
// filed. If the active set is unchanged there is nothing left to derive, because
// the earlier completed run saw exactly that evidence and applied everything it
// found. Skipping also stays conservative in the other direction: more visible
// pending proposals can only make the curator propose LESS (it is instructed
// never to operate on a proposed memory), so a skip can forgo work but cannot
// cause a wrong write. Approving or rejecting changes the ACTIVE set, so the
// next sweep re-runs — which is what makes the drift refusal's promise true.
function computeInputHash(
  slice: EvidenceSlice,
  memory: MemoryEvidenceBundle,
  addendum: string,
): string {
  const parts: string[] = [
    `slice:${slice.kind}`,
    // The unified prompt version (T8): bumping it (e.g. v2→v5) deliberately
    // invalidates every slice's skip hash, so each slice re-grooms once under
    // the new prompt instead of riding a stale idempotency skip.
    `prompt:${CURATOR_PROMPT_VERSION}`,
    `addendum:${redactSecrets(addendum).redacted}`,
  ];
  for (const m of memory.activeMemories) {
    parts.push(`m:${m.id}:${m.updatedAt}:${m.status}`);
  }
  for (const t of memory.tombstones) {
    parts.push(`t:${t.id}:${t.contentFingerprint}`);
  }
  return createHash("sha256").update(parts.sort().join("\n"), "utf8").digest("hex");
}
