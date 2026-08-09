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

function parseWorkspaceOverrides(source: string): Record<string, string> {
  const block = source.match(/^overrides:\n((?: {2}.+\n?)+)/m)?.[1];
  if (!block) throw new Error("pnpm-workspace.yaml overrides block not found");

  return Object.fromEntries(
    block
      .trimEnd()
      .split("\n")
      .map((line) => {
        const entry = line.match(/^ {2}("[^"]+"):\s+("[^"]+")$/);
        if (!entry) throw new Error(`unsupported workspace override entry: ${line}`);
        return [JSON.parse(entry[1]), JSON.parse(entry[2])] as const;
      }),
  );
}

describe("dependency security policy", () => {
  it("keeps pnpm 9 and pnpm 11 override declarations aligned at patched floors", () => {
    expect(rootPackage.packageManager).toBe("pnpm@9.15.0");
    expect(dockerfile).toContain("corepack prepare pnpm@9.15.0 --activate");

    const expectedFloors = {
      "postcss@<=8.5.25": "8.5.26",
      "sharp@<0.35.0": "0.35.3",
      "tar@<=7.5.21": "7.5.22",
    };
    const packageOverrides = rootPackage.pnpm?.overrides;
    const workspaceOverrides = parseWorkspaceOverrides(workspace);

    expect(packageOverrides).toEqual(workspaceOverrides);
    expect(packageOverrides).toMatchObject(expectedFloors);
  });

  it("blocks a published image when production dependencies have a high advisory", () => {
    expect(ci).toContain("pnpm audit --prod --audit-level=high");
  });
});
