// Tests for the GitHub latest-release lookup.
//
// Mocks `fetch` so the suite can cover all four code paths (200/404/403/
// timeout) without touching the network, and pins the cache TTL behaviour.

import { __resetLatestReleaseCacheForTests, getLatestRelease } from "@librarian/mcp-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const originalFetch = globalThis.fetch;

function mockFetchOnce(impl: typeof globalThis.fetch): void {
  globalThis.fetch = impl as typeof globalThis.fetch;
}

beforeEach(() => {
  __resetLatestReleaseCacheForTests();
  delete process.env.LIBRARIAN_DISABLE_VERSION_CHECK;
  delete process.env.LIBRARIAN_GITHUB_TOKEN;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("getLatestRelease", () => {
  it("returns disabled when LIBRARIAN_DISABLE_VERSION_CHECK is set", async () => {
    process.env.LIBRARIAN_DISABLE_VERSION_CHECK = "true";
    let fetched = 0;
    mockFetchOnce(async () => {
      fetched++;
      return jsonResponse({});
    });
    expect(await getLatestRelease()).toEqual({ kind: "disabled" });
    expect(fetched).toBe(0);
  });

  it("returns ok with the parsed release on 200", async () => {
    mockFetchOnce(async () =>
      jsonResponse({
        tag_name: "v0.2.0",
        html_url: "https://github.com/code-ministry-ltd/the-librarian/releases/tag/v0.2.0",
        published_at: "2026-06-01T00:00:00Z",
        body: "## What's new\n\n- handoffs",
      }),
    );
    const status = await getLatestRelease();
    expect(status.kind).toBe("ok");
    if (status.kind !== "ok") throw new Error("unreachable");
    expect(status.release.tag).toBe("v0.2.0");
    expect(status.release.htmlUrl).toContain("releases/tag/v0.2.0");
    expect(status.release.bodyExcerpt).toContain("handoffs");
  });

  // AGENTS.md / review 2026-09-29 #23: with a token attached, a redirect must not
  // be followed (it would carry the bearer to wherever it points).
  it("refuses redirects when LIBRARIAN_GITHUB_TOKEN is sent", async () => {
    process.env.LIBRARIAN_GITHUB_TOKEN = "gh-test";
    let init: RequestInit | undefined;
    mockFetchOnce(async (_url, requestInit) => {
      init = requestInit;
      return new Response("Not Found", { status: 404 });
    });
    await getLatestRelease();
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer gh-test");
    expect(init?.redirect).toBe("error");
  });

  it("refuses a LIBRARIAN_GITHUB_REPO that is not owner/repo, without calling GitHub", async () => {
    process.env.LIBRARIAN_GITHUB_REPO = "owner/repo/../../user";
    let fetched = 0;
    mockFetchOnce(async () => {
      fetched++;
      return jsonResponse({});
    });
    try {
      expect(await getLatestRelease()).toEqual({ kind: "unavailable", reason: "invalid_repo" });
      expect(fetched).toBe(0);
    } finally {
      delete process.env.LIBRARIAN_GITHUB_REPO;
    }
  });

  it("returns no_release on 404 (pre-tag repo)", async () => {
    mockFetchOnce(async () => new Response("Not Found", { status: 404 }));
    const status = await getLatestRelease();
    expect(status.kind).toBe("no_release");
  });

  it("returns unavailable on rate-limit (403)", async () => {
    mockFetchOnce(async () => new Response("", { status: 403 }));
    const status = await getLatestRelease();
    expect(status).toEqual({ kind: "unavailable", reason: "rate_limited" });
  });

  it("returns unavailable on network failure", async () => {
    mockFetchOnce(async () => {
      throw new Error("ENETUNREACH");
    });
    const status = await getLatestRelease();
    expect(status.kind).toBe("unavailable");
    if (status.kind !== "unavailable") throw new Error("unreachable");
    expect(status.reason).toBe("network_error");
  });

  it("caches a successful response across calls", async () => {
    let calls = 0;
    mockFetchOnce(async () => {
      calls++;
      return jsonResponse({
        tag_name: "v0.2.0",
        html_url: "https://example/releases/tag/v0.2.0",
        published_at: "2026-06-01T00:00:00Z",
        body: null,
      });
    });
    await getLatestRelease();
    await getLatestRelease();
    await getLatestRelease();
    expect(calls).toBe(1);
  });

  it("rejects a malformed payload as unavailable", async () => {
    mockFetchOnce(async () => jsonResponse({ tag_name: 42 }));
    const status = await getLatestRelease();
    expect(status).toMatchObject({ kind: "unavailable", reason: "malformed_response" });
  });

  it("sends an authorization header when LIBRARIAN_GITHUB_TOKEN is set", async () => {
    process.env.LIBRARIAN_GITHUB_TOKEN = "ghp_fake_test_token";
    const seen: Record<string, string> = {};
    mockFetchOnce(async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      for (const key of Object.keys(headers)) seen[key.toLowerCase()] = headers[key]!;
      return jsonResponse({
        tag_name: "v0.2.0",
        html_url: "https://example/releases/tag/v0.2.0",
        published_at: "2026-06-01T00:00:00Z",
      });
    });
    await getLatestRelease();
    expect(seen.authorization).toBe("Bearer ghp_fake_test_token");
  });
});
