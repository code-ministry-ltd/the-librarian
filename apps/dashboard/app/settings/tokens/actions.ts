"use server";

import { revalidatePath } from "next/cache";
import { serverTRPC } from "@/lib/trpc-server";

// A5: agent-token management server actions. The owner mints/revokes DB tokens
// from the dashboard; the plaintext token is returned to the client exactly once
// (on create) and never stored client-side beyond the one-time reveal.

export type CreateTokenResult =
  { ok: true; id: string; token: string } | { ok: false; error: string };
export type RevokeTokenResult = { ok: true } | { ok: false; error: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createTokenAction(input: {
  agentId: string;
  label?: string;
}): Promise<CreateTokenResult> {
  try {
    const { id, token } = await serverTRPC.tokens.create.mutate(input);
    revalidatePath("/settings/tokens");
    return { ok: true, id, token };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

export async function revokeTokenAction(id: string): Promise<RevokeTokenResult> {
  try {
    await serverTRPC.tokens.revoke.mutate({ id });
    revalidatePath("/settings/tokens");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}
