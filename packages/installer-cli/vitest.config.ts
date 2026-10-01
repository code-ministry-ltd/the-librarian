import { defineConfig } from "vitest/config";
import { GIT_NO_AUTO_MAINTENANCE } from "../../test/git-test-env.mjs";

export default defineConfig({
  test: {
    // Background git maintenance races test-vault teardown (see the module).
    env: GIT_NO_AUTO_MAINTENANCE,
    include: ["tests/**/*.test.ts"],
  },
});
