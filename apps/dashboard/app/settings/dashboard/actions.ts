"use server";

import { revalidatePath } from "next/cache";
import { serverTRPC } from "@/lib/trpc-server";

// Server actions for Settings → Dashboard. The read-log switch (spec 081) takes effect on the
// running server at once; no restart.

export type SaveReadLogResult = { ok: true } | { ok: false; error: string };

export async function setReadLogAction(enabled: boolean): Promise<SaveReadLogResult> {
  try {
    await serverTRPC.logs.setReadLog.mutate({ enabled });
    revalidatePath("/settings/dashboard");
    revalidatePath("/logs");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The remote-notices fetch switch (spec 084). */
export async function setNoticesFetchAction(enabled: boolean): Promise<SaveReadLogResult> {
  try {
    await serverTRPC.notices.setFetch.mutate({ enabled });
    revalidatePath("/settings/dashboard");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
