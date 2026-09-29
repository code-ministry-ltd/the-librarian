// Handoff <-> markdown-document mapping (plan 036 Phase 2 / spec 035 §F9).
// A handoff is stored as `handoffs/<id>.md`: frontmatter metadata + the
// 5-heading narrative body (the document_md). The cross-repo 5-heading
// contract is preserved in the body verbatim; Zod heading validation stays
// at the MCP boundary (schemas/handoff.ts), so this mapping is lossless and
// doesn't re-validate structure.
//
// Deterministic frontmatter (fixed key order); parse coerces any YAML Date
// back to an ISO string (js-yaml's implicit timestamp typing / hand edits).

import { parseFrontmatter, stringifyFrontmatter } from "../../safe-frontmatter.js";
import { z } from "zod";
import { IsoTimestampSchema } from "../../schemas/common.js";
import type { HandoffDetail } from "../handoff-store.js";

const ClaimedBySchema = z
  .object({
    agent_id: z.string().nullable(),
    harness: z.string().nullable(),
    source_ref: z.string().nullable(),
    cwd: z.string().nullable(),
  })
  .nullable();

const HandoffFrontmatterSchema = z.object({
  handoff_id: z.string().min(1),
  title: z.string(),
  project_key: z.string().nullable(),
  source_ref: z.string().nullable(),
  cwd: z.string().nullable(),
  created_by_agent_id: z.string().nullable(),
  created_in_harness: z.string().nullable(),
  tags: z.array(z.string()),
  created_at: IsoTimestampSchema,
  claimed_at: IsoTimestampSchema.nullable(),
  claimed_by: ClaimedBySchema,
});

/** Serialize a handoff to its markdown document form (frontmatter + body). */
export function serializeHandoffDocument(handoff: HandoffDetail): string {
  // Fixed key order → deterministic output → minimal git diffs.
  const frontmatter = {
    handoff_id: handoff.handoff_id,
    title: handoff.title,
    project_key: handoff.project_key,
    source_ref: handoff.source_ref,
    cwd: handoff.cwd,
    created_by_agent_id: handoff.created_by_agent_id,
    created_in_harness: handoff.created_in_harness,
    tags: handoff.tags ?? [],
    created_at: handoff.created_at,
    claimed_at: handoff.claimed_at,
    claimed_by: handoff.claimed_by ?? null,
  };
  return stringifyFrontmatter(handoff.document_md.trim(), frontmatter);
}

/** Parse a markdown document back into a `HandoffDetail`; teaching error on a bad shape. */
export function parseHandoffDocument(raw: string): HandoffDetail {
  const { data, content } = parseFrontmatter(raw);
  const result = HandoffFrontmatterSchema.safeParse(coerceDates(data));
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid handoff document frontmatter: ${detail}`);
  }
  return { ...result.data, document_md: content.trim() };
}

function coerceDates(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}
