import type { Principal } from "../caller-identity.js";
import { SYSTEM_ACTOR_IDS } from "../caller-identity.js";
import {
  migrateLegacyCuratorLlm,
  readConsumerConfig,
  resolveConsumerToken,
} from "../curator-consumers.js";
import { isCuratorPausedForRestore } from "../curator-pause.js";
import { type LlmClient, createGroomingLlmClient } from "../grooming-llm-client.js";
import type { ChronicleRunTrigger } from "../store/chronicle-types.js";
import type { VaultCommit } from "../store/git/git-history.js";
import type { LibrarianStore, ShelfScopedStore } from "../store/librarian-store.js";
import { parseHandoffDocument } from "../store/markdown/handoff-doc.js";
import type { VaultTreeNode } from "../store/vault-files.js";
import type { Shelf } from "../vault-router.js";
import { validateShelfSet } from "../vault-router.js";
import { collectChronicleFacts } from "./collect.js";
import { readChronicleConfig, readLastChronicleRunAt, writeLastChronicleRunAt } from "./config.js";
import { narrateChronicle } from "./narrate.js";
import {
  currentChroniclePeriod,
  isChronicleScheduleDue,
  scheduledChroniclePeriod,
} from "./schedule.js";
import type { ChronicleFacts, ChronicleHandoffRead, ChroniclePeriod } from "./types.js";
import { writeChronicle } from "./write.js";

export type ChronicleTickSkipReason = "disabled" | "paused" | "no_writable_shelves";

export interface ChronicleTickSummary {
  ran: true;
  trigger: ChronicleRunTrigger;
  period: ChroniclePeriod;
  attempted: number;
  completed: number;
  failed: number;
  generated: number;
  digestOnly: number;
}

export type ChronicleTickResult =
  ChronicleTickSummary | { ran: false; reason: ChronicleTickSkipReason };

export interface ChronicleTickOptions {
  store: LibrarianStore;
  now?: Date;
  trigger?: ChronicleRunTrigger;
  /** Manual admin runs may override the default-off job gate. */
  allowDisabled?: boolean;
  buildClient?: (
    conn: { endpoint: string; model: string; timeoutMs: number },
    token: string,
  ) => LlmClient;
  /** Monotonic-enough millisecond clock for duration accounting; test-injectable. */
  clock?: () => number;
}

export async function runChronicleTick(
  options: ChronicleTickOptions,
): Promise<ChronicleTickResult> {
  const { store } = options;
  const now = options.now ?? new Date();
  const trigger = options.trigger ?? "schedule";
  const chronicleConfig = readChronicleConfig(store);
  if (isCuratorPausedForRestore(store, now)) return { ran: false, reason: "paused" };
  if (!options.allowDisabled && !chronicleConfig.enabled) {
    return { ran: false, reason: "disabled" };
  }

  const principal: Principal = {
    kind: "system",
    actorId: SYSTEM_ACTOR_IDS.scheduler,
    roles: ["system"],
  };
  const systemShelves = store.vaultRouter.shelves(principal, "groom");
  validateShelfSet(systemShelves);
  const shelves = systemShelves.filter((shelf) => shelf.writable);
  if (shelves.length === 0) return { ran: false, reason: "no_writable_shelves" };

  migrateLegacyCuratorLlm(store);
  const llmConfig = readConsumerConfig(store, "chronicle");
  const llmClient = buildNarratorClient(store, llmConfig, options.buildClient);
  const period =
    trigger === "manual"
      ? currentChroniclePeriod(now)
      : scheduledChroniclePeriod(now, chronicleConfig);
  const clock = options.clock ?? Date.now;
  const summary: ChronicleTickSummary = {
    ran: true,
    trigger,
    period,
    attempted: 0,
    completed: 0,
    failed: 0,
    generated: 0,
    digestOnly: 0,
  };

  for (const shelf of shelves) {
    summary.attempted++;
    const started = clock();
    const run = store.createChronicleRun({
      trigger,
      shelf_id: shelf.id,
      shelf_label: shelf.label ?? null,
      period_start: period.start,
      period_end: period.end,
      iso_week: period.isoWeek,
      partial: period.partial,
      model_provider: llmClient ? llmConfig.providerId : null,
      model_name: llmClient ? llmConfig.model : null,
    });
    store.startChronicleRun(run.id);
    let stage: "collection" | "write" = "collection";
    let narrated: Awaited<ReturnType<typeof narrateChronicle>> | null = null;
    try {
      const facts = collectForShelf(store, shelf, period);
      narrated = llmClient ? await narrateChronicle(facts, llmClient) : null;
      stage = "write";
      const written = writeChronicle(
        facts,
        narrated?.narrative ?? undefined,
        { upsert: (input) => store.systemWriteChronicle(shelf, input) },
        { generatedAt: now.toISOString() },
      );
      const narrative = narrated?.status ?? "skipped";
      store.completeChronicleRun(run.id, {
        narrative,
        path: written.path,
        duration_ms: elapsed(clock, started),
        usage_input_tokens: narrated?.usage?.promptTokens ?? 0,
        usage_output_tokens: narrated?.usage?.completionTokens ?? 0,
      });
      summary.completed++;
      if (narrative === "generated") summary.generated++;
      else summary.digestOnly++;
    } catch {
      store.failChronicleRun(run.id, {
        error: stage === "collection" ? "collection_failed" : "write_failed",
        duration_ms: elapsed(clock, started),
        narrative: narrated?.status ?? "skipped",
        usage_input_tokens: narrated?.usage?.promptTokens ?? 0,
        usage_output_tokens: narrated?.usage?.completionTokens ?? 0,
      });
      summary.failed++;
    }
  }

  return summary;
}

