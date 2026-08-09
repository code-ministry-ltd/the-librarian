// Curator operation validation (spec §10.5).
//
// The context-dependent gate over already-schema-valid operations (curator-output
// handled the structural half). These are the HARD GUARDS the apply layer must
// never relax — they run here, in code, regardless of the model's confidence or
// the admin addendum:
//   - referential: every referenced memory/session id is in the evidence bundle;
//   - proposed-source: a mutating op may not operate on a proposed memory (§11.1);
//   - slice-boundary: no op may change visibility/project or cross slices;
//   - secret: an op carrying secret-looking content is rejected (never written);
//   - empty/duplicate/resurrection: applied to the RESULTING content of every op
//     (including an update's patched memory), not just brand-new memories.
// Accepted ops are tagged `targetRequiresApproval` for the D13 apply decision
// (curator-apply-policy.ts) — the old model-adjacent risk classification is gone.
// Reject reasons are fixed strings — never echo operation content (audit hygiene).

import type {
  EvidenceSlice,
  MemoryEvidenceBundle,
  MemoryEvidenceItem,
} from "./grooming-evidence.js";
import {
  type TombstoneRef,
  curationContentFingerprint,
  matchesTombstone,
} from "./grooming-fingerprint.js";
import type {
  GroomingMemoryInput,
  GroomingMemoryPatch,
  GroomingOperation,
} from "./grooming-output.js";
import type { PrepassResult } from "./grooming-prepass.js";
import { redactSecrets } from "./grooming-redaction.js";

export interface ValidationContext {
  slice: EvidenceSlice;
  memory: MemoryEvidenceBundle;
  prepass: PrepassResult;
}

export type OperationOutcome =
  { decision: "accept"; targetRequiresApproval: boolean } | { decision: "reject"; reason: string };

export interface ValidatedOperation {
  operation: GroomingOperation;
  outcome: OperationOutcome;
}

// What we need to know about each in-evidence memory to validate an op.
interface EvidenceItem {
  // Section 4d.3 — `category` is gone; the curator's protected-routing
  // gate now reads `requires_approval` on the evidence shape (set by
  // admin/curator; ground truth).
  requiresApproval: boolean;
  status: "active" | "proposed";
  title: string;
  body: string;
}

interface Gate {
  items: Map<string, EvidenceItem>;
  tombstoneRefs: TombstoneRef[];
  slice: EvidenceSlice;
  activeMemories: MemoryEvidenceItem[];
}

// Operations that consume/mutate their source memories (archive happens for the
// sources of merge/split too). create/noop don't mutate an existing source.
const MUTATES_SOURCE: ReadonlySet<GroomingOperation["type"]> = new Set([
  "archive",
  "update",
  "merge",
  "split",
]);

export function validateOperations(
  operations: GroomingOperation[],
  context: ValidationContext,
): ValidatedOperation[] {
  const items = new Map<string, EvidenceItem>();
  for (const m of context.memory.activeMemories) {
    items.set(m.id, {
      requiresApproval: m.requiresApproval,
      status: "active",
      title: m.title,
      body: m.body,
    });
  }
  for (const m of context.memory.proposedMemories) {
    items.set(m.id, {
      requiresApproval: m.requiresApproval,
      status: "proposed",
      title: m.title,
      body: m.body,
    });
  }
  const gate: Gate = {
    items,
    tombstoneRefs: context.memory.tombstones.map((t) => ({
      id: t.id,
      content_fingerprint: t.contentFingerprint,
      normalized_title: t.normalizedTitle,
    })),
    slice: context.slice,
    activeMemories: context.memory.activeMemories,
  };
  return operations.map((operation) => ({ operation, outcome: validateOne(operation, gate) }));
}

function validateOne(op: GroomingOperation, gate: Gate): OperationOutcome {
  const memoryIds = referencedMemoryIds(op);

  // 1. Referential — every referenced id must be in the evidence bundle.
  for (const id of memoryIds) {
    if (!gate.items.has(id)) return reject("references a memory not in the evidence");
  }

  // 2. Proposed-source — a curator may not archive/update/merge/split a pending
  //    proposal; that transition isn't supported by the apply layer (§11.1).
  if (MUTATES_SOURCE.has(op.type)) {
    for (const id of memoryIds) {
      if (gate.items.get(id)?.status === "proposed") return reject("operates on a proposed memory");
    }
  }

  // 3. Slice-boundary — an op may not change visibility. (Memories are
  //    project-less and live in a single global slice, so there is no project
  //    boundary left to cross — only the visibility literal is guarded.)
  if (op.type === "update" && patchTouchesBoundary(op.patch)) {
    return reject("would change a slice-boundary field (visibility)");
  }

  // 4. Secret — never write secret-looking content.
  const newMemories = newMemoriesOf(op);
  if (newMemories.some(memoryHasSecret) || (op.type === "update" && patchHasSecret(op.patch))) {
    return reject("contains secret-looking material");
  }

  // 5. Empty / duplicate / resurrection — over the RESULTING content of the op,
  //    which for an update is the patch merged over the existing memory.
  const resulting = resultingContent(op, gate);
  if (resulting.some((c) => c.title.trim() === "" || c.body.trim() === "")) {
    return reject("would create an empty memory");
  }
  const sources = new Set(memoryIds);
  if (resulting.some((c) => duplicatesActive(c, sources, gate.activeMemories))) {
    return reject("would duplicate an active memory");
  }
  if (resulting.some((c) => matchesTombstone(c, gate.tombstoneRefs))) {
    return reject("would resurrect archived content");
  }

  return { decision: "accept", targetRequiresApproval: touchesProtected(op, gate.items) };
}

