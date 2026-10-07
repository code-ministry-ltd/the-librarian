// Curator operation validation (spec §10.5).
//
// The context-dependent gate over already-schema-valid operations. These are the
// HARD GUARDS that §11 apply must never relax:
//   - referential: every referenced memory id is in the evidence bundle;
//   - slice-boundary: an op may not change visibility (memories are project-less
//     now, so there is a single global slice and no project boundary to cross);
//   - secret: an op carrying secret-looking content is rejected (never written);
//   - empty/duplicate: no empty memory, no duplicate of an active memory;
//   - resurrection: no create/merge that matches an archived tombstone (§9.1).
// Accepted ops go on to the D13 apply decision, which reads only confidence.
// Reject reasons are value-free (audit hygiene).

import {
  type GroomingOperation,
  type EvidenceSlice,
  type MemoryEvidenceBundle,
  type MemoryEvidenceItem,
  type PrepassResult,
  curationContentFingerprint,
  curationNormalizedTitle,
  validateOperations,
} from "@librarian/core";
import { describe, expect, it } from "vitest";

function memItem(id: string, over: Partial<MemoryEvidenceItem> = {}): MemoryEvidenceItem {
  return {
    id,
    title: `title ${id}`,
    body: `body ${id}`,
    agentId: null,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    isGlobal: false,
    ...over,
  };
}

function tomb(id: string, title: string, body: string): MemoryEvidenceBundle["tombstones"][number] {
  return {
    id,
    title,
    agentId: null,
    archivedAt: "2026-01-01T00:00:00.000Z",
    archiveReason: null,
    contentFingerprint: curationContentFingerprint(title, body),
    normalizedTitle: curationNormalizedTitle(title),
  };
}

interface CtxParts {
  slice?: EvidenceSlice;
  active?: MemoryEvidenceItem[];
  proposed?: MemoryEvidenceItem[];
  tombstones?: MemoryEvidenceBundle["tombstones"];
  prepass?: PrepassResult;
}

function ctx(parts: CtxParts = {}) {
  const slice = parts.slice ?? { kind: "common_global" };
  const memory: MemoryEvidenceBundle = {
    slice,
    activeMemories: parts.active ?? [],
    proposedMemories: parts.proposed ?? [],
    tombstones: parts.tombstones ?? [],
    truncatedMemories: false,
    truncatedFields: false,
    redactionCount: 0,
  };
  return { slice, memory, prepass: parts.prepass ?? { findings: [] } };
}

const newMem = {
  title: "Fresh",
  body: "fresh body",
  visibility: "common" as const,
};

function only(ops: GroomingOperation[], context: Parameters<typeof validateOperations>[1]) {
  return validateOperations(ops, context)[0]!.outcome;
}

describe("validateOperations — referential guard", () => {
  it("accepts an archive of an in-evidence active memory", () => {
    const outcome = only(
      [{ type: "archive", source_memory_ids: ["mem_a"], rationale: "dup", confidence: 0.95 }],
      ctx({ active: [memItem("mem_a")] }),
    );
    expect(outcome.decision).toBe("accept");
  });

  it("rejects an op referencing an unknown memory id", () => {
    const outcome = only(
      [{ type: "archive", source_memory_ids: ["mem_ghost"], rationale: "x", confidence: 0.9 }],
      ctx({ active: [memItem("mem_a")] }),
    );
    expect(outcome).toMatchObject({ decision: "reject" });
    expect((outcome as { reason: string }).reason).toMatch(/memory/i);
  });
});

describe("validateOperations — slice-boundary guard", () => {
  it("rejects an update.patch that changes visibility", () => {
    // Any patch touching the visibility boundary field is rejected — even a
    // no-op visibility ("common" is the only schema-valid value post-D8; the
    // field stays frozen). (`scope`/`project_key` left the wire contract — the
    // strict patch schema rejects them at parse, covered in
    // grooming-output.test.ts.)
    const outcome = only(
      [
        {
          type: "update",
          source_memory_id: "mem_a",
          patch: { visibility: "common" },
          rationale: "x",
          confidence: 0.9,
        },
      ],
      ctx({ active: [memItem("mem_a")] }),
    );
    expect(outcome).toMatchObject({ decision: "reject" });
    expect((outcome as { reason: string }).reason).toMatch(/boundary/i);
  });
});

describe("validateOperations — secret guard", () => {
  it("rejects an op carrying secret-looking content, without echoing the secret", () => {
    const SECRET = "FAKEVALIDATESECRET";
    const outcome = only(
      [
        {
          type: "create",
          memory: { ...newMem, body: `token = "${SECRET}"` },
          rationale: "x",
          confidence: 0.9,
        },
      ],
      ctx(),
    );
    expect(outcome).toMatchObject({ decision: "reject" });
    expect((outcome as { reason: string }).reason).toMatch(/secret/i);
    expect((outcome as { reason: string }).reason).not.toContain(SECRET);
  });
});

