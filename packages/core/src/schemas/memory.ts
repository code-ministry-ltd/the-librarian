// Memory schema — the canonical shape of a memory document (frontmatter +
// body) as the markdown store reads and writes it.

import { z } from "zod";
import { ConfidenceSchema, IdSchema, IsoTimestampSchema, MemoryStatusSchema } from "./common.js";
import { ProjectKeysSchema } from "./project.js";

// Curator provenance attached to a memory (memory-curator spec §8). All fields
// optional so partial provenance (e.g. just run/operation ids on an auto-applied
// create) is valid; `supersedes` lists memory ids a correction is meant to replace.
export const CuratorNoteSchema = z.object({
  text: z.string().optional(),
  supersedes: z.array(z.string()).optional(),
  // Content digest of each superseded source AS DRAFTED, keyed by memory id
  // (spec 072 D1/T3). Review recomputes these to tell whether a source moved
  // underneath the proposal while it sat in the queue; a proposal without them
  // (drafted before 072) reads as `unknown` and is never blocked (D2).
  source_digests: z.record(z.string(), z.string()).optional(),
  run_id: z.string().optional(),
  operation_id: z.string().optional(),
  // Self-describing proposal provenance (spec 2026-06-20 proposal-review-ux, D2).
  // Both intake (`intake/apply.ts`) and grooming (`grooming-apply.ts`) stamp these
  // onto a PROPOSED memory's curator_note so the dashboard has one read path for
  // the action badge / source chip / rationale; `proposed_action` is what lets
  // approve tell a split from an update. Optional so existing docs, auto-applied
  // creates (run_id only), and agent/user memories (null note) still validate.
  // These already round-trip through the markdown store, which persists
  // curator_note as a free-form record (`store/markdown/memory-doc.ts`); the
  // schema is typed to match that reality.
  source: z.string().optional(),
  proposed_action: z.string().optional(),
  rationale: z.string().optional(),
  // The judge's persisted PLAN (proposal-review rework 2026-07-01, D1/D10) —
  // what the curator WANTED to do, stamped by intake's propose path so the
  // dashboard can render it and offer to execute it. Additive keys, never
  // `supersedes`: a guessed target is not a resolved one (the D5 badge rule and
  // plain-approve's archive semantics stay untouched). All planned text is
  // redacted before persisting (untrusted model output in the vault).
  guessed_target_id: z.string().optional(),
  planned_addition: z.string().optional(),
  planned_title: z.string().optional(),
  planned_body: z.string().optional(),
  planned_tags: z.array(z.string()).optional(),
  /**
   * Destination shelf id for a `proposed_action: "move"` plan. In that shape,
   * `guessed_target_id` is the authoritative target pointer rather than a guess.
   */
  planned_shelf: z.string().optional(),
  /** The judgment's confidence in [0,1] (a number — not the memory's confidence label). */
  confidence: z.number().min(0).max(1).optional(),
  // How a proposal left the queue (D8/D9): "applied_plan" when the persisted
  // plan was executed, "resolved_via_chat" when a proposal-grounded chat action
  // was confirmed. Stamped at resolution time; absent on live proposals.
  resolution: z.string().optional(),
  // The retired under-evaluation/dry-run tags (`addendum_version`, `dry_run`,
  // `dry_run_candidate` — rethink T9, D4) are no longer reserved here; the
  // non-strict parse tolerates them on existing vault docs.
});
export type CuratorNote = z.infer<typeof CuratorNoteSchema>;

export const MemorySchema = z.object({
  id: IdSchema,
  title: z.string(),
  body: z.string(),
  agent_id: z.string().nullable(),
  status: MemoryStatusSchema,
  confidence: ConfidenceSchema,
  tags: z.array(z.string()),
  applies_to: z.array(z.string()),
  // Shelf-local relevance metadata only. Shelf policy remains the sole
  // authorisation boundary.
  project_keys: ProjectKeysSchema.optional(),
  supersedes: z.array(z.string()),
  conflicts_with: z.array(z.string()),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
  // Curator provenance + superseded reference (memory-curator spec §8). Set by
  // the curator's apply layer; null for agent/user-authored memories.
  curator_note: CuratorNoteSchema.nullable().optional(),
  // Routing booleans (optional on the schema; set by admin/curator only).
  is_global: z.boolean().optional(),
  requires_approval: z.boolean().optional(),
});
export type Memory = z.infer<typeof MemorySchema>;

// Partial patches accepted by `memories.update` and the proposal approve flow.
// Field set mirrors the writable fields; `id` and `created_at` are excluded.
export const MemoryPatchSchema = MemorySchema.partial().omit({
  id: true,
  created_at: true,
  // Curator-only provenance — set via the trusted create/apply path, not
  // patchable over the wire (cleanPatch strips it; this keeps the contract honest).
  curator_note: true,
});
export type MemoryPatch = z.infer<typeof MemoryPatchSchema>;

// User-facing input accepted by `createMemory` and the various proposal flows.
// Currently lenient: fields beyond the documented set are tolerated (Zod strips
// unknown keys, and `normalizeMemoryInput` drops anything it doesn't know).
export const MemoryInputSchema = z.object({
  agent_id: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  content: z.string().optional(),
  applies_to: z.array(z.string()).optional(),
  project_keys: ProjectKeysSchema.optional(),
  confidence: ConfidenceSchema.optional(),
  tags: z.array(z.string()).optional(),
  status: MemoryStatusSchema.optional(),
});
export type MemoryInput = z.infer<typeof MemoryInputSchema>;
