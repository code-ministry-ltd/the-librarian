import type { ProjectUpdate, ProjectUpdateSourceKind } from "../schemas/project-update.js";

export interface ListProjectUpdatesInput {
  project_id?: string;
  candidate_fingerprint?: string;
  source_kind?: ProjectUpdateSourceKind;
  source_ref?: string;
  limit?: number;
}

export interface ProjectUpdateStore {
  append(update: ProjectUpdate, actorId?: string): ProjectUpdate;
  getById(id: string): ProjectUpdate | null;
  getByFingerprint(fingerprint: string): ProjectUpdate | null;
  list(input?: ListProjectUpdatesInput): ProjectUpdate[];
}

export class ProjectUpdateExistsError extends Error {
  constructor(id: string) {
    super(`Project update ${id} already exists; project updates are append-only`);
    this.name = "ProjectUpdateExistsError";
  }
}
