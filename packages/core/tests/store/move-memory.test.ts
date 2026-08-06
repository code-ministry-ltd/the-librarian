import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type Principal,
  type Shelf,
  type VaultRouter,
  MemoryAlreadyOnShelfError,
  MemoryMoveDestinationExistsError,
  MemoryMoveUnsafePathError,
  MemoryNotFoundForPrincipalError,
  ShelfNotWritableError,
  actionForSubject,
  commitSubject,
  createLibrarianStore,
  parseMemoryDocument,
  serializeMemoryDocument,
} from "@librarian/core";
import { CuratorNoteSchema } from "@librarian/core/schemas";
import { afterEach, describe, expect, it } from "vitest";
import { projectRecord } from "../fixtures/project-records.js";

const SOURCE: Shelf = { id: "personal", prefix: "members/alice/", writable: true };
const DESTINATION: Shelf = { id: "team", prefix: "team/", writable: true, label: "Team" };
const OFF_SET: Shelf = { id: "other", prefix: "members/bob/", writable: true };
const PRINCIPAL: Principal = { kind: "member", actorId: "member:alice", roles: ["member"] };

const dataDirs: string[] = [];
const stores: LibrarianStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dataDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function freshStore(
  shelves: readonly Shelf[] = [SOURCE, DESTINATION],
  builds?: string[],
): { store: LibrarianStore; vaultDir: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-memory-move-"));
  dataDirs.push(dataDir);
  const router: VaultRouter = {
    shelves: () => shelves,
    writeTarget: () => SOURCE,
  };
  const store = createLibrarianStore({
    dataDir,
    vaultRouter: router,
    ...(builds ? { onIndexBuild: (prefix) => builds.push(prefix) } : {}),
  });
  stores.push(store);
  return { store, vaultDir: path.join(dataDir, "vault") };
}

function memoryPath(vaultDir: string, shelf: Shelf, id: string): string {
  const memoriesDir = path.join(vaultDir, ...shelf.prefix.split("/").filter(Boolean), "memories");
  const name = fs.readdirSync(memoriesDir).find((entry) => {
    const raw = fs.readFileSync(path.join(memoriesDir, entry), "utf8");
    return parseMemoryDocument(raw).id === id;
  });
  if (!name) throw new Error(`fixture memory ${id} not found on ${shelf.id}`);
  return path.join(memoriesDir, name);
}

