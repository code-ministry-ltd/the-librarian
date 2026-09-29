import { describe, expect, it } from "vitest";
import { isAllowedHost } from "@/lib/allowed-host";

// DNS rebinding (review 2026-09-29 item #2): with auth open, only names a
// rebinding page cannot produce may reach the dashboard.
describe("isAllowedHost", () => {
  it.each([
    "localhost:3839",
    "127.0.0.1:3839",
    "[::1]:3839",
    "192.168.1.20:3839",
    "dashboard.localhost",
    "dashboard:3839",
    "nas.local:3839",
    "server.lan",
  ])("accepts %s", (host) => {
    expect(isAllowedHost(host, {})).toBe(true);
  });

  it.each(["evil.example:3839", "127.0.0.1.nip.io:3839", "localhost.evil.example"])(
    "refuses the rebindable public name %s",
    (host) => {
      expect(isAllowedHost(host, {})).toBe(false);
    },
  );

  it("accepts names from LIBRARIAN_ALLOWED_HOSTS, LIBRARIAN_PUBLIC_URL and AUTH_URL", () => {
    const env = {
      LIBRARIAN_ALLOWED_HOSTS: " Lib.Example.com , other.example.com",
      LIBRARIAN_PUBLIC_URL: "https://public.example.com",
      AUTH_URL: "https://auth.example.com/api/auth",
    };
    for (const host of [
      "lib.example.com",
      "other.example.com:8443",
      "public.example.com",
      "auth.example.com",
    ]) {
      expect(isAllowedHost(host, env)).toBe(true);
    }
    expect(isAllowedHost("evil.example", env)).toBe(false);
  });

  it("accepts a request with no Host header", () => {
    expect(isAllowedHost(null, {})).toBe(true);
  });
});
