import { defineConfig } from "vitest/config";
import { GIT_NO_AUTO_MAINTENANCE } from "./test/git-test-env.mjs";

// Root vitest config for cross-cutting tests that live at the repo
// root (healthcheck, integrations). Per-package configs continue to
// own their own tests; this picks up only `test/**/*.test.ts`.

export default defineConfig({
  test: {
    // Background git maintenance races test-vault teardown (see the module).
    env: GIT_NO_AUTO_MAINTENANCE,
    include: ["test/**/*.test.ts"],
    passWithNoTests: true,
    // Vite 5's SSR transformer drops the `node:` prefix when resolving
    // Node built-ins like `node:sqlite`, which then fail to load. The
    // healthcheck test imports test/helpers.js which pulls in the
    // @librarian/core store; externalize that compiled tree so Node's
    // own loader handles the import chain.
    server: {
      deps: {
        external: [
          /\/packages\/core\/(src|dist)\//,
          /\/packages\/mcp-server\/(src|dist)\//,
          // The seed scripts are plain .mjs run by node in production; let node's
          // own loader resolve them (and their deps, e.g. gray-matter) in tests too.
          /\/scripts\//,
        ],
      },
    },
  },
});
