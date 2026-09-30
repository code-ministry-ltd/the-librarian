// DNS rebinding (review 2026-09-29 item #2).
//
// A page on evil.example rebinds its name to 127.0.0.1. The browser then sends
// `Host: evil.example:<port>` (and, on a POST, a matching `Origin`), so the
// same-host origin rule passes and the page reads every response. Browsers never
// let a page choose the Host header, so the defence is to refuse any Host a
// rebinding attacker could produce: a public DNS name the operator did not list.
//
// The internal admin listener has no bearer at all, so it always checks. The
// public listener only needs to when the no-auth bypass would admit the request:
// with a token in force, a rebinding page has nothing to replay.

import http from "node:http";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { type AuthConfig, isAllowedHost } from "../../dist/http/auth.js";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

const config: AuthConfig = {
  adminToken: "",
  agentToken: "",
  agentTokenMap: new Map(),
  allowedOrigins: [],
  allowNoAuth: false,
  host: "0.0.0.0",
  port: 3838,
};

function reqWithHost(host?: string): IncomingMessage {
  return { headers: host === undefined ? {} : { host } } as unknown as IncomingMessage;
}

describe("isAllowedHost", () => {
  it.each([
    "127.0.0.1:3840",
    "localhost:3840",
    "LOCALHOST",
    "app.localhost:3839",
    "[::1]:3840",
    "10.0.0.5:3840",
    "mcp-server:3840", // a docker-compose service name
    "nas.local:3840",
    "box.tail1234.ts.net", // Tailscale MagicDNS: Tailscale, not an attacker, answers for ts.net
    "box.home.arpa",
  ])("accepts %s, which no public DNS name can rebind to", (host) => {
    expect(isAllowedHost(reqWithHost(host), config)).toBe(true);
  });

  it.each([
    "evil.example:3840",
    "evil.example",
    "127.0.0.1.nip.io:3840",
    "localhost.evil.example",
    "ts.net.evil.example",
  ])("refuses the rebindable public name %s", (host) => {
    expect(isAllowedHost(reqWithHost(host), config)).toBe(false);
  });

  it("accepts a name listed in LIBRARIAN_ALLOWED_HOSTS, case-insensitively", () => {
    const listed = { ...config, allowedHosts: ["Librarian.Example.com"] };
    expect(isAllowedHost(reqWithHost("librarian.example.com:443"), listed)).toBe(true);
    expect(isAllowedHost(reqWithHost("other.example.com"), listed)).toBe(false);
  });

  it("accepts the host of an origin listed in LIBRARIAN_ALLOWED_ORIGINS", () => {
    const listed = { ...config, allowedOrigins: ["https://dash.example.com"] };
    expect(isAllowedHost(reqWithHost("dash.example.com"), listed)).toBe(true);
  });

  it("accepts the configured bind host", () => {
    expect(isAllowedHost(reqWithHost("box.lan:3838"), { ...config, host: "box.lan" })).toBe(true);
  });

  it("accepts a request with no Host header (never a browser)", () => {
    expect(isAllowedHost(reqWithHost(), config)).toBe(true);
  });
});

function request(
  url: string,
  host: string,
  options: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: options.method ?? "GET",
        headers: { host, ...(options.headers ?? {}) },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function withEnv<T>(env: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("DNS-rebinding requests are refused", () => {
  it("the internal admin listener refuses a rebinding Host and serves loopback and listed names", async () => {
    const dataDir = makeTempDir();
    const server = await withEnv({ LIBRARIAN_ALLOWED_HOSTS: "admin.internal.example" }, () =>
      startHttpServer({ dataDir }),
    );
    try {
      const port = new URL(server.trpcUrl).port;
      const url = `${server.trpcUrl}/trpc/health.ping`;

      const rebound = await request(url, `evil.example:${port}`);
      expect(rebound.status).toBe(403);
      expect(rebound.body).toContain("LIBRARIAN_ALLOWED_HOSTS");

      expect((await request(url, `127.0.0.1:${port}`)).status).toBe(200);
      expect((await request(url, `mcp-server:${port}`)).status).toBe(200);
      expect((await request(url, `admin.internal.example:${port}`)).status).toBe(200);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("the public listener refuses a rebinding Host when the no-auth bypass would admit it", async () => {
    const dataDir = makeTempDir();
    const server = await withEnv({ LIBRARIAN_ALLOW_NO_AUTH: "true" }, () =>
      startHttpServer({ dataDir }),
    );
    try {
      const port = new URL(server.url).port;
      const call = (host: string) =>
        request(`${server.url}/mcp`, host, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });

      expect((await call(`evil.example:${port}`)).status).toBe(403);
      expect((await call(`localhost:${port}`)).status).toBe(200);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("the public listener still serves any Host when a bearer token is required", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const port = new URL(server.url).port;
      const res = await request(`${server.url}/mcp`, `librarian.example.com:${port}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${server.agentToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(200);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
