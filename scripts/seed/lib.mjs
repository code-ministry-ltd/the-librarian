// Seed/migration helpers (spec 038 superseded — see scripts/seed/README.md).
//
// A us-only tool to bootstrap / re-seed a markdown vault from an external raw
// layer, grooming everything through the intake. Pure helpers + the
// import orchestration live here so they're unit-testable; the `extract.mjs` /
// `import.mjs` bins are thin arg-parsing wrappers.
//
// Design (settled 2026-06-03): references are copied verbatim; every memory
// (hand-authored `memories/**` + an exported SQLite `extract/**`) is replayed
// through the REAL `remember` MCP handler in-process, intake ON, seed-first;
// the intake then grooms the inbox (navigate→judge→file with [[wikilinks]]).
// Re-seeding = wipe the vault + re-run. No manifest, no idempotency layer.

import fs from "node:fs";
import path from "node:path";
import { handleMcpPayload } from "@librarian/mcp-server";

const MAX_TITLE = 120;

const unquote = (s) => s.replace(/^["']|["']$/g, "");

/**
 * Minimal frontmatter split — `{ data, content }`. Dependency-free (the script
 * stays self-contained). Handles the only shapes a seed file needs: scalars,
 * inline `[a, b]` arrays, and block `- item` arrays. No frontmatter → all body.
 */
export function parseFrontmatter(input) {
  // Normalise CRLF first — otherwise `split("\n")` leaves a trailing \r that the
  // key/value regex never matches, silently dropping every frontmatter field
  // (Windows / git autocrlf checkouts).
  const raw = input.replace(/\r\n/g, "\n");
  if (!raw.startsWith("---")) return { data: {}, content: raw };
  const close = raw.indexOf("\n---", 3);
  if (close === -1) return { data: {}, content: raw };
  const block = raw.slice(raw.indexOf("\n") + 1, close);
  const content = raw.slice(close + 4).replace(/^\r?\n/, "");
  const data = {};
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    if (value === "") {
      const arr = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        arr.push(unquote(lines[(i += 1)].replace(/^\s*-\s+/, "").trim()));
      }
      data[key] = arr;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
    } else {
      data[key] = unquote(value);
    }
  }
  return { data, content };
}

/** Recursive list of `.md` files under `dir`, returned as `{ rel, abs }` (posix rel), sorted. */
export function listMarkdown(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      // Skip dotfiles + dot-directories: hidden config (.obsidian, .git) and —
      // crucially — macOS AppleDouble sidecars (._Foo.md), which are BINARY
      // resource forks that share the .md extension. Importing them feeds the
      // intake garbage (and the LLM chokes on the binary blob).
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push({ rel: path.relative(dir, abs).split(path.sep).join("/"), abs });
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Route a source layer by folder (the settled convention): `memories/` →
 * memories, `references/` → references. Anything else is ignored (with a note).
 */
export function routeSourceDir(sourceDir) {
  return {
    memoryFiles: listMarkdown(path.join(sourceDir, "memories")),
    referenceFiles: listMarkdown(path.join(sourceDir, "references")),
  };
}

/** First markdown heading text, else first non-empty line, else the filename stem. */
export function deriveTitle(body, relPath) {
  for (const line of body.split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (heading) return heading[1].slice(0, MAX_TITLE);
    if (line.trim()) return line.trim().slice(0, MAX_TITLE);
  }
  const stem = relPath.slice(relPath.lastIndexOf("/") + 1).replace(/\.md$/, "");
  return stem || "Untitled note";
}

/** Build `remember` arguments from a hand-authored markdown file (frontmatter optional). */
export function rememberArgsFromMarkdown(relPath, raw, agentId) {
  const { data, content } = parseFrontmatter(raw);
  const body = content.trim();
  const args = { agent_id: agentId, title: deriveTitle(body, relPath), body };
  if (Array.isArray(data.tags)) args.tags = data.tags.filter((t) => typeof t === "string");
  if (Array.isArray(data.applies_to)) {
    args.applies_to = data.applies_to.filter((a) => typeof a === "string");
  }
  const projectKeys = importedProjectKeys(data);
  if (projectKeys !== undefined) args.project_keys = projectKeys;
  return args;
}

/** Build `remember` arguments from one exported SQLite memory record (extract/*.json). */
export function rememberArgsFromExtractRecord(rec, fallbackAgentId) {
  const args = {
    agent_id: typeof rec.agent_id === "string" && rec.agent_id ? rec.agent_id : fallbackAgentId,
    title: typeof rec.title === "string" ? rec.title : "Untitled note",
    body: typeof rec.body === "string" ? rec.body : "",
  };
  if (Array.isArray(rec.tags)) args.tags = rec.tags.filter((t) => typeof t === "string");
  if (Array.isArray(rec.applies_to))
    args.applies_to = rec.applies_to.filter((a) => typeof a === "string");
  const projectKeys = importedProjectKeys(rec);
  if (projectKeys !== undefined) args.project_keys = projectKeys;
  return args;
}

function importedProjectKeys(input) {
  if (Array.isArray(input.project_keys)) {
    return input.project_keys.filter((key) => typeof key === "string");
  }
  if (typeof input.project_key === "string" && input.project_key.length > 0) {
    return [input.project_key];
  }
  return undefined;
}

/** Read exported `extract/*.json` records from a directory. */
export function readExtractRecords(extractDir) {
  if (!extractDir || !fs.existsSync(extractDir)) return [];
  return fs
    .readdirSync(extractDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(extractDir, f), "utf8")));
}

