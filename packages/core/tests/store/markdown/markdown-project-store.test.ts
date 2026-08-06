import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DuplicateProjectKeyError,
  ProjectRecordExistsError,
  ProjectRecordNotFoundError,
  UnsafeVaultPathError,
  createMarkdownProjectStore,
  createVault,
  serializeProjectDocument,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectRecord } from "../../fixtures/project-records.js";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-project-store-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("Markdown ProjectStore", () => {
  it("creates, reads, lists, filters and updates one immutable-id document", () => {
    const vault = createVault({ dataDir });
    const store = createMarkdownProjectStore({ vault });
    const first = projectRecord();
    const second = projectRecord({
      id: "prj_456",
      key: "other-project",
      display_name: "Other project",
      status: "archived",
      created_at: "2026-08-05T12:00:00.000Z",
      updated_at: "2026-08-05T12:00:00.000Z",
    });

    expect(store.create(first)).toEqual(first);
    store.create(second);
    expect(store.getById(first.id)).toEqual(first);
    expect(store.getByKey("the-librarian")).toEqual(first);
    expect(store.list().map((project) => project.id)).toEqual([first.id, second.id]);
    expect(store.list({ status: "archived" }).map((project) => project.id)).toEqual([second.id]);

    const changed = {
      ...first,
      display_name: "The Librarian memory service",
      updated_at: "2026-08-06T13:00:00.000Z",
    };
    expect(store.update(changed)).toEqual(changed);
    expect(store.getById(first.id)?.display_name).toBe("The Librarian memory service");
    expect(vault.listMarkdown("projects")).toEqual(["projects/prj_123.md", "projects/prj_456.md"]);
  });

  it("rejects duplicate ids and duplicate keys within the shelf", () => {
    const store = createMarkdownProjectStore({ vault: createVault({ dataDir }) });
    store.create(projectRecord());
    expect(() => store.create(projectRecord())).toThrow(ProjectRecordExistsError);
    expect(() =>
      store.create(projectRecord({ id: "prj_456", display_name: "Duplicate key" })),
    ).toThrow(DuplicateProjectKeyError);
    expect(() => store.update(projectRecord({ id: "prj_missing" }))).toThrow(
      ProjectRecordNotFoundError,
    );
  });

  it("revalidates key uniqueness on update", () => {
    const store = createMarkdownProjectStore({ vault: createVault({ dataDir }) });
    store.create(projectRecord());
    const second = projectRecord({ id: "prj_456", key: "other", display_name: "Other" });
    store.create(second);
    expect(() => store.update({ ...second, key: "the-librarian" })).toThrow(
      DuplicateProjectKeyError,
    );
  });

  it("refuses unsafe lookup ids and a document whose filename disagrees with its id", () => {
    const vault = createVault({ dataDir });
    const store = createMarkdownProjectStore({ vault });
    for (const id of ["../other", "/absolute", "nested/path", "nested\\path", "."]) {
      expect(() => store.getById(id)).toThrow(/path-safe document id/);
    }
    vault.writeText(
      "projects/prj_123.md",
      serializeProjectDocument(projectRecord({ id: "prj_other" })),
    );
    expect(() => store.getById("prj_123")).toThrow(/filename.*prj_123.*prj_other/i);
  });

  it("commits only the affected path with a sanitised subject and actor", () => {
    const commits: Array<{ paths: string[]; message: string; actor?: string }> = [];
    const store = createMarkdownProjectStore({
      vault: createVault({ dataDir }),
      commit: (paths, message, actor) => commits.push({ paths, message, actor }),
    });
    const created = store.create(projectRecord(), "admin-1");
    store.update({ ...created, updated_at: "2026-08-06T13:00:00.000Z" }, "curator-1");
    expect(commits).toEqual([
      {
        paths: ["projects/prj_123.md"],
        message: "project: create prj_123",
        actor: "admin-1",
      },
      {
        paths: ["projects/prj_123.md"],
        message: "project: update prj_123",
        actor: "curator-1",
      },
    ]);
  });

  it("refuses reads and writes through a symlinked project document", () => {
    const vault = createVault({ dataDir });
    const outside = path.join(dataDir, "outside-project.md");
    const original = serializeProjectDocument(projectRecord());
    fs.writeFileSync(outside, original);
    fs.mkdirSync(path.join(vault.root, "projects"), { recursive: true });
    fs.symlinkSync(outside, path.join(vault.root, "projects", "prj_123.md"));
    const store = createMarkdownProjectStore({ vault });

    expect(() => store.getById("prj_123")).toThrow(UnsafeVaultPathError);
    expect(() =>
      store.update(
        projectRecord({
          display_name: "Attempted overwrite",
          updated_at: "2026-08-06T13:00:00.000Z",
        }),
      ),
    ).toThrow(UnsafeVaultPathError);
    expect(fs.readFileSync(outside, "utf8")).toBe(original);
  });
});
