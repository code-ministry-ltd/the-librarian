// Memory <-> markdown-document mapping (plan 036 Phase 2 / spec 035 §F1).
//
// The markdown backend stores each memory as a markdown file — a YAML
// frontmatter block + the memory body. This is the parity-first mapping:
// it is lossless for the full current `Memory` shape so the markdown
// backend can pass the existing (storage-agnostic) verb tests while it's
// built behind `LibrarianStore`. The D16 frontmatter minimisation (drop
// agent/confidence/usefulness/…) happens later, at cutover; until
// then the raw memory docs carry the whole shape.
//
// Frontmatter is built in a fixed key order so serialization is
// deterministic (minimal git diffs). `parseMemoryDocument` coerces any
// YAML `Date` back to an ISO string, so the timestamp fields survive hand
// edits and js-yaml's implicit timestamp typing.

import { parseFrontmatter, stringifyFrontmatter } from "../../safe-frontmatter.js";
import { z } from "zod";
import { IsoTimestampSchema } from "../../schemas/common.js";
import type { Memory, MemoryFlag } from "../memory-store.js";

// The curator's latest review of a flag (ADR 0013).
const FlagReviewSchema = z.object({
  outcome: z.enum(["proposed", "no_change", "declined", "too_long"]),
  at: IsoTimestampSchema,
  run_id: z.string().min(1).optional(),
  rationale: z.string().optional(),
  proposal_id: z.string().min(1).optional(),
});

const MemoryFrontmatterSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  agent_id: z.string(),
  status: z.string(),
  confidence: z.string(),
  // Tags pre-date the strict markdown schema and hand-edited vaults can contain scalar or
  // mixed-array values. Treat only stored strings as tags without rewriting the document; this
  // keeps one malformed legacy value from making the otherwise-valid memory unreadable.
  tags: z.preprocess(
    (value) =>
      Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === "string") : [],
    z.array(z.string()),
  ),
  applies_to: z.array(z.string()),
  supersedes: z.array(z.string()),
  conflicts_with: z.array(z.string()),
  // Open agent flags routing the memory to review (spec 047 / ADR 0006).
  // Optional-with-default so docs written before this field still parse.
  flags: z
    .array(
      z.object({
        agent_id: z.string(),
        reason: z.string(),
        created_at: IsoTimestampSchema,
        // ADR 0013. An unreadable review is dropped rather than failing the whole
        // memory: the flag itself is what matters, and grooming re-reviews it.
        review: FlagReviewSchema.optional().catch(undefined),
      }),
    )
    .default([]),
  // `correction_work` (ADR 0012, retired by ADR 0013) is no longer in the schema:
  // z.object strips it on read, so a legacy marker vanishes on the next write.
  is_global: z.boolean(),
  requires_approval: z.boolean(),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
  // The last principal to mutate this memory (spec 064 SC 4). Optional + additive: absent
  // on docs written before 064, and on anonymous writes. Being IN the schema is what makes a
  // 064 Librarian PRESERVE it — a plain z.object strips unknown keys (Q2's noted caveat), so
  // an OLDER Librarian would drop it on the next write.
  updated_by: z.string().optional(),
  curator_note: z.record(z.string(), z.unknown()).nullable(),
});

/** Serialize a memory to its markdown document form (frontmatter + body). */
export function serializeMemoryDocument(memory: Memory): string {
  // Fixed key order → deterministic output → minimal git diffs.
  const frontmatter: Record<string, unknown> = {
    id: memory.id,
    title: memory.title,
    agent_id: memory.agent_id,
    status: memory.status,
    confidence: memory.confidence,
    tags: memory.tags ?? [],
    applies_to: memory.applies_to ?? [],
    supersedes: memory.supersedes ?? [],
    conflicts_with: memory.conflicts_with ?? [],
    flags: (memory.flags ?? []).map(serializeFlag),
    is_global: memory.is_global ?? false,
    requires_approval: memory.requires_approval ?? false,
    created_at: memory.created_at,
    updated_at: memory.updated_at,
  };
  // `updated_by` is written ONLY when set (spec 064 SC 4), so a memory that no attributed
  // mutation has touched serialises byte-for-byte as before — the golden fixture is unmoved
  // by T4, and only regenerates in T5 where the cycle gains an attributed update/archive.
  if (memory.updated_by !== undefined) frontmatter.updated_by = memory.updated_by;
  frontmatter.curator_note = memory.curator_note ?? null;
  return stringifyFrontmatter(memory.body.trim(), frontmatter);
}

/** Parse a markdown document back into a `Memory`; teaching error on a bad shape. */
export function parseMemoryDocument(raw: string): Memory {
  const { data, content } = parseFrontmatter(raw);
  const result = MemoryFrontmatterSchema.safeParse(coerceDates(data));
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid memory document frontmatter: ${detail}`);
  }
  // `updated_by` is optional: under exactOptionalPropertyTypes it must be OMITTED when
  // absent, never set to `undefined` (which zod's `.optional()` yields for a missing key).
  const { updated_by, flags, ...rest } = result.data;
  return {
    ...rest,
    flags: flags.map(normalizeFlag),
    requires_approval: rest.requires_approval && !isResolvedProposal(rest),
    body: content.trim(),
    ...(updated_by !== undefined ? { updated_by } : {}),
  };
}

// A reviewed proposal: it carries the curator_note every proposal path stamps
// (intake, grooming, dashboard move) but is no longer
// proposed. Its requires_approval was the "awaiting review" marker, not a
// protection. Approval used to leave it set, so every accepted proposal became
// protected forever and forced every later curator change to it back into
// review whatever the apply threshold. Reading it as false heals memories
// approved before approveProposal cleared it, without a migration. A memory
// protected on purpose (no curator_note) keeps its flag.
function isResolvedProposal(doc: { status: string; curator_note: unknown }): boolean {
  return doc.status !== "proposed" && doc.curator_note !== null;
}

// Optional keys are OMITTED when absent (exactOptionalPropertyTypes), and a flag
// with no review serialises exactly as it did before ADR 0013.
type ParsedFlag = Omit<MemoryFlag, "review"> & {
  review?:
    | {
        outcome: NonNullable<MemoryFlag["review"]>["outcome"];
        at: string;
        run_id?: string | undefined;
        rationale?: string | undefined;
        proposal_id?: string | undefined;
      }
    | undefined;
};

function normalizeFlag(flag: ParsedFlag): MemoryFlag {
  const { review, ...base } = flag;
  if (!review) return base;
  const { run_id, rationale, proposal_id, ...required } = review;
  return {
    ...base,
    review: {
      ...required,
      ...(run_id !== undefined ? { run_id } : {}),
      ...(rationale !== undefined ? { rationale } : {}),
      ...(proposal_id !== undefined ? { proposal_id } : {}),
    },
  };
}

function serializeFlag(flag: MemoryFlag): Record<string, unknown> {
  const out: Record<string, unknown> = {
    agent_id: flag.agent_id,
    reason: flag.reason,
    created_at: flag.created_at,
  };
  if (flag.review) out.review = normalizeFlag(flag).review;
  return out;
}

function coerceDates(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}
