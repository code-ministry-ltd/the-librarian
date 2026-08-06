import {
  ProjectSuggestionSchema,
  type ProjectSuggestion,
} from "../../schemas/project-suggestion.js";
import {
  ProjectDocumentIdSchema,
  ProjectHashSchema,
  ProjectSectionKeySchema,
  type ProjectSectionKey,
} from "../../schemas/project.js";
import { commitSubject } from "../commit-message.js";
import type { Vault } from "../corpus/vault.js";
import {
  type ListProjectSuggestionsInput,
  type ProjectSuggestionStore,
  ProjectSuggestionExistsError,
  ProjectSuggestionNotFoundError,
} from "../project-suggestion-store.js";
import { assertSafeProjectStorePath } from "./project-store-path.js";
import {
  parseProjectSuggestionDocument,
  serializeProjectSuggestionDocument,
} from "./project-suggestion-doc.js";

export interface MarkdownProjectSuggestionStoreDeps {
  vault: Vault;
  commit?: (paths: string[], message: string, actorId?: string) => void;
}

function assertId(id: string): string {
  const result = ProjectDocumentIdSchema.safeParse(id);
  if (!result.success) {
    throw new Error(
      `Invalid project suggestion id '${id}': ${result.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  return result.data;
}

function suggestionPath(id: string): string {
  return `project-suggestions/${assertId(id)}.md`;
}

function boundedLimit(limit: number | undefined): number {
  const value = limit ?? 100;
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new Error("Project suggestion list limit must be an integer between 1 and 500");
  }
  return value;
}

export function createMarkdownProjectSuggestionStore(
  deps: MarkdownProjectSuggestionStoreDeps,
): ProjectSuggestionStore {
  const commit = deps.commit ?? (() => {});

  function getById(id: string): ProjectSuggestion | null {
    const safeId = assertId(id);
    const rel = suggestionPath(safeId);
    assertSafeProjectStorePath(deps.vault, rel);
    const raw = deps.vault.tryReadText(rel);
    if (raw === null) return null;
    const suggestion = parseProjectSuggestionDocument(raw);
    if (suggestion.id !== safeId) {
      throw new Error(
        `Invalid project suggestion document: filename id ${safeId} disagrees with frontmatter id ${suggestion.id}`,
      );
    }
    return suggestion;
  }

  function readAll(): ProjectSuggestion[] {
    return deps.vault.listMarkdown("project-suggestions").map((rel) => {
      assertSafeProjectStorePath(deps.vault, rel);
      const expectedId = rel.slice("project-suggestions/".length, -".md".length);
      const suggestion = parseProjectSuggestionDocument(deps.vault.readText(rel));
      if (suggestion.id !== expectedId) {
        throw new Error(
          `Invalid project suggestion document: filename id ${expectedId} disagrees with frontmatter id ${suggestion.id}`,
        );
      }
      return suggestion;
    });
  }

  function list(input: ListProjectSuggestionsInput = {}): ProjectSuggestion[] {
    return readAll()
      .filter(
        (suggestion) =>
          input.project_id === undefined || suggestion.project_id === input.project_id,
      )
      .filter((suggestion) => input.section === undefined || suggestion.section === input.section)
      .filter((suggestion) => input.status === undefined || suggestion.status === input.status)
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id))
      .slice(0, boundedLimit(input.limit));
  }

  function findByContentHash(
    projectId: string,
    section: ProjectSectionKey,
    contentHash: string,
  ): ProjectSuggestion | null {
    const safeProjectId = assertId(projectId);
    const safeSection = ProjectSectionKeySchema.parse(section);
    const safeHash = ProjectHashSchema.parse(contentHash);
    return (
      readAll().find(
        (suggestion) =>
          suggestion.project_id === safeProjectId &&
          suggestion.section === safeSection &&
          suggestion.content_hash === safeHash,
      ) ?? null
    );
  }

  function create(input: ProjectSuggestion, actorId?: string): ProjectSuggestion {
    const suggestion = ProjectSuggestionSchema.parse(input);
    const rel = suggestionPath(suggestion.id);
    assertSafeProjectStorePath(deps.vault, rel);
    if (deps.vault.exists(rel)) throw new ProjectSuggestionExistsError(suggestion.id);
    assertSafeProjectStorePath(deps.vault, rel);
    deps.vault.writeText(rel, serializeProjectSuggestionDocument(suggestion));
    commit([rel], commitSubject.projectSuggestionCreate(suggestion.id), actorId);
    return suggestion;
  }

  function update(input: ProjectSuggestion, actorId?: string): ProjectSuggestion {
    const suggestion = ProjectSuggestionSchema.parse(input);
    const rel = suggestionPath(suggestion.id);
    assertSafeProjectStorePath(deps.vault, rel);
    if (!deps.vault.exists(rel)) throw new ProjectSuggestionNotFoundError(suggestion.id);
    assertSafeProjectStorePath(deps.vault, rel);
    deps.vault.writeText(rel, serializeProjectSuggestionDocument(suggestion));
    commit([rel], commitSubject.projectSuggestionUpdate(suggestion.id), actorId);
    return suggestion;
  }

  return { create, update, getById, findByContentHash, list };
}
