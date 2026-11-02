import { expect, test } from "@playwright/test";

test.describe("single-port mode is inert by default", () => {
  for (const route of ["/mcp", "/healthz", "/primer.md", "/journal.md", "/transcript", "/ingest"]) {
    test(`${route} remains absent when the opt-in flag is unset`, async ({ request }) => {
      const response = await request.get(route);

      expect(response.status()).toBe(404);
      expect(await response.text()).toBe("Not Found");
    });
  }
});
