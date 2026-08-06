import { ProjectUpdateSchema, type ProjectUpdate } from "@librarian/core";
import { describe, expect, it } from "vitest";

const observedAt = "2026-08-06T11:00:00.000Z";
const capturedAt = "2026-08-06T12:00:00.000Z";

function update(overrides: Partial<ProjectUpdate> = {}): ProjectUpdate {
  return {
    id: "pru_123",
    project_id: null,
    candidate_fingerprint: "a".repeat(64),
    suggested_key: "the-librarian",
    suggested_name: "The Librarian",
    suggested_aliases: [],
    suggested_repository_identifiers: ["code-ministry-ltd/the-librarian"],
    confidence: 0.96,
    rationale: "The source explicitly names an ongoing repository.",
    explicitly_new_project: true,
    evidence: {
      overview: ["A durable memory service for agents."],
      technology_and_architecture: ["A TypeScript monorepo with Markdown storage."],
      completed: [],
      current: ["Project briefing storage is being built."],
      planned: ["Add materialised briefing compilation."],
      blockers: [],
    },
    source_kind: "capture",
    source_ref: "conversation:conv_123",
    observed_at: observedAt,
    captured_at: capturedAt,
    shelf_id: "personal",
    fingerprint: "b".repeat(64),
    ...overrides,
  };
}

describe("ProjectUpdateSchema", () => {
  it("accepts bounded candidate evidence from every supported source kind", () => {
    for (const source_kind of ["intake", "capture", "handoff", "admin"] as const) {
      expect(ProjectUpdateSchema.safeParse(update({ source_kind })).success).toBe(true);
    }
  });

  it("is strict at the update and evidence boundaries", () => {
    expect(ProjectUpdateSchema.safeParse({ ...update(), surprise: true }).success).toBe(false);
    expect(
      ProjectUpdateSchema.safeParse({
        ...update(),
        evidence: { ...update().evidence, surprise: [] },
      }).success,
    ).toBe(false);
  });

  it("requires exactly one matched or candidate identity", () => {
    expect(
      ProjectUpdateSchema.safeParse(
        update({
          project_id: "prj_existing",
          candidate_fingerprint: null,
          suggested_key: null,
          suggested_name: null,
          suggested_repository_identifiers: [],
        }),
      ).success,
    ).toBe(true);
    expect(ProjectUpdateSchema.safeParse(update({ project_id: "prj_existing" })).success).toBe(
      false,
    );
    expect(
      ProjectUpdateSchema.safeParse(
        update({ candidate_fingerprint: null, suggested_key: null, suggested_name: null }),
      ).success,
    ).toBe(false);
  });

  it("requires candidate identity details and forbids them on a matched update", () => {
    expect(ProjectUpdateSchema.safeParse(update({ suggested_name: null })).success).toBe(false);
    expect(ProjectUpdateSchema.safeParse(update({ suggested_key: null })).success).toBe(false);
    expect(
      ProjectUpdateSchema.safeParse(
        update({
          project_id: "prj_existing",
          candidate_fingerprint: null,
          suggested_key: "wrong",
          suggested_name: null,
          suggested_repository_identifiers: [],
        }),
      ).success,
    ).toBe(false);
  });

  it("bounds evidence, source references and confidence", () => {
    expect(ProjectUpdateSchema.safeParse(update({ confidence: 1.01 })).success).toBe(false);
    expect(ProjectUpdateSchema.safeParse(update({ source_ref: "x".repeat(513) })).success).toBe(
      false,
    );
    expect(
      ProjectUpdateSchema.safeParse(
        update({ evidence: { ...update().evidence, current: Array(26).fill("state") } }),
      ).success,
    ).toBe(false);
    expect(
      ProjectUpdateSchema.safeParse(
        update({ evidence: { ...update().evidence, current: ["x".repeat(1_001)] } }),
      ).success,
    ).toBe(false);
    expect(
      ProjectUpdateSchema.safeParse(
        update({
          evidence: {
            overview: [],
            technology_and_architecture: [],
            completed: [],
            current: [],
            planned: [],
            blockers: [],
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("requires path-safe ids, SHA-256 fingerprints and ISO timestamps", () => {
    expect(ProjectUpdateSchema.safeParse(update({ id: "../update" })).success).toBe(false);
    expect(ProjectUpdateSchema.safeParse(update({ fingerprint: "not-a-hash" })).success).toBe(
      false,
    );
    expect(ProjectUpdateSchema.safeParse(update({ observed_at: "today" })).success).toBe(false);
    expect(ProjectUpdateSchema.safeParse(update({ captured_at: "2026-08-06" })).success).toBe(
      false,
    );
    expect(
      ProjectUpdateSchema.safeParse(
        update({
          observed_at: "2026-08-06T13:00:00.000Z",
          captured_at: "2026-08-06T12:00:00.000Z",
        }),
      ).success,
    ).toBe(false);
  });
});
