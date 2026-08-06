// scripts/seed — the us-only seed/migration tool. Pure helpers (folder routing,
// remember-arg derivation) + the import orchestration driven end-to-end against a
// real markdown store with a SCRIPTED intake (no network): references copy
// verbatim, memories replay through the real `remember` handler seed-first, the
// intake grooms them, and `--wipe` clears the derived vault.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  INTAKE_ENABLED_KEY,
  type InternalLibrarianStore,
  createLibrarianStore,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const lib = await import(path.resolve(__dirname, "..", "scripts", "seed", "lib.mjs"));

// A scripted curator brain: files every submission as a fresh `create`.
const scriptedClient = {
  async complete() {
    return {
      content: JSON.stringify({
        action: "create",
        title: "Filed",
        body: "Body.",
        tags: [],
        rationale: "r",
        confidence: 0.99,
      }),
      model: "scripted",
      usage: null,
    };
  },
};

describe("seed lib — listMarkdown", () => {
  it("returns real .md files but skips dotfiles and macOS AppleDouble (._*) sidecars", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-listmd-"));
    try {
      fs.writeFileSync(path.join(dir, "Family.md"), "# Family\nreal note");
      fs.writeFileSync(path.join(dir, "._Family.md"), "  binary resource fork");
      fs.mkdirSync(path.join(dir, ".obsidian"));
      fs.writeFileSync(path.join(dir, ".obsidian", "workspace.md"), "hidden config");
      const rels = lib.listMarkdown(dir).map((f: { rel: string }) => f.rel);
      expect(rels).toEqual(["Family.md"]); // only the real file — junk + hidden excluded
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("seed lib — pure helpers", () => {
  it("derives a title from the first heading, else first line, else filename", () => {
    expect(lib.deriveTitle("# Communication Style\n\nbody", "x.md")).toBe("Communication Style");
    expect(lib.deriveTitle("just a line\nmore", "x.md")).toBe("just a line");
    expect(lib.deriveTitle("", "context/role-and-responsibilities.md")).toBe(
      "role-and-responsibilities",
    );
  });

  it("builds remember args from markdown, honouring optional frontmatter", () => {
    const withFm = lib.rememberArgsFromMarkdown(
      "a.md",
      "---\ntags: [identity]\napplies_to: [Guybrush]\nproject_key: proj-x\n---\n# Elaine\nmoved",
      "agent-a",
    );
    expect(withFm).toMatchObject({
      agent_id: "agent-a",
      title: "Elaine",
      tags: ["identity"],
      applies_to: ["Guybrush"],
      project_keys: ["proj-x"],
    });
    // Scalar compatibility input is normalised; callers never write it back.
    expect(withFm).not.toHaveProperty("project_key");
    const plural = lib.rememberArgsFromMarkdown(
      "plural.md",
      "---\nproject_keys: [proj-x, proj-y]\nproject_key: ignored\n---\n# Plural\nbody",
      "agent-a",
    );
    expect(plural.project_keys).toEqual(["proj-x", "proj-y"]);
    const noFm = lib.rememberArgsFromMarkdown("b.md", "# Plain\ntext", "agent-a");
    expect(noFm).toEqual({ agent_id: "agent-a", title: "Plain", body: "# Plain\ntext" });

    // CRLF-authored frontmatter must still parse (Windows / git autocrlf).
    const crlf = lib.rememberArgsFromMarkdown(
      "c.md",
      "---\r\ntags: [a, b]\r\n---\r\n# T\r\nbody",
      "agent-a",
    );
    expect(crlf.tags).toEqual(["a", "b"]);
  });

  it("builds remember args from an extract record, falling back the agent id", () => {
    expect(
      lib.rememberArgsFromExtractRecord({ title: "T", body: "B", tags: ["x"] }, "fallback"),
    ).toEqual({ agent_id: "fallback", title: "T", body: "B", tags: ["x"] });
    expect(
      lib.rememberArgsFromExtractRecord(
        { title: "T", body: "B", project_key: "legacy-project" },
        "fallback",
      ),
    ).toMatchObject({ project_keys: ["legacy-project"] });
    expect(
      lib.rememberArgsFromExtractRecord(
        {
          title: "T",
          body: "B",
          project_key: "ignored",
          project_keys: ["current-project"],
        },
        "fallback",
      ),
    ).toMatchObject({ project_keys: ["current-project"] });
  });

  it("preflightLlm resolves when the LLM answers, and rethrows when it errors", async () => {
    await expect(lib.preflightLlm(scriptedClient)).resolves.toBeUndefined();
    const throwing = {
      async complete() {
        throw new Error("HTTP 401: invalid key");
      },
    };
    // Fails fast — the bad key surfaces here, before any embedder load / import.
    await expect(lib.preflightLlm(throwing)).rejects.toThrow("HTTP 401");
  });

  it("preflightLlm probes in plain-text mode (json_object would 400 on this synthetic prompt)", async () => {
    let seen: { jsonResponse?: boolean } | undefined;
    await lib.preflightLlm({
      async complete(req: { jsonResponse?: boolean }) {
        seen = req;
        return { content: "ok", model: "m", usage: null };
      },
    });
    // The bug guard: OpenAI-compatible providers 400 in json mode unless the
    // prompt says "json", so the probe must NOT request json_object.
    expect(seen?.jsonResponse).toBe(false);
  });
});

describe("seed lib — runSeedImport (end to end, scripted intake)", () => {
  let dataDir = "";
  let sourceDir = "";
  let store: InternalLibrarianStore | null = null;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-seed-data-"));
    sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-seed-src-"));
    fs.mkdirSync(path.join(sourceDir, "memories"), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, "references", "AI"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, "memories", "identity.md"),
      "# Identity\nGuybrush builds agents.",
    );
    fs.writeFileSync(path.join(sourceDir, "references", "AI", "note.md"), "# Background\nlong doc");
    store = createLibrarianStore({ dataDir, backend: "markdown" });
    // Intake enablement is now the `curator.intake.enabled` setting (spec 043
    // D-E), not the LIBRARIAN_CONSOLIDATOR env — route remember → inbox.
    store.setSetting(INTAKE_ENABLED_KEY, "true");
  });
  afterEach(() => {
    try {
      store?.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(sourceDir, { recursive: true, force: true });
  });

  it("copies references verbatim and grooms memories through the intake", async () => {
    const summary = await lib.runSeedImport({
      store,
      vaultRoot: path.join(dataDir, "vault"),
      sourceDir,
      llmClient: scriptedClient,
    });

    expect(summary.referencesCopied).toBe(1);
    expect(summary.remembered).toBe(1);
    // The reference landed verbatim in the vault, subpath preserved.
    expect(fs.existsSync(path.join(dataDir, "vault", "references", "AI", "note.md"))).toBe(true);
    // The memory was submitted + groomed into an active memory by the (scripted) curator.
    expect(store!.listMemories({ status: "active" }).total).toBeGreaterThanOrEqual(1);
  });

  it("--wipe clears the derived vault before re-importing", async () => {
    await lib.runSeedImport({
      store,
      vaultRoot: path.join(dataDir, "vault"),
      sourceDir,
      llmClient: scriptedClient,
    });
    const before = store!.listMemories({ status: "active" }).total;
    expect(before).toBeGreaterThanOrEqual(1);

    const summary = await lib.runSeedImport({
      store,
      vaultRoot: path.join(dataDir, "vault"),
      sourceDir,
      llmClient: scriptedClient,
      wipe: true,
    });
    expect(summary.wiped).toContain("memories");
    // Rebuilt from the source, not doubled.
    expect(store!.listMemories({ status: "active" }).total).toBe(before);
  });

  it("surfaces the intake error instead of a silent count", async () => {
    const throwing = {
      async complete() {
        throw new Error("HTTP 400: model not found");
      },
    };
    const summary = await lib.runSeedImport({
      store,
      vaultRoot: path.join(dataDir, "vault"),
      sourceDir,
      llmClient: throwing,
    });
    expect(summary.sweep.errored).toBeGreaterThanOrEqual(1);
    expect(summary.errors).toContain("HTTP 400: model not found");
  });
});
