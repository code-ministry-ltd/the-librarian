"use server";

// Server actions for the Journal page (spec 077 PR D) — the dashboard's write path
// wraps the identity-bearing server tRPC client, like app/handoffs/actions.ts.
// Deletes are permanent from the app; each is a vault git commit, so history keeps
// a copy until the vault's history is rewritten.

import { revalidatePath } from "next/cache";
import { serverTRPC } from "@/lib/trpc-server";

export type JournalDeleteResult = { ok: true } | { ok: false; error: string };

export type JournalDeleteTarget =
  { kind: "episode"; date: string; key: string } | { kind: "period"; path: string };

export async function deleteJournalAction(
  target: JournalDeleteTarget,
): Promise<JournalDeleteResult> {
  try {
    if (target.kind === "episode") {
      await serverTRPC.journal.deleteEpisode.mutate({ date: target.date, key: target.key });
    } else {
      await serverTRPC.journal.deletePeriod.mutate({ path: target.path });
    }
    revalidatePath("/journal");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
