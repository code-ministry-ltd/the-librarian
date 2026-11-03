"use server";

import { revalidatePath } from "next/cache";
import { serverTRPC } from "@/lib/trpc-server";

// Server actions for Settings → Primer (spec 083). The primer is the shipped default (fixed)
// followed by the operator's addendum (vault/primer.md). Saving "" clears the addendum, leaving
// the default alone; over 2 KB is refused server-side and the teaching message comes back as the
// error. Mirrors the curator config-action shape (server action → tRPC → revalidatePath).

export type SavePrimerResult = { ok: true } | { ok: false; error: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function savePrimerAddendumAction(addendum: string): Promise<SavePrimerResult> {
  try {
    await serverTRPC.awareness.setAddendum.mutate({ addendum });
    revalidatePath("/settings/primer");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export async function dismissPrimerReviewAction(): Promise<SavePrimerResult> {
  try {
    await serverTRPC.awareness.dismissReview.mutate();
    revalidatePath("/settings/primer");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}
