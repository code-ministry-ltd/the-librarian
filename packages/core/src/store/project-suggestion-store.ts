import type { ProjectSuggestion, ProjectSuggestionStatus } from "../schemas/project-suggestion.js";
import type { ProjectSectionKey } from "../schemas/project.js";

export interface ListProjectSuggestionsInput {
  project_id?: string;
  section?: ProjectSectionKey;
  status?: ProjectSuggestionStatus;
  limit?: number;
}

export interface ProjectSuggestionStore {
  create(suggestion: ProjectSuggestion, actorId?: string): ProjectSuggestion;
  update(suggestion: ProjectSuggestion, actorId?: string): ProjectSuggestion;
  getById(id: string): ProjectSuggestion | null;
  findByContentHash(
    projectId: string,
    section: ProjectSectionKey,
    contentHash: string,
  ): ProjectSuggestion | null;
  list(input?: ListProjectSuggestionsInput): ProjectSuggestion[];
}

export class ProjectSuggestionExistsError extends Error {
  constructor(id: string) {
    super(`Project suggestion ${id} already exists`);
    this.name = "ProjectSuggestionExistsError";
  }
}

export class ProjectSuggestionNotFoundError extends Error {
  constructor(id: string) {
    super(`Project suggestion ${id} does not exist`);
    this.name = "ProjectSuggestionNotFoundError";
  }
}
