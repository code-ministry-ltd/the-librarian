// Ingest spec criterion 1 / S1 — the browser-extension origin gate.
//
// A Chromium MV3 background service worker POSTs to /ingest with an
// `Origin: chrome-extension://<id>` header. The same-host origin rule would 403
// it before dispatch, so the gate must let any `chrome-extension:` scheme origin
// through. The real gate on /ingest is the capture bearer token (D28); a web page
// cannot forge a `chrome-extension://` origin, and the server is bearer- not
// cookie-authed so CSRF isn't the threat. Unit-tests the compiled auth seam.

import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { type AuthConfig, isAllowedOrigin } from "../../dist/http/auth.js";

function reqWithOrigin(origin?: string, host = "0.0.0.0:3838"): IncomingMessage {
  return {
    headers: { ...(origin ? { origin } : {}), host },
  } as unknown as IncomingMessage;
}

const config: AuthConfig = {
  adminToken: "",
  agentToken: "",
  agentTokenMap: new Map(),
  allowedOrigins: [],
  allowNoAuth: false,
  host: "0.0.0.0",
  port: 3838,
};

const ingest = { surface: "public", path: "/ingest" } as const;

describe("isAllowedOrigin — chrome-extension origins", () => {
  it("accepts a chrome-extension:// origin on /ingest (the browser-extension capture path)", () => {
    expect(isAllowedOrigin(reqWithOrigin("chrome-extension://abc"), config, ingest)).toBe(true);
  });

  // Review 2026-09-29 #22a: the exemption is justified by /ingest's capture token.
  // Any installed extension with localhost access must not get the admin listener,
  // which has no bearer, nor any other public route.
  it("refuses a chrome-extension:// origin on any other public route", () => {
    expect(
      isAllowedOrigin(reqWithOrigin("chrome-extension://abc"), config, {
        surface: "public",
        path: "/mcp",
      }),
    ).toBe(false);
  });

  it("refuses a chrome-extension:// origin on the internal admin listener", () => {
    expect(
      isAllowedOrigin(reqWithOrigin("chrome-extension://abc", "127.0.0.1:3840"), config, {
        surface: "internal",
        path: "/trpc/auth.config",
      }),
    ).toBe(false);
  });

  it("refuses even a same-host browser origin on the internal admin listener", () => {
    expect(
      isAllowedOrigin(reqWithOrigin("http://127.0.0.1:3840", "127.0.0.1:3840"), config, {
        surface: "internal",
      }),
    ).toBe(false);
  });

  it("serves the internal listener with no Origin, or an explicitly allowed one", () => {
    const internal = { surface: "internal" } as const;
    expect(isAllowedOrigin(reqWithOrigin(undefined, "127.0.0.1:3840"), config, internal)).toBe(
      true,
    );
    const listed = { ...config, allowedOrigins: ["https://dash.example.com"] };
    expect(isAllowedOrigin(reqWithOrigin("https://dash.example.com"), listed, internal)).toBe(true);
  });

  it("still rejects a stray cross-site https origin under the same-host rule", () => {
    expect(isAllowedOrigin(reqWithOrigin("https://evil.com"), config)).toBe(false);
  });

  it("still accepts a same-host origin", () => {
    expect(isAllowedOrigin(reqWithOrigin("http://0.0.0.0:3838"), config)).toBe(true);
  });
});
