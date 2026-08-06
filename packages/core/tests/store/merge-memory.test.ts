// Shared merge store primitive (spec 044 D-5a). Sibling of splitMemory: pins the
// two invariants both merge paths (curator run + admin) rely on:
//   1. create-replacement-then-archive-sources ordering (data-loss-safe);
//   2. sources archived IFF an archive actor is passed (apply vs propose).
// The replacement's input/options are the caller's; the primitive only sequences.

import { type MergeMemoryStore, mergeMemory } from "@librarian/core";
import { describe, expect, it } from "vitest";

function fakeStore() {
  const calls: string[] = [];
  let n = 0;
  const store: MergeMemoryStore = {
    createMemory: (input) => {
      const id = `mem_new_${n++}`;
      calls.push(`create:${String(input.title)}`);
      return { memory: { id } };
    },
    archiveMemory: (id, actor) => {
      calls.push(`archive:${id}:${String(actor)}`);
      return null;
    },
    getMemory: (id) =>
      id === "mem_a" ? { project_keys: ["alpha", "shared"] } : { project_keys: ["shared", "beta"] },
  };
  return { store, calls };
}

describe("mergeMemory", () => {
  it("creates the replacement, then archives every source (apply path)", () => {
    const { store, calls } = fakeStore();
    const id = mergeMemory(store, {
      replacement: { input: { title: "Merged" } },
      sourceIds: ["mem_a", "mem_b"],
      archiveActorId: "system-curator",
    });
    expect(id).toBe("mem_new_0");
    // Ordering invariant: the create precedes BOTH archives.
    expect(calls).toEqual([
      "create:Merged",
      "archive:mem_a:system-curator",
      "archive:mem_b:system-curator",
    ]);
  });

  it("leaves the sources untouched when no archive actor is passed (propose path)", () => {
    const { store, calls } = fakeStore();
    const id = mergeMemory(store, {
      replacement: { input: { title: "Merged" } },
      sourceIds: ["mem_a", "mem_b"],
    });
    expect(id).toBe("mem_new_0");
    expect(calls).toEqual(["create:Merged"]); // NO archives
  });

  it("passes the replacement's options through verbatim", () => {
    let seen: Record<string, unknown> | undefined;
    const store: MergeMemoryStore = {
      createMemory: (_input, options) => {
        seen = options;
        return { memory: { id: "x" } };
      },
      archiveMemory: () => null,
      getMemory: () => null,
    };
    mergeMemory(store, {
      replacement: { input: { title: "M" }, options: { requires_approval: true } },
      sourceIds: ["s1", "s2"],
    });
    expect(seen).toEqual({ requires_approval: true });
  });

  it("uses a stable union of source project keys when the replacement omits them", () => {
    const seen: Record<string, unknown>[] = [];
    const store: MergeMemoryStore = {
      createMemory: (input) => {
        seen.push(input);
        return { memory: { id: "merged" } };
      },
      archiveMemory: () => null,
      getMemory: (id) =>
        id === "a" ? { project_keys: ["alpha", "shared"] } : { project_keys: ["shared", "beta"] },
    };
    mergeMemory(store, { replacement: { input: { title: "M" } }, sourceIds: ["a", "b"] });
    expect(seen[0]?.project_keys).toEqual(["alpha", "shared", "beta"]);
  });

  it("honours an explicit replacement project_keys value, including an empty list", () => {
    const seen: unknown[] = [];
    const store: MergeMemoryStore = {
      createMemory: (input) => {
        seen.push(input.project_keys);
        return { memory: { id: "merged" } };
      },
      archiveMemory: () => null,
      getMemory: () => ({ project_keys: ["source-project"] }),
    };
    mergeMemory(store, {
      replacement: { input: { title: "M", project_keys: [] } },
      sourceIds: ["a", "b"],
    });
    expect(seen).toEqual([[]]);
  });
});
