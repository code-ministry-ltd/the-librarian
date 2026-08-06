import matter from "gray-matter";
import { z } from "zod";
import { IsoTimestampSchema } from "../../schemas/common.js";
import {
  ProjectSuggestionSchema,
  ProjectSuggestionStatusSchema,
  type ProjectSuggestion,
} from "../../schemas/project-suggestion.js";
import {
  ProjectDocumentIdSchema,
  ProjectHashSchema,
  ProjectSectionKeySchema,
  ProjectSourceIdSchema,
} from "../../schemas/project.js";

const START_MARKER = "<!-- librarian-suggestion:start -->";
const END_MARKER = "<!-- librarian-suggestion:end -->";
const BODY_PREFIX = `## Proposed replacement\n${START_MARKER}\n`;

const ProjectSuggestionFrontmatterSchema = z.strictObject({
  id: ProjectDocumentIdSchema,
  project_id: ProjectDocumentIdSchema,
  section: ProjectSectionKeySchema,
  rationale: z.string().min(1).max(2_000),
  source_ids: z.array(ProjectSourceIdSchema).min(1).max(50),
  content_hash: ProjectHashSchema,
  status: ProjectSuggestionStatusSchema,
  created_at: IsoTimestampSchema,
  resolved_at: IsoTimestampSchema.nullable(),
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

function renderBody(content: string): string {
  if (content.includes(START_MARKER) || content.includes(END_MARKER)) {
    throw new Error("Invalid proposed_content: content contains a reserved framing marker");
  }
  return `${BODY_PREFIX}${content}\n${END_MARKER}`;
}

function parseBody(rawBody: string): string {
  const body = rawBody.endsWith("\n") ? rawBody.slice(0, -1) : rawBody;
  if (!body.startsWith(BODY_PREFIX)) {
    throw new Error("Invalid project suggestion body: missing proposed_content start marker");
  }
  const closing = `\n${END_MARKER}`;
  if (!body.endsWith(closing)) {
    throw new Error("Invalid project suggestion body: missing proposed_content end marker");
  }
  return body.slice(BODY_PREFIX.length, -closing.length);
}

export function serializeProjectSuggestionDocument(input: ProjectSuggestion): string {
  const suggestion = ProjectSuggestionSchema.parse(input);
  const frontmatter = {
    id: suggestion.id,
    project_id: suggestion.project_id,
    section: suggestion.section,
    rationale: suggestion.rationale,
    source_ids: suggestion.source_ids,
    content_hash: suggestion.content_hash,
    status: suggestion.status,
    created_at: suggestion.created_at,
    resolved_at: suggestion.resolved_at,
  };
  return matter.stringify(renderBody(suggestion.proposed_content), frontmatter);
}

export function parseProjectSuggestionDocument(raw: string): ProjectSuggestion {
  const { data, content } = matter(raw);
  const frontmatter = ProjectSuggestionFrontmatterSchema.safeParse(coerceDates(data));
  if (!frontmatter.success) {
    throw new Error(
      `Invalid project suggestion document frontmatter: ${validationDetail(frontmatter.error)}`,
    );
  }
  const suggestion = ProjectSuggestionSchema.safeParse({
    ...frontmatter.data,
    proposed_content: parseBody(content),
  });
  if (!suggestion.success) {
    throw new Error(`Invalid project suggestion document: ${validationDetail(suggestion.error)}`);
  }
  return suggestion.data;
}
