import {
  type LibrarianStore,
  type MemoryCorrectionWorkItem,
  type Principal,
  SYSTEM_ACTOR_IDS,
  createGroomingLlmClient,
  createSerialScheduler,
  defaultVaultRouter,
  processMemoryCorrectionWork,
  readApplyConfidenceThreshold,
  readConsumerConfig,
  readGroomingConfig,
  resolveConsumerToken,
  validateShelfSet,
} from "@librarian/core";
import type { SerialScheduler, Shelf } from "@librarian/core";
import type { MemoryCorrectionWakeRequest } from "./mcp/tool.js";
import { logger } from "./logging.js";

const CORRECTION_POLL_MS = 60_000;
const MAX_WORK_ITEMS_PER_TICK = 10;
const MAX_CACHED_PRINCIPALS = 512;

const SYSTEM_PRINCIPAL: Principal = {
  kind: "system",
  actorId: SYSTEM_ACTOR_IDS.memoryCurator,
  roles: ["system"],
};
const ADMIN_REVIEWER: Principal = {
  kind: "admin",
  actorId: SYSTEM_ACTOR_IDS.dashboardAdmin,
  roles: ["admin"],
};
// This principal is used only with defaultVaultRouter, which is documented as
// independent of principal identity and role. Never use it to infer authority
// from a custom router.
const DEFAULT_ROUTER_CHECK: Principal = {
  kind: "system",
  actorId: "system-correction-router-check",
  roles: ["system"],
};

export interface MemoryCorrectionRuntime {
  scheduler: SerialScheduler;
  /** Call only after flag + marker persistence succeeds. Never blocks the MCP response. */
  wake: (request: MemoryCorrectionWakeRequest) => void;
  /** Stop future work and wait for the currently running batch before closing the store. */
  drain: () => Promise<void>;
}

