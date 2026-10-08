// Shown on the review queues (Proposals, Flagged) when the shared auto-apply
// threshold is 0. At 0 every curator change applies itself (ADR 0014), so the
// queue stays empty of new curator work; without this an operator could wait on
// a page that will never fill.

import Link from "next/link";

const MESSAGES = {
  proposals:
    "The auto-apply threshold is 0, so the curator applies every change itself. No new proposals will appear here unless you raise the threshold.",
  flagged:
    "The auto-apply threshold is 0, so the curator applies every correction and archive itself. It will not send anything here for review unless you raise the threshold. Agent flags it leaves unchanged still appear.",
} as const;

export function ThresholdZeroNotice({
  threshold,
  page,
}: {
  /** The shared D13 threshold, or null when it could not be read. */
  threshold: number | null;
  page: keyof typeof MESSAGES;
}) {
  if (threshold === null || threshold > 0) return null;
  return (
    <p
      role="note"
      className="border border-ink-accent/40 bg-ink-accent/[0.06] p-3 text-sm text-foreground"
    >
      {MESSAGES[page]}{" "}
      <Link href="/settings/curator" className="text-ink-accent underline-offset-2 hover:underline">
        Change the threshold →
      </Link>
    </p>
  );
}
