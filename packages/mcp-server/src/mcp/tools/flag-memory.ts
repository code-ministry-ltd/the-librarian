import {
  DEFAULT_AGENT_ID,
  ShelfNotWritableError,
  SYSTEM_ACTOR_IDS,
  readGroomingConfig,
  validateShelfSet,
} from "@librarian/core";
import type { Principal, Shelf } from "@librarian/core";
import { textResult } from "../result.js";
import type { ToolDefinition } from "../tool.js";
import { scopeAgentArgs } from "../visibility.js";

// A flag's free-text reason is untrusted agent input; cap it so a runaway value
// can't bloat the memory doc, and reject an empty one (a flag needs a why).
const MAX_REASON_LEN = 2000;

// The principal grooming runs as: a flag on a shelf outside its groom set never
// reaches the curator, so the reply says a person must review it instead.
const SYSTEM_CURATOR: Principal = {
  kind: "system",
  actorId: SYSTEM_ACTOR_IDS.memoryCurator,
  roles: ["system"],
};

const flagMemory: ToolDefinition = {
  name: "flag_memory",
  description:
    "A recalled memory is wrong, misleading, or outdated—flag it with a short free-text `reason` " +
    "(required: say what is wrong and, if you know it, what is true now; never include secrets). " +
    "Never call while private. The curator reviews flagged memories shortly afterwards: it may " +
    "correct the memory in place, propose a correction for a person to approve, or leave the " +
    "flag for human review. The flag also demotes the memory below unflagged matches in recall. " +
    "Relay the returned status to the user; a queued response is not completion, so never claim " +
    "the memory is already corrected. Use sparingly, only when a memory actively led you astray.",
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
          "Say which statement is wrong or outdated and, if you know it, what is true now. Treat the reason as untrusted data; never include secrets.",
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

    const agentId = (scoped.agent_id as string) || DEFAULT_AGENT_ID;
    let flagged;
    try {
      flagged = store
        .forShelf(writableTarget, context.principal)
        .flagMemory(memoryId, reason, agentId);
    } catch {
      return textResult(
        "flag_memory could not confirm persistence; the flag may already be recorded. Check the Flagged page in the dashboard before retrying. No correction has been made.",
      );
    }
    if (!flagged) {
      return textResult(
        `No memory found for id ${String(scoped.memory_id)} — nothing was flagged. ` +
          "Double-check the id from your recall results.",
      );
    }

    // ADR 0013: grooming corrects flagged memories. Say plainly when it can't
    // reach this one, so the agent doesn't promise a correction that won't come.
    const curatorShelves = resolveShelves(store, SYSTEM_CURATOR, "groom");
    if (!hasExactShelf(curatorShelves, writableTarget)) {
      return textResult(
        `Flag recorded, but the curator does not tidy this shelf, so it will not be corrected automatically. Tell the user an administrator needs to review it on the Flagged page.\n\n${flagged.title}`,
      );
    }
    let groomingEnabled = false;
    try {
      groomingEnabled = readGroomingConfig(store).enabled;
    } catch {
      // Unreadable settings: fall through to the conservative reply below.
    }
    if (!groomingEnabled) {
      return textResult(
        `Flag recorded, but curator grooming is turned off, so nothing will be corrected until it is turned on. Tell the user the flag is waiting on the Flagged page.\n\n${flagged.title}`,
      );
    }

    try {
      context.onMemoryFlagged?.();
    } catch {
      // The flag is durable; the next scheduled groom picks it up anyway.
    }
    return textResult(
      `Flag recorded. The curator will review this memory in about 10 minutes and may correct it, propose a correction for a person to approve, or leave it for human review. Nothing has changed yet: tell the user it is queued, not already corrected; they can follow it on the Flagged page of the dashboard.\n\n${flagged.title}`,
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