export type ScheduledChronicleResult = ChronicleTickResult | { ran: false; reason: "not_due" };

export interface ScheduledChronicleOptions {
  store: LibrarianStore;
  now?: Date;
  runPass?: (store: LibrarianStore, now: Date) => Promise<ChronicleTickResult>;
}

export async function runScheduledChronicle(
  options: ScheduledChronicleOptions,
): Promise<ScheduledChronicleResult> {
  const now = options.now ?? new Date();
  const config = readChronicleConfig(options.store);
  if (!config.enabled) return { ran: false, reason: "disabled" };
  if (
    !isChronicleScheduleDue(now, readLastChronicleRunAt(options.store), {
      dayOfWeek: config.dayOfWeek,
      scheduleTime: config.scheduleTime,
    })
  ) {
    return { ran: false, reason: "not_due" };
  }

  const runPass =
    options.runPass ??
    ((store: LibrarianStore, at: Date) =>
      runChronicleTick({ store, now: at, trigger: "schedule" }));
  const result = await runPass(options.store, now);
  if (result.ran && result.failed === 0) writeLastChronicleRunAt(options.store, now);
  return result;
}

function buildNarratorClient(
  store: LibrarianStore,
  config: ReturnType<typeof readConsumerConfig>,
  injected?: ChronicleTickOptions["buildClient"],
): LlmClient | null {
  if (!config.isOperational) return null;
  let token: string | null;
  try {
    token = resolveConsumerToken(store, "chronicle");
  } catch {
    return null;
  }
  if (!token) return null;
  const build =
    injected ??
    ((conn: { endpoint: string; model: string; timeoutMs: number }, secret: string) =>
      createGroomingLlmClient({ ...conn, token: secret }));
  try {
    return build(
      { endpoint: config.endpoint, model: config.model, timeoutMs: config.timeoutMs },
      token,
    );
  } catch {
    return null;
  }
}

function collectForShelf(
  store: LibrarianStore,
  shelf: Shelf,
  period: ChroniclePeriod,
): ChronicleFacts {
  const scoped = store.forShelf(shelf);
  const facts = collectChronicleFacts(period, {
    recentCommits: (input) => store.vaultActivity(input),
    projectCommit: (commit) => projectCommitToShelf(commit, shelf),
    listMemories: () => scoped.listAll(),
    readHandoffs: () => readHandoffs(scoped, shelf),
    listCurationRuns: (input) => store.listCurationRuns({ ...input, shelfId: shelf.id }),
    listCurationOperations: (runId) => store.getCurationOperations(runId),
    listIntakeRuns: (input) => store.listIntakeRuns({ ...input, shelfId: shelf.id }),
    listIntakeOperations: (runId) => store.getIntakeOperations(runId),
  });
  if (!facts.runs.intakeTokenUsageAvailable) {
    facts.warnings.push("Intake token usage is unavailable in the current run-log schema.");
  }
  return facts;
}

function projectCommitToShelf(commit: VaultCommit, shelf: Shelf): VaultCommit | null {
  if (shelf.prefix === "") return commit;
  const within = (file: string) => file.startsWith(shelf.prefix);
  const touches =
    commit.files.some(within) ||
    commit.renames.some((rename) => within(rename.from) || within(rename.to));
  if (!touches) return null;

  const crossesBoundary =
    commit.files.some((file) => !within(file)) ||
    commit.renames.some((rename) => !within(rename.from) || !within(rename.to));
  return {
    ...commit,
    subject: crossesBoundary ? "cross-shelf change" : commit.subject,
    files: commit.files.filter(within),
    renames: commit.renames.filter((rename) => within(rename.from) && within(rename.to)),
  };
}

function readHandoffs(store: ShelfScopedStore, shelf: Shelf): ChronicleHandoffRead[] {
  const prefix = `${shelf.prefix}handoffs/`;
  return files(store.vaultFiles.tree())
    .filter((file) => file.path.startsWith(prefix) && file.path.endsWith(".md"))
    .map((file) => {
      try {
        return {
          path: file.path,
          handoff: parseHandoffDocument(store.vaultFiles.readFile(file.path).raw),
        };
      } catch {
        return { path: file.path, error: "invalid_document" };
      }
    });
}

function files(nodes: VaultTreeNode[]): VaultTreeNode[] {
  return nodes.flatMap((node) => (node.type === "file" ? [node] : files(node.children ?? [])));
}

function elapsed(clock: () => number, started: number): number {
  return Math.max(0, Math.round(clock() - started));
}
