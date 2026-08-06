// Normalization helpers + the few constants that aren't covered by the
// Zod-derived enums in schemas/common.ts.
//
// The enums (MemoryStatus, Confidence) are the single source of
// truth for wire-format strings — `normalizeMemoryInput` and the
// `normalizeEnum` helper below funnel free-form input through them.
//
// Section 4d.2 retired the legacy `Category` / `Visibility` / `Scope`
// enums + `deriveLegacyMemoryFlags` + `isProtectedCategory`.
// `is_global` / `requires_approval` are plain booleans set only by
// admin/curator (rethink T4); tags carry whatever organising signal a
// memory needs. (The conv_state-derived domain was retired with
// conv_state.)

import { Confidence, MemoryStatus } from "./schemas/common.js";
import { ProjectKeysSchema } from "./schemas/project.js";

export const DEFAULT_AGENT_ID = "unknown-agent";

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (value == null || value === "") return [];
  return [String(value)];
}

export function normalizeString(value: unknown, fallback = ""): string {
  if (value == null) return fallback;
  return String(value).trim();
}

export function normalizeEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const normalized = normalizeString(value, fallback);
  return (allowed as readonly string[]).includes(normalized) ? (normalized as T) : fallback;
}

export interface NormalizedMemoryInput {
  title: string;
  body: string;
  agent_id: string;
  applies_to: string[];
  project_keys?: string[];
  confidence: Confidence;
  tags: string[];
  status: MemoryStatus;
  // Routing booleans — conservative-default landings; trusted callers
  // (admin/curator) set the real values via the options channel.
  is_global: boolean;
  requires_approval: boolean;
}

export function normalizeMemoryInput(input: Record<string, unknown> = {}): NormalizedMemoryInput {
  const projectKeys =
    input.project_keys === undefined
      ? undefined
      : ProjectKeysSchema.parse(asArray(input.project_keys));
  return {
    title: normalizeString(input.title || input.content || "Untitled memory"),
    body: normalizeString(input.body || input.content || ""),
    agent_id: normalizeString(input.agent_id, DEFAULT_AGENT_ID),
    applies_to: asArray(input.applies_to),
    ...(projectKeys !== undefined ? { project_keys: projectKeys } : {}),
    confidence: normalizeEnum(input.confidence, Object.values(Confidence), Confidence.Working),
    tags: asArray(input.tags),
    status: normalizeEnum(input.status, Object.values(MemoryStatus), MemoryStatus.Active),
    // Conservative defaults — trusted callers (admin/curator) override
    // via the options channel; the legacy category-derived bridge is gone.
    is_global: false,
    requires_approval: false,
  };
}
