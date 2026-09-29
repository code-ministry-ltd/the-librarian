// Cached lookup for the latest GitHub release of The Librarian.
//
// Powers the dashboard's "behind latest" indicator. Calls the GitHub
// REST API at most once per `CACHE_TTL_MS`, swallows rate-limit and
// network failures, and degrades gracefully when no release exists (the
// repo is pre-tag, the operator's instance is offline, the operator
// disabled the check via `LIBRARIAN_DISABLE_VERSION_CHECK=true`, etc.).

const DEFAULT_REPO = "code-ministry-ltd/the-librarian";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const REQUEST_TIMEOUT_MS = 4_000;

export interface LatestRelease {
  tag: string; // e.g. "v0.2.0"
  htmlUrl: string;
  publishedAt: string; // ISO 8601
  /** Truncated body (≤ 4 KB) for the dashboard popover; full notes live on the html_url. */
  bodyExcerpt: string | null;
}

export type LatestReleaseStatus =
  | { kind: "ok"; release: LatestRelease; cachedAt: string }
  | { kind: "no_release"; cachedAt: string } // 404 — repo has no releases yet
  | { kind: "disabled" }
  | { kind: "unavailable"; reason: string }; // network / rate-limited / other

interface CacheEntry {
  fetchedAt: number; // epoch ms
  status: LatestReleaseStatus;
}

let cache: CacheEntry | null = null;

function repoSlug(): string {
  return process.env.LIBRARIAN_GITHUB_REPO || DEFAULT_REPO;
}

function isDisabled(): boolean {
  return process.env.LIBRARIAN_DISABLE_VERSION_CHECK === "true";
}

function fresh(entry: CacheEntry, now: number): boolean {
  // Only successful and "no_release" responses are cached for the full TTL.
  // Transient failures (`unavailable`) get a much shorter cache so the next
  // request retries — but we still cache them briefly so a broken network
  // doesn't hammer the API.
  if (entry.status.kind === "unavailable") {
    return now - entry.fetchedAt < 30_000;
  }
  return now - entry.fetchedAt < CACHE_TTL_MS;
}

async function callGithub(): Promise<LatestReleaseStatus> {
  const slug = repoSlug();
  // The slug is interpolated into the request path: accept only `owner/repo`.
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) {
    return { kind: "unavailable", reason: "invalid_repo" };
  }
  const url = `https://api.github.com/repos/${slug}/releases/latest`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "the-librarian-dashboard",
      "x-github-api-version": "2022-11-28",
    };
    // Optional auth lifts the unauthenticated 60 req/h limit to 5000 — useful
    // for shared dashboards. Anonymous requests are fine for personal use.
    const token = process.env.LIBRARIAN_GITHUB_TOKEN;
    if (token) headers.authorization = `Bearer ${token}`;
    // A credentialed request never follows a redirect (AGENTS.md): it would carry
    // the token to wherever it points. Anonymous lookups may still follow one
    // (GitHub redirects renamed repositories).
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: token ? "error" : "follow",
    });
    if (response.status === 404) {
      return { kind: "no_release", cachedAt: new Date().toISOString() };
    }
    if (response.status === 403 || response.status === 429) {
      return { kind: "unavailable", reason: "rate_limited" };
    }
    if (!response.ok) {
      return { kind: "unavailable", reason: `http_${response.status}` };
    }
    const payload = (await response.json()) as {
      tag_name?: unknown;
      html_url?: unknown;
      published_at?: unknown;
      body?: unknown;
    };
    if (
      typeof payload.tag_name !== "string" ||
      typeof payload.html_url !== "string" ||
      typeof payload.published_at !== "string"
    ) {
      return { kind: "unavailable", reason: "malformed_response" };
    }
    const bodyExcerpt =
      typeof payload.body === "string" && payload.body.length > 0
        ? payload.body.slice(0, 4_000)
        : null;
    return {
      kind: "ok",
      release: {
        tag: payload.tag_name,
        htmlUrl: payload.html_url,
        publishedAt: payload.published_at,
        bodyExcerpt,
      },
      cachedAt: new Date().toISOString(),
    };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "AbortError" ? "timeout" : "network_error";
    return { kind: "unavailable", reason };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Returns the latest-release status, fetching from GitHub on the first call
 * and at most once per TTL afterwards. Always resolves — no throws — so the
 * caller can render the indicator without try/catch noise.
 */
export async function getLatestRelease(): Promise<LatestReleaseStatus> {
  if (isDisabled()) return { kind: "disabled" };
  const now = Date.now();
  if (cache && fresh(cache, now)) return cache.status;
  const status = await callGithub();
  cache = { fetchedAt: now, status };
  return status;
}

/** Test-only: forget the cache so a unit test can drive a fresh fetch. */
export function __resetLatestReleaseCacheForTests(): void {
  cache = null;
}