/** Shared targeted worker lifecycle used by HTTP and stdio runtimes. */
export function createMemoryCorrectionRuntime(
  store: LibrarianStore,
  pollMs = CORRECTION_POLL_MS,
): MemoryCorrectionRuntime {
  let stopping = false;
  let activeRun: Promise<void> | null = null;
  const principals = new Map<string, Principal>();

  const scheduler = createSerialScheduler({
    task: async () => {
      if (stopping) return;
      const run = processDueBatch();
      activeRun = run;
      try {
        await run;
      } finally {
        if (activeRun === run) activeRun = null;
      }
    },
    intervalMs: pollMs,
    onError: () => logger.error("targeted memory correction worker tick failed"),
  });

  return {
    scheduler,
    wake(request) {
      if (stopping) return;
      const key = workKey(request.memory_id, request.snapshot_digest);
      principals.delete(key);
      principals.set(key, request.principal);
      while (principals.size > MAX_CACHED_PRINCIPALS) {
        const oldest = principals.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        principals.delete(oldest);
      }
      // SerialScheduler routes task errors to the value-free onError callback. A
      // racing wake during an active pass is picked up by the next poll/recovery.
      void scheduler.runNow();
    },
    async drain() {
      stopping = true;
      scheduler.stop();
      const run = activeRun;
      if (run) await run;
      principals.clear();
    },
  };

  async function processDueBatch(): Promise<void> {
    const defaultRouter = store.vaultRouter === defaultVaultRouter;
    // Only the OSS default router promises identity-independent shelf decisions. A
    // custom router is scoped from each flagger's cached authenticated principal, but
    // without a dedicated admin resolver it is never allowed to approve a model pass.
    const systemShelves = defaultRouter ? shelvesFor(store, SYSTEM_PRINCIPAL, "groom") : null;
    const adminShelves = defaultRouter ? shelvesFor(store, ADMIN_REVIEWER, "recall") : null;
    const cachedWriteShelves = defaultRouter
      ? []
      : [...principals.values()].flatMap(
          (principal) => shelvesFor(store, principal, "write") ?? [],
        );
    const shelves = uniqueShelves([
      ...(systemShelves ?? []),
      ...(adminShelves ?? []),
      ...cachedWriteShelves,
    ]);
    if (shelves.length === 0) return;

    const config = readConsumerConfig(store, "grooming");
    let llmClient: ReturnType<typeof createGroomingLlmClient> | undefined;
    let preconditionFailure: string | undefined = defaultRouter
      ? undefined
      : "custom_router_unverified";
    if (defaultRouter && !readGroomingConfig(store).enabled) {
      preconditionFailure = "grooming_disabled";
    } else if (defaultRouter && !config.enabled) {
      preconditionFailure = "grooming_disabled";
    } else if (defaultRouter && !config.isOperational) {
      preconditionFailure = "provider_unavailable";
    } else if (defaultRouter) {
      try {
        const token = resolveConsumerToken(store, "grooming");
        if (!token) {
          preconditionFailure = "token_unavailable";
        } else {
          llmClient = createGroomingLlmClient({
            endpoint: config.endpoint,
            token,
            model: config.model,
            timeoutMs: config.timeoutMs,
          });
        }
      } catch {
        preconditionFailure = "token_unavailable";
      }
    }

    const confidenceThreshold = readApplyConfidenceThreshold(store);
    const systemSetAvailable = systemShelves !== null;
    let processed = 0;
    for (const shelf of shelves) {
      if (stopping || processed >= MAX_WORK_ITEMS_PER_TICK) return;
      let shelfStore;
      let due: MemoryCorrectionWorkItem[];
      try {
        // This is a raw, exact-shelf system store. The current flagger's write
        // permission is independently revalidated below before any correction.
        shelfStore = store.groomingStoreForShelf(shelf);
        due = shelfStore.listDueMemoryCorrections();
      } catch {
        continue;
      }
      const adminCanReview = defaultRouter && hasExactShelf(adminShelves, shelf, "recall");
      const systemCanWork =
        defaultRouter && systemSetAvailable && hasExactShelf(systemShelves, shelf, "groom");
      for (const item of due) {
        if (stopping || processed >= MAX_WORK_ITEMS_PER_TICK) return;
        processed += 1;
        if (item.work.status === "proposal_pending") {
          if (!adminCanReview) continue;
          try {
            shelfStore.reconcileMemoryCorrectionProposalResolution({
              source_memory_id: item.memory_id,
              ...(item.work.proposal_id !== undefined
                ? { proposal_id: item.work.proposal_id }
                : {}),
              snapshot_digest: item.work.snapshot_digest,
              shelf_id: shelf.id,
              agent_id: SYSTEM_ACTOR_IDS.memoryCurator,
            });
          } catch {
            logger.error("targeted memory correction proposal resolution recovery failed");
          }
          continue;
        }
        const flagger = resolveFlaggerPrincipal(store, item, principals);
        const authorizedToWrite = flagger
          ? hasExactShelf(shelvesFor(store, flagger, "write"), shelf, "write")
          : false;
        let failure = preconditionFailure;
        if (!defaultRouter) failure = "custom_router_unverified";
        else if (!systemCanWork) failure = "no_worker_scope";
        try {
          const result = await processMemoryCorrectionWork({
            store: shelfStore,
            item,
            shelfId: shelf.id,
            principalId: item.work.principal_id,
            authorizedToWrite,
            adminCanReview,
            ...(failure ? { preconditionFailure: failure } : {}),
            ...(llmClient && !failure ? { llmClient } : {}),
            confidenceThreshold,
            leaseMs: config.timeoutMs + 60_000,
          });
          if (result.status !== "retry_scheduled" && result.status !== "claim_lost") {
            principals.delete(workKey(item.memory_id, item.work.snapshot_digest));
          }
        } catch {
          // The marker's lease makes a thrown store/provider failure recoverable.
          // Do not emit error messages that could include memory or provider data.
          logger.error(
            "targeted memory correction item failed; it will be recovered by lease expiry",
          );
        }
      }
    }
  }
}

function resolveFlaggerPrincipal(
  store: LibrarianStore,
  item: MemoryCorrectionWorkItem,
  principals: ReadonlyMap<string, Principal>,
): Principal | null {
  const cached = principals.get(workKey(item.memory_id, item.work.snapshot_digest));
  if (cached && cached.actorId === item.work.principal_id) return cached;
  // The OSS router is principal-independent. For custom routers, actor id alone
  // cannot reconstruct roles, token scope, or attributes: no resolver means deny.
  return store.vaultRouter === defaultVaultRouter ? DEFAULT_ROUTER_CHECK : null;
}

function shelvesFor(
  store: LibrarianStore,
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

function hasExactShelf(
  shelves: readonly Shelf[] | null,
  target: Shelf,
  op: "write" | "groom" | "recall",
): boolean {
  if (!shelves) return false;
  return shelves.some(
    (shelf) =>
      shelf.id === target.id &&
      shelf.prefix === target.prefix &&
      (op !== "write" || shelf.writable),
  );
}

function uniqueShelves(shelves: readonly Shelf[]): Shelf[] {
  const found = new Map<string, Shelf>();
  for (const shelf of shelves) found.set(`${shelf.id}\0${shelf.prefix}`, shelf);
  return [...found.values()];
}

function workKey(memoryId: string, snapshotDigest: string): string {
  return `${memoryId}\0${snapshotDigest}`;
}
