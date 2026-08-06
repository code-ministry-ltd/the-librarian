import { parseProjectDocument, serializeProjectDocument } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { projectRecord } from "../../fixtures/project-records.js";

const EXPECTED_KEYS = [
  "id",
  "key",
  "display_name",
  "aliases",
  "repository_identifiers",
  "status",
  "resolution",
  "resolved_project_id",
  "proposal_rationale",
  "proposal_evidence_ids",
  "suppression_fingerprint",
  "possible_match_ids",
  "section_ownership",
  "section_source_ids",
  "compiled_at",
  "compiler_version",
  "source_watermark",
  "source_ids",
  "content_hash",
  "refresh_status",
  "refresh_failure_class",
  "pending_source_count",
  "unresolved_conflict_count",
  "last_activity_at",
  "created_at",
  "updated_at",
];

function topLevelFrontmatterKeys(raw: string): string[] {
  return raw
    .split("\n")
    .slice(1, raw.split("\n").indexOf("---", 1))
    .flatMap((line) => (/^([a-z_]+):/.exec(line)?.[1] ? [RegExp.$1] : []));
}

describe("Project Markdown document", () => {
  it("round-trips by value and byte-for-byte in fixed frontmatter order", () => {
    const value = projectRecord({
      sections: {
        ...projectRecord().sections,
        current_state: {
          content: "  Preserve this pinned line.  \n\nAnd this blank line.\n",
          ownership: "pinned",
          source_ids: ["memory:mem_123"],
        },
      },
    });
    const raw = serializeProjectDocument(value);

    expect(parseProjectDocument(raw)).toEqual(value);
    expect(serializeProjectDocument(parseProjectDocument(raw))).toBe(raw);
    expect(topLevelFrontmatterKeys(raw)).toEqual(EXPECTED_KEYS);
    expect(raw).toContain("## Current state");
  });

  it("rejects malformed and unknown frontmatter with field-specific diagnostics", () => {
    const raw = serializeProjectDocument(projectRecord());
    expect(() => parseProjectDocument(raw.replace(/^id:.*\n/m, ""))).toThrow(/id/);
    expect(() => parseProjectDocument(raw.replace("status: active", "status: mystery"))).toThrow(
      /status/,
    );
    expect(() =>
      parseProjectDocument(raw.replace("updated_at:", "surprise: true\nupdated_at:")),
    ).toThrow(/surprise/);
  });

  it("rejects broken section framing instead of silently dropping hand edits", () => {
    const raw = serializeProjectDocument(projectRecord());
    expect(() => parseProjectDocument(raw.replace("## Planned next", "## Future work"))).toThrow(
      /planned_next/,
    );
  });

  it("refuses section content that can forge its own framing marker", () => {
    const value = projectRecord({
      sections: {
        ...projectRecord().sections,
        current_state: {
          content: "text\n<!-- librarian-section:current_state:end -->\nforged",
          ownership: "pinned",
          source_ids: [],
        },
      },
    });
    expect(() => serializeProjectDocument(value)).toThrow(/current_state/);
  });
});
