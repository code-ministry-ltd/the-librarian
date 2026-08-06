import { PROJECT_SECTION_KEYS, ProjectSchema, type Project } from "@librarian/core";
import { describe, expect, it } from "vitest";

const now = "2026-08-06T12:00:00.000Z";

const automaticSection = {
  content: "Not established from current sources.",
  ownership: "automatic" as const,
  source_ids: [],
};

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "prj_123",
    key: "the-librarian",
    display_name: "The Librarian",
    aliases: ["Librarian"],
    repository_identifiers: ["code-ministry-ltd/the-librarian"],
    status: "active",
    resolution: null,
    resolved_project_id: null,
    proposal_rationale: null,
    proposal_evidence_ids: [],
    suppression_fingerprint: null,
    possible_match_ids: [],
    sections: {
      what_this_project_is: automaticSection,
      technology_and_architecture: automaticSection,
      current_state: automaticSection,
      last_meaningful_work: automaticSection,
      planned_next: automaticSection,
      blockers_and_uncertainties: automaticSection,
    },
    compiled_at: null,
    compiler_version: null,
    source_watermark: null,
    source_ids: [],
    content_hash: null,
    refresh_status: "not_built",
    refresh_failure_class: null,
    pending_source_count: 0,
    unresolved_conflict_count: 0,
    last_activity_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("ProjectSchema", () => {
  it("accepts the six fixed sections and both ownership values", () => {
    const value = project({
      sections: {
        ...project().sections,
        current_state: {
          content: "The first storage slice is in progress.",
          ownership: "pinned",
          source_ids: ["memory:mem_123"],
        },
      },
    });

    expect(ProjectSchema.parse(value)).toEqual(value);
    expect(PROJECT_SECTION_KEYS).toEqual([
      "what_this_project_is",
      "technology_and_architecture",
      "current_state",
      "last_meaningful_work",
      "planned_next",
      "blockers_and_uncertainties",
    ]);
  });

  it("rejects unknown fields at every object boundary", () => {
    expect(ProjectSchema.safeParse({ ...project(), surprise: true }).success).toBe(false);
    expect(
      ProjectSchema.safeParse({
        ...project(),
        sections: {
          ...project().sections,
          current_state: { ...automaticSection, surprise: true },
        },
      }).success,
    ).toBe(false);
    expect(
      ProjectSchema.safeParse({
        ...project(),
        sections: { ...project().sections, surprise: automaticSection },
      }).success,
    ).toBe(false);
  });

  it("enforces path-safe ids and stable lower-case project keys", () => {
    for (const id of ["../other", "/absolute", "nested/path", "nested\\path", ".", "a\nb"]) {
      expect(ProjectSchema.safeParse(project({ id })).success).toBe(false);
    }
    for (const key of ["Uppercase", "two words", "-leading", "trailing-", "a/b", "a".repeat(65)]) {
      expect(ProjectSchema.safeParse(project({ key })).success).toBe(false);
    }
    expect(ProjectSchema.safeParse(project({ key: "briefing-v1" })).success).toBe(true);
  });

  it("bounds identity, section content and source collections", () => {
    expect(ProjectSchema.safeParse(project({ display_name: "x".repeat(121) })).success).toBe(false);
    expect(ProjectSchema.safeParse(project({ aliases: Array(21).fill("alias") })).success).toBe(
      false,
    );
    expect(
      ProjectSchema.safeParse(
        project({
          sections: {
            ...project().sections,
            current_state: { ...automaticSection, content: "x".repeat(12_001) },
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      ProjectSchema.safeParse(project({ source_ids: Array(201).fill("memory:mem_1") })).success,
    ).toBe(false);
    expect(ProjectSchema.safeParse(project({ source_ids: ["x".repeat(513)] })).success).toBe(false);
  });

  it("requires valid UTC ISO timestamps", () => {
    expect(ProjectSchema.safeParse(project({ created_at: "yesterday" })).success).toBe(false);
    expect(ProjectSchema.safeParse(project({ compiled_at: "2026-08-06" })).success).toBe(false);
    expect(ProjectSchema.safeParse(project({ last_activity_at: "not-a-time" })).success).toBe(
      false,
    );
    expect(
      ProjectSchema.safeParse(
        project({
          created_at: "2026-08-06T13:00:00.000Z",
          updated_at: "2026-08-06T12:00:00.000Z",
        }),
      ).success,
    ).toBe(false);
  });

  it("enforces proposal and resolution lifecycle combinations", () => {
    expect(
      ProjectSchema.safeParse(
        project({
          status: "proposed",
          proposal_rationale: "A durable named repository was explicitly described.",
          proposal_evidence_ids: ["capture:conversation-1"],
        }),
      ).success,
    ).toBe(true);
    expect(ProjectSchema.safeParse(project({ status: "proposed" })).success).toBe(false);
    expect(ProjectSchema.safeParse(project({ resolution: "rejected" })).success).toBe(false);
    expect(
      ProjectSchema.safeParse(
        project({ status: "archived", resolution: "rejected", suppression_fingerprint: null }),
      ).success,
    ).toBe(false);
    expect(
      ProjectSchema.safeParse(
        project({
          status: "archived",
          resolution: "rejected",
          suppression_fingerprint: "a".repeat(64),
        }),
      ).success,
    ).toBe(true);
    expect(
      ProjectSchema.safeParse(
        project({
          status: "archived",
          resolution: "belongs_to_existing",
          resolved_project_id: "prj_existing",
        }),
      ).success,
    ).toBe(true);
    expect(
      ProjectSchema.safeParse(project({ status: "archived", resolution: "belongs_to_existing" }))
        .success,
    ).toBe(false);
  });

  it("requires a content-free failure class only for failed refreshes", () => {
    expect(
      ProjectSchema.safeParse(
        project({ refresh_status: "failed", refresh_failure_class: "provider_timeout" }),
      ).success,
    ).toBe(true);
    expect(ProjectSchema.safeParse(project({ refresh_status: "failed" })).success).toBe(false);
    expect(
      ProjectSchema.safeParse(project({ refresh_failure_class: "provider_timeout" })).success,
    ).toBe(false);
  });
});
