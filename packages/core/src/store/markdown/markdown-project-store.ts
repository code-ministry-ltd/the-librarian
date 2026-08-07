import {
  ProjectDocumentIdSchema,
  ProjectKeySchema,
  ProjectSchema,
  type Project,
} from "../../schemas/project.js";
import { commitSubject } from "../commit-message.js";
import type { Vault } from "../corpus/vault.js";
import {
  DuplicateProjectKeyError,
  type ListProjectsInput,
  type ProjectStore,
  ProjectKeyImmutableError,
  ProjectRecordExistsError,
  ProjectRecordNotFoundError,
} from "../project-store.js";
import { parseProjectDocument, serializeProjectDocument } from "./project-doc.js";
import { assertSafeProjectStorePath } from "./project-store-path.js";

export interface MarkdownProjectStoreDeps {
  vault: Vault;
  commit?: (paths: string[], message: string, actorId?: string) => void;
}

function assertId(id: string): string {
  const result = ProjectDocumentIdSchema.safeParse(id);
  if (!result.success) {
    throw new Error(`Invalid project id '${id}': ${result.error.issues[0]?.message ?? "invalid"}`);
  }
  return result.data;
}

function projectPath(id: string): string {
  return `projects/${assertId(id)}.md`;
}

function compareProjects(a: Project, b: Project): number {
  return b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id);
}

export function createMarkdownProjectStore(deps: MarkdownProjectStoreDeps): ProjectStore {
  const commit = deps.commit ?? (() => {});

  function readPath(rel: string, expectedId?: string): Project {
    assertSafeProjectStorePath(deps.vault, rel);
    const project = parseProjectDocument(deps.vault.readText(rel));
    if (expectedId !== undefined && project.id !== expectedId) {
      throw new Error(
        `Invalid project document: filename id ${expectedId} disagrees with frontmatter id ${project.id}`,
      );
    }
    return project;
  }

  function getById(id: string): Project | null {
    const safeId = assertId(id);
    const rel = projectPath(safeId);
    assertSafeProjectStorePath(deps.vault, rel);
    const raw = deps.vault.tryReadText(rel);
    if (raw === null) return null;
    const project = parseProjectDocument(raw);
    if (project.id !== safeId) {
      throw new Error(
        `Invalid project document: filename id ${safeId} disagrees with frontmatter id ${project.id}`,
      );
    }
    return project;
  }

  function list(input: ListProjectsInput = {}): Project[] {
    const projects = deps.vault
      .listMarkdown("projects")
      .map((rel) => readPath(rel, rel.slice("projects/".length, -".md".length)));
    const seenKeys = new Set<string>();
    for (const project of projects) {
      if (seenKeys.has(project.key)) throw new DuplicateProjectKeyError(project.key);
      seenKeys.add(project.key);
    }
    return projects
      .filter((project) => input.status === undefined || project.status === input.status)
      .sort(compareProjects);
  }

  function getByKey(key: string): Project | null {
    const safeKey = ProjectKeySchema.parse(key);
    return list().find((project) => project.key === safeKey) ?? null;
  }

  function assertUniqueKey(project: Project): void {
    const existing = getByKey(project.key);
    if (existing !== null && existing.id !== project.id) {
      throw new DuplicateProjectKeyError(project.key);
    }
  }

  function create(input: Project, actorId?: string): Project {
    const project = ProjectSchema.parse(input);
    const rel = projectPath(project.id);
    assertSafeProjectStorePath(deps.vault, rel);
    if (deps.vault.exists(rel)) throw new ProjectRecordExistsError(project.id);
    assertUniqueKey(project);
    assertSafeProjectStorePath(deps.vault, rel);
    deps.vault.writeText(rel, serializeProjectDocument(project));
    commit([rel], commitSubject.projectCreate(project.id), actorId);
    return project;
  }

  function update(input: Project, actorId?: string): Project {
    const project = ProjectSchema.parse(input);
    const rel = projectPath(project.id);
    assertSafeProjectStorePath(deps.vault, rel);
    const existing = getById(project.id);
    if (existing === null) throw new ProjectRecordNotFoundError(project.id);
    assertUniqueKey(project);
    if (existing.status !== "proposed" && existing.key !== project.key) {
      throw new ProjectKeyImmutableError(existing.key);
    }
    assertSafeProjectStorePath(deps.vault, rel);
    deps.vault.writeText(rel, serializeProjectDocument(project));
    commit([rel], commitSubject.projectUpdate(project.id), actorId);
    return project;
  }

  return { create, update, getById, getByKey, list };
}
