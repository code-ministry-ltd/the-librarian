import { ProjectSuggestionSchema, type ProjectSuggestion } from "@librarian/core";
import { describe, expect, it } from "vitest";

const createdAt = "2026-08-06T12:00:00.000Z";

function suggestion(overrides: Partial<ProjectSuggestion> = {}): ProjectSuggestion {
  return {
    id: "prs_123",
    project_id: "prj_123",
    section: "current_state",
    proposed_content: "The storage layer is complete and the compiler is next.",
    rationale: "New evidence materially changes the pinned current state.",
    source_ids: ["update:pru_123"],
    content_hash: "c".repeat(64),
    status: "pending",
    created_at: createdAt,
    resolved_at: null,
    ...overrides,
  };
}

describe("ProjectSuggestionSchema", () => {
  it("accepts one of the six project sections", () => {
    for (const section of [
      "what_this_project_is",
      "technology_and_architecture",
      "current_state",
      "last_meaningful_work",
      "planned_next",
      "blockers_and_uncertainties",
    ] as const) {
      expect(ProjectSuggestionSchema.safeParse(suggestion({ section })).success).toBe(true);
    }
  });

  it("rejects unknown fields", () => {
    expect(ProjectSuggestionSchema.safeParse({ ...suggestion(), surprise: true }).success).toBe(
      false,
    );
  });

  it("bounds content and requires grounded source ids", () => {
    expect(
      ProjectSuggestionSchema.safeParse(suggestion({ proposed_content: "x".repeat(12_001) }))
        .success,
    ).toBe(false);
    expect(ProjectSuggestionSchema.safeParse(suggestion({ source_ids: [] })).success).toBe(false);
    expect(
      ProjectSuggestionSchema.safeParse(suggestion({ source_ids: Array(51).fill("update:1") }))
        .success,
    ).toBe(false);
    expect(
      ProjectSuggestionSchema.safeParse(
        suggestion({ source_ids: ["update:pru_123", "update:pru_123"] }),
      ).success,
    ).toBe(false);
  });

  it("enforces pending and resolved lifecycle timestamps", () => {
    expect(
      ProjectSuggestionSchema.safeParse(
        suggestion({ status: "accepted", resolved_at: "2026-08-06T13:00:00.000Z" }),
      ).success,
    ).toBe(true);
    expect(ProjectSuggestionSchema.safeParse(suggestion({ status: "accepted" })).success).toBe(
      false,
    );
    expect(
      ProjectSuggestionSchema.safeParse(
        suggestion({ status: "pending", resolved_at: "2026-08-06T13:00:00.000Z" }),
      ).success,
    ).toBe(false);
  });

  it("requires safe ids, known sections, hashes and timestamps", () => {
    expect(ProjectSuggestionSchema.safeParse(suggestion({ id: "../suggestion" })).success).toBe(
      false,
    );
    expect(ProjectSuggestionSchema.safeParse(suggestion({ project_id: "a/b" })).success).toBe(
      false,
    );
    expect(
      ProjectSuggestionSchema.safeParse(suggestion({ section: "history" as never })).success,
    ).toBe(false);
    expect(ProjectSuggestionSchema.safeParse(suggestion({ content_hash: "bad" })).success).toBe(
      false,
    );
    expect(ProjectSuggestionSchema.safeParse(suggestion({ created_at: "today" })).success).toBe(
      false,
    );
  });
});