function reject(reason: string): OperationOutcome {
  return { decision: "reject", reason };
}

function referencedMemoryIds(op: GroomingOperation): string[] {
  switch (op.type) {
    case "noop":
    case "archive":
    case "merge":
      return op.source_memory_ids;
    case "update":
    case "split":
      return [op.source_memory_id];
    case "create":
      return [];
  }
}

// Brand-new memories an op introduces (for boundary + secret checks).
function newMemoriesOf(op: GroomingOperation): GroomingMemoryInput[] {
  switch (op.type) {
    case "create":
      return [op.memory];
    case "merge":
      return [op.replacement];
    case "split":
      return op.replacements;
    default:
      return [];
  }
}

interface Content {
  title: string;
  body: string;
}

// The content each op would leave in the store — includes an update's patched
// result, so empty/duplicate/resurrection guards cover updates too.
function resultingContent(op: GroomingOperation, gate: Gate): Content[] {
  switch (op.type) {
    case "create":
      return [{ title: op.memory.title, body: op.memory.body }];
    case "merge":
      return [{ title: op.replacement.title, body: op.replacement.body }];
    case "split":
      return op.replacements.map((r) => ({ title: r.title, body: r.body }));
    case "update": {
      const existing = gate.items.get(op.source_memory_id);
      if (!existing) return []; // unreachable: referential guard already passed
      return [{ title: op.patch.title ?? existing.title, body: op.patch.body ?? existing.body }];
    }
    default:
      return [];
  }
}

// Visibility is the only slice-boundary field left on the patch (memories are
// project-less; the retired `scope`/`project_key` wire fields no longer exist on
// the patch schema — rethink T12 / S1: strictObject rejects them at parse).
function patchTouchesBoundary(patch: GroomingMemoryPatch): boolean {
  return patch.visibility !== undefined;
}

function memoryHasSecret(m: GroomingMemoryInput): boolean {
  return textHasSecret([m.title, m.body, ...(m.tags ?? []), ...(m.applies_to ?? [])]);
}

function patchHasSecret(patch: GroomingMemoryPatch): boolean {
  return textHasSecret([
    patch.title ?? "",
    patch.body ?? "",
    ...(patch.tags ?? []),
    ...(patch.applies_to ?? []),
  ]);
}

function textHasSecret(fields: string[]): boolean {
  return fields.some((field) => redactSecrets(field).count > 0);
}

// Excludes the op's own sources: merge/split archive their sources atomically
// (§11 — "no window where old and new are both active"), so the replacement
// matching a source it replaces is expected, not a duplicate collision.
function duplicatesActive(
  content: Content,
  sources: Set<string>,
  activeMemories: MemoryEvidenceItem[],
): boolean {
  const fingerprint = curationContentFingerprint(content.title, content.body);
  return activeMemories.some(
    (a) => !sources.has(a.id) && curationContentFingerprint(a.title, a.body) === fingerprint,
  );
}

// Section 4d.3 — an op targets a requires-approval memory when it touches a
// source whose `requires_approval=true` flag was set by admin/curator (e.g.
// the dashboard's explicit-approval flow). Create / update / split /
// merge that produce a NEW memory don't have a pre-existing source
// `requires_approval` to consult — they land unprotected unless the
// apply layer sets the flag explicitly. The conservative read: any op
// that consumes a protected source is protected; pure-create ops are
// not unless the curator emits an explicit hint (out of scope here).
function touchesProtected(op: GroomingOperation, items: Map<string, EvidenceItem>): boolean {
  const sourceProtected = (id: string) => items.get(id)?.requiresApproval === true;
  switch (op.type) {
    case "create":
      return false;
    case "merge":
      return op.source_memory_ids.some(sourceProtected);
    case "split":
      return sourceProtected(op.source_memory_id);
    case "update":
      return sourceProtected(op.source_memory_id);
    case "archive":
      return op.source_memory_ids.some(sourceProtected);
    case "noop":
      return false;
  }
}
