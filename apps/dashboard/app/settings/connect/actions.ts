"use server";

import { revalidatePath } from "next/cache";
import { serverTRPC } from "@/lib/trpc-server";

// "Connect a device" server actions (reference-ingest spec criterion 14/21,
// D2/D21). The owner mints a least-privilege CAPTURE-scoped token for the
// browser extension / mobile share, and revokes capture tokens here. The
// plaintext token is returned to the client exactly ONCE (on create) and never
// stored client-side beyond the one-time reveal — same contract as agent tokens.

export type CreateCaptureTokenResult =
  { ok: true; id: string; token: string } | { ok: false; error: string };
export type RevokeCaptureTokenResult = { ok: true } | { ok: false; error: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createCaptureTokenAction(input: {
  label?: string;
}): Promise<CreateCaptureTokenResult> {
  try {
    const trimmed = input.label?.trim();
    const { id, token } = await serverTRPC.tokens.create.mutate({
      // A device name doubles as the agent id so the capture surface is
      // identifiable in the token list; default to a generic "capture" handle.
      agentId: trimmed || "capture-device",
      scope: "capture",
      ...(trimmed ? { label: trimmed } : {}),
    });
    revalidatePath("/settings/connect");
    return { ok: true, id, token };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export async function revokeCaptureTokenAction(id: string): Promise<RevokeCaptureTokenResult> {
  try {
    await serverTRPC.tokens.revoke.mutate({ id });
    revalidatePath("/settings/connect");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}
