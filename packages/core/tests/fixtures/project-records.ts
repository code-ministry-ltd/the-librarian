import type { Project, ProjectSuggestion, ProjectUpdate } from "@librarian/core";

export const PROJECT_NOW = "2026-08-06T12:00:00.000Z";

const automaticSection = {
  content: "Not established from current sources.",
  ownership: "automatic" as const,
  source_ids: [] as string[],
};

export function projectRecord(overrides: Partial<Project> = {}): Project {
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
      what_this_project_is: { ...automaticSection },
      technology_and_architecture: { ...automaticSection },
      current_state: { ...automaticSection },
      last_meaningful_work: { ...automaticSection },
      planned_next: { ...automaticSection },
      blockers_and_uncertainties: { ...automaticSection },
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
    created_at: PROJECT_NOW,
    updated_at: PROJECT_NOW,
    ...overrides,
  };
}

export function projectUpdateRecord(overrides: Partial<ProjectUpdate> = {}): ProjectUpdate {
  return {
    id: "pru_123",
    project_id: "prj_123",
    candidate_fingerprint: null,
    suggested_key: null,
    suggested_name: null,
    suggested_aliases: [],
    suggested_repository_identifiers: [],
    confidence: 0.93,
    rationale: "The source describes current implementation work.",
    explicitly_new_project: false,
    evidence: {
      overview: [],
      technology_and_architecture: ["The codebase is a TypeScript monorepo."],
      completed: [],
      current: ["The project briefing storage slice is in progress."],
      planned: ["Build the asynchronous compiler."],
      blockers: [],
    },
    source_kind: "capture",
    source_ref: "conversation:conv_123",
    observed_at: "2026-08-06T11:00:00.000Z",
    captured_at: PROJECT_NOW,
    shelf_id: "main",
    fingerprint: "a".repeat(64),
    ...overrides,
  };
}

export function projectSuggestionRecord(
  overrides: Partial<ProjectSuggestion> = {},
): ProjectSuggestion {
  return {
    id: "prs_123",
    project_id: "prj_123",
    section: "current_state",
    proposed_content: "The storage slice is complete; compiler work is next.",
    rationale: "New evidence materially changes the pinned current state.",
    source_ids: ["update:pru_123"],
    content_hash: "b".repeat(64),
    status: "pending",
    created_at: PROJECT_NOW,
    resolved_at: null,
    ...overrides,
  };
}
