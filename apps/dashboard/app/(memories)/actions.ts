"use server";

import { revalidatePath } from "next/cache";
import { type MemoryRow, type ReferenceHit, type RouterInputs } from "@/components/memories/types";
import { serverTRPC } from "@/lib/trpc-server";

type CreateInput = NonNullable<RouterInputs["memories"]["create"]>;
type UpdatePatch = RouterInputs["memories"]["update"]["patch"];

type ActionResult = { ok: true; warning?: string } | { ok: false; error: string };

function fail(message: string): ActionResult {
  return { ok: false, error: message };
}

function string(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function tags(form: FormData, key: string): string[] {
  const raw = form.get(key);
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export async function createMemoryAction(form: FormData): Promise<ActionResult> {
  try {
    const input = {
      title: string(form, "title"),
      body: string(form, "body"),
      tags: tags(form, "tags"),
    } as CreateInput;
    await serverTRPC.memories.create.mutate(input);
    revalidatePath("/");
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function updateMemoryAction(id: string, form: FormData): Promise<ActionResult> {
  try {
    const patch = {
      title: string(form, "title"),
      body: string(form, "body"),
      tags: tags(form, "tags"),
    } as UpdatePatch;
    await serverTRPC.memories.update.mutate({ id, patch });
    revalidatePath("/");
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

function revalidateMemoryRoutes(): void {
  // Approve/reject can move a row between the active list, the proposals
  // queue, and the archive — revalidate every status-filtered view so a
  // navigation back doesn't show stale rows.
  revalidatePath("/");
  revalidatePath("/proposals");
  revalidatePath("/archive");
}

// `patch` (D11): the judge's curated title/body/tags, sent when the admin
// approves a create-plan proposal's curated version. Omitted → today's
// behaviour (the raw submission activates unchanged).
export async function approveProposalAction(
  id: string,
  patch?: { title?: string; body?: string; tags?: string[] },
): Promise<ActionResult> {
  try {
    await serverTRPC.memories.approve.mutate({ id, ...(patch ? { patch } : {}) });
    revalidateMemoryRoutes();
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

// Execute a proposal's persisted plan (proposal-review rework F3): the server
// mutation applies the judge's plan through its guards, then consumes the
// proposal (archive + resolution: "applied_plan"). A guard failure comes back
// as {ok:false, error} with the server's teaching message — the card renders
// it, never throws.
export async function applyProposalPlanAction(id: string): Promise<ActionResult> {
  try {
    await serverTRPC.memories.applyProposalPlan.mutate({ id });
    revalidateMemoryRoutes();
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function rejectProposalAction(id: string): Promise<ActionResult> {
  try {
    await serverTRPC.memories.reject.mutate({ id });
    revalidateMemoryRoutes();
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export type DistillResult =
  | { ok: true; current: string; candidate: string; diff: string }
  | { ok: false; error: string };

// "Reject & make an example" step 1 (proposal-review rework F4): ask the
// curator to distill the rejected submission into the examples document. PURE
// — returns the current doc, the candidate whole-document rewrite, and a
// server-rendered diff; nothing is committed until teachExampleAction.
export async function distillExampleAction(
  proposalId: string,
  note?: string,
): Promise<DistillResult> {
  try {
    const result = await serverTRPC.examples.distill.mutate({
      proposalId,
      ...(note?.trim() ? { note } : {}),
    });
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// "Reject & make an example" step 2 (scenario C ordering): commit the distilled
// document FIRST, then reject the proposal — a failure between the two leaves
// the lesson taught and the proposal still open (harmless; re-reject), never a
// rejected proposal whose lesson was lost.
export async function teachExampleAction(
  proposalId: string,
  candidate: string,
): Promise<ActionResult> {
  try {
    await serverTRPC.examples.set.mutate({ content: candidate });
    await serverTRPC.memories.reject.mutate({ id: proposalId });
    revalidateMemoryRoutes();
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function archiveMemoryAction(id: string): Promise<ActionResult> {
  try {
    await serverTRPC.memories.archive.mutate({ id });
    revalidatePath("/");
    revalidatePath("/archive");
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function moveMemoryAction(id: string, shelf: string): Promise<ActionResult> {
  try {
    const moved = await serverTRPC.memories.move.mutate({ id, shelf });
    revalidatePath("/");
    const warning = moved.move_warnings?.map((item) => item.message).join(" ");
    return warning ? { ok: true, warning } : { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function proposeMoveAction(
  id: string,
  shelf: string,
  rationale?: string,
): Promise<ActionResult> {
  try {
    const trimmed = rationale?.trim();
    await serverTRPC.memories.proposeMove.mutate({
      id,
      shelf,
      ...(trimmed ? { rationale: trimmed } : {}),
    });
    revalidatePath("/proposals");
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

// Adjudicate one flagged memory (spec 048 PR-2) via tRPC `memories.resolveFlag`.
// `dismiss` clears the open flags and keeps the memory active; `archive`
// archives it then clears its flags — either way the row drops out of the
// flagged review queue. Revalidates the flagged + active + archive views so a
// navigation back doesn't show a stale queue.
export async function resolveFlagAction(
  id: string,
  action: "dismiss" | "archive",
): Promise<ActionResult> {
  try {
    await serverTRPC.memories.resolveFlag.mutate({ id, action });
    revalidatePath("/");
    revalidatePath("/flagged");
    revalidatePath("/archive");
    return { ok: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export type BulkUpdateResult =
  | { ok: true; updated: number; transaction_id: string }
  | { ok: false; error: string };

// D1.1 — re-home flow: bulk-update memories' agent_id in one tRPC round-trip.
// Whitelisted server-side to agent_id (memories are project-less now).
export async function bulkUpdateMemoriesAction(
  ids: string[],
  patch: { agent_id?: string },
): Promise<BulkUpdateResult> {
  if (ids.length === 0) return { ok: false, error: "No memories selected." };
  if (patch.agent_id === undefined) {
    return { ok: false, error: "Re-home requires a new agent." };
  }
  try {
    const result = await serverTRPC.memories.bulkUpdate.mutate({
      ids,
      patch: { agent_id: patch.agent_id },
    });
    revalidatePath("/");
    return { ok: true, updated: result.updated, transaction_id: result.transaction_id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type PurgeResult = { ok: true; purged: number } | { ok: false; error: string };

// Permanently delete archived memories (irreversible from the app). Hard-deletes
// via tRPC `memories.purge`, which refuses any non-archived memory server-side.
// Revalidates the archive view so the deleted rows drop out.
export async function purgeMemoriesAction(ids: string[]): Promise<PurgeResult> {
  if (ids.length === 0) return { ok: false, error: "No memories selected." };
  try {
    const result = await serverTRPC.memories.purge.mutate({ ids });
    revalidatePath("/archive");
    return { ok: true, purged: result.purged };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type RecallResult = { ok: true; memories: MemoryRow[] } | { ok: false; error: string };

// Recall via the hybrid engine (the server procedure calls store.recall). `tags`
// (any-match) and `limit` are the same knobs the recall MCP tool gives agents,
// so the operator can reproduce a specific agent's recall; both are omitted when
// absent so the default limit (12) applies.
export async function recallAction(
  query: string,
  opts?: { tags?: string[]; limit?: number },
): Promise<RecallResult> {
  if (!query.trim()) return { ok: false, error: "Recall query is empty." };
  try {
    const result = await serverTRPC.memories.recall.mutate({
      query,
      ...(opts?.tags && opts.tags.length > 0 ? { tags: opts.tags } : {}),
      limit: opts?.limit ?? 12,
    });
    revalidatePath("/");
    return { ok: true, memories: result.memories as MemoryRow[] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type SearchReferencesResult =
  | { ok: true; references: ReferenceHit[]; searched: number }
  | { ok: false; error: string };

// The References retrieval tester. Calls vault.searchReferences — the same store
// method the search_references MCP tool runs — so the operator sees exactly what
// an agent sees. `searched` (the count of reference docs in the vault) is passed
// through so the UI can tell "none filed" from "filed but none matched". `limit`
// is omitted when absent so the server applies its default (12); a pure read, so
// no revalidation.
export async function searchReferencesAction(
  query: string,
  limit?: number,
): Promise<SearchReferencesResult> {
  if (!query.trim()) return { ok: false, error: "Reference query is empty." };
  try {
    const result = await serverTRPC.vault.searchReferences.mutate({
      query,
      ...(limit !== undefined ? { limit } : {}),
    });
    return { ok: true, references: result.references, searched: result.searched };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// File a reference from the dashboard (spec 073 T5) — a URL to fetch, or
// Markdown the operator pasted or picked from disk. Member-tier server-side;
// the browser reads any chosen .md with the File API and sends its text, so
// there is no multipart plumbing and the file path collapses into the same code
// as paste. Fail-soft like its siblings: a failure is returned, never thrown.
export async function addReferenceAction(
  input: { url: string } | { content: string; title?: string },
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  try {
    const result = await serverTRPC.vault.addReference.mutate(input);
    return { ok: true, path: result.path };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
