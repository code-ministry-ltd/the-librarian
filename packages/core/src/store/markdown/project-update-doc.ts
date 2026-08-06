import matter from "gray-matter";
import { z } from "zod";
import { IsoTimestampSchema } from "../../schemas/common.js";
import {
  ProjectUpdateEvidenceSchema,
  ProjectUpdateSchema,
  ProjectUpdateSourceKindSchema,
  type ProjectUpdate,
} from "../../schemas/project-update.js";
import {
  ProjectDocumentIdSchema,
  ProjectHashSchema,
  ProjectKeySchema,
  ProjectSourceIdSchema,
} from "../../schemas/project.js";

const ShelfIdSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => !value.includes("]") && !/\p{Cc}/u.test(value));

const ProjectUpdateFrontmatterSchema = z.strictObject({
  id: ProjectDocumentIdSchema,
  project_id: ProjectDocumentIdSchema.nullable(),
  candidate_fingerprint: ProjectHashSchema.nullable(),
  suggested_key: ProjectKeySchema.nullable(),
  suggested_name: z.string().trim().min(1).max(120).nullable(),
  suggested_aliases: z.array(z.string().trim().min(1).max(120)).max(20),
  suggested_repository_identifiers: z.array(z.string().trim().min(1).max(240)).max(20),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(2_000),
  explicitly_new_project: z.boolean(),
  evidence: ProjectUpdateEvidenceSchema,
  source_kind: ProjectUpdateSourceKindSchema,
  source_ref: ProjectSourceIdSchema,
  observed_at: IsoTimestampSchema,
  captured_at: IsoTimestampSchema,
  shelf_id: ShelfIdSchema,
  fingerprint: ProjectHashSchema,
});

function validationDetail(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function coerceDates(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}

export function serializeProjectUpdateDocument(input: ProjectUpdate): string {
  const update = ProjectUpdateSchema.parse(input);
  const frontmatter = {
    id: update.id,
    project_id: update.project_id,
    candidate_fingerprint: update.candidate_fingerprint,
    suggested_key: update.suggested_key,
    suggested_name: update.suggested_name,
    suggested_aliases: update.suggested_aliases,
    suggested_repository_identifiers: update.suggested_repository_identifiers,
    confidence: update.confidence,
    rationale: update.rationale,
    explicitly_new_project: update.explicitly_new_project,
    evidence: update.evidence,
    source_kind: update.source_kind,
    source_ref: update.source_ref,
    observed_at: update.observed_at,
    captured_at: update.captured_at,
    shelf_id: update.shelf_id,
    fingerprint: update.fingerprint,
  };
  return matter.stringify("", frontmatter);
}

export function parseProjectUpdateDocument(raw: string): ProjectUpdate {
  const { data, content } = matter(raw);
  if (content.trim() !== "") {
    throw new Error("Invalid project update document body: evidence belongs in frontmatter");
  }
  const frontmatter = ProjectUpdateFrontmatterSchema.safeParse(coerceDates(data));
  if (!frontmatter.success) {
    throw new Error(
      `Invalid project update document frontmatter: ${validationDetail(frontmatter.error)}`,
    );
  }
  const update = ProjectUpdateSchema.safeParse(frontmatter.data);
  if (!update.success) {
    throw new Error(`Invalid project update document: ${validationDetail(update.error)}`);
  }
  return update.data;
}
