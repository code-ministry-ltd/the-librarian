import { defineConfig } from "vitest/config";
import { GIT_NO_AUTO_MAINTENANCE } from "../../test/git-test-env.mjs";

export default defineConfig({
  test: {
    // Background git maintenance races test-vault teardown (see the module).
    env: GIT_NO_AUTO_MAINTENANCE,
    include: ["tests/**/*.test.ts"],
    server: {
      deps: {
        // Vite 5's SSR transformer can mangle `node:` built-in resolution
        // for native deps in the import chain. Externalise the @librarian/*
        // packages so Node's own loader handles the import chain.
        external: [/\/packages\/(core|mcp-server)\/(src|dist)\//],
      },
    },
  },
});
