"use server";

import { revalidatePath } from "next/cache";
import { serverTRPC } from "@/lib/trpc-server";

// Server actions for Settings → Telemetry (spec 085).

export type TelemetryActionResult = { ok: true } | { ok: false; error: string };

function failure(error: unknown): TelemetryActionResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

export async function setTelemetryAction(enabled: boolean): Promise<TelemetryActionResult> {
  try {
    await serverTRPC.telemetry.setEnabled.mutate({ enabled });
    revalidatePath("/settings/telemetry");
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

export async function resetInstallIdAction(): Promise<TelemetryActionResult> {
  try {
    await serverTRPC.telemetry.resetInstallId.mutate();
    revalidatePath("/settings/telemetry");
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}
