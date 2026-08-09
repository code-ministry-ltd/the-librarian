"use server";

import type {
  ChatResponse,
  ChronicleConfigPatch,
  ChronicleTickResult,
  ConfigurableJobConsumer,
  IntakeOperation,
  IntakeTickResult,
  ConsumerConfig,
  ConsumerConfigPatch,
  GroomingConfigPatch,
  CuratorJob,
  GroomingTickResult,
  LlmProvider,
  LlmProviderInput,
  LlmProviderPatch,
  ProposedAction,
} from "@librarian/core";
import { revalidatePath } from "next/cache";
import type { RouterInputs } from "@/components/memories/types";
import { serverTRPC } from "@/lib/trpc-server";

export type RunNowResult = { ok: true; result: GroomingTickResult } | { ok: false; error: string };

// Intake run-now widens the tick result with a router-applied `disabled` skip.
type IntakeRunResult = IntakeTickResult | { ran: false; reason: "disabled" };
export type RunIntakeNowResult =
  { ok: true; result: IntakeRunResult } | { ok: false; error: string };
export type RunChronicleNowResult =
  { ok: true; result: ChronicleTickResult } | { ok: false; error: string };

export type SaveConfigResult = { ok: true } | { ok: false; error: string };

export type LoadOperationsResult =
  { ok: true; operations: IntakeOperation[] } | { ok: false; error: string };

// Provider mutations return the fresh provider list / consumer config so the
// client can update without an extra round-trip; the page also revalidates.
export type ProviderListResult =
  { ok: true; providers: LlmProvider[] } | { ok: false; error: string };
export type ConsumerConfigResult =
  { ok: true; config: ConsumerConfig } | { ok: false; error: string };
export type ModelsResult = { models: string[] };
export type TestConnectionResult = { ok: boolean; error?: string };

