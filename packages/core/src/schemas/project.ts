import { z } from "zod";
import { IsoTimestampSchema } from "./common.js";

export const PROJECT_SECTION_KEYS = [
  "what_this_project_is",
  "technology_and_architecture",
  "current_state",
  "last_meaningful_work",
  "planned_next",
  "blockers_and_uncertainties",
] as const;

export const ProjectSectionKeySchema = z.enum(PROJECT_SECTION_KEYS);
export type ProjectSectionKey = z.infer<typeof ProjectSectionKeySchema>;

export const ProjectSectionOwnershipSchema = z.enum(["automatic", "pinned"]);
export type ProjectSectionOwnership = z.infer<typeof ProjectSectionOwnershipSchema>;

export const ProjectStatusSchema = z.enum(["proposed", "active", "archived"]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const ProjectResolutionSchema = z.enum(["rejected", "belongs_to_existing"]);
export type ProjectResolution = z.infer<typeof ProjectResolutionSchema>;

export const ProjectRefreshStatusSchema = z.enum([
  "not_built",
  "dirty",
  "queued",
  "compiling",
  "succeeded",
  "failed",
]);
export type ProjectRefreshStatus = z.infer<typeof ProjectRefreshStatusSchema>;

/** Immutable ids are also Markdown filenames, so only one safe path segment is legal. */
export const ProjectDocumentIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "must be a path-safe document id");

export const ProjectKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a lower-case slug");

export const ProjectKeysSchema = z
  .array(ProjectKeySchema)
  .max(20)
  .refine((values) => new Set(values).size === values.length, "project keys must be unique");

export const ProjectSourceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !/\p{Cc}/u.test(value), "must not contain control characters");

export const ProjectHashSchema = z.string().regex(/^[a-f0-9]{64}$/, "must be a SHA-256 hash");

const DisplayTextSchema = z.string().trim().min(1).max(120);
const RepositoryIdentifierSchema = z.string().trim().min(1).max(240);
const FailureClassSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "must be a content-free failure class");

function hasNoDuplicates(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export const ProjectSectionSchema = z.strictObject({
  content: z.string().max(12_000),
  ownership: ProjectSectionOwnershipSchema,
  source_ids: z
    .array(ProjectSourceIdSchema)
    .max(50)
    .refine(hasNoDuplicates, "source ids must be unique"),
});
export type ProjectSection = z.infer<typeof ProjectSectionSchema>;

export const ProjectSectionsSchema = z.strictObject({
  what_this_project_is: ProjectSectionSchema,
  technology_and_architecture: ProjectSectionSchema,
  current_state: ProjectSectionSchema,
  last_meaningful_work: ProjectSectionSchema,
  planned_next: ProjectSectionSchema,
  blockers_and_uncertainties: ProjectSectionSchema,
});
export type ProjectSections = z.infer<typeof ProjectSectionsSchema>;

export const ProjectSchema = z
  .strictObject({
    id: ProjectDocumentIdSchema,
    key: ProjectKeySchema,
    display_name: DisplayTextSchema,
    aliases: z.array(DisplayTextSchema).max(20).refine(hasNoDuplicates, "aliases must be unique"),
    repository_identifiers: z
      .array(RepositoryIdentifierSchema)
      .max(20)
      .refine(hasNoDuplicates, "repository identifiers must be unique"),
    status: ProjectStatusSchema,
    resolution: ProjectResolutionSchema.nullable(),
    resolved_project_id: ProjectDocumentIdSchema.nullable(),
    proposal_rationale: z.string().min(1).max(2_000).nullable(),
    proposal_evidence_ids: z
      .array(ProjectSourceIdSchema)
      .max(50)
      .refine(hasNoDuplicates, "proposal evidence ids must be unique"),
    suppression_fingerprint: ProjectHashSchema.nullable(),
    possible_match_ids: z
      .array(ProjectDocumentIdSchema)
      .max(20)
      .refine(hasNoDuplicates, "possible match ids must be unique"),
    sections: ProjectSectionsSchema,
    compiled_at: IsoTimestampSchema.nullable(),
    compiler_version: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a safe compiler version")
      .nullable(),
    source_watermark: ProjectHashSchema.nullable(),
    source_ids: z
      .array(ProjectSourceIdSchema)
      .max(200)
      .refine(hasNoDuplicates, "source ids must be unique"),
    content_hash: ProjectHashSchema.nullable(),
    refresh_status: ProjectRefreshStatusSchema,
    refresh_failure_class: FailureClassSchema.nullable(),
    pending_source_count: z.number().int().min(0).max(1_000_000),
    unresolved_conflict_count: z.number().int().min(0).max(1_000_000),
    last_activity_at: IsoTimestampSchema.nullable(),
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema,
  })
  .superRefine((project, context) => {
    if (Date.parse(project.updated_at) < Date.parse(project.created_at)) {
      context.addIssue({
        code: "custom",
        path: ["updated_at"],
        message: "updated_at cannot precede created_at",
      });
    }

    if (project.status === "proposed") {
      if (project.proposal_rationale === null) {
        context.addIssue({
          code: "custom",
          path: ["proposal_rationale"],
          message: "a proposed project requires a rationale",
        });
      }
      if (project.proposal_evidence_ids.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["proposal_evidence_ids"],
          message: "a proposed project requires source evidence",
        });
      }
    }

    if (project.status !== "archived" && project.resolution !== null) {
      context.addIssue({
        code: "custom",
        path: ["resolution"],
        message: "only an archived project may have a resolution",
      });
    }
    if (project.resolution === "rejected" && project.suppression_fingerprint === null) {
      context.addIssue({
        code: "custom",
        path: ["suppression_fingerprint"],
        message: "a rejected project requires a suppression fingerprint",
      });
    }
    if (project.resolution === "belongs_to_existing" && project.resolved_project_id === null) {
      context.addIssue({
        code: "custom",
        path: ["resolved_project_id"],
        message: "a mapped proposal requires the existing project id",
      });
    }
    if (project.resolution !== "belongs_to_existing" && project.resolved_project_id !== null) {
      context.addIssue({
        code: "custom",
        path: ["resolved_project_id"],
        message: "resolved_project_id is only valid for belongs_to_existing",
      });
    }
    if (project.resolution !== "rejected" && project.suppression_fingerprint !== null) {
      context.addIssue({
        code: "custom",
        path: ["suppression_fingerprint"],
        message: "suppression_fingerprint is only valid for a rejected project",
      });
    }

    if (project.refresh_status === "failed" && project.refresh_failure_class === null) {
      context.addIssue({
        code: "custom",
        path: ["refresh_failure_class"],
        message: "a failed refresh requires a failure class",
      });
    }
    if (project.refresh_status !== "failed" && project.refresh_failure_class !== null) {
      context.addIssue({
        code: "custom",
        path: ["refresh_failure_class"],
        message: "a failure class is only valid for a failed refresh",
      });
    }
  });
export type Project = z.infer<typeof ProjectSchema>;
