import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SHELF,
  ShelfNotWritableError,
  type LibrarianStore,
  type Shelf,
  createLibrarianStore,
} from "@librarian/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  projectRecord,
  projectSuggestionRecord,
  projectUpdateRecord,
} from "../fixtures/project-records.js";

const dataDirs: string[] = [];
const stores: LibrarianStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dataDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function freshStore(): { store: LibrarianStore; vault: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-project-shelf-"));
  dataDirs.push(dataDir);
  const store = createLibrarianStore({ dataDir });
  stores.push(store);
  return { store, vault: path.join(dataDir, "vault") };
}

const PERSONAL: Shelf = { id: "personal", prefix: "members/x/", writable: true };
const TEAM_WRITABLE: Shelf = { id: "team", prefix: "team/", writable: true };
const TEAM_READ_ONLY: Shelf = { ...TEAM_WRITABLE, writable: false };

describe("project stores on shelf-scoped handles", () => {
  it("keeps default-shelf aliases on the same raw store instances", () => {
    const { store, vault } = freshStore();
    const main = store.forShelf(DEFAULT_SHELF);
    expect(main.projects).toBe(store.projects);
    expect(main.projectUpdates).toBe(store.projectUpdates);
    expect(main.projectSuggestions).toBe(store.projectSuggestions);

    store.projects.create(projectRecord(), "admin-1");
    store.projectUpdates.append(projectUpdateRecord(), "curator-1");
    store.projectSuggestions.create(projectSuggestionRecord(), "curator-1");
    expect(fs.existsSync(path.join(vault, "projects/prj_123.md"))).toBe(true);
    expect(fs.existsSync(path.join(vault, "project-updates/pru_123.md"))).toBe(true);
    expect(fs.existsSync(path.join(vault, "project-suggestions/prs_123.md"))).toBe(true);
  });

  it("allows the same project key in different shelves without sibling visibility", () => {
    const { store, vault } = freshStore();
    const personal = store.forShelf(PERSONAL);
    const team = store.forShelf(TEAM_WRITABLE);
    personal.projects.create(projectRecord(), "admin-personal");
    team.projects.create(
      projectRecord({ id: "prj_team", display_name: "The Librarian team" }),
      "admin-team",
    );

    expect(personal.projects.list().map((project) => project.id)).toEqual(["prj_123"]);
    expect(team.projects.list().map((project) => project.id)).toEqual(["prj_team"]);
    expect(personal.projects.getById("prj_team")).toBeNull();
    expect(team.projects.getById("prj_123")).toBeNull();
    expect(personal.projects.getByKey("the-librarian")?.id).toBe("prj_123");
    expect(team.projects.getByKey("the-librarian")?.id).toBe("prj_team");
    expect(fs.existsSync(path.join(vault, "projects"))).toBe(false);
  });

  it("lets a read-only public handle read but refuses every project mutation", () => {
    const { store } = freshStore();
    const system = store.systemProjectStoresForShelf(TEAM_READ_ONLY);
    const project = system.projects.create(
      projectRecord({ id: "prj_team", display_name: "Team project" }),
      "system-curator",
    );
    const update = projectUpdateRecord({
      id: "pru_team",
      project_id: project.id,
      shelf_id: TEAM_READ_ONLY.id,
    });
    const suggestion = projectSuggestionRecord({
      id: "prs_team",
      project_id: project.id,
      source_ids: ["update:pru_team"],
    });
    system.projectUpdates.append(update, "system-curator");
    system.projectSuggestions.create(suggestion, "system-curator");

    const publicTeam = store.forShelf(TEAM_READ_ONLY);
    expect(publicTeam.projects.getById(project.id)).toEqual(project);
    expect(publicTeam.projectUpdates.getById(update.id)).toEqual(update);
    expect(publicTeam.projectSuggestions.getById(suggestion.id)).toEqual(suggestion);
    expect(() => publicTeam.projects.create(projectRecord({ id: "prj_no" }))).toThrow(
      ShelfNotWritableError,
    );
    expect(() => publicTeam.projects.update(project)).toThrow(ShelfNotWritableError);
    expect(() => publicTeam.projectUpdates.append(update)).toThrow(ShelfNotWritableError);
    expect(() => publicTeam.projectSuggestions.create(suggestion)).toThrow(ShelfNotWritableError);
    expect(() => publicTeam.projectSuggestions.update(suggestion)).toThrow(ShelfNotWritableError);
  });

  it("confines the raw system accessor to the explicitly supplied shelf", () => {
    const { store, vault } = freshStore();
    const systemTeam = store.systemProjectStoresForShelf(TEAM_READ_ONLY);
    systemTeam.projects.create(projectRecord());
    systemTeam.projectUpdates.append(projectUpdateRecord({ shelf_id: TEAM_READ_ONLY.id }));
    systemTeam.projectSuggestions.create(projectSuggestionRecord());

    expect(fs.existsSync(path.join(vault, "team/projects/prj_123.md"))).toBe(true);
    expect(fs.existsSync(path.join(vault, "team/project-updates/pru_123.md"))).toBe(true);
    expect(fs.existsSync(path.join(vault, "team/project-suggestions/prs_123.md"))).toBe(true);
    expect(fs.existsSync(path.join(vault, "projects"))).toBe(false);
    expect(store.projects.list()).toEqual([]);
  });
});
