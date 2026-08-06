import { parseProjectUpdateDocument, serializeProjectUpdateDocument } from "@librarian/core";
import { describe, expect, it } from "vitest";
import { projectUpdateRecord } from "../../fixtures/project-records.js";

const EXPECTED_KEYS = [
  "id",
  "project_id",
  "candidate_fingerprint",
  "suggested_key",
  "suggested_name",
  "suggested_aliases",
  "suggested_repository_identifiers",
  "confidence",
  "rationale",
  "explicitly_new_project",
  "evidence",
  "source_kind",
  "source_ref",
  "observed_at",
  "captured_at",
  "shelf_id",
  "fingerprint",
];

function topLevelFrontmatterKeys(raw: string): string[] {
  return raw
    .split("\n")
    .slice(1, raw.split("\n").indexOf("---", 1))
    .flatMap((line) => (/^([a-z_]+):/.exec(line)?.[1] ? [RegExp.$1] : []));
}

describe("ProjectUpdate Markdown document", () => {
  it("round-trips by value and byte-for-byte in fixed frontmatter order", () => {
    const value = projectUpdateRecord();
    const raw = serializeProjectUpdateDocument(value);
    expect(parseProjectUpdateDocument(raw)).toEqual(value);
    expect(serializeProjectUpdateDocument(parseProjectUpdateDocument(raw))).toBe(raw);
    expect(topLevelFrontmatterKeys(raw)).toEqual(EXPECTED_KEYS);
  });

  it("rejects malformed or unknown fields with precise diagnostics", () => {
    const raw = serializeProjectUpdateDocument(projectUpdateRecord());
    expect(() => parseProjectUpdateDocument(raw.replace(/^source_ref:.*\n/m, ""))).toThrow(
      /source_ref/,
    );
    expect(() =>
      parseProjectUpdateDocument(raw.replace("source_kind: capture", "source_kind: guess")),
    ).toThrow(/source_kind/);
    expect(() =>
      parseProjectUpdateDocument(raw.replace(/^fingerprint:/m, "surprise: true\nfingerprint:")),
    ).toThrow(/surprise/);
  });

  it("rejects a body because update evidence has one canonical frontmatter representation", () => {
    const raw = serializeProjectUpdateDocument(projectUpdateRecord());
    expect(() => parseProjectUpdateDocument(`${raw}unexpected body\n`)).toThrow(/body/i);
  });
});
