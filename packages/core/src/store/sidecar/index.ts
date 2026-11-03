// Sidecar stores (plan 036 Phase 2) — file-based stores that live OUTSIDE
// the git-pushed vault: settings/secrets + curation/intake records
// (bookkeeping, not durable knowledge).

export { type JsonSettingsStoreDeps, createJsonSettingsStore } from "./settings-store.js";
export { type JsonCurationStoreDeps, createJsonCurationStore } from "./curation-store.js";
export {
  type JsonIntakeStoreDeps,
  INTAKE_RUNS_FILE,
  LEGACY_INTAKE_RUNS_FILE,
  createJsonIntakeStore,
  resolveIntakeRunsPath,
} from "./intake-store.js";
export {
  type ReadRefusalsOptions,
  type ReadRefusalsResult,
  type RecordRefusalInput,
  type RefusalDenial,
  type RefusalDenialKind,
  type RefusalDropped,
  type RefusalLog,
  type RefusalLogDeps,
  type RefusalLogErrorSink,
  type RefusalOutcome,
  type RefusalRecord,
  type RefusalSurface,
  REFUSAL_LOG_BUCKET_CAPACITY,
  REFUSAL_LOG_FILE,
  REFUSAL_LOG_MAX_BYTES,
  REFUSAL_LOG_REFILL_PER_SECOND,
  RefusalDenialKindSchema,
  RefusalDenialSchema,
  RefusalDroppedSchema,
  RefusalOutcomeSchema,
  RefusalRecordSchema,
  RefusalSurfaceSchema,
  createRefusalLog,
  principalRefusalEvidence,
} from "./refusal-log.js";
export {
  type NdjsonSidecar,
  type NdjsonSidecarDeps,
  type SidecarErrorSink,
  type SidecarReadOptions,
  type SidecarReadResult,
  createNdjsonSidecar,
} from "./ndjson-sidecar.js";
export {
  type ReadKind,
  type ReadLog,
  type ReadLogDeps,
  type ReadReadsOptions,
  type ReadReadsResult,
  type ReadRecord,
  type RecordReadInput,
  READ_LOG_FILE,
  READ_LOG_MAX_BYTES,
  READ_LOG_MAX_ITEMS,
  READ_LOG_QUERY_MAX_LENGTH,
  JournalReadSchema,
  PrimerReadSchema,
  ReadDroppedSchema,
  ReadRecordSchema,
  RecallReadSchema,
  ReferenceReadSchema,
  buildReadRecord,
  createReadLog,
  READ_LOG_ENABLED_KEY,
  shortHash,
} from "./read-log.js";
