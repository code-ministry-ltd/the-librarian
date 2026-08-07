import type { Project, ProjectStatus } from "../schemas/project.js";

export interface ListProjectsInput {
  status?: ProjectStatus;
}

export interface ProjectStore {
  create(project: Project, actorId?: string): Project;
  update(project: Project, actorId?: string): Project;
  getById(id: string): Project | null;
  getByKey(key: string): Project | null;
  list(input?: ListProjectsInput): Project[];
}

export class ProjectRecordExistsError extends Error {
  constructor(id: string) {
    super(`Project ${id} already exists`);
    this.name = "ProjectRecordExistsError";
  }
}

export class ProjectRecordNotFoundError extends Error {
  constructor(id: string) {
    super(`Project ${id} does not exist`);
    this.name = "ProjectRecordNotFoundError";
  }
}

export class DuplicateProjectKeyError extends Error {
  constructor(key: string) {
    super(`Project key '${key}' is already in use in this shelf`);
    this.name = "DuplicateProjectKeyError";
  }
}

export class ProjectKeyImmutableError extends Error {
  constructor(key: string) {
    super(`Project key '${key}' is stable after approval and cannot be changed`);
    this.name = "ProjectKeyImmutableError";
  }
}
