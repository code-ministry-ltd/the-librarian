// Per-capture-token rate limit (reference-ingest spec criterion 10 / D19).
//
// A leaked capture token is the threat (D19): without a bound it could bloat the
// vault repo and amplify server-side fetches. So each token gets a daily quota
// (~200/day) plus a short burst cap (~5 / 10 s) — over either limit, /ingest
// returns 429.
//
// DURABILITY CHOICE. The counter lives in the settings sidecar (the same store as
// the tokens and the ingest log), keyed by `tokenId` + UTC date. That store
// (`createJsonSettingsStore`) writes a plain JSON file OUTSIDE the git vault — a
// `setSetting` is a single file write, NOT a git commit — so persisting a counter
// there does not hammer git, and the limit survives a server restart (an in-memory
// limiter would reset on every redeploy, handing a leaked token a fresh quota).
// Keying on `tokenId` (not agentId) means revoking-then-reminting doesn't inherit
// the old count, and one token's burst can't throttle another.
//
// The bucket holds the day's count plus the timestamps of recent requests within
// the burst window; both reset implicitly when the UTC date rolls over. Each row
// is a fixed-size O(burstMax) record, so the sidecar can't grow unbounded per day.

const KEY_PREFIX = "ingest_rate:";

/** Default limits (D19: ~200/day, ~1/sec → a 5-request burst per 10 s). */
const DEFAULT_DAILY_LIMIT = 200;
const DEFAULT_BURST_MAX = 5;
const DEFAULT_BURST_WINDOW_MS = 10_000;

type SettingsLike = {
  setSetting: (key: string, value: string, options?: { secret?: boolean }) => void;
  getSetting: (key: string) => string | null;
  deleteSetting?: (key: string) => void;
  listSettings: () => { key: string }[];
};

interface RateBucket {
  /** UTC `YYYY-MM-DD` the count belongs to; a different date resets the count. */
  date: string;
  /** Captures accepted so far today (the daily-quota counter). */
  count: number;
  /** Epoch-ms of recent accepted requests, trimmed to the burst window. */
  recent: number[];
}

export interface RateLimitOptions {
  /** Max captures per UTC day (default 200). */
  dailyLimit?: number;
  /** Max captures within the burst window (default 5). */
  burstMax?: number;
  /** Burst window length in ms (default 10 000). */
  burstWindowMs?: number;
  /** Injectable clock for tests; defaults to `Date.now()`. */
  now?: number;
}

export type RateLimitResult =
  { allowed: true } | { allowed: false; reason: "burst" | "daily"; retryAfterSeconds: number };

function utcDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Delete every rate bucket that isn't for `today` (issue #423). Buckets are keyed
 * `ingest_rate:<tokenId>:<UTC-date>` and only today's is ever read, so prior days
 * (incl. revoked tokens') are pure dead weight in the shared settings sidecar.
 * Run on the accept path; it's self-limiting — once swept, only today's keys
 * remain, so subsequent sweeps are cheap. No-op if the store can't delete.
 */
function gcStaleBuckets(store: SettingsLike, today: string): void {
  if (!store.deleteSetting) return;
  const suffix = `:${today}`;
  for (const { key } of store.listSettings()) {
    if (key.startsWith(KEY_PREFIX) && !key.endsWith(suffix)) {
      store.deleteSetting(key);
    }
  }
}

function readBucket(store: SettingsLike, key: string, today: string): RateBucket {
  let raw: string | null = null;
  try {
    raw = store.getSetting(key);
  } catch {
    // Fail-OPEN on a read throw (review finding #2): a settings-store hiccup must
    // not propagate out of /ingest as a 500 — the limiter is a leaked-token bound,
    // not a hard gate, so a fresh bucket (allow this capture) is the safe default.
    return { date: today, count: 0, recent: [] };
  }
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as RateBucket;
      // A bucket from a previous UTC day is treated as fresh (count + burst reset).
      if (parsed && parsed.date === today && Array.isArray(parsed.recent)) {
        return { date: today, count: Number(parsed.count) || 0, recent: parsed.recent };
      }
    } catch {
      // A malformed row is treated as absent rather than throwing on the hot path.
    }
  }
  return { date: today, count: 0, recent: [] };
}

/**
 * Check (and, when allowed, record) one capture for `tokenId`. Returns `allowed`
 * with no side effect on a reject, or records the request and returns allowed.
 * Never throws — a settings read/parse failure fails OPEN to a fresh bucket so a
 * storage hiccup can't block a legitimate capture (fail-soft, like the rest of
 * /ingest); the durable counter is the leaked-token bound, not a hard gate.
 */
export function checkIngestRateLimit(
  store: SettingsLike,
  tokenId: string,
  opts: RateLimitOptions = {},
): RateLimitResult {
  const now = opts.now ?? Date.now();
  const dailyLimit = opts.dailyLimit ?? DEFAULT_DAILY_LIMIT;
  const burstMax = opts.burstMax ?? DEFAULT_BURST_MAX;
  const burstWindowMs = opts.burstWindowMs ?? DEFAULT_BURST_WINDOW_MS;
  const today = utcDate(now);
  const key = KEY_PREFIX + tokenId + ":" + today;

  const bucket = readBucket(store, key, today);
  const recent = bucket.recent.filter((t) => now - t < burstWindowMs);

  // Burst first: the tighter, faster-recovering limit. Retry-after is the time
  // until the oldest in-window request ages out.
  if (recent.length >= burstMax) {
    const oldest = recent[0] ?? now;
    const retryAfterSeconds = Math.max(1, Math.ceil((burstWindowMs - (now - oldest)) / 1000));
    return { allowed: false, reason: "burst", retryAfterSeconds };
  }

  // Daily quota: retry-after is the time until the next UTC midnight.
  if (bucket.count >= dailyLimit) {
    const nextMidnight = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate() + 1,
    );
    const retryAfterSeconds = Math.max(1, Math.ceil((nextMidnight - now) / 1000));
    return { allowed: false, reason: "daily", retryAfterSeconds };
  }

  // Accept: record this request (trimmed burst list + incremented daily count).
  recent.push(now);
  const next: RateBucket = { date: today, count: bucket.count + 1, recent };
  try {
    store.setSetting(key, JSON.stringify(next));
    // Opportunistic GC of prior-day buckets (issue #423) — bounded + self-limiting.
    gcStaleBuckets(store, today);
  } catch {
    // Fail-soft: a write failure doesn't block the capture (the row just doesn't
    // persist this tick). The endpoint must never throw to the caller.
  }
  return { allowed: true };
}