/**
 * Fail-fast probe of the intake LLM: one tiny completion so a bad
 * endpoint / model / token surfaces in ~2s, BEFORE the import loads the ~300MB
 * embedder and replays every memory. Resolves on success; rethrows the client's
 * error otherwise (the bin turns it into a friendly message).
 *
 * Probes in PLAIN-TEXT mode (`jsonResponse: false`). The client defaults to
 * json_object response_format, but OpenAI-compatible providers (incl. DeepSeek)
 * return HTTP 400 in json mode unless the prompt contains the word "json", and a
 * tight max_tokens can't fit a JSON object — both would make this synthetic probe
 * a false negative. A plain-text call still validates what a preflight is for:
 * endpoint reachable, model exists, token accepted. Any json-mode-specific issue
 * surfaces on the first real judge call (which the sweep error-surfacing reports).
 */
export async function preflightLlm(llmClient) {
  await llmClient.complete({
    messages: [{ role: "user", content: "Reply with: ok" }],
    jsonResponse: false,
  });
}

/** Invoke the real `remember` MCP handler in-process. Returns its result text. */
export async function remember(store, args) {
  const res = await handleMcpPayload(store, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "remember", arguments: args },
  });
  return res?.result?.content?.[0]?.text ?? "";
}

/** Copy reference files verbatim into the vault, never overwriting an existing one. */
export function copyReferences(referenceFiles, vaultReferencesDir) {
  let copied = 0;
  for (const file of referenceFiles) {
    const dest = path.join(vaultReferencesDir, file.rel);
    if (fs.existsSync(dest)) continue; // never overwrite
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file.abs, dest);
    copied += 1;
  }
  return copied;
}

/** Clear the derived knowledge from a vault (memories/references/inbox + the index). NOT the source. */
export function wipeVaultKnowledge(vaultRoot) {
  const removed = [];
  for (const sub of ["memories", "references", "inbox", ".index"]) {
    const target = path.join(vaultRoot, sub);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(sub);
    }
  }
  return removed;
}

/**
 * Run the seed import against a markdown store (intake ON): wipe (optional),
 * copy references verbatim, replay every memory through `remember` SEED-FIRST
 * (hand-authored `memories/**` before the SQLite `extract/**`), then drain the
 * inbox through the intake. Returns a summary. `llmClient` is injected (a
 * real curator client from the bin; a scripted one in tests).
 */
export async function runSeedImport({
  store,
  vaultRoot,
  sourceDir,
  extractDir,
  llmClient,
  agentId = "seed-import",
  wipe = false,
}) {
  const summary = { wiped: [], referencesCopied: 0, remembered: 0, sweep: null };

  // Intake enablement is now the `curator.intake.enabled` setting (spec 043 D-E),
  // not the LIBRARIAN_CONSOLIDATOR env. Turn it on for this store so `remember`
  // routes submissions to the inbox; the explicit runIntakeSweep below drains
  // it (this script runs in-process with no scheduler). Idempotent.
  store.setSetting("curator.intake.enabled", "true");

  if (wipe) summary.wiped = wipeVaultKnowledge(vaultRoot);

  const { memoryFiles, referenceFiles } = routeSourceDir(sourceDir);
  summary.referencesCopied = copyReferences(referenceFiles, path.join(vaultRoot, "references"));

  // Seed-first: hand-authored memory docs, then the exported SQLite records — so
  // DB memories merge ONTO the curated context, not the reverse.
  for (const file of memoryFiles) {
    await remember(
      store,
      rememberArgsFromMarkdown(file.rel, fs.readFileSync(file.abs, "utf8"), agentId),
    );
    summary.remembered += 1;
  }
  for (const rec of readExtractRecords(extractDir)) {
    await remember(store, rememberArgsFromExtractRecord(rec, agentId));
    summary.remembered += 1;
  }

  // Drain the inbox: this script runs in-process with no scheduler, so we groom
  // explicitly (the http server would do this on a tick).
  const errors = [];
  summary.sweep = await store.runIntakeSweep({
    llmClient,
    onError: (e) => errors.push(e instanceof Error ? e.message : String(e)),
  });
  // A failing sweep is usually the SAME error 212 times (bad model/key) — surface
  // the first few distinct messages so it's not a silent count.
  summary.errors = [...new Set(errors)].slice(0, 3);
  return summary;
}
