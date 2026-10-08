import "server-only";
import { serverTRPC } from "@/lib/trpc-server";

/**
 * The shared D13 auto-apply threshold, for the review-queue pages' notice.
 * Fail-soft: a failed read returns null and the page simply shows no notice.
 */
export async function readApplyThreshold(): Promise<number | null> {
  try {
    return (await serverTRPC.intake.config.query()).applyConfidenceThreshold;
  } catch {
    return null;
  }
}
