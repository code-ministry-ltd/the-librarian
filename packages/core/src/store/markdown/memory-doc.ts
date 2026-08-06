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

import matter from "gray-matter";
import { z } from "zod";
import { IsoTimestampSchema } from "../../schemas/common.js";
import { ProjectKeysSchema } from "../../schemas/project.js";
import type { Memory } from "../memory-store.js";

const MemoryFrontmatterSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  agent_id: z.string(),
  status: z.string(),
  confidence: z.string(),
  tags: z.array(z.string()),
  applies_to: z.array(z.string()),
  project_keys: ProjectKeysSchema.optional(),
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
      }),
    )
    .default([]),
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
    ...(memory.project_keys !== undefined ? { project_keys: memory.project_keys } : {}),
    supersedes: memory.supersedes ?? [],
    conflicts_with: memory.conflicts_with ?? [],
    flags: memory.flags ?? [],
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
  return matter.stringify(memory.body.trim(), frontmatter);
}

/** Parse a markdown document back into a `Memory`; teaching error on a bad shape. */
export function parseMemoryDocument(raw: string): Memory {
  const { data, content } = matter(raw);
  const compatible = coerceLegacyProjectKey(coerceDates(data));
  const result = MemoryFrontmatterSchema.safeParse(compatible);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid memory document frontmatter: ${detail}`);
  }
  // `updated_by` is optional: under exactOptionalPropertyTypes it must be OMITTED when
  // absent, never set to `undefined` (which zod's `.optional()` yields for a missing key).
  const { updated_by, project_keys, ...rest } = result.data;
  return {
    ...rest,
    body: content.trim(),
    ...(updated_by !== undefined ? { updated_by } : {}),
    ...(project_keys !== undefined ? { project_keys } : {}),
  };
}

function coerceLegacyProjectKey(data: Record<string, unknown>): Record<string, unknown> {
  if (data.project_keys !== undefined || typeof data.project_key !== "string") return data;
  return { ...data, project_keys: [data.project_key] };
}

function coerceDates(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}
