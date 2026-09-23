// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";

/** @typedef {{ type: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] }} HastNode */

// Astro defaults to a static build; the docs site is plain static HTML served
// by Cloudflare Pages (spec K2), so the output is pinned explicitly.
// https://docs.astro.build/en/reference/configuration-reference/
export default defineConfig({
  // The canonical production origin (spec OQ1). Drives absolute canonical/OG
  // URLs and the generated sitemap; without it Astro skips the sitemap and
  // emits relative canonicals. Served at the subdomain root, so no `base`.
  site: "https://librarian-docs.codeministry.net",
  output: "static",
  integrations: [
    starlight({
      title: "The Librarian",
      description:
        "Operating guide for The Librarian — a portable memory + handoff layer for AI agents.",
      components: {
        // Default to light (Manuscript) for first-time visitors instead of
        // following the OS, matching the dashboard + marketing surfaces. See the
        // component header for the reasoning.
        ThemeProvider: "./src/components/ThemeProvider.astro",
        // Reuses the default footer and adds a dependency-free image lightbox
        // (content images enlarge in a native <dialog>).
        Footer: "./src/components/Footer.astro",
      },
      expressiveCode: {
        plugins: [
          {
            name: "keyboard-accessible-code-blocks",
            hooks: {
              postprocessRenderedBlock({ renderData }) {
                // Code can overflow at different viewport widths and zoom levels.
                // Make every block focusable in the static HTML so keyboard users
                // can reach and scroll it without depending on client-side JS.
                /** @param {HastNode} node */
                const makePreFocusable = (node) => {
                  if (node.type !== "element") return;
                  if (node.tagName === "pre") {
                    node.properties ??= {};
                    node.properties.tabIndex = 0;
                  }
                  for (const child of node.children ?? []) makePreFocusable(child);
                };
                makePreFocusable(renderData.blockAst);
              },
            },
          },
        ],
      },
      // Fails the build on broken INTERNAL links/anchors over the built site.
      // External links are never network-checked (they'd flake), satisfying
      // spec success criterion 6.
      plugins: [starlightLinksValidator()],
      customCss: [
        // The three-face editorial system (Fontsource), loaded before the
        // skin so the `--sl-font` overrides can reference the families.
        "@fontsource/fraunces/400.css",
        "@fontsource/fraunces/500.css",
        "@fontsource/newsreader/400.css",
        "@fontsource/newsreader/500.css",
        "@fontsource/ibm-plex-mono/400.css",
        "@fontsource/ibm-plex-mono/500.css",
        // The Reading Room palette + typography (`--sl-*` overrides).
        "./src/styles/reading-room.css",
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/code-ministry-ltd/the-librarian",
        },
      ],
      sidebar: [
        {
          label: "Start here",
          items: [
            { slug: "start-here/what-is-the-librarian" },
            { slug: "start-here/install" },
            { slug: "start-here/first-run" },
          ],
        },
        {
          label: "Connect your agent",
          items: [
            { slug: "connect/claude-code" },
            { slug: "connect/codex" },
            { slug: "connect/opencode" },
            { slug: "connect/hermes" },
            { slug: "connect/pi" },
          ],
        },
        {
          label: "Using the dashboard",
          items: [
            { slug: "dashboard" },
            { slug: "dashboard/memories" },
            { slug: "dashboard/proposals" },
            { slug: "dashboard/flagged" },
            { slug: "dashboard/archive" },
            { slug: "dashboard/analytics" },
            { slug: "dashboard/handoffs" },
            { slug: "dashboard/curator" },
            { slug: "dashboard/vault" },
            { slug: "dashboard/activity" },
            { slug: "dashboard/health" },
            { slug: "dashboard/settings" },
          ],
        },
        {
          label: "Operating guides",
          items: [
            { slug: "guides/reviewing-proposals" },
            { slug: "guides/working-with-references" },
            { slug: "guides/handoff-takeover" },
            { slug: "guides/private-mode" },
            { slug: "guides/backups-restore" },
            { slug: "guides/configuring-the-curator" },
            { slug: "guides/chronicle" },
          ],
        },
        {
          // Generated technical appendix (docs-site spec, Phase 2). Pages under
          // reference/ are produced by `pnpm docs:gen` from canonical sources and
          // drift-guarded by `pnpm check:docs` — edit the sources, not these pages.
          label: "Reference",
          items: [
            { slug: "reference/mcp-verbs" },
            { slug: "reference/slash-commands" },
            { slug: "reference/cli" },
            { slug: "reference/primer" },
            { slug: "reference/capture-matrix" },
          ],
        },
        {
          label: "Deploy & operate",
          items: [
            { slug: "deploy-and-operate/self-host" },
            { slug: "deploy-and-operate/manual-install" },
            { slug: "deploy-and-operate/auth-and-secrets" },
          ],
        },
        {
          // Build-time plugin API (ADR 0011 seam S1, spec 060). Experimental until
          // spec 062 — see the page header.
          label: "Extend the Librarian",
          items: [{ slug: "extend/extension-api" }],
        },
      ],
    }),
  ],
});
