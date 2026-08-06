import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ProjectUpdateExistsError,
  createMarkdownProjectUpdateStore,
  createVault,
  serializeProjectUpdateDocument,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectUpdateRecord } from "../../fixtures/project-records.js";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-project-update-store-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("Markdown ProjectUpdateStore", () => {
  it("appends evidence and supports bounded deterministic filters", () => {
    const store = createMarkdownProjectUpdateStore({ vault: createVault({ dataDir }) });
    const older = projectUpdateRecord();
    const newer = projectUpdateRecord({
      id: "pru_456",
      source_kind: "handoff",
      source_ref: "handoff:hdo_456",
      captured_at: "2026-08-06T13:00:00.000Z",
      fingerprint: "b".repeat(64),
    });
    store.append(older);
    store.append(newer);

    expect(store.getById(older.id)).toEqual(older);
    expect(store.getByFingerprint(newer.fingerprint)).toEqual(newer);
    expect(store.list().map((update) => update.id)).toEqual([newer.id, older.id]);
    expect(store.list({ project_id: "prj_123", source_kind: "handoff" })).toEqual([newer]);
    expect(store.list({ source_ref: "conversation:conv_123", limit: 1 })).toEqual([older]);
  });

  it("is append-only: a duplicate id cannot replace the original bytes", () => {
    const vault = createVault({ dataDir });
    const store = createMarkdownProjectUpdateStore({ vault });
    const original = projectUpdateRecord();
    store.append(original);
    const raw = vault.readText("project-updates/pru_123.md");
    expect(() => store.append({ ...original, rationale: "Attempted replacement" })).toThrow(
      ProjectUpdateExistsError,
    );
    expect(vault.readText("project-updates/pru_123.md")).toBe(raw);
  });

  it("refuses unsafe ids and filename/frontmatter disagreement", () => {
    const vault = createVault({ dataDir });
    const store = createMarkdownProjectUpdateStore({ vault });
    expect(() => store.getById("../update")).toThrow(/path-safe document id/);
    vault.writeText(
      "project-updates/pru_123.md",
      serializeProjectUpdateDocument(projectUpdateRecord({ id: "pru_other" })),
    );
    expect(() => store.getById("pru_123")).toThrow(/filename.*pru_123.*pru_other/i);
  });

  it("commits the appended path with attribution", () => {
    const commits: unknown[][] = [];
    const store = createMarkdownProjectUpdateStore({
      vault: createVault({ dataDir }),
      commit: (...args) => commits.push(args),
    });
    store.append(projectUpdateRecord(), "curator-1");
    expect(commits).toEqual([
      [["project-updates/pru_123.md"], "project-update: append pru_123", "curator-1"],
    ]);
  });

  it("finds a fingerprint outside the bounded presentation window", () => {
    const store = createMarkdownProjectUpdateStore({ vault: createVault({ dataDir }) });
    const target = projectUpdateRecord({
      id: "pru_target",
      observed_at: "2026-08-05T11:00:00.000Z",
      captured_at: "2026-08-05T12:00:00.000Z",
      fingerprint: "f".repeat(64),
    });
    store.append(target);
    for (let index = 0; index < 500; index++) {
      store.append(
        projectUpdateRecord({
          id: `pru_new_${index}`,
          source_ref: `conversation:new-${index}`,
          captured_at: "2026-08-06T12:00:00.000Z",
          fingerprint: index.toString(16).padStart(64, "0"),
        }),
      );
    }
    expect(store.list()).toHaveLength(100);
    expect(store.getByFingerprint(target.fingerprint)).toEqual(target);
  });
});
