// Import limits on the dashboard (spec 079 §5): read the config with the frozen cutoffs,
// save the limits, and refuse an out-of-range value with a teaching message.

import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, startHttpServer } from "../../../../test/helpers.js";

async function trpc(
  server: { trpcUrl: string; token: string },
  proc: string,
  input: unknown,
  method: "GET" | "POST",
): Promise<{ status: number; json: { result?: { data: unknown }; error?: { message?: string } } }> {
  const query = method === "GET" ? `?input=${encodeURIComponent(JSON.stringify(input))}` : "";
  const res = await fetch(`${server.trpcUrl}/trpc/${proc}${query}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
    ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
  });
  return { status: res.status, json: (await res.json()) as never };
}

describe("tRPC import.config / import.setConfig", () => {
  it("reads the defaults, saves new limits, and refuses an out-of-range allowance", async () => {
    const dataDir = makeTempDir();
    const server = await startHttpServer({ dataDir });
    try {
      const before = await trpc(server, "import.config", undefined, "GET");
      expect(before.json.result?.data).toMatchObject({
        maxAgeDays: 90,
        allowanceRemaining: 200,
        memoriesCutoff: null,
        journalCutoff: null,
        conversationsRecorded: 0,
      });
      const saved = await trpc(
        server,
        "import.setConfig",
        { maxAgeDays: 365, allowanceRemaining: 50 },
        "POST",
      );
      expect(saved.json.result?.data).toMatchObject({ maxAgeDays: 365, allowanceRemaining: 50 });
      const bad = await trpc(server, "import.setConfig", { allowanceRemaining: -1 }, "POST");
      expect(bad.status).toBe(400);
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });
});
