"use server";

import { revalidatePath } from "next/cache";
import { serverTRPC } from "@/lib/trpc-server";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type BackupNowResult =
  { ok: true; commit: string | null; repo: string } | { ok: false; error: string };

export async function backupNowAction(): Promise<BackupNowResult> {
  try {
    const r = await serverTRPC.backup.createNow.mutate();
    revalidatePath("/settings/backups");
    return { ok: true, commit: r.commit, repo: r.repo };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// The setConfig input shape (mirrors the backup tRPC SetConfigSchema). The token is
// write-only: an empty/absent field leaves the stored value unchanged.
export interface SaveBackupConfigInput {
  enabled?: boolean;
  intervalMinutes?: number;
  webhookUrl?: string;
  github?: { repo?: string; token?: string };
}

export type SaveConfigResult = { ok: true } | { ok: false; error: string };

export async function saveBackupConfigAction(
  input: SaveBackupConfigInput,
): Promise<SaveConfigResult> {
  try {
    await serverTRPC.backup.setConfig.mutate(input);
    revalidatePath("/settings/backups");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export type StageRestoreResult = { ok: true; staged: string } | { ok: false; error: string };

// Clone the backup remote into a staging dir + write the pending-restore marker.
// The swap happens on the next boot (never under the live store).
export async function stageRestoreAction(): Promise<StageRestoreResult> {
  try {
    const r = await serverTRPC.backup.stageRestore.mutate();
    revalidatePath("/settings/backups");
    return { ok: true, staged: r.staged };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export type RestartResult = { ok: true } | { ok: false; error: string };

export async function restartAction(): Promise<RestartResult> {
  try {
    await serverTRPC.backup.restart.mutate();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}
