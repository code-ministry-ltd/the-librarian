// Flagged memories and grooming (ADR 0013).
//
// An agent's flag is a request for the curator to look at a memory again. The
// server arms a targeted groom when one arrives (`runGroomingTick({ focus:
// "flagged" })`); these helpers answer "is anything waiting?" and handle the
// one-time move away from the retired ADR 0012 correction worker.

import { type Principal, SYSTEM_ACTOR_IDS } from "./caller-identity.js";
import { MemoryStatus } from "./schemas/common.js";
import type { LibrarianStore } from "./store/librarian-store.js";
import type { Memory, MemoryStore } from "./store/memory-types.js";
import { validateShelfSet } from "./vault-router.js";

const SYSTEM_CURATOR: Principal = {
  kind: "system",
  actorId: SYSTEM_ACTOR_IDS.memoryCurator,
  roles: ["system"],
};

/** An agent flag the curator has not reviewed yet (its own archive flags excluded). */
export function hasUnreviewedAgentFlag(memory: Pick<Memory, "flags">): boolean {
  return (memory.flags ?? []).some(
    (flag) => flag.agent_id !== SYSTEM_ACTOR_IDS.memoryCurator && !flag.review,
  );
}

function groomShelves(store: LibrarianStore) {
  const shelves = store.vaultRouter.shelves(SYSTEM_CURATOR, "groom");
  validateShelfSet(shelves);
  return shelves;
}

/**
 * True when an active memory on a shelf the curator grooms carries an agent flag
 * it has not reviewed yet — i.e. a targeted flag groom has work to do.
 */
export function hasFlagsAwaitingCurator(store: LibrarianStore): boolean {
  return groomShelves(store).some((shelf) =>
    store
      .groomingStoreForShelf(shelf)
      .listAll({ status: MemoryStatus.Active })
      .some(hasUnreviewedAgentFlag),
  );
}

/**
 * The dashboard's "Ask the curator again": forget the curator's last review of a
 * memory's flags so the next targeted groom looks at it afresh. Returns false
 * for an unknown id or a memory with nothing to reset.
 */
export function askCuratorAgain(
  store: Pick<MemoryStore, "getMemory" | "setFlagReview">,
  id: string,
  agentId: string,
): boolean {
  const memory = store.getMemory(id);
  if (!memory || memory.status !== MemoryStatus.Active) return false;
  if (!(memory.flags ?? []).some((flag) => flag.agent_id !== SYSTEM_ACTOR_IDS.memoryCurator)) {
    return false;
  }
  store.setFlagReview(id, null, { agent_id: agentId });
  return true;
}

/** The resolution stamped on correction proposals left behind by ADR 0012. */
export const LEGACY_CORRECTION_RESOLUTION =
  "withdrawn: the flagged-correction worker was retired (ADR 0013); the flag goes back to the curator";

/**
 * One-time upgrade step (ADR 0013): withdraw the open proposals the retired
 * flagged-correction worker filed. Their source memories keep their flags, which
 * carry no review yet, so the next targeted groom picks them up. Idempotent:
 * once withdrawn they are no longer proposed. Fail-soft per proposal. Returns the
 * number withdrawn.
 */
export function withdrawLegacyCorrectionProposals(store: LibrarianStore): number {
  let withdrawn = 0;
  for (const shelf of groomShelves(store)) {
    const scoped = store.groomingStoreForShelf(shelf);
    for (const proposal of scoped.listAll({ status: MemoryStatus.Proposed })) {
      const note = proposal.curator_note;
      const legacy =
        note?.source === "flagged_correction" || Object.hasOwn(note ?? {}, "correction");
      if (!legacy) continue;
      try {
        scoped.resolveProposal(
          proposal.id,
          LEGACY_CORRECTION_RESOLUTION,
          SYSTEM_ACTOR_IDS.memoryCurator,
        );
        withdrawn++;
      } catch {
        // Leave it for an administrator; it no longer blocks anything.
      }
    }
  }
  return withdrawn;
}
