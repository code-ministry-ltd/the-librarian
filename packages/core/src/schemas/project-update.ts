import { z } from "zod";
import { IsoTimestampSchema } from "./common.js";
import {
  ProjectDocumentIdSchema,
  ProjectHashSchema,
  ProjectKeySchema,
  ProjectSourceIdSchema,
} from "./project.js";

export const ProjectUpdateSourceKindSchema = z.enum(["intake", "capture", "handoff", "admin"]);
export type ProjectUpdateSourceKind = z.infer<typeof ProjectUpdateSourceKindSchema>;

const EvidenceItemSchema = z.string().min(1).max(1_000);
const EvidenceListSchema = z.array(EvidenceItemSchema).max(25);
const SuggestedNameSchema = z.string().trim().min(1).max(120);
const SuggestedAliasSchema = z.string().trim().min(1).max(120);
const SuggestedRepositorySchema = z.string().trim().min(1).max(240);
const ShelfIdSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => !value.includes("]") && !/\p{Cc}/u.test(value), {
    message: "must be a printable shelf id without ']'",
  });

export const ProjectUpdateEvidenceSchema = z.strictObject({
  overview: EvidenceListSchema,
  technology_and_architecture: EvidenceListSchema,
  completed: EvidenceListSchema,
  current: EvidenceListSchema,
  planned: EvidenceListSchema,
  blockers: EvidenceListSchema,
});
export type ProjectUpdateEvidence = z.infer<typeof ProjectUpdateEvidenceSchema>;

export const ProjectUpdateSchema = z
  .strictObject({
    id: ProjectDocumentIdSchema,
    project_id: ProjectDocumentIdSchema.nullable(),
    candidate_fingerprint: ProjectHashSchema.nullable(),
    suggested_key: ProjectKeySchema.nullable(),
    suggested_name: SuggestedNameSchema.nullable(),
    suggested_aliases: z.array(SuggestedAliasSchema).max(20),
    suggested_repository_identifiers: z.array(SuggestedRepositorySchema).max(20),
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
  })
  .superRefine((update, context) => {
    if (Date.parse(update.captured_at) < Date.parse(update.observed_at)) {
      context.addIssue({
        code: "custom",
        path: ["captured_at"],
        message: "captured_at cannot precede observed_at",
      });
    }

    const matched = update.project_id !== null;
    const candidate = update.candidate_fingerprint !== null;
    if (matched === candidate) {
      context.addIssue({
        code: "custom",
        path: ["project_id"],
        message: "exactly one matched project or candidate fingerprint is required",
      });
    }

    if (candidate && (update.suggested_key === null || update.suggested_name === null)) {
      context.addIssue({
        code: "custom",
        path: [update.suggested_key === null ? "suggested_key" : "suggested_name"],
        message: "a candidate requires a suggested key and name",
      });
    }
    if (
      matched &&
      (update.suggested_key !== null ||
        update.suggested_name !== null ||
        update.suggested_aliases.length > 0 ||
        update.suggested_repository_identifiers.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["suggested_key"],
        message: "matched updates must not carry candidate identity",
      });
    }

    const evidenceCount = Object.values(update.evidence).reduce(
      (total, items) => total + items.length,
      0,
    );
    if (evidenceCount === 0) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "a project update requires at least one evidence item",
      });
    }
  });
export type ProjectUpdate = z.infer<typeof ProjectUpdateSchema>;