/** Inline `{ endpoint, token }` draft OR a saved `providerId` for a model probe. */
export type ProbeInput = { providerId?: string; endpoint?: string; token?: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Admin run-now (§12) — shares the scheduler enqueue path via the grooming router.
export async function runGroomingNowAction(): Promise<RunNowResult> {
  try {
    const result = await serverTRPC.grooming.runNow.mutate();
    revalidatePath("/curator");
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// Save the curator config (§7.1). An empty token field leaves the stored token
// unchanged (the form never round-trips the secret); send "" explicitly to clear.
export async function saveGroomingConfigAction(
  patch: GroomingConfigPatch,
): Promise<SaveConfigResult> {
  try {
    await serverTRPC.grooming.setConfig.mutate(patch);
    revalidatePath("/curator");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// --- LLM provider CRUD (spec 042 §4, B4b) -------------------------------------
// The token is write-only: an empty/omitted token on add or update leaves the
// stored secret untouched — the form never round-trips it.

export async function addProviderAction(input: LlmProviderInput): Promise<ProviderListResult> {
  try {
    await serverTRPC.llm.addProvider.mutate(input);
    const providers = await serverTRPC.llm.listProviders.query();
    revalidatePath("/curator");
    return { ok: true, providers };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export async function updateProviderAction(
  input: { id: string } & LlmProviderPatch,
): Promise<ProviderListResult> {
  try {
    await serverTRPC.llm.updateProvider.mutate(input);
    const providers = await serverTRPC.llm.listProviders.query();
    revalidatePath("/curator");
    return { ok: true, providers };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export async function deleteProviderAction(id: string): Promise<ProviderListResult> {
  try {
    const providers = await serverTRPC.llm.deleteProvider.mutate({ id });
    revalidatePath("/curator");
    return { ok: true, providers };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// --- Per-job (intake / grooming / Chronicle) provider+model selection ---------

export async function setConsumerConfigAction(
  consumer: ConfigurableJobConsumer,
  patch: ConsumerConfigPatch,
): Promise<ConsumerConfigResult> {
  try {
    const config = await serverTRPC.llm.setConsumerConfig.mutate({ consumer, ...patch });
    revalidatePath("/curator");
    revalidatePath("/settings/curator");
    return { ok: true, config };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// --- Chronicle ---------------------------------------------------------------

export async function saveChronicleConfigAction(
  patch: ChronicleConfigPatch,
): Promise<SaveConfigResult> {
  try {
    await serverTRPC.chronicle.setConfig.mutate(patch);
    revalidatePath("/settings/curator");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export async function runChronicleNowAction(): Promise<RunChronicleNowResult> {
  try {
    const result = await serverTRPC.chronicle.runNow.mutate();
    revalidatePath("/settings/curator");
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// --- Model picker + connection probe (fail-soft on the server) ----------------

export async function listModelsAction(input: ProbeInput): Promise<ModelsResult> {
  try {
    return await serverTRPC.llm.listModels.query(input);
  } catch {
    // Mirror the server's fail-soft contract: an unreachable proxy/server still
    // lets the user fall back to typing a model name.
    return { models: [] };
  }
}

export async function testConnectionAction(input: ProbeInput): Promise<TestConnectionResult> {
  try {
    return await serverTRPC.llm.testConnection.query(input);
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// --- Intake section (spec 043 C5b) --------------------------------------------
// Mirrors the grooming actions above against the C5a `intake` router. The intake
// job owns only an enablement toggle here (provider/model is the shared
// per-consumer selector); its runs are the C1 intake decision log.

// Admin run-now: force one inbox sweep. Surfaces the {ran:false,reason} skip
// states (disabled / incomplete_config / no_token) to the caller, never swallows.
export async function runIntakeNowAction(): Promise<RunIntakeNowResult> {
  try {
    const result = await serverTRPC.intake.runNow.mutate();
    revalidatePath("/curator");
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// Update intake's NON-LLM config: the enablement toggle (`curator.intake.enabled`,
// authoritative per spec 043 D-E — toggling off actually disables the job) and/or
// the sweep cadence (`curator.intake.interval_minutes`, spec 045 D-3). Both fields
// are optional so the form can patch one without the other; a bad cadence comes back
// as a server BAD_REQUEST and is surfaced inline by the form.
export async function setIntakeConfigAction(input: {
  enabled?: boolean;
  intervalMinutes?: number;
}): Promise<SaveConfigResult> {
  try {
    await serverTRPC.intake.setConfig.mutate(input);
    revalidatePath("/curator");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// --- Server auto-update (spec 2026-06-16-server-autoupdate T4) -----------------
// Write the auto-update config — the enablement toggle and/or the cadence
// (daily|weekly) — via the admin `autoupdate.set` router. Both fields are optional
// so the form can patch one without the other; a bad cadence comes back as a
// server BAD_REQUEST and is surfaced inline by the form. The dashboard only ever
// WRITES these settings (spec §2): the host timer performs the update, never the
// dashboard.
export async function setAutoUpdateConfigAction(input: {
  enabled?: boolean;
  cadence?: "daily" | "weekly";
}): Promise<SaveConfigResult> {
  try {
    await serverTRPC.autoupdate.set.mutate(input);
    revalidatePath("/settings/dashboard");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// Lazy per-run drill-down: the C1 decisions (action/outcome/confidence/rationale)
// for one intake run, fetched on demand when an admin expands the row.
export async function loadIntakeOperationsAction(runId: string): Promise<LoadOperationsResult> {
  try {
    const operations = await serverTRPC.intake.runOperations.query({ runId });
    return { ok: true, operations };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// --- Curator chat (spec 044 D-7 / decisions D-5/6/9/11) -----------------------
// The whole 2C self-improvement loop surfaced in the dashboard: discuss a memory
// (or the corpus) with the curator, accept its proposed fixes, and drive the
// addendum-evaluation lifecycle.

export type ChatResult = { ok: true; response: ChatResponse } | { ok: false; error: string };

// One chat turn: send the conversation so far (+ an optional memory to ground in,
// + an optional job) and get back exactly ONE response (NO streaming). The panel
// keeps the messages array client-side and appends. A non-operational chat LLM
// surfaces a clear error ("configure the chat/grooming LLM first").
export async function chatAction(input: {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  memoryId?: string;
  job?: CuratorJob;
}): Promise<ChatResult> {
  try {
    const response = await serverTRPC.grooming.chat.mutate({
      messages: input.messages,
      ...(input.memoryId ? { memoryId: input.memoryId } : {}),
      ...(input.job ? { job: input.job } : {}),
    });
    return { ok: true, response };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// Confirm a proposed action (human-in-the-loop). The chat NEVER auto-runs an
// action; the admin clicks Confirm and ONLY THEN does the matching D5 memory
// mutation run. The action's `type` selects the mutation; the rest of the action
// IS that mutation's input (the proposed-action schema mirrors the D5 inputs
// exactly), so we drop `type` and pass the rest straight through.
export type ConfirmActionResult = { ok: true } | { ok: false; error: string };

// `proposalId` (proposal-review rework F5 / D9): set when the chat was opened
// FROM a proposal ("Discuss this proposal") — after the confirmed action
// applies, the originating proposal is consumed (archived, stamped
// resolution: "resolved_via_chat") so the queue holds no stale entry. The
// consumption is fail-soft: the corpus mutation already succeeded and a
// lingering proposal is harmless (the admin can still reject it), so a
// resolve failure never fails the confirm.
export async function confirmActionAction(
  action: ProposedAction,
  proposalId?: string,
): Promise<ConfirmActionResult> {
  try {
    const { type, ...input } = action;
    switch (type) {
      case "merge":
        await serverTRPC.memories.merge.mutate(input as RouterInputs["memories"]["merge"]);
        break;
      case "split":
        await serverTRPC.memories.split.mutate(input as RouterInputs["memories"]["split"]);
        break;
      case "update":
        await serverTRPC.memories.update.mutate(input as RouterInputs["memories"]["update"]);
        break;
      case "unmerge":
        await serverTRPC.memories.unmerge.mutate(input as RouterInputs["memories"]["unmerge"]);
        break;
    }
    if (proposalId) {
      try {
        await serverTRPC.memories.resolveViaChat.mutate({ id: proposalId });
        revalidatePath("/proposals");
      } catch {
        // Fail-soft (see above): the action applied; the proposal lingers.
      }
    }
    revalidatePath("/curator");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// --- Addendum (spec 044 D-1, simplified by rethink D4) -------------------------

export type AddendumState = {
  content: string;
  version: string | null;
};
export type AddendumStateResult =
  { ok: true; addendum: AddendumState } | { ok: false; error: string };

// Commit a new addendum for a job — it applies immediately (rethink D4): the
// job's next run reads the new text. Works whether or not the job is enabled:
// the edit commits and takes effect when the job next runs. The 2 KB cap is the
// hard backstop (setJobAddendum throws over-cap); surfaced as an error here.
export async function setAddendumAction(input: {
  job: CuratorJob;
  content: string;
}): Promise<AddendumStateResult> {
  try {
    const addendum = await serverTRPC.addendum.set.mutate(input);
    revalidatePath("/curator");
    return { ok: true, addendum };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// Roll the addendum back to its prior committed version (rethink D4: git is the
// rollback — the restoration lands as a new, revertable commit).
export async function rollbackAddendumAction(input: {
  job: CuratorJob;
}): Promise<AddendumStateResult> {
  try {
    const { content, version } = await serverTRPC.addendum.rollback.mutate(input);
    revalidatePath("/curator");
    return { ok: true, addendum: { content, version } };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}
