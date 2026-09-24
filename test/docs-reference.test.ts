// Reference-parity guard for the generated docs (docs-site spec criterion #4).
//
// The reference pages under apps/docs are GENERATED from canonical sources by
// scripts/docs-gen.mjs and committed; scripts/check-docs.mjs (the drift-guard)
// fails CI if the committed pages fall out of sync. This suite pins the parity
// contract on the generator's output itself: the MCP-verbs page must carry
// exactly the seven verbs, each with its tool-level description and every
// parameter's name, type, required-ness, and human description — so a verb or
// parameter can never silently vanish from the reference.

import { readFileSync } from "node:fs";

import { DEFAULT_PRIMER } from "@librarian/core";
import { tools } from "@librarian/mcp-server";
import { describe, expect, it } from "vitest";
import { collectCliHelp, generateReference, renderMcpVerbs } from "../scripts/docs-gen.mjs";

const page = renderMcpVerbs(tools);
const reference = generateReference();

/** The `## `verb`` headings, in document order. */
function verbHeadings(markdown: string): string[] {
  return [...markdown.matchAll(/^##\s+`([a-z_]+)`/gm)].map((m) => m[1]);
}

describe("generated MCP-verbs reference page", () => {
  it("has Starlight frontmatter with a title", () => {
    expect(page).toMatch(/^---\n[\s\S]*?\btitle:/);
  });

  it("documents exactly the seven verbs, by name", () => {
    expect(verbHeadings(page).sort()).toEqual(
      [
        "claim_handoff",
        "flag_memory",
        "list_handoffs",
        "recall",
        "remember",
        "search_references",
        "store_handoff",
      ].sort(),
    );
    // Count guard: no duplicate or stray verb sections.
    expect(verbHeadings(page)).toHaveLength(7);
  });

  it("renders each verb's tool-level teaching description verbatim", () => {
    for (const tool of tools) {
      expect(page, `missing description for ${tool.name}`).toContain(tool.description);
    }
  });

  it("renders every parameter of every verb with its name and description", () => {
    for (const tool of tools) {
      const schema = tool.inputSchema as {
        properties?: Record<string, { description?: string }>;
      };
      for (const [name, prop] of Object.entries(schema.properties ?? {})) {
        expect(page, `${tool.name}: parameter '${name}' not rendered`).toContain(`\`${name}\``);
        expect(page, `${tool.name}.${name}: description not rendered`).toContain(prop.description);
      }
    }
  });

  it("marks the server-populated agent_id distinctly, not as a parameter you pass", () => {
    // agent_id appears in recall/remember/flag_memory but is resolved from the
    // bearer token — the reference must not present it as caller-supplied.
    expect(page).toMatch(/agent_id[\s\S]*?server-populated/i);
  });
});

describe("generated CLI reference page", () => {
  const cli = reference["apps/docs/src/content/docs/reference/cli.md"];

  it("is part of the generated reference", () => {
    expect(cli).toBeTruthy();
    expect(cli).toMatch(/^---\n[\s\S]*?title: CLI/);
  });

  it("embeds every CLI surface's help verbatim — both CLIs, every command", () => {
    // Verbatim parity: each canonical usage block appears in full, so adding or
    // renaming a command in any CLI forces the page to regenerate (check:docs).
    const help = collectCliHelp();
    for (const [surface, text] of Object.entries(help)) {
      expect(cli, `cli page is missing the ${surface} help block`).toContain(text.trimEnd());
    }
  });

  it("names both binaries and their key subcommands", () => {
    for (const token of [
      "librarian server", // installer/self-host CLI + its server subcommands
      "the-librarian handoffs", // admin CLI + handoffs
      "the-librarian auth", // admin CLI + auth recovery
    ]) {
      expect(cli, `cli page should reference '${token}'`).toContain(token);
    }
  });
});

describe("generated primer reference page", () => {
  const primer = reference["apps/docs/src/content/docs/reference/primer.md"];

  it("reproduces the shipped DEFAULT_PRIMER verbatim", () => {
    expect(primer).toBeTruthy();
    expect(primer).toContain(DEFAULT_PRIMER.trimEnd());
  });

  it("says it documents the shipped default, with the live primer operator-editable", () => {
    expect(primer).toMatch(/vault\/primer\.md/);
    expect(primer).toMatch(/default/i);
  });
});

describe("included canonical docs (slash commands, capture matrix)", () => {
  const slash = reference["apps/docs/src/content/docs/reference/slash-commands.md"];
  const capture = reference["apps/docs/src/content/docs/reference/capture-matrix.md"];

  /** A repo-relative markdown link (not http/anchor/site-absolute). */
  const REPO_RELATIVE_LINK = /\]\((?!https?:\/\/|#|\/)[^)]*\)/;

  it("includes the four slash commands and their contract table", () => {
    for (const cmd of ["/handoff", "/takeover", "/learn", "/toggle-private"]) {
      expect(slash, `slash-commands page missing ${cmd}`).toContain(cmd);
    }
    expect(slash).toContain("| Command | Purpose |");
  });

  it("includes the capture matrix and keeps its external links", () => {
    expect(capture).toMatch(/title: Harness capture matrix/);
    expect(capture).toContain("POST /transcript");
    expect(capture).toContain("https://github.com/mem0ai/mem0");
  });

  it("leaves no repo-relative links that would 404 the site link-checker", () => {
    expect(slash, "slash-commands page still has a repo-relative link").not.toMatch(
      REPO_RELATIVE_LINK,
    );
    expect(capture, "capture-matrix page still has a repo-relative link").not.toMatch(
      REPO_RELATIVE_LINK,
    );
  });

  it("strips the source's leading H1 so the page has a single title", () => {
    // Body (after frontmatter) must not begin with a top-level '# ' heading.
    for (const [name, page] of [
      ["slash-commands", slash],
      ["capture-matrix", capture],
    ] as const) {
      const body = page.replace(/^---\n[\s\S]*?\n---\n/, "");
      expect(body, `${name} body should not start with an H1`).not.toMatch(/^\s*#\s/);
    }
  });
});

describe("private-mode correction caveat parity", () => {
  const surfaces = [
    "packages/core/src/primer.ts",
    "docs/slash-commands.md",
    "integrations/claude/README.md",
    "integrations/claude/commands/toggle-private.md",
    "integrations/codex/README.md",
    "integrations/hermes/README.md",
    "integrations/hermes/librarian/commands.py",
    "integrations/opencode/README.md",
    "integrations/opencode/commands/toggle-private.md",
    "integrations/pi/README.md",
    "integrations/pi/extensions/librarian/commands.ts",
  ];

  it("warns on every harness surface that queued public correction work may finish while private", () => {
    for (const file of surfaces) {
      const content = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      expect(content, `${file}: server-side limitation missing`).toMatch(
        /server cannot verify its\s+marker/,
      );
      expect(content, `${file}: queued-work timing missing`).toMatch(
        /from public\s+context may still finish\s+after switching private/,
      );
      expect(content, `${file}: non-cancellation guarantee missing`).toMatch(
        /cancel\s+queued work/,
      );
    }
  });
});
