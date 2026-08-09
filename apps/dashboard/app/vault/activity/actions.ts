"use server";

// Server actions for /activity (rethink T21, spec §8 / D16):
//  - restoreVaultAction: thin wrapper over the admin activity router for the
//    guarded whole-vault restore. The typed confirmation phrase is forwarded
//    VERBATIM — the server validates it, runs the guarded sequence (curator
//    pause → pre-restore tag → one revert commit → index invalidation →
//    resume), and the teaching errors come back as-is.
//  - commitDiffAction: lazy-loads the per-file diffs for a single commit
//    when the operator expands an accordion row.

import { revalidatePath } from "next/cache";
import { serverTRPC } from "@/lib/trpc-server";

export type RestoreVaultResult =
  | { ok: true; restoredTo: string; preRestoreTag: string; commit: string | null }
  | { ok: false; error: string };

export async function restoreVaultAction(input: {
  hash: string;
  confirm: string;
}): Promise<RestoreVaultResult> {
  try {
    const result = await serverTRPC.activity.restoreVault.mutate(input);
    revalidatePath("/");
    revalidatePath("/activity");
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface CommitDiffFileShape {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  fromPath?: string;
  diff: string;
}

export type CommitDiffResult =
  { ok: true; hash: string; files: CommitDiffFileShape[] } | { ok: false; error: string };

export async function commitDiffAction(input: { hash: string }): Promise<CommitDiffResult> {
  try {
    const result = await serverTRPC.activity.commitDiff.query(input);
    return { ok: true, hash: result.hash, files: result.files };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
