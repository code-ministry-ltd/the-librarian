import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// DNS rebinding (review 2026-09-29 item #2). With authentication open, a page on a
// rebound public name must reach neither the dashboard pages (and so their server
// actions) nor the /api/trpc proxy to the admin listener.

const getAuthConfigMock = vi.fn();
const enforcementMock = vi.fn();
vi.mock("@/lib/auth-config-client", () => ({
  getAuthConfigSafe: () => getAuthConfigMock(),
  getAuthConfig: () => getAuthConfigMock(),
}));
vi.mock("@/lib/auth-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-gate")>()),
  resolveEnforcement: () => enforcementMock(),
}));
vi.mock("@/auth", () => ({ auth: async () => null }));

const { default: middleware } = await import("@/middleware");
const { GET } = await import("@/app/api/trpc/[trpc]/route");

const openConfig = {
  enabled: false,
  methods: [],
  password: null,
  oauth: {},
  ownerOAuth: {},
  authSecret: "s",
  claimPending: false,
};

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getAuthConfigMock.mockReset().mockResolvedValue(openConfig);
  enforcementMock.mockReset().mockResolvedValue("open");
  fetchSpy = vi.fn(async () => new Response('{"result":{"data":null}}', { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
  delete process.env.LIBRARIAN_AUTH_ENABLED;
  delete process.env.LIBRARIAN_ALLOWED_HOSTS;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LIBRARIAN_ALLOWED_HOSTS;
});

function page(host: string): NextRequest {
  return new NextRequest(`http://${host}/memories`, { headers: { host } });
}

function trpcGet(host: string): NextRequest {
  return new NextRequest(`http://${host}/api/trpc/auth.config`, { headers: { host } });
}

const params = { params: Promise.resolve({ trpc: "auth.config" }) };

describe("DNS-rebinding guard with authentication open", () => {
  it("middleware refuses a page request on a rebound public name", async () => {
    const res = await middleware(page("evil.example:3839"));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("LIBRARIAN_ALLOWED_HOSTS");
  });

  it("middleware serves loopback and listed names", async () => {
    expect((await middleware(page("localhost:3839"))).status).toBe(200);
    process.env.LIBRARIAN_ALLOWED_HOSTS = "lib.example.com";
    expect((await middleware(page("lib.example.com"))).status).toBe(200);
  });

  it("the /api/trpc proxy refuses a rebound name without reaching the admin listener", async () => {
    const res = await GET(trpcGet("evil.example:3839"), params);
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the /api/trpc proxy still serves loopback", async () => {
    const res = await GET(trpcGet("127.0.0.1:3839"), params);
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
