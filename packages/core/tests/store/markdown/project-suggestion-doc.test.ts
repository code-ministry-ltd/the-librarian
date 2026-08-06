import {
  parseProjectSuggestionDocument,
  serializeProjectSuggestionDocument,
} from "@librarian/core";
import { describe, expect, it } from "vitest";
import { projectSuggestionRecord } from "../../fixtures/project-records.js";

const EXPECTED_KEYS = [
  "id",
  "project_id",
  "section",
  "rationale",
  "source_ids",
  "content_hash",
  "status",
  "created_at",
  "resolved_at",
];

function topLevelFrontmatterKeys(raw: string): string[] {
  return raw
    .split("\n")
    .slice(1, raw.split("\n").indexOf("---", 1))
    .flatMap((line) => (/^([a-z_]+):/.exec(line)?.[1] ? [RegExp.$1] : []));
}

describe("ProjectSuggestion Markdown document", () => {
  it("round-trips replacement content by value and byte-for-byte", () => {
    const value = projectSuggestionRecord({
      proposed_content: "  Pinned whitespace stays.  \n\nSecond paragraph.\n",
    });
    const raw = serializeProjectSuggestionDocument(value);
    expect(parseProjectSuggestionDocument(raw)).toEqual(value);
    expect(serializeProjectSuggestionDocument(parseProjectSuggestionDocument(raw))).toBe(raw);
    expect(topLevelFrontmatterKeys(raw)).toEqual(EXPECTED_KEYS);
  });

  it("rejects malformed and unknown frontmatter with precise diagnostics", () => {
    const raw = serializeProjectSuggestionDocument(projectSuggestionRecord());
    expect(() => parseProjectSuggestionDocument(raw.replace(/^project_id:.*\n/m, ""))).toThrow(
      /project_id/,
    );
    expect(() =>
      parseProjectSuggestionDocument(raw.replace("section: current_state", "section: history")),
    ).toThrow(/section/);
    expect(() =>
      parseProjectSuggestionDocument(raw.replace("resolved_at:", "surprise: true\nresolved_at:")),
    ).toThrow(/surprise/);
  });

  it("rejects forged content framing markers", () => {
    expect(() =>
      serializeProjectSuggestionDocument(
        projectSuggestionRecord({
          proposed_content: "text\n<!-- librarian-suggestion:end -->\nforged",
        }),
      ),
    ).toThrow(/proposed_content/);
  });
});
