import {
  DEFAULT_AGENT_ID,
  ShelfNotWritableError,
  SYSTEM_ACTOR_IDS,
  type CorrectionManualReviewReasonCode,
  defaultVaultRouter,
  validateShelfSet,
} from "@librarian/core";
import type { Principal, Shelf } from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";

// A flag's free-text reason is untrusted agent input; cap it so a runaway value
// can't bloat the memory doc, and reject an empty one (a flag needs a why).
const MAX_REASON_LEN = 2000;

const SYSTEM_CORRECTION_PRINCIPAL: Principal = {
  kind: "system",
  actorId: SYSTEM_ACTOR_IDS.memoryCurator,
  roles: ["system"],
};
const ADMIN_REVIEWER: Principal = {
  kind: "admin",
  actorId: SYSTEM_ACTOR_IDS.dashboardAdmin,
  roles: ["admin"],
};

const flagMemory: ToolDefinition = {
  name: "flag_memory",
  description:
    "A recalled memory is wrong, misleading, or outdated—flag it with a short free-text `reason` " +
    "(required: say why; never include secrets). Never call while private. A saved flag queues " +
    "targeted asynchronous correction review: if the shared confidence policy permits, a safe " +
    "exact-claim removal may apply automatically; otherwise a reviewable proposal may be created. " +
    "Unsafe or unreviewable cases remain flagged for human review. The flag also demotes the " +
    "memory below unflagged matches in recall. Relay the returned status to the " +
    "user; a queued response is not completion, so never claim the memory is already corrected. " +
    "Whole-memory Archive remains a separate human action. Use sparingly, only when a memory " +
    "actively led you astray.",
  inputSchema: {
    type: "object",
    required: ["memory_id", "reason"],
    properties: {
      agent_id: {
        type: "string",
        description:
          "Server-populated from your authenticated token, not supplied by you — it records " +
          "which agent raised the flag.",
      },
      memory_id: {
        type: "string",
        description:
          "The id of the memory to flag — take it from a recall result fetched with include_ids: true.",
      },
      reason: {
        type: "string",
        minLength: 1,
        maxLength: MAX_REASON_LEN,
        description:
          "Briefly identify which claim is wrong or outdated. Treat the reason as untrusted data; never include secrets.",
      },
    },
  },
  handler(store, args, context) {
    const scoped = scopeAgentArgs(args, context);
    const reason = (typeof scoped.reason === "string" ? scoped.reason : "").trim();
    if (!reason) {
      return textResult(
        "flag_memory rejected: 'reason' is required — say why the memory is wrong (incorrect, misleading, outdated…).",
      );
    }
    if (reason.length > MAX_REASON_LEN) {
      return textResult(
        `flag_memory rejected: 'reason' is too long (${reason.length} chars; max ${MAX_REASON_LEN}).`,
      );
    }

    const memoryId = scoped.memory_id as string;
    const recallShelves = resolveShelves(store, context.principal, "recall");
    if (!recallShelves) {
      return textResult(
        "flag_memory could not verify access to the exact memory shelf; no flag was recorded. Ask an administrator to review the shelf configuration.",
      );
    }
    let target: Shelf | undefined;
    try {
      target = recallShelves.find((shelf) => store.forShelf(shelf).getMemory(memoryId) != null);
    } catch {
      return textResult("flag_memory could not read the exact memory shelf; no flag was recorded.");
    }
    if (!target) {
      return textResult(
        `No memory found for id ${String(scoped.memory_id)} — nothing was flagged. ` +
          "Double-check the id from your recall results.",
      );
    }

    // `forShelf` confines a write and checks `shelf.writable`, but does not prove
    // membership in the principal's write set. Resolve the exact same physical
    // shelf in that set before appending the flag or its durable work marker.
    const writeShelves = resolveShelves(store, context.principal, "write");
    const writableTarget = writeShelves?.find(
      (shelf) => shelf.id === target.id && shelf.prefix === target.prefix && shelf.writable,
    );
    if (!writableTarget) {
      if (!target.writable) throw new ShelfNotWritableError(target);
      throw new Error(
        "flag_memory could not be recorded because you are not authorized to write to this exact shelf. Ask an administrator to review shelf access.",
      );
    }

    const adminShelves = resolveShelves(store, ADMIN_REVIEWER, "recall");
    const systemShelves = resolveShelves(store, SYSTEM_CORRECTION_PRINCIPAL, "groom");
    let manualReason: CorrectionManualReviewReasonCode | undefined;
    if (store.vaultRouter !== defaultVaultRouter) {
      manualReason = "custom_router_unverified";
    } else if (!hasExactShelf(adminShelves, writableTarget)) {
      manualReason = "no_admin_scope";
    } else if (!hasExactShelf(systemShelves, writableTarget)) {
      manualReason = "no_worker_scope";
    }

    const agentId = (scoped.agent_id as string) || DEFAULT_AGENT_ID;
    let flagged;
    try {
      flagged = store.forShelf(writableTarget, context.principal).flagMemoryForCorrection({
        id: memoryId,
        reason,
        agent_id: agentId,
        principal_id: context.principal.actorId,
        shelf_id: writableTarget.id,
        ...(manualReason ? { manual_review_reason_code: manualReason } : {}),
      });
    } catch {
      return textResult(
        "flag_memory could not confirm persistence; the flag may already be recorded. Check the Flagged dashboard before retrying. If the write landed, correction work may still run; no correction is confirmed complete.",
      );
    }
    if (!flagged) {
      return textResult(
        `No memory found for id ${String(scoped.memory_id)} — nothing was flagged. ` +
          "Double-check the id from your recall results.",
      );
    }

    const work = flagged.correction_work?.at(-1);
    if (work?.status === "manual_review") {
      if (work.reason_code === "no_admin_scope") {
        return textResult(
          `Flag recorded, but automatic review was not queued because an administrator cannot review this exact shelf. Ask an administrator to configure shelf access and review this flag.\n\n${flagged.title}`,
        );
      }
      if (work.reason_code === "no_worker_scope") {
        return textResult(
          `Flag recorded, but automatic review was not queued because the correction worker cannot process this exact shelf. Ask an administrator to configure shelf access and review this flag.\n\n${flagged.title}`,
        );
      }
      if (work.reason_code === "custom_router_unverified") {
        return textResult(
          `Flag recorded, but automatic review was not queued because custom vault-router authority cannot be independently verified for automatic correction. Ask an administrator to review this flag.\n\n${flagged.title}`,
        );
      }
      return textResult(
        `Flag recorded for manual review; automatic correction is unavailable for this memory state.\n\n${flagged.title}`,
      );
    }

    try {
      if (work?.status === "pending") {
        context.wakeMemoryCorrection?.({
          memory_id: memoryId,
          snapshot_digest: work.snapshot_digest,
          principal: context.principal,
        });
      }
    } catch {
      // The marker is durable; startup recovery/polling will pick it up.
    }
    return textResult(
      `Flag recorded and targeted correction review was queued; no correction has completed yet. The curator may apply a safe exact correction or prepare a proposal. Tell the user it is queued, not already corrected, and see the flagged-memory review in the dashboard.\n\n${flagged.title}`,
    );
  },
};

function resolveShelves(
  store: Parameters<ToolDefinition["handler"]>[0],
  principal: Principal,
  op: "write" | "groom" | "recall",
): readonly Shelf[] | null {
  try {
    const shelves = store.vaultRouter.shelves(principal, op);
    validateShelfSet(shelves);
    return shelves;
  } catch {
    return null;
  }
}

function hasExactShelf(shelves: readonly Shelf[] | null, target: Shelf): boolean {
  return Boolean(
    shelves?.some((shelf) => shelf.id === target.id && shelf.prefix === target.prefix),
  );
}

export default flagMemory;
