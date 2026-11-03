// Spec 063 — exact key-set pin for the derived docs map.
//
// The existing cross-surface guard (tests/docs-map.test.ts) iterates the CURRENT
// slug set, so a *shrunken* map still passes it — a derivation that dropped, say,
// /activity or /health would go unnoticed. This pin fixes the full 20-key map by
// value, so any missing or extra route is caught.

import { describe, expect, it } from "vitest";
import { ROUTE_DOCS_SLUG } from "@/lib/docs-map";

const EXPECTED: Record<string, string> = {
  "/": "dashboard/vault",
  "/activity": "dashboard/activity",
  "/curator": "dashboard/curator",
  "/memories": "dashboard/memories",
  "/journal": "guides/journal",
  "/handoffs": "dashboard/handoffs",
  "/analytics": "dashboard/analytics",
  "/proposals": "dashboard/proposals",
  "/flagged": "dashboard/flagged",
  "/archive": "dashboard/archive",
  "/logs": "dashboard/logs",
  "/health": "dashboard/health",
  "/settings/dashboard": "dashboard/settings",
  "/settings/auth": "dashboard/settings",
  "/settings/primer": "dashboard/settings",
  "/settings/curator": "dashboard/settings",
  "/settings/tokens": "dashboard/settings",
  "/settings/connect": "dashboard/settings",
  "/settings/ingest": "dashboard/settings",
  "/settings/backups": "dashboard/settings",
};

describe("ROUTE_DOCS_SLUG — exact key set", () => {
  it("maps exactly the expected 20 routes to their slugs", () => {
    expect(Object.keys(ROUTE_DOCS_SLUG)).toHaveLength(20);
    expect(Object.keys(ROUTE_DOCS_SLUG).sort()).toEqual(Object.keys(EXPECTED).sort());
    // Values too, so a route can't be silently re-pointed at the wrong docs page.
    expect(ROUTE_DOCS_SLUG).toEqual(EXPECTED);
  });
});
