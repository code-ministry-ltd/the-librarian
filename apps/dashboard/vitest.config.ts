import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": here,
      // `server-only` throws when resolved through its default (client) export
      // condition, which is what Vitest picks. Stub it so server-route modules
      // (e.g. the tRPC proxy) can be imported and unit-tested directly.
      "server-only": path.join(here, "tests/stubs/server-only.ts"),
    },
  },
  test: {
    // The Server-Component renderToString tests run in plain Node; the
    // component-interaction tests under tests/components need a DOM.
    // Vitest 4 replaced environmentMatchGlobs with projects.
    projects: [
      {
        extends: true,
        test: {
          name: "components",
          include: ["tests/components/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: ["./tests/setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "node",
          include: ["tests/**/*.test.{ts,tsx}"],
          exclude: ["tests/components/**"],
          environment: "node",
          setupFiles: ["./tests/setup.ts"],
        },
      },
    ],
    passWithNoTests: true,
  },
});
