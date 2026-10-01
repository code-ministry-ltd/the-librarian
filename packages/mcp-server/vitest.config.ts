import { defineConfig } from "vitest/config";
import { GIT_NO_AUTO_MAINTENANCE } from "../../test/git-test-env.mjs";

export default defineConfig({
  test: {
    // Background git maintenance races test-vault teardown (see the module).
    env: GIT_NO_AUTO_MAINTENANCE,
    include: ["tests/**/*.test.ts"],
    passWithNoTests: true,
    // HTTP tests spawn the compiled bin and exercise the server via
    // real fetch calls. Give them a generous deadline and serialise the
    // worker pool so the child processes don't race on ports.
    testTimeout: 30000,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    // Vite 5's SSR transformer can mangle `node:` built-in resolution for
    // native deps in the import chain. Externalize the core store + local
    // source/dist so Node's own loader handles the import chain.
    server: {
      deps: {
        external: [/\/packages\/core\/(src|dist)\//, /\/packages\/mcp-server\/(src|dist)\//],
      },
    },
  },
});
