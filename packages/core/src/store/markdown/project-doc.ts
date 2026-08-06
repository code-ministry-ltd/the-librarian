import matter from "gray-matter";
import { z } from "zod";
import { IsoTimestampSchema } from "../../schemas/common.js";
import {
  PROJECT_SECTION_KEYS,
  ProjectDocumentIdSchema,
  ProjectHashSchema,
  ProjectKeySchema,
  ProjectRefreshStatusSchema,
  ProjectResolutionSchema,
  ProjectSchema,
  ProjectSectionOwnershipSchema,
  ProjectSourceIdSchema,
  ProjectStatusSchema,
  type Project,
  type ProjectSectionKey,
  type ProjectSections,
} from "../../schemas/project.js";

const SECTION_HEADINGS: Record<ProjectSectionKey, string> = {
  what_this_project_is: "What this project is",
  technology_and_architecture: "Technology and architecture",
  current_state: "Current state",
  last_meaningful_work: "Last meaningful work",
  planned_next: "Planned next",
  blockers_and_uncertainties: "Blockers and uncertainties",
};

const SectionOwnershipFrontmatterSchema = z.strictObject({
  what_this_project_is: ProjectSectionOwnershipSchema,
  technology_and_architecture: ProjectSectionOwnershipSchema,
  current_state: ProjectSectionOwnershipSchema,
  last_meaningful_work: ProjectSectionOwnershipSchema,
  planned_next: ProjectSectionOwnershipSchema,
  blockers_and_uncertainties: ProjectSectionOwnershipSchema,
});

const SectionSourceIdsFrontmatterSchema = z.strictObject({
  what_this_project_is: z.array(ProjectSourceIdSchema).max(50),
  technology_and_architecture: z.array(ProjectSourceIdSchema).max(50),
  current_state: z.array(ProjectSourceIdSchema).max(50),
  last_meaningful_work: z.array(ProjectSourceIdSchema).max(50),
  planned_next: z.array(ProjectSourceIdSchema).max(50),
  blockers_and_uncertainties: z.array(ProjectSourceIdSchema).max(50),
});

const ProjectFrontmatterSchema = z.strictObject({
  id: ProjectDocumentIdSchema,
  key: ProjectKeySchema,
  display_name: z.string().trim().min(1).max(120),
  aliases: z.array(z.string().trim().min(1).max(120)).max(20),
  repository_identifiers: z.array(z.string().trim().min(1).max(240)).max(20),
  status: ProjectStatusSchema,
  resolution: ProjectResolutionSchema.nullable(),
  resolved_project_id: ProjectDocumentIdSchema.nullable(),
  proposal_rationale: z.string().min(1).max(2_000).nullable(),
  proposal_evidence_ids: z.array(ProjectSourceIdSchema).max(50),
  suppression_fingerprint: ProjectHashSchema.nullable(),
  possible_match_ids: z.array(ProjectDocumentIdSchema).max(20),
  section_ownership: SectionOwnershipFrontmatterSchema,
  section_source_ids: SectionSourceIdsFrontmatterSchema,
  compiled_at: IsoTimestampSchema.nullable(),
  compiler_version: z.string().min(1).max(64).nullable(),
  source_watermark: ProjectHashSchema.nullable(),
  source_ids: z.array(ProjectSourceIdSchema).max(200),
  content_hash: ProjectHashSchema.nullable(),
  refresh_status: ProjectRefreshStatusSchema,
  refresh_failure_class: z.string().min(1).max(100).nullable(),
  pending_source_count: z.number().int().min(0).max(1_000_000),
  unresolved_conflict_count: z.number().int().min(0).max(1_000_000),
  last_activity_at: IsoTimestampSchema.nullable(),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});

function startMarker(key: ProjectSectionKey): string {
  return `<!-- librarian-section:${key}:start -->`;
}

function endMarker(key: ProjectSectionKey): string {
  return `<!-- librarian-section:${key}:end -->`;
}

function renderSections(sections: ProjectSections): string {
  return PROJECT_SECTION_KEYS.map((key) => {
    const content = sections[key].content;
    if (content.includes(startMarker(key)) || content.includes(endMarker(key))) {
      throw new Error(`Invalid project section ${key}: content contains a reserved framing marker`);
    }
    return [`## ${SECTION_HEADINGS[key]}`, startMarker(key), `${content}\n${endMarker(key)}`].join(
      "\n",
    );
  }).join("\n\n");
}

