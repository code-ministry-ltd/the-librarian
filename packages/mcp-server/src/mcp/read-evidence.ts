// Read-log helpers (spec 080). Call sites build a row only when the read log is active, and a
// failure here must never change the read being observed — so every entry point swallows.

import type { LibrarianStore, Principal, RecordReadInput } from "@librarian/core";

type Evidence = Pick<RecordReadInput, "actorId" | "tokenId" | "shelfIds">;

/** The caller fields every read row carries: who read, with which token, over which shelves. */
export function readEvidence(store: LibrarianStore, principal: Principal | undefined): Evidence {
  if (principal === undefined) return {};
  let shelfIds: string[] | undefined;
  try {
    shelfIds = store.shelvesForPrincipal(principal).map((shelf) => shelf.id);
  } catch {
    shelfIds = undefined;
  }
  return {
    actorId: principal.actorId,
    ...(principal.tokenId === undefined ? {} : { tokenId: principal.tokenId }),
    ...(shelfIds === undefined ? {} : { shelfIds }),
  };
}

/** Append one read row if the log is active. Never throws, never awaits on the caller's path. */
export function logRead(store: LibrarianStore, build: () => RecordReadInput): void {
  if (!store.readLogActive) return;
  try {
    void store.recordRead(build());
  } catch {
    // Fail-soft (AGENTS.md): the read already happened; evidence is best-effort.
  }
}

/** Milliseconds since `startMs`, as a non-negative whole number. */
export function elapsedMs(startMs: number): number {
  return Math.max(0, Math.round(performance.now() - startMs));
}