function writeMemory(vaultDir: string, shelf: Shelf, id: string): void {
  const dir = path.join(vaultDir, ...shelf.prefix.split("/").filter(Boolean), "memories");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.md`),
    serializeMemoryDocument({
      id,
      title: id,
      body: `body ${id}`,
      agent_id: "member:alice",
      confidence: "high",
      tags: [],
      applies_to: [],
      supersedes: [],
      conflicts_with: [],
      flags: [],
      status: "active",
      is_global: false,
      requires_approval: false,
      created_at: "2026-07-18T00:00:00.000Z",
      updated_at: "2026-07-18T00:00:00.000Z",
    }),
  );
}

describe("moveMemoryForPrincipal", () => {
  it("moves the same bytes and filename between prefixes while preserving the memory id", () => {
    const { store, vaultDir } = freshStore();
    const { memory } = store
      .forShelf(SOURCE)
      .createMemory(
        { title: "Promotion candidate", body: "keep these bytes", agent_id: PRINCIPAL.actorId },
        {},
      );
    const beforePath = memoryPath(vaultDir, SOURCE, memory.id);
    const before = fs.readFileSync(beforePath);

    const moved = store.moveMemoryForPrincipal(PRINCIPAL, memory.id, DESTINATION.id);

    const afterPath = memoryPath(vaultDir, DESTINATION, memory.id);
    expect(path.basename(afterPath)).toBe(path.basename(beforePath));
    expect(fs.existsSync(beforePath)).toBe(false);
    expect(fs.readFileSync(afterPath)).toEqual(before);
    expect(moved).toEqual(memory);
    expect(store.forShelf(DESTINATION).getMemory(memory.id)?.id).toBe(memory.id);
  });

  it("preserves project keys and returns a non-blocking warning for missing active destination projects", () => {
    const { store, vaultDir } = freshStore();
    store
      .systemProjectStoresForShelf(DESTINATION)
      .projects.create(projectRecord({ id: "prj_shared", key: "shared-project" }));
    const { memory } = store.forShelf(SOURCE).createMemory(
      {
        title: "Project evidence",
        body: "keep these bytes",
        agent_id: PRINCIPAL.actorId,
        project_keys: ["shared-project", "source-only"],
      },
      {},
    );
    const before = fs.readFileSync(memoryPath(vaultDir, SOURCE, memory.id));

    const moved = store.moveMemoryForPrincipal(PRINCIPAL, memory.id, DESTINATION.id);

    expect(fs.readFileSync(memoryPath(vaultDir, DESTINATION, memory.id))).toEqual(before);
    expect(moved.project_keys).toEqual(["shared-project", "source-only"]);
    expect(moved.move_warnings).toEqual([
      expect.objectContaining({
        code: "missing-active-projects",
        project_keys: ["source-only"],
        message: expect.stringMatching(/associations were preserved/i),
      }),
    ]);
  });

  it("returns the original memory shape when every destination project is active", () => {
    const { store } = freshStore();
    store
      .systemProjectStoresForShelf(DESTINATION)
      .projects.create(projectRecord({ id: "prj_shared", key: "shared-project" }));
    const { memory } = store.forShelf(SOURCE).createMemory(
      {
        title: "Project evidence",
        body: "body",
        agent_id: PRINCIPAL.actorId,
        project_keys: ["shared-project"],
      },
      {},
    );

    expect(store.moveMemoryForPrincipal(PRINCIPAL, memory.id, DESTINATION.id)).toEqual(memory);
  });

  it("invalidates both shelves' corpus indexes", async () => {
    const builds: string[] = [];
    const { store } = freshStore([SOURCE, DESTINATION], builds);
    const { memory } = store
      .forShelf(SOURCE)
      .createMemory({ title: "Piano", body: "piano tuning", agent_id: PRINCIPAL.actorId }, {});
    store
      .forShelf(DESTINATION)
      .createMemory({ title: "Sailing", body: "open water", agent_id: PRINCIPAL.actorId }, {});
    await store.forShelf(SOURCE).recall({ query: "piano" });
    await store.forShelf(DESTINATION).recall({ query: "sailing" });

    store.moveMemoryForPrincipal(PRINCIPAL, memory.id, DESTINATION.id);
    await store.forShelf(SOURCE).recall({ query: "piano" });
    await store.forShelf(DESTINATION).recall({ query: "piano" });

    expect(builds).toEqual([SOURCE.prefix, DESTINATION.prefix, SOURCE.prefix, DESTINATION.prefix]);
  });

  it("uses an indistinguishable typed refusal for absent and off-set target ids", () => {
    const { store, vaultDir } = freshStore();
    writeMemory(vaultDir, OFF_SET, "mem_off_set");

    for (const id of ["mem_missing", "mem_off_set"]) {
      expect(() => store.moveMemoryForPrincipal(PRINCIPAL, id, DESTINATION.id)).toThrow(
        MemoryNotFoundForPrincipalError,
      );
      try {
        store.moveMemoryForPrincipal(PRINCIPAL, id, DESTINATION.id);
      } catch (error) {
        expect(error).toMatchObject({
          name: "MemoryNotFoundForPrincipalError",
          message: "memory or shelf was not found",
        });
      }
    }
  });

  it("uses the same no-oracle refusal for an unknown or off-set destination id", () => {
    const { store } = freshStore();
    const { memory } = store
      .forShelf(SOURCE)
      .createMemory({ title: "Move me", body: "body", agent_id: PRINCIPAL.actorId }, {});

    for (const shelfId of ["missing", OFF_SET.id]) {
      expect(() => store.moveMemoryForPrincipal(PRINCIPAL, memory.id, shelfId)).toThrow(
        MemoryNotFoundForPrincipalError,
      );
    }
  });

  it("refuses the source shelf itself by identity", () => {
    const { store } = freshStore();
    const { memory } = store
      .forShelf(SOURCE)
      .createMemory({ title: "Stay", body: "body", agent_id: PRINCIPAL.actorId }, {});

    expect(() => store.moveMemoryForPrincipal(PRINCIPAL, memory.id, SOURCE.id)).toThrow(
      MemoryAlreadyOnShelfError,
    );
  });

  it("refuses a destination shelf that already bears the memory id under another filename", () => {
    const { store, vaultDir } = freshStore();
    const { memory } = store
      .forShelf(SOURCE)
      .createMemory({ title: "Drifted copy", body: "source", agent_id: PRINCIPAL.actorId }, {});
    // The same logical id on the destination under a DIFFERENT filename — the
    // shared-id state list dedupe resolves by precedence. A path check alone
    // would let the move land a second file with this id on the destination.
    const destinationDir = path.join(vaultDir, DESTINATION.prefix, "memories");
    fs.mkdirSync(destinationDir, { recursive: true });
    fs.writeFileSync(
      path.join(destinationDir, "unrelated-filename.md"),
      fs.readFileSync(memoryPath(vaultDir, SOURCE, memory.id)),
    );

    expect(() => store.moveMemoryForPrincipal(PRINCIPAL, memory.id, DESTINATION.id)).toThrow(
      MemoryMoveDestinationExistsError,
    );
    expect(fs.existsSync(memoryPath(vaultDir, SOURCE, memory.id))).toBe(true);
  });

  it("never overwrites an occupied destination path", () => {
    const { store, vaultDir } = freshStore();
    const { memory } = store
      .forShelf(SOURCE)
      .createMemory({ title: "Collision", body: "source", agent_id: PRINCIPAL.actorId }, {});
    const sourcePath = memoryPath(vaultDir, SOURCE, memory.id);
    const destinationDir = path.join(vaultDir, DESTINATION.prefix, "memories");
    fs.mkdirSync(destinationDir, { recursive: true });
    const destinationPath = path.join(destinationDir, path.basename(sourcePath));
    fs.writeFileSync(destinationPath, "occupied");

    expect(() => store.moveMemoryForPrincipal(PRINCIPAL, memory.id, DESTINATION.id)).toThrow(
      MemoryMoveDestinationExistsError,
    );
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.readFileSync(destinationPath, "utf8")).toBe("occupied");
  });

  it("refuses a destination shelf that traverses a symbolic link", () => {
    const { store, vaultDir } = freshStore();
    const { memory } = store
      .forShelf(SOURCE)
      .createMemory({ title: "Contained", body: "source", agent_id: PRINCIPAL.actorId }, {});
    const sourcePath = memoryPath(vaultDir, SOURCE, memory.id);
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-move-escape-"));
    dataDirs.push(externalDir);
    fs.symlinkSync(
      externalDir,
      path.join(vaultDir, DESTINATION.prefix.replace(/\/$/, "")),
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(() => store.moveMemoryForPrincipal(PRINCIPAL, memory.id, DESTINATION.id)).toThrow(
      MemoryMoveUnsafePathError,
    );
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(path.join(externalDir, "memories", path.basename(sourcePath)))).toBe(
      false,
    );
  });

  it("rolls the filesystem and Git index back when the move commit fails", () => {
    const { store, vaultDir } = freshStore();
    const { memory } = store
      .forShelf(SOURCE)
      .createMemory({ title: "Rollback", body: "source", agent_id: PRINCIPAL.actorId }, {});
    const sourcePath = memoryPath(vaultDir, SOURCE, memory.id);
    const destinationPath = path.join(
      vaultDir,
      DESTINATION.prefix,
      "memories",
      path.basename(sourcePath),
    );
    const hook = path.join(vaultDir, ".git", "hooks", "pre-commit");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    expect(() => store.moveMemoryForPrincipal(PRINCIPAL, memory.id, DESTINATION.id)).toThrow();

    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(destinationPath)).toBe(false);
    expect(
      execFileSync("git", ["status", "--porcelain"], { cwd: vaultDir, encoding: "utf8" }),
    ).toBe("");
  });

  it("refuses a read-only source and a destination with no writable bearer", () => {
    const readOnlySource: Shelf = { ...SOURCE, writable: false };
    const readOnlyDestination: Shelf = { ...DESTINATION, writable: false };

    const sourceCase = freshStore([readOnlySource, DESTINATION]);
    writeMemory(sourceCase.vaultDir, readOnlySource, "mem_source_read_only");
    expect(() =>
      sourceCase.store.moveMemoryForPrincipal(PRINCIPAL, "mem_source_read_only", DESTINATION.id),
    ).toThrow(ShelfNotWritableError);

    const destinationCase = freshStore([SOURCE, readOnlyDestination]);
    const { memory } = destinationCase.store
      .forShelf(SOURCE)
      .createMemory({ title: "No bearer", body: "body", agent_id: PRINCIPAL.actorId }, {});
    expect(() =>
      destinationCase.store.moveMemoryForPrincipal(PRINCIPAL, memory.id, readOnlyDestination.id),
    ).toThrow(ShelfNotWritableError);
  });

  it("resolves a shared destination id to its unique writable bearer", () => {
    const sharedReadOnly: Shelf = { id: "shared", prefix: "shared-read/", writable: false };
    const sharedWritable: Shelf = { id: "shared", prefix: "shared-write/", writable: true };
    const { store, vaultDir } = freshStore([SOURCE, sharedReadOnly, sharedWritable]);
    const { memory } = store
      .forShelf(SOURCE)
      .createMemory({ title: "Shared target", body: "body", agent_id: PRINCIPAL.actorId }, {});

    store.moveMemoryForPrincipal(PRINCIPAL, memory.id, "shared");

    expect(memoryPath(vaultDir, sharedWritable, memory.id)).toBeTruthy();
    expect(fs.existsSync(path.join(vaultDir, sharedReadOnly.prefix, "memories"))).toBe(false);
  });

  it("does not mistake a same-id, different-prefix shelf for the source identity", () => {
    const sourceReadOnly: Shelf = { id: "shared", prefix: "shared-read/", writable: false };
    const destinationWritable: Shelf = { id: "shared", prefix: "shared-write/", writable: true };
    const { store, vaultDir } = freshStore([sourceReadOnly, destinationWritable]);
    writeMemory(vaultDir, sourceReadOnly, "mem_same_id");

    expect(() => store.moveMemoryForPrincipal(PRINCIPAL, "mem_same_id", "shared")).toThrow(
      ShelfNotWritableError,
    );
    expect(() => store.moveMemoryForPrincipal(PRINCIPAL, "mem_same_id", "shared")).not.toThrow(
      MemoryAlreadyOnShelfError,
    );
  });
});

describe("commitSubject.memoryMove", () => {
  it("uses shelf ids, strips newlines, and never includes paths or labels", () => {
    expect(commitSubject.memoryMove("mem_1\nforged", "personal\r\nx", "team\nx")).toBe(
      "memory: move mem_1forged (personalx -> teamx)",
    );
  });
});

describe("move proposal schema and audit records", () => {
  it("round-trips planned_shelf through the markdown memory store", () => {
    expect(CuratorNoteSchema.parse({ planned_shelf: DESTINATION.id })).toEqual({
      planned_shelf: DESTINATION.id,
    });
    const { store } = freshStore();
    const created = store.forShelf(SOURCE).createMemory(
      { title: "Move request", body: "Promote this", agent_id: PRINCIPAL.actorId },
      {
        requires_approval: true,
        curator_note: {
          source: "dashboard",
          proposed_action: "move",
          guessed_target_id: "mem_target",
          planned_shelf: DESTINATION.id,
          rationale: "Useful to the team",
        },
      },
    );

    expect(store.forShelf(SOURCE).getMemory(created.memory.id)?.curator_note).toMatchObject({
      proposed_action: "move",
      guessed_target_id: "mem_target",
      planned_shelf: DESTINATION.id,
    });
  });

  it("maps the move subject to other while exporting typed departure and arrival records", () => {
    const wideAdmin: Principal = { kind: "admin", actorId: "wide", roles: ["admin"] };
    const scopedAdmin: Principal = { kind: "admin", actorId: "scoped", roles: ["admin"] };
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-memory-move-audit-"));
    dataDirs.push(dataDir);
    const router: VaultRouter = {
      shelves: (principal) => (principal.actorId === "wide" ? [SOURCE, DESTINATION] : [SOURCE]),
      writeTarget: () => SOURCE,
    };
    const store = createLibrarianStore({ dataDir, vaultRouter: router });
    stores.push(store);
    const { memory } = store
      .forShelf(SOURCE)
      .createMemory({ title: "Audit move", body: "body", agent_id: wideAdmin.actorId }, {});

    store.moveMemoryForPrincipal(wideAdmin, memory.id, DESTINATION.id);

    expect(actionForSubject(commitSubject.memoryMove(memory.id, SOURCE.id, DESTINATION.id))).toBe(
      "other",
    );
    const wideMove = store
      .exportAudit(wideAdmin)
      .events.filter((event) => event.commit === store.exportAudit(wideAdmin).events[0]?.commit);
    expect(wideMove.map((event) => event.action)).toEqual(["shelf.departure", "shelf.arrival"]);

    const scopedMove = store.exportAudit(scopedAdmin).events[0];
    expect(scopedMove).toMatchObject({
      action: "shelf.departure",
      shelves: [SOURCE.id],
      renames: [{ from: expect.stringMatching(/^members\/alice\/memories\//), to: null }],
    });
    expect(JSON.stringify(scopedMove)).not.toContain(DESTINATION.prefix);
  });

  it("exports a typed move pair when Git reports a dirty source as delete plus add", () => {
    const { store, vaultDir } = freshStore();
    const { memory } = store
      .forShelf(SOURCE)
      .createMemory(
        { title: "Dirty move", body: "small original", agent_id: PRINCIPAL.actorId },
        {},
      );
    const sourcePath = memoryPath(vaultDir, SOURCE, memory.id);
    fs.writeFileSync(
      sourcePath,
      serializeMemoryDocument({
        ...memory,
        title: "Completely rewritten before move",
        body: "uncommitted replacement ".repeat(2_000),
      }),
    );

    store.moveMemoryForPrincipal(PRINCIPAL, memory.id, DESTINATION.id);

    const rawStatus = execFileSync("git", ["show", "--name-status", "-M", "--format=", "HEAD"], {
      cwd: vaultDir,
      encoding: "utf8",
    });
    expect(rawStatus).toContain(`D\t${path.relative(vaultDir, sourcePath)}`);
    expect(rawStatus).toContain(
      `A\t${path.join(DESTINATION.prefix, "memories", path.basename(sourcePath))}`,
    );
    expect(
      store
        .exportAudit(PRINCIPAL)
        .events.slice(0, 2)
        .map((event) => event.action),
    ).toEqual(["shelf.departure", "shelf.arrival"]);
  });
});
