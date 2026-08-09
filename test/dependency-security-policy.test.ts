import fs from "node:fs";
import { describe, expect, it } from "vitest";

const rootPackage = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  packageManager?: string;
  pnpm?: { overrides?: Record<string, string> };
};
const workspace = fs.readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
const dockerfile = fs.readFileSync(
  new URL("../docker/all-in-one.Dockerfile", import.meta.url),
  "utf8",
);
const ci = fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

describe("dependency security policy", () => {
  it("keeps pnpm 9 and pnpm 11 override declarations aligned at patched floors", () => {
    expect(rootPackage.packageManager).toBe("pnpm@9.15.0");
    expect(dockerfile).toContain("corepack prepare pnpm@9.15.0 --activate");

    const expected = {
      "postcss@<=8.5.25": "8.5.26",
      "sharp@<0.35.0": "0.35.3",
      "tar@<=7.5.21": "7.5.22",
    };
    expect(rootPackage.pnpm?.overrides).toMatchObject(expected);
    for (const [selector, version] of Object.entries(expected)) {
      expect(workspace).toContain(`"${selector}": "${version}"`);
    }
  });

  it("blocks a published image when production dependencies have a high advisory", () => {
    expect(ci).toContain("pnpm audit --prod --audit-level=high");
  });
});
