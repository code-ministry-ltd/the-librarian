// tRPC app router.
//
// Composes the per-feature routers (memories, handoffs) plus health and
// admin surfaces. The `AppRouter` type is the public contract the
// dashboard imports.
//
// sessions-rethink PR 7 — the `sessions` router is retired with the
// rest of the session subsystem. D16 — the `domains` router is retired
// with the rest of the domain model. The event ledger is gone; the
// vault's git history is the audit trail, surfaced by the `activity`
// router (rethink T21): the commit feed + the guarded whole-vault restore.

import { activityRouter } from "./activity.js";
import { addendumRouter } from "./addendum.js";
import { authRouter } from "./auth.js";
import { autoupdateRouter } from "./autoupdate.js";
import { awarenessRouter } from "./awareness.js";
import { backupRouter } from "./backup.js";
import { importRouter } from "./import.js";
import { journalRouter } from "./journal.js";
import { examplesRouter } from "./examples.js";
import { groomingRouter } from "./grooming.js";
import { handoffsRouter } from "./handoffs.js";
import { healthRouter } from "./health.js";
import { ingestRouter } from "./ingest.js";
import { intakeRouter } from "./intake.js";
import { llmRouter } from "./llm.js";
import { logsRouter } from "./logs.js";
import { memoriesRouter } from "./memories.js";
import { tokensRouter } from "./tokens.js";
import { router } from "./trpc.js";
import { vaultRouter } from "./vault.js";

/**
 * The core feature routers, keyed by their top-level namespace. Broken out as a
 * named record (rather than inlined into the `router(...)` call) so the plugin
 * layer can compose it: `buildAppRouter` (plugin.ts, spec 060 T4) merges plugin
 * namespaces alongside these to build the runtime tRPC router, and its keys ARE
 * the reserved namespaces a plugin name may not shadow (`assertNoCoreNamespace-
 * Collision`). `appRouter` — and thus the dashboard's `AppRouter` contract — is
 * exactly `router(coreRouterRecord)`, unchanged by that composition.
 */
export const coreRouterRecord = {
  activity: activityRouter,
  addendum: addendumRouter,
  auth: authRouter,
  autoupdate: autoupdateRouter,
  awareness: awarenessRouter,
  backup: backupRouter,
  journal: journalRouter,
  import: importRouter,
  examples: examplesRouter,
  grooming: groomingRouter,
  handoffs: handoffsRouter,
  health: healthRouter,
  ingest: ingestRouter,
  intake: intakeRouter,
  llm: llmRouter,
  logs: logsRouter,
  memories: memoriesRouter,
  tokens: tokensRouter,
  vault: vaultRouter,
};

export const appRouter = router(coreRouterRecord);

export type AppRouter = typeof appRouter;
