import { ProjectUpdateSchema, type ProjectUpdate } from "../../schemas/project-update.js";
import { ProjectDocumentIdSchema, ProjectHashSchema } from "../../schemas/project.js";
import { commitSubject } from "../commit-message.js";
import type { Vault } from "../corpus/vault.js";
import {
  type ListProjectUpdatesInput,
  type ProjectUpdateStore,
  ProjectUpdateExistsError,
} from "../project-update-store.js";
import { assertSafeProjectStorePath } from "./project-store-path.js";
import {
  parseProjectUpdateDocument,
  serializeProjectUpdateDocument,
} from "./project-update-doc.js";

export interface MarkdownProjectUpdateStoreDeps {
  vault: Vault;
  commit?: (paths: string[], message: string, actorId?: string) => void;
}

function assertId(id: string): string {
  const result = ProjectDocumentIdSchema.safeParse(id);
  if (!result.success) {
    throw new Error(
      `Invalid project update id '${id}': ${result.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  return result.data;
}

function updatePath(id: string): string {
  return `project-updates/${assertId(id)}.md`;
}

function compareUpdates(a: ProjectUpdate, b: ProjectUpdate): number {
  return b.captured_at.localeCompare(a.captured_at) || a.id.localeCompare(b.id);
}

function boundedLimit(limit: number | undefined): number {
  const value = limit ?? 100;
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new Error("Project update list limit must be an integer between 1 and 500");
  }
  return value;
}

export function createMarkdownProjectUpdateStore(
  deps: MarkdownProjectUpdateStoreDeps,
): ProjectUpdateStore {
  const commit = deps.commit ?? (() => {});

  function getById(id: string): ProjectUpdate | null {
    const safeId = assertId(id);
    const rel = updatePath(safeId);
    assertSafeProjectStorePath(deps.vault, rel);
    const raw = deps.vault.tryReadText(rel);
    if (raw === null) return null;
    const update = parseProjectUpdateDocument(raw);
    if (update.id !== safeId) {
      throw new Error(
        `Invalid project update document: filename id ${safeId} disagrees with frontmatter id ${update.id}`,
      );
    }
    return update;
  }

  function readAll(): ProjectUpdate[] {
    return deps.vault.listMarkdown("project-updates").map((rel) => {
      assertSafeProjectStorePath(deps.vault, rel);
      const expectedId = rel.slice("project-updates/".length, -".md".length);
      const update = parseProjectUpdateDocument(deps.vault.readText(rel));
      if (update.id !== expectedId) {
        throw new Error(
          `Invalid project update document: filename id ${expectedId} disagrees with frontmatter id ${update.id}`,
        );
      }
      return update;
    });
  }

  function list(input: ListProjectUpdatesInput = {}): ProjectUpdate[] {
    return readAll()
      .filter((update) => input.project_id === undefined || update.project_id === input.project_id)
      .filter(
        (update) =>
          input.candidate_fingerprint === undefined ||
          update.candidate_fingerprint === input.candidate_fingerprint,
      )
      .filter(
        (update) => input.source_kind === undefined || update.source_kind === input.source_kind,
      )
      .filter((update) => input.source_ref === undefined || update.source_ref === input.source_ref)
      .sort(compareUpdates)
      .slice(0, boundedLimit(input.limit));
  }

  function getByFingerprint(fingerprint: string): ProjectUpdate | null {
    const safeFingerprint = ProjectHashSchema.parse(fingerprint);
    return readAll().find((update) => update.fingerprint === safeFingerprint) ?? null;
  }

  function append(input: ProjectUpdate, actorId?: string): ProjectUpdate {
    const update = ProjectUpdateSchema.parse(input);
    const rel = updatePath(update.id);
    assertSafeProjectStorePath(deps.vault, rel);
    if (deps.vault.exists(rel)) throw new ProjectUpdateExistsError(update.id);
    assertSafeProjectStorePath(deps.vault, rel);
    deps.vault.writeText(rel, serializeProjectUpdateDocument(update));
    commit([rel], commitSubject.projectUpdateAppend(update.id), actorId);
    return update;
  }

  return { append, getById, getByFingerprint, list };
}
