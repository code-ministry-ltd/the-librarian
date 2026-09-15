"use server";

// Server actions for the Handoffs page — the dashboard's write path follows
// the established pattern (a server action wraps the identity-bearing server
// tRPC client; see app/(memories)/actions.ts).

import { revalidatePath } from "next/cache";
import { serverTRPC } from "@/lib/trpc-server";

export type DeleteHandoffResult = { ok: true } | { ok: false; error: string };

/**
 * Permanently delete a handoff (the dashboard's delete buttons). Hard delete
 * at the vault — the deletion is a git commit, so it is recoverable from
 * history but not from the app. Revalidates the list and the detail route on
 * success.
 */
export async function deleteHandoffAction(handoffId: string): Promise<DeleteHandoffResult> {
  if (!handoffId) return { ok: false, error: "No handoff selected." };
  try {
    await serverTRPC.handoffs.purge.mutate({ handoff_id: handoffId });
    revalidatePath("/handoffs");
    revalidatePath(`/handoffs/${handoffId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
