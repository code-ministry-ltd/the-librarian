// Memory update-patch whitelist (plan 036 Phase 2). Restricts a free-form
// patch to the fields a caller may set on update/approve, so an agent can't
// smuggle protected fields (e.g. is_global / requires_approval /
// curator_note) through the update path. Array fields are normalized via
// `asArray`.

import { asArray } from "../constants.js";

const ALLOWED_PATCH_FIELDS = [
  "title",
  "body",
  "agent_id",
  "applies_to",
  "project_keys",
  "status",
  "confidence",
  "supersedes",
  "conflicts_with",
  "tags",
];

export function cleanPatch(patch: Record<string, unknown> = {}): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of ALLOWED_PATCH_FIELDS) {
    if (patch[key] !== undefined) {
      output[key] = Array.isArray(patch[key]) ? asArray(patch[key]) : patch[key];
    }
  }
  return output;
}
