// Curator LLM output parsing + schema validation (spec §10.5, structural half).
//
// The LLM response is UNTRUSTED. This layer parses the `{ operations: [...] }`
// envelope and strictly validates each operation against the GroomingOperation
// schema (§10.4). Strict objects REJECT any unexpected field — the guard against
// the model smuggling fields (e.g. a forged `curator_note`) past the prompt and
// into the apply layer. Validation is per-operation: valid ones are kept, the
// rest recorded as rejected (with their index + a reason) for audit, so one bad
// operation never discards the whole batch.
//
// Context-dependent checks — id membership, slice-boundary, secrets, empty/
// duplicate — are a separate pass (they need the evidence bundle). Risk
// classification and the apply policy (§11) follow.

import { z } from "zod";
import { ConfidenceSchema } from "./schemas/common.js";

// The curator's MemoryInput is a STRICT subset of memory fields (§10.4): no
// agent_id (ownership comes from the run slice, §11), no status, no curator_note.
//
// Rethink T12 / S1 — the zombie `category`/`scope` wire fields are gone: the
// store dropped the columns at the cutover, so requiring the model to emit
// them was pure token waste (and strictObject now REJECTS them, like any
// unexpected field). `visibility` stays pinned to "common" — the private
// namespace is gone (rethink T9, D8), so any other value is schema-rejected
// before validation even runs.
const GroomingMemoryInputSchema = z.strictObject({
  title: z.string().min(1),
  body: z.string().min(1),
  visibility: z.literal("common"),
  applies_to: z.array(z.string()).optional(),
  confidence: ConfidenceSchema.optional(),
  tags: z.array(z.string()).optional(),
});

// A patch is a partial MemoryInput — every field optional, still strict.
const GroomingMemoryPatchSchema = z.strictObject({
  title: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
  visibility: z.literal("common").optional(),
  applies_to: z.array(z.string()).optional(),
  confidence: ConfidenceSchema.optional(),
  tags: z.array(z.string()).optional(),
});

// Common to every operation: a non-empty rationale and an operation-confidence
// number in [0,1] (distinct from a memory's confidence ENUM above).
const rationale = z.string().min(1);
const confidence = z.number().min(0).max(1);
const id = z.string().min(1); // ids are non-empty (an "" id can't match evidence)

const NoopSchema = z.strictObject({
  type: z.literal("noop"),
  source_memory_ids: z.array(id),
  rationale,
  confidence,
});
const ArchiveSchema = z.strictObject({
  type: z.literal("archive"),
  source_memory_ids: z.array(id).min(1),
  rationale,
  confidence,
});
const UpdateSchema = z.strictObject({
  type: z.literal("update"),
  source_memory_id: z.string().min(1),
  patch: GroomingMemoryPatchSchema,
  // ADR 0013: true when this update fixes EVERY open flag on the memory. An
  // applied one clears the flags; a proposed one clears them on approval.
  resolves_flags: z.boolean().optional(),
  rationale,
  confidence,
});
const MergeSchema = z.strictObject({
  type: z.literal("merge"),
  source_memory_ids: z.array(id).min(2),
  replacement: GroomingMemoryInputSchema,
  rationale,
  confidence,
});
const SplitSchema = z.strictObject({
  type: z.literal("split"),
  source_memory_id: z.string().min(1),
  replacements: z.array(GroomingMemoryInputSchema).min(2),
  rationale,
  confidence,
});
const CreateSchema = z.strictObject({
  type: z.literal("create"),
  memory: GroomingMemoryInputSchema,
  rationale,
  confidence,
});

export const GroomingOperationSchema = z.discriminatedUnion("type", [
  NoopSchema,
  ArchiveSchema,
  UpdateSchema,
  MergeSchema,
  SplitSchema,
  CreateSchema,
]);

export type GroomingOperation = z.infer<typeof GroomingOperationSchema>;
export type GroomingMemoryInput = z.infer<typeof GroomingMemoryInputSchema>;
export type GroomingMemoryPatch = z.infer<typeof GroomingMemoryPatchSchema>;

export interface RejectedOperation {
  /** Index in the model's `operations` array. */
  index: number;
  /** Why the operation failed schema validation. */
  reason: string;
}

export interface ParsedGroomingOutput {
  operations: GroomingOperation[];
  rejected: RejectedOperation[];
  /** Set when the whole response was unusable (bad JSON or no operations array). */
  parseError?: string;
}

export function parseGroomingOutput(raw: string): ParsedGroomingOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    return { operations: [], rejected: [], parseError: "output was not valid JSON" };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.operations)) {
    return { operations: [], rejected: [], parseError: 'output missing an "operations" array' };
  }

  const operations: GroomingOperation[] = [];
  const rejected: RejectedOperation[] = [];
  parsed.operations.forEach((element, index) => {
    const result = GroomingOperationSchema.safeParse(element);
    if (result.success) operations.push(result.data);
    else rejected.push({ index, reason: summarizeIssues(result.error) });
  });
  return { operations, rejected };
}

// Some OpenAI-compatible providers ignore response_format and wrap JSON in a
// markdown fence; tolerate a single leading/trailing ``` block.
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/\n?```$/, "")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Build the audit reason from the issue CODE + PATH only — never Zod's message
// text, `keys`, or received value. The model controls its own JSON keys and
// values, and `unrecognized_keys` messages echo the offending key verbatim, so
// passing the raw message through would route untrusted (possibly secret-looking)
// text straight into the persisted audit row. Path entries are our own schema
// field names / array indices, so they are safe.
function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.join(".");
      const detail = issue.code === "unrecognized_keys" ? "unexpected field" : issue.code;
      return path ? `${path}: ${detail}` : detail;
    })
    .join("; ");
}
