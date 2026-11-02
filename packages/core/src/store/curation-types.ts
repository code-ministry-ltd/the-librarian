// Curation data-model store — shared type contract (memory-curator spec §8).
//
// The run/operation types and the `CurationStore` interface. The concrete
// implementation is the JSON sidecar curation store; `curation-store.ts`
// re-exports these from its old path for back-compat.

import type {
  EvidenceSlice,
  MemoryEvidenceBundle,
  MemoryEvidenceCaps,
} from "../grooming-evidence.js";

export interface CreateCurationRunInput {
  trigger: string; // schedule | manual | maintenance
  input_hash: string;
  /** Shelf whose corpus this run inspected. Bound by the shelf-scoped store in production. */
  shelf_id?: string | null;
  shelf_label?: string | null;
  status?: string; // defaults to "pending"
  mode?: string; // defaults to "apply"
  // Slices are project-key-only (rethink D8): null = the global slice.
  project_key?: string | null;
  input_memory_ids?: string[];
  model_provider?: string | null;
  model_name?: string | null;
}

export interface CurationRun {
  id: string;
  status: string;
  trigger: string;
  /** Missing on older sidecar rows; readers attribute those rows to the main shelf. */
  shelf_id?: string | null;
  shelf_label?: string | null;
  mode: string;
  project_key: string | null;
  input_hash: string;
  input_memory_ids: string[];
  model_provider: string | null;
  model_name: string | null;
  usage_input_tokens: number;
  usage_output_tokens: number;
  summary: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface RecordCurationOperationInput {
  run_id: string;
  operation_type: string; // noop | create | update | archive | merge | split
  // The realised D13 apply verdict: proposed | applied | skipped | failed | superseded.
  status: string;
  confidence: number;
  rationale: string;
  proposed_payload: Record<string, unknown>;
  source_memory_ids?: string[];
  target_memory_ids?: string[];
  title?: string | null;
}

export interface CurationOperation {
  id: string;
  run_id: string;
  operation_type: string;
  status: string;
  confidence: number;
  source_memory_ids: string[];
  target_memory_ids: string[];
  title: string | null;
  rationale: string;
  proposed_payload: Record<string, unknown>;
  applied_at: string | null;
  error: string | null;
}

export interface ListCurationRunsInput {
  status?: string;
  trigger?: string;
  /** Restrict before paging, so one shelf's listing never borrows another shelf's runs. */
  shelfId?: string;
  /** Exclusive run-id cursor in the deterministic newest-first ordering. */
  before?: string;
  /** Page size, defaulted to 50 and clamped to a 200 ceiling. */
  limit?: number;
}

export interface CompleteCurationRunInput {
  summary?: string | null;
  usage_input_tokens?: number;
  usage_output_tokens?: number;
}

export interface FailCurationRunInput {
  /** A value-free error label (no secrets / untrusted content). */
  error: string;
}

export interface CurationStore {
  createCurationRun: (input: CreateCurationRunInput) => CurationRun;
  getCurationRun: (id: string) => CurationRun | null;
  /** Latest completed apply-mode run with this input hash, for §10.2 idempotency. */
  findCompletedApplyRun: (inputHash: string) => CurationRun | null;
  listCurationRuns: (input?: ListCurationRunsInput) => CurationRun[];
  recordCurationOperation: (input: RecordCurationOperationInput) => CurationOperation;
  getCurationOperations: (runId: string) => CurationOperation[];
  // Lifecycle transitions on the authoritative run record.
  startCurationRun: (id: string) => CurationRun;
  completeCurationRun: (id: string, input?: CompleteCurationRunInput) => CurationRun;
  failCurationRun: (id: string, input: FailCurationRunInput) => CurationRun;
  // Curator read-side (F0): thin wrappers binding the store db to the pure
  // curator functions so curator-worker/enqueue never touch `store.db`.
  gatherMemoryEvidence: (slice: EvidenceSlice, caps: MemoryEvidenceCaps) => MemoryEvidenceBundle;
  // The full slice set a grooming pass attempts. The per-slice interval gate is
  // retired (spec 045 D-3a) — runDueCuration iterates this and relies on input-hash
  // idempotency in runCuration to skip unchanged slices.
  listGroomingSlices: () => EvidenceSlice[];
  findRunningRun: (slice: EvidenceSlice) => { id: string; startedAt: Date } | null;
}
