// The targeted flag groom's timer (ADR 0013).
//
// A flag asks the curator to look at a memory again. Agents often flag in bursts
// (several stale memories in one session, or a second flag with more detail), so
// the groom waits until flags have been quiet for 10 minutes, and never more than
// 30 minutes after the first one, then runs once for the lot. On a serial local
// model that is the difference between one request and a queue of them.
//
// State is in memory only: on boot the server re-arms when any unreviewed flag is
// waiting, so a restart loses nothing. `tick` is polled by a serial scheduler and
// never runs two grooms at once; grooming's own slice lock keeps a flag groom and
// a scheduled groom from overlapping.

/** Flags must be quiet this long before the targeted groom runs. */
export const FLAG_GROOM_DEBOUNCE_MS = 10 * 60_000;
/** ...but it never waits longer than this after the first pending flag. */
export const FLAG_GROOM_MAX_WAIT_MS = 30 * 60_000;

export interface FlagGroomTriggerOptions {
  /** Run one targeted groom. `ran:false` means it could not run (e.g. grooming is off). */
  runFlagGroom: () => Promise<{ ran: boolean }>;
  /** True while a flag is still waiting for the curator. */
  hasPending: () => boolean;
  now?: () => number;
  debounceMs?: number;
  maxWaitMs?: number;
  onError?: (error: unknown) => void;
}

export interface FlagGroomTrigger {
  /** A flag was just recorded. */
  noteFlag: () => void;
  /** Run the targeted groom when it is due. Safe to call often. */
  tick: () => Promise<void>;
  /** For tests and diagnostics. */
  isArmed: () => boolean;
}

export function createFlagGroomTrigger(options: FlagGroomTriggerOptions): FlagGroomTrigger {
  const now = options.now ?? Date.now;
  const debounceMs = options.debounceMs ?? FLAG_GROOM_DEBOUNCE_MS;
  const maxWaitMs = options.maxWaitMs ?? FLAG_GROOM_MAX_WAIT_MS;
  let firstAt: number | null = null;
  let lastAt: number | null = null;

  function noteFlag(): void {
    const at = now();
    firstAt ??= at;
    lastAt = at;
  }

  async function tick(): Promise<void> {
    if (firstAt === null || lastAt === null) return;
    const at = now();
    if (at - lastAt < debounceMs && at - firstAt < maxWaitMs) return;
    firstAt = null;
    lastAt = null;
    let ran = false;
    try {
      ran = (await options.runFlagGroom()).ran;
    } catch (error) {
      options.onError?.(error);
    }
    // One run takes a handful of flagged memories. If more are waiting, go again
    // after another quiet period. A run that could not happen (grooming off, no
    // model) is not retried here: the next flag, a restart, or the next scheduled
    // groom picks the flags up.
    if (!ran) return;
    let pending = false;
    try {
      pending = options.hasPending();
    } catch (error) {
      options.onError?.(error);
    }
    if (pending) noteFlag();
  }

  return { noteFlag, tick, isArmed: () => firstAt !== null };
}
