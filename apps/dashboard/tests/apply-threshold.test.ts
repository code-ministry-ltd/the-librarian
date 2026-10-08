import { afterEach, describe, expect, it, vi } from "vitest";

const intakeConfigMock = vi.fn();

vi.mock("@/lib/trpc-server", () => ({
  serverTRPC: { intake: { config: { query: intakeConfigMock } } },
}));

const { readApplyThreshold } = await import("@/lib/apply-threshold");

afterEach(() => intakeConfigMock.mockReset());

describe("readApplyThreshold", () => {
  it("returns the shared auto-apply threshold", async () => {
    intakeConfigMock.mockResolvedValue({ applyConfidenceThreshold: 0 });
    await expect(readApplyThreshold()).resolves.toBe(0);
  });

  it("returns null instead of throwing when the server cannot be reached", async () => {
    intakeConfigMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(readApplyThreshold()).resolves.toBeNull();
  });
});
