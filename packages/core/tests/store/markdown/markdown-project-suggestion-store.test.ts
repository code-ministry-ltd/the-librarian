import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ProjectSuggestionExistsError,
  ProjectSuggestionNotFoundError,
  createMarkdownProjectSuggestionStore,
  createVault,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectSuggestionRecord } from "../../fixtures/project-records.js";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-project-suggestion-store-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("Markdown ProjectSuggestionStore", () => {
  it("creates, reads, filters and resolves a suggestion without moving its path", () => {
    const vault = createVault({ dataDir });
    const store = createMarkdownProjectSuggestionStore({ vault });
    const pending = projectSuggestionRecord();
    store.create(pending);
    expect(store.getById(pending.id)).toEqual(pending);
    expect(store.list({ project_id: "prj_123", status: "pending" })).toEqual([pending]);

    const accepted = {
      ...pending,
      status: "accepted" as const,
      resolved_at: "2026-08-06T13:00:00.000Z",
    };
    expect(store.update(accepted)).toEqual(accepted);
    expect(store.list({ status: "pending" })).toEqual([]);
    expect(store.list({ status: "accepted" })).toEqual([accepted]);
    expect(vault.listMarkdown("project-suggestions")).toEqual(["project-suggestions/prs_123.md"]);
  });

  it("refuses duplicate creates, missing updates and unsafe ids", () => {
    const store = createMarkdownProjectSuggestionStore({ vault: createVault({ dataDir }) });
    store.create(projectSuggestionRecord());
    expect(() => store.create(projectSuggestionRecord())).toThrow(ProjectSuggestionExistsError);
    expect(() => store.update(projectSuggestionRecord({ id: "prs_missing" }))).toThrow(
      ProjectSuggestionNotFoundError,
    );
    expect(() => store.getById("../suggestion")).toThrow(/path-safe document id/);
  });

  it("finds an existing project/section/hash suggestion for idempotent conflict handling", () => {
    const store = createMarkdownProjectSuggestionStore({ vault: createVault({ dataDir }) });
    const suggestion = projectSuggestionRecord();
    store.create(suggestion);
    expect(
      store.findByContentHash(suggestion.project_id, suggestion.section, suggestion.content_hash),
    ).toEqual(suggestion);
    expect(
      store.findByContentHash(suggestion.project_id, "planned_next", suggestion.content_hash),
    ).toBeNull();
  });

  it("commits create and update paths with attribution", () => {
    const commits: unknown[][] = [];
    const store = createMarkdownProjectSuggestionStore({
      vault: createVault({ dataDir }),
      commit: (...args) => commits.push(args),
    });
    const pending = store.create(projectSuggestionRecord(), "curator-1");
    store.update(
      {
        ...pending,
        status: "rejected",
        resolved_at: "2026-08-06T13:00:00.000Z",
      },
      "admin-1",
    );
    expect(commits).toEqual([
      [["project-suggestions/prs_123.md"], "project-suggestion: create prs_123", "curator-1"],
      [["project-suggestions/prs_123.md"], "project-suggestion: update prs_123", "admin-1"],
    ]);
  });

  it("deduplicates by content hash outside the bounded presentation window", () => {
    const store = createMarkdownProjectSuggestionStore({ vault: createVault({ dataDir }) });
    const target = projectSuggestionRecord({
      id: "prs_target",
      created_at: "2026-08-05T12:00:00.000Z",
      content_hash: "f".repeat(64),
    });
    store.create(target);
    for (let index = 0; index < 500; index++) {
      store.create(
        projectSuggestionRecord({
          id: `prs_new_${index}`,
          created_at: "2026-08-06T12:00:00.000Z",
          content_hash: index.toString(16).padStart(64, "0"),
        }),
      );
    }
    expect(store.list()).toHaveLength(100);
    expect(store.findByContentHash(target.project_id, target.section, target.content_hash)).toEqual(
      target,
    );
  });
});
