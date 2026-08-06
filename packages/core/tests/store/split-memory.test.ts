// Shared split store primitive (spec 043 D-B). Pins the two invariants both
// curator apply paths (grooming + intake) rely on:
//   1. create-all-then-archive ordering (data-loss-safe);
//   2. archive happens IFF an archive actor is passed (apply vs propose).
// The per-row input/options are the caller's; the primitive only sequences them.

import { type SplitMemoryStore, splitMemory } from "@librarian/core";
import { describe, expect, it } from "vitest";

function fakeStore() {
  const calls: string[] = [];
  let n = 0;
  const store: SplitMemoryStore = {
    createMemory: (input) => {
      const id = `mem_new_${n++}`;
      calls.push(`create:${String(input.title)}`);
      return { memory: { id } };
    },
    archiveMemory: (id, actor) => {
      calls.push(`archive:${id}:${String(actor)}`);
      return null;
    },
    getMemory: () => ({ project_keys: ["source-project"] }),
  };
  return { store, calls };
}

describe("splitMemory", () => {
  it("creates every replacement, then archives the source (apply path)", () => {
    const { store, calls } = fakeStore();
    const ids = splitMemory(store, {
      sourceId: "mem_src",
      replacements: [{ input: { title: "Elaine" } }, { input: { title: "Bob" } }],
      archiveActorId: "system-curator",
    });
    expect(ids).toEqual(["mem_new_0", "mem_new_1"]);
    // Ordering invariant: both creates precede the archive.
    expect(calls).toEqual(["create:Elaine", "create:Bob", "archive:mem_src:system-curator"]);
  });

  it("leaves the source untouched when no archive actor is passed (propose path)", () => {
    const { store, calls } = fakeStore();
    const ids = splitMemory(store, {
      sourceId: "mem_src",
      replacements: [{ input: { title: "Elaine" } }, { input: { title: "Bob" } }],
    });
    expect(ids).toEqual(["mem_new_0", "mem_new_1"]);
    expect(calls).toEqual(["create:Elaine", "create:Bob"]); // NO archive
  });

  it("passes each replacement's options through verbatim", () => {
    const seen: (Record<string, unknown> | undefined)[] = [];
    const store: SplitMemoryStore = {
      createMemory: (_input, options) => {
        seen.push(options);
        return { memory: { id: "x" } };
      },
      archiveMemory: () => null,
      getMemory: () => ({ project_keys: ["source-project"] }),
    };
    splitMemory(store, {
      sourceId: "s",
      replacements: [
        { input: { title: "A" }, options: { requires_approval: true } },
        { input: { title: "B" } },
      ],
    });
    expect(seen).toEqual([{ requires_approval: true }, undefined]);
  });

  it("inherits the source project keys without dropping explicit additions", () => {
    const seen: Record<string, unknown>[] = [];
    const store: SplitMemoryStore = {
      createMemory: (input) => {
        seen.push(input);
        return { memory: { id: "x" } };
      },
      archiveMemory: () => null,
      getMemory: () => ({ project_keys: ["source-project", "shared"] }),
    };
    splitMemory(store, {
      sourceId: "s",
      replacements: [
        { input: { title: "A" } },
        { input: { title: "B", project_keys: ["shared", "explicit-project"] } },
      ],
    });
    expect(seen.map((input) => input.project_keys)).toEqual([
      ["source-project", "shared"],
      ["source-project", "shared", "explicit-project"],
    ]);
  });
});
