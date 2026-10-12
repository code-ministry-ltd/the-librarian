// Wikilinks resolve by title in recall, and follow merges (spec 076 §4). The
// curator links memories as `[[Title]]`; until now the recall graph kept only
// id links, and a merge left every link to its sources dangling.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  type ValidatedOperation,
  applyOperations,
  buildCorpusIndex,
  createHashEmbedder,
  createLibrarianStore,
  createVault,
  createVaultGroomingMemorySource,
  gatherMemoryEvidence,
  repointWikilinkTargets,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dataDir = "";
let store: LibrarianStore;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-wikilinks-"));
  store = createLibrarianStore({ dataDir });
});
afterEach(() => {
  store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const create = (title: string, body: string, options: Record<string, unknown> = {}) =>
  store.createMemory({ agent_id: "a", title, body }, options).memory;

describe("repointWikilinkTargets", () => {
  it("rewrites every form of a link to any of the old titles, case-insensitively", () => {
    const body = "See [[Old A]], [[old a|the old one]], [[OLD B#Ports]] and ![[Other]].";
    expect(repointWikilinkTargets(body, ["Old A", "Old B"], "Merged")).toBe(
      "See [[Merged]], [[Merged|the old one]], [[Merged#Ports]] and ![[Other]].",
    );
  });
});

describe("recall link graph — title links", () => {
  async function recall(query: string) {
    const index = await buildCorpusIndex(createVault({ dataDir }), {
      embedder: createHashEmbedder(),
    });
    return index.recall(query);
  }

  it("pulls in a memory linked by title as a backlink neighbour", async () => {
    create("Elaine", "Elaine teaches piano; her partner is [[bob smith]].");
    const bob = create("Bob Smith", "Sails a boat called Kestrel.");
    const hits = await recall("piano");
    expect(hits.find((h) => h.id === bob.id)).toMatchObject({ matchedDirectly: false });
  });

  it("does not guess when two memories share the title", async () => {
    create("Elaine", "Elaine teaches piano; her partner is [[Bob Smith]].");
    const bob1 = create("Bob Smith", "Sails a boat called Kestrel.");
    const bob2 = create("Bob Smith", "Runs the village bakery.");
    const ids = (await recall("piano")).map((h) => h.id);
    expect(ids).not.toContain(bob1.id);
    expect(ids).not.toContain(bob2.id);
  });
});

describe("links follow a merge", () => {
  function merge(sourceIds: string[], threshold: number) {
    const run = store.createCurationRun({ trigger: "manual", project_key: null, input_hash: "h" });
    const slice = { kind: "common_global" as const };
    const op = {
      type: "merge" as const,
      source_memory_ids: sourceIds,
      replacement: {
        title: "Marvin Ports",
        body: "api 3838; grafana 9126",
        visibility: "common" as const,
      },
      rationale: "duplicates",
      confidence: 0.9,
    };
    applyOperations(
      [{ operation: op, outcome: { decision: "accept" } } as ValidatedOperation],
      {
        slice,
        memory: gatherMemoryEvidence(createVaultGroomingMemorySource(store), slice, {
          maxMemories: 50,
        }),
        prepass: { findings: [] },
      },
      { store, runId: run.id, actorId: "system-memory-curator", confidenceThreshold: threshold },
    );
  }

  it("repoints links to the sources when a merge applies", () => {
    const a = create("API Port", "api 3838");
    const b = create("Grafana Port", "grafana 9126");
    const linker = create("Marvin", "See [[API Port]] and [[grafana port|Grafana]].");
    merge([a.id, b.id], 0);
    expect(store.getMemory(linker.id)!.body).toBe(
      "See [[Marvin Ports]] and [[Marvin Ports|Grafana]].",
    );
  });

  it("repoints only when a proposed merge is approved", () => {
    const a = create("API Port", "api 3838");
    const b = create("Grafana Port", "grafana 9126");
    const linker = create("Marvin", "See [[API Port]].");
    merge([a.id, b.id], 1);
    expect(store.getMemory(linker.id)!.body).toBe("See [[API Port]].");
    const proposal = store.listAll({ status: "proposed" })[0]!;
    store.approveProposal(proposal.id, "approve", {}, "admin");
    expect(store.getMemory(linker.id)!.body).toBe("See [[Marvin Ports]].");
  });
});