describe("validateOperations — empty + duplicate guards", () => {
  it("rejects a whitespace-only memory as empty", () => {
    const outcome = only(
      [
        {
          type: "create",
          memory: { ...newMem, title: "   ", body: "   " },
          rationale: "x",
          confidence: 0.9,
        },
      ],
      ctx(),
    );
    expect(outcome).toMatchObject({ decision: "reject" });
    expect((outcome as { reason: string }).reason).toMatch(/empty/i);
  });

  it("rejects a create that duplicates an existing active memory", () => {
    const outcome = only(
      [
        {
          type: "create",
          memory: { ...newMem, title: "Dup", body: "dup body" },
          rationale: "x",
          confidence: 0.9,
        },
      ],
      ctx({ active: [memItem("mem_a", { title: "Dup", body: "dup body" })] }),
    );
    expect(outcome).toMatchObject({ decision: "reject" });
    expect((outcome as { reason: string }).reason).toMatch(/duplicate/i);
  });
});

describe("validateOperations — resurrection guard", () => {
  it("rejects a create whose content matches an archived tombstone", () => {
    const outcome = only(
      [
        {
          type: "create",
          memory: { ...newMem, title: "Gone", body: "deleted content" },
          rationale: "x",
          confidence: 0.9,
        },
      ],
      ctx({ tombstones: [tomb("mem_dead", "Gone", "deleted content")] }),
    );
    expect(outcome).toMatchObject({ decision: "reject" });
    expect((outcome as { reason: string }).reason).toMatch(/resurrect|archived/i);
  });
});

describe("validateOperations — security regressions (audit)", () => {
  it("accepts a create in the global slice (memories are project-less)", () => {
    const outcome = only(
      [
        {
          type: "create",
          memory: { ...newMem },
          rationale: "x",
          confidence: 0.9,
        },
      ],
      ctx(),
    );
    expect(outcome.decision).toBe("accept");
  });

  it("rejects mutating a proposed memory (§11.1)", () => {
    const archived = only(
      [{ type: "archive", source_memory_ids: ["mem_p"], rationale: "x", confidence: 0.9 }],
      ctx({ proposed: [memItem("mem_p", { status: "proposed" })] }),
    );
    expect(archived).toMatchObject({ decision: "reject" });
    expect((archived as { reason: string }).reason).toMatch(/proposed/i);

    const updated = only(
      [
        {
          type: "update",
          source_memory_id: "mem_p",
          patch: { body: "tweak" },
          rationale: "x",
          confidence: 0.9,
        },
      ],
      ctx({ proposed: [memItem("mem_p", { status: "proposed" })] }),
    );
    expect(updated).toMatchObject({ decision: "reject" });
  });

  it("rejects an update whose patched content resurrects a tombstone", () => {
    const outcome = only(
      [
        {
          type: "update",
          source_memory_id: "mem_a",
          patch: { title: "Gone", body: "deleted content" },
          rationale: "x",
          confidence: 0.9,
        },
      ],
      ctx({
        active: [memItem("mem_a")],
        tombstones: [tomb("mem_dead", "Gone", "deleted content")],
      }),
    );
    expect(outcome).toMatchObject({ decision: "reject" });
    expect((outcome as { reason: string }).reason).toMatch(/resurrect|archived/i);
  });

  it("rejects an update that empties or duplicates via its patched result", () => {
    const emptied = only(
      [
        {
          type: "update",
          source_memory_id: "mem_a",
          patch: { body: "   " },
          rationale: "x",
          confidence: 0.9,
        },
      ],
      ctx({ active: [memItem("mem_a")] }),
    );
    expect(emptied).toMatchObject({ decision: "reject" });

    const duped = only(
      [
        {
          type: "update",
          source_memory_id: "mem_a",
          patch: { title: "Dup", body: "dup body" },
          rationale: "x",
          confidence: 0.9,
        },
      ],
      ctx({ active: [memItem("mem_a"), memItem("mem_b", { title: "Dup", body: "dup body" })] }),
    );
    expect(duped).toMatchObject({ decision: "reject" });
  });
});

describe("validateOperations — batch", () => {
  it("returns one outcome per operation, in order", () => {
    const results = validateOperations(
      [
        { type: "noop", source_memory_ids: [], rationale: "ok", confidence: 0.5 },
        { type: "archive", source_memory_ids: ["ghost"], rationale: "x", confidence: 0.9 },
      ],
      ctx(),
    );
    expect(results).toHaveLength(2);
    expect(results[0]!.outcome.decision).toBe("accept");
    expect(results[1]!.outcome.decision).toBe("reject");
  });
});
