import { z } from "zod";
import { IsoTimestampSchema } from "./common.js";
import {
  ProjectDocumentIdSchema,
  ProjectHashSchema,
  ProjectSectionKeySchema,
  ProjectSourceIdSchema,
} from "./project.js";

export const ProjectSuggestionStatusSchema = z.enum([
  "pending",
  "accepted",
  "rejected",
  "dismissed",
]);
export type ProjectSuggestionStatus = z.infer<typeof ProjectSuggestionStatusSchema>;

export const ProjectSuggestionSchema = z
  .strictObject({
    id: ProjectDocumentIdSchema,
    project_id: ProjectDocumentIdSchema,
    section: ProjectSectionKeySchema,
    proposed_content: z.string().min(1).max(12_000),
    rationale: z.string().min(1).max(2_000),
    source_ids: z
      .array(ProjectSourceIdSchema)
      .min(1)
      .max(50)
      .refine((values) => new Set(values).size === values.length, "source ids must be unique"),
    content_hash: ProjectHashSchema,
    status: ProjectSuggestionStatusSchema,
    created_at: IsoTimestampSchema,
    resolved_at: IsoTimestampSchema.nullable(),
  })
  .superRefine((suggestion, context) => {
    if (suggestion.status === "pending" && suggestion.resolved_at !== null) {
      context.addIssue({
        code: "custom",
        path: ["resolved_at"],
        message: "a pending suggestion cannot be resolved",
      });
    }
    if (suggestion.status !== "pending" && suggestion.resolved_at === null) {
      context.addIssue({
        code: "custom",
        path: ["resolved_at"],
        message: "a resolved suggestion requires resolved_at",
      });
    }
  });
export type ProjectSuggestion = z.infer<typeof ProjectSuggestionSchema>;
