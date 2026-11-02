import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as healthzRoute from "@/app/healthz/route";
import * as ingestRoute from "@/app/ingest/route";
import * as journalRoute from "@/app/journal.md/route";
import * as mcpRoute from "@/app/mcp/route";
import * as primerRoute from "@/app/primer.md/route";
import * as transcriptRoute from "@/app/transcript/route";
import { config as middlewareConfig } from "@/middleware";

const PRIOR_FLAG = process.env.LIBRARIAN_SINGLE_PORT;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  delete process.env.LIBRARIAN_SINGLE_PORT;
  fetchSpy = vi.fn(async () => new Response("ok"));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (PRIOR_FLAG === undefined) delete process.env.LIBRARIAN_SINGLE_PORT;
  else process.env.LIBRARIAN_SINGLE_PORT = PRIOR_FLAG;
});

describe("single-port document routes", () => {
  it.each([
    ["/healthz", healthzRoute.GET],
    ["/primer.md", primerRoute.GET],
  ] as const)("%s is a dormant GET-only passthrough", async (pathname, GET) => {
    const request = new NextRequest(`https://library.example${pathname}`);

    expect((await GET(request)).status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();

    process.env.LIBRARIAN_SINGLE_PORT = "true";
    expect((await GET(request)).status).toBe(200);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(`http://127.0.0.1:3838${pathname}`);
  });

  it.each([
    ["/healthz", healthzRoute],
    ["/primer.md", primerRoute],
  ] as const)("%s explicitly refuses HEAD and OPTIONS", async (_pathname, route) => {
    process.env.LIBRARIAN_SINGLE_PORT = "true";

    expect((await route.HEAD()).status).toBe(405);
    expect((await route.OPTIONS()).status).toBe(405);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("single-port bearer routes", () => {
  it.each([
    ["/mcp", mcpRoute],
    ["/transcript", transcriptRoute],
    ["/ingest", ingestRoute],
  ] as const)(
    "%s exports GET and POST and refuses framework-special verbs",
    async (pathname, route) => {
      process.env.LIBRARIAN_SINGLE_PORT = "true";
      fetchSpy
        .mockResolvedValueOnce(Response.json({ mcp_auth: "enabled" }))
        .mockResolvedValueOnce(new Response("ok"));

      const request = new NextRequest(`https://library.example${pathname}`);
      expect((await route.GET(request)).status).toBe(200);
      expect(route.POST).toBeTypeOf("function");
      expect(route.HEAD().status).toBe(405);
      expect(route.OPTIONS().status).toBe(405);
    },
  );
});

describe("single-port journal route (spec 077)", () => {
  it("is a GET-only passthrough that requires the explicit-auth path, like /mcp", async () => {
    process.env.LIBRARIAN_SINGLE_PORT = "true";
    fetchSpy
      .mockResolvedValueOnce(Response.json({ mcp_auth: "enabled" }))
      .mockResolvedValueOnce(new Response("journal"));

    const request = new NextRequest("https://library.example/journal.md");
    expect((await journalRoute.GET(request)).status).toBe(200);
    expect(String(fetchSpy.mock.calls.at(-1)?.[0])).toBe("http://127.0.0.1:3838/journal.md");
    expect(journalRoute.HEAD().status).toBe(405);
    expect(journalRoute.OPTIONS().status).toBe(405);
    expect("POST" in journalRoute).toBe(false);
  });
});

describe("single-port middleware exclusions", () => {
  it("excludes exactly the six proxy roots from dashboard session gating", () => {
    const matcher = middlewareConfig.matcher[0];
    for (const pathRoot of [
      "healthz",
      "primer\\.md",
      "journal\\.md",
      "mcp",
      "transcript",
      "ingest",
    ]) {
      expect(matcher).toContain(`${pathRoot}(?:/|$)`);
    }
  });

  it("keeps the excluded proxy roots free of dashboard pages", () => {
    const appDir = path.resolve(process.cwd(), "app");
    for (const pathRoot of ["healthz", "primer.md", "journal.md", "mcp", "transcript", "ingest"]) {
      expect(fs.existsSync(path.join(appDir, pathRoot, "page.tsx"))).toBe(false);
    }
  });
});