function parseSections(rawBody: string): Record<ProjectSectionKey, string> {
  const body = rawBody.endsWith("\n") ? rawBody.slice(0, -1) : rawBody;
  const sections = {} as Record<ProjectSectionKey, string>;
  let cursor = 0;

  for (const [index, key] of PROJECT_SECTION_KEYS.entries()) {
    const prefix = `## ${SECTION_HEADINGS[key]}\n${startMarker(key)}\n`;
    if (!body.startsWith(prefix, cursor)) {
      throw new Error(`Invalid project document body: expected framing for section ${key}`);
    }
    const contentStart = cursor + prefix.length;
    const closing = `\n${endMarker(key)}`;
    const contentEnd = body.indexOf(closing, contentStart);
    if (contentEnd < 0) {
      throw new Error(`Invalid project document body: missing end marker for section ${key}`);
    }
    sections[key] = body.slice(contentStart, contentEnd);
    cursor = contentEnd + closing.length;
    if (index < PROJECT_SECTION_KEYS.length - 1) {
      if (!body.startsWith("\n\n", cursor)) {
        throw new Error(`Invalid project document body: expected separator after section ${key}`);
      }
      cursor += 2;
    }
  }

  if (cursor !== body.length) {
    throw new Error("Invalid project document body: content exists outside the six sections");
  }
  return sections;
}

function coerceDates(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  );
}

function validationDetail(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

export function serializeProjectDocument(input: Project): string {
  const project = ProjectSchema.parse(input);
  const section_ownership = Object.fromEntries(
    PROJECT_SECTION_KEYS.map((key) => [key, project.sections[key].ownership]),
  ) as z.infer<typeof SectionOwnershipFrontmatterSchema>;
  const section_source_ids = Object.fromEntries(
    PROJECT_SECTION_KEYS.map((key) => [key, project.sections[key].source_ids]),
  ) as z.infer<typeof SectionSourceIdsFrontmatterSchema>;
  const frontmatter = {
    id: project.id,
    key: project.key,
    display_name: project.display_name,
    aliases: project.aliases,
    repository_identifiers: project.repository_identifiers,
    status: project.status,
    resolution: project.resolution,
    resolved_project_id: project.resolved_project_id,
    proposal_rationale: project.proposal_rationale,
    proposal_evidence_ids: project.proposal_evidence_ids,
    suppression_fingerprint: project.suppression_fingerprint,
    possible_match_ids: project.possible_match_ids,
    section_ownership,
    section_source_ids,
    compiled_at: project.compiled_at,
    compiler_version: project.compiler_version,
    source_watermark: project.source_watermark,
    source_ids: project.source_ids,
    content_hash: project.content_hash,
    refresh_status: project.refresh_status,
    refresh_failure_class: project.refresh_failure_class,
    pending_source_count: project.pending_source_count,
    unresolved_conflict_count: project.unresolved_conflict_count,
    last_activity_at: project.last_activity_at,
    created_at: project.created_at,
    updated_at: project.updated_at,
  };
  return matter.stringify(renderSections(project.sections), frontmatter);
}

export function parseProjectDocument(raw: string): Project {
  const { data, content } = matter(raw);
  const frontmatter = ProjectFrontmatterSchema.safeParse(coerceDates(data));
  if (!frontmatter.success) {
    throw new Error(`Invalid project document frontmatter: ${validationDetail(frontmatter.error)}`);
  }
  const sectionContent = parseSections(content);
  const sections = Object.fromEntries(
    PROJECT_SECTION_KEYS.map((key) => [
      key,
      {
        content: sectionContent[key],
        ownership: frontmatter.data.section_ownership[key],
        source_ids: frontmatter.data.section_source_ids[key],
      },
    ]),
  ) as ProjectSections;
  const {
    section_ownership: _ownership,
    section_source_ids: _sources,
    ...metadata
  } = frontmatter.data;
  const project = ProjectSchema.safeParse({ ...metadata, sections });
  if (!project.success) {
    throw new Error(`Invalid project document: ${validationDetail(project.error)}`);
  }
  return project.data;
}
