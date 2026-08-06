// remember verb — inbox cutover routing (plan 036 Phase 4 / spec 035 §F5).
// When intake is enabled (the `curator.intake.enabled` setting, spec 043 D-E)
// AND the store is on the markdown backend, `remember` is a fire-and-forget
// submission to the intake inbox; otherwise it writes directly via
// createMemory (the legacy path, unchanged by default). Dispatched through
// handleMcpPayload over a real store.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  INTAKE_ENABLED_KEY,
  type LibrarianStore,
  type Project,
  createLibrarianStore,
  parseInboxItem,
} from "@librarian/core";
import { handleMcpPayload } from "@librarian/mcp-server";
import { afterEach, describe, expect, it } from "vitest";

let store: LibrarianStore | null = null;
let dataDir = "";

function makeStore(): void {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-remember-"));
  store = createLibrarianStore({ dataDir });
}

afterEach(() => {
  try {
    store?.close();
  } catch {
    /* ignore */
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  store = null;
});

type CallResult = { result: { content: { text: string }[] } };
const remember = (args: Record<string, unknown>): Promise<unknown> =>
  handleMcpPayload(store as never, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "remember", arguments: args },
  });
const text = (res: unknown): string => (res as CallResult).result.content[0]!.text;

function project(status: Project["status"] = "active"): Project {
  const section = { content: "", ownership: "automatic" as const, source_ids: [] };
  return {
    id: `prj_${status}`,
    key: "the-librarian",
    display_name: "The Librarian",
    aliases: [],
    repository_identifiers: [],
    status,
    resolution: null,
    resolved_project_id: null,
    proposal_rationale: status === "proposed" ? "Possible project" : null,
    proposal_evidence_ids: status === "proposed" ? ["inbox:1"] : [],
    suppression_fingerprint: null,
    possible_match_ids: [],
    sections: {
      what_this_project_is: { ...section },
      technology_and_architecture: { ...section },
      current_state: { ...section },
      last_meaningful_work: { ...section },
      planned_next: { ...section },
      blockers_and_uncertainties: { ...section },
    },
    compiled_at: null,
    compiler_version: null,
    source_watermark: null,
    source_ids: [],
    content_hash: null,
    refresh_status: "not_built",
    refresh_failure_class: null,
    pending_source_count: 0,
    unresolved_conflict_count: 0,
    last_activity_at: null,
    created_at: "2026-08-06T00:00:00.000Z",
    updated_at: "2026-08-06T00:00:00.000Z",
  };
}

describe("remember verb — inbox cutover routing", () => {
  it("submits to the inbox (not a memory) when intake is enabled + markdown", async () => {
    makeStore();
    store!.setSetting(INTAKE_ENABLED_KEY, "true");

    const res = await remember({ title: "Elaine", body: "moved to Berlin", agent_id: "agent-a" });

    expect(text(res)).toMatch(/queued for consolidation/i);
    // Nothing filed as a memory yet — it's in the inbox awaiting intake.
    expect(store!.listMemories({}).total).toBe(0);
    const inboxFiles = fs
      .readdirSync(path.join(dataDir, "vault", "inbox"))
      .filter((f) => f.endsWith(".md"));
    expect(inboxFiles).toHaveLength(1);
  });

  it("writes directly (createMemory) when intake is off — the default", async () => {
    makeStore();
    // curator.intake.enabled unset → default off.

    const res = await remember({ title: "T", body: "B", agent_id: "agent-a" });

    expect(text(res)).toMatch(/Memory saved/);
    expect(store!.listMemories({ status: "active" }).total).toBe(1);
  });

  it("stores project_keys only when every key names an active project on the write shelf", async () => {
    makeStore();
    store!.projects.create(project());

    const res = await remember({
      title: "Briefing compiler",
      body: "The compiler is live.",
      agent_id: "agent-a",
      project_keys: ["the-librarian"],
    });

    expect(text(res)).toMatch(/Memory saved/);
    expect(store!.listMemories({}).memories[0]?.project_keys).toEqual(["the-librarian"]);
  });

  it("rejects missing or inactive project associations without writing a memory", async () => {
    makeStore();
    store!.projects.create(project("archived"));

    const archived = await remember({
      title: "Old",
      body: "Old project fact",
      agent_id: "agent-a",
      project_keys: ["the-librarian"],
    });
    const missing = await remember({
      title: "Unknown",
      body: "Unknown project fact",
      agent_id: "agent-a",
      project_keys: ["missing-project"],
    });

    expect(archived).toHaveProperty("error.message", expect.stringMatching(/active project/i));
    expect(missing).toHaveProperty("error.message", expect.stringMatching(/active project/i));
    expect(store!.listMemories({}).total).toBe(0);
  });

  it("carries validated project_keys through the inbox when intake is enabled", async () => {
    makeStore();
    store!.projects.create(project());
    store!.setSetting(INTAKE_ENABLED_KEY, "true");

    await remember({
      title: "Briefing compiler",
      body: "The compiler is live.",
      agent_id: "agent-a",
      project_keys: ["the-librarian"],
    });

    const inboxFile = fs
      .readdirSync(path.join(dataDir, "vault", "inbox"))
      .find((file) => file.endsWith(".md"))!;
    const item = parseInboxItem(
      fs.readFileSync(path.join(dataDir, "vault", "inbox", inboxFile), "utf8"),
    );
    expect(item.hints.projectKeys).toEqual(["the-librarian"]);
  });

  it("respects the setting toggled off even after it was on", async () => {
    makeStore();
    store!.setSetting(INTAKE_ENABLED_KEY, "true");
    store!.setSetting(INTAKE_ENABLED_KEY, "false");

    const res = await remember({ title: "T", body: "B", agent_id: "agent-a" });

    expect(text(res)).toMatch(/Memory saved/);
    expect(store!.listMemories({ status: "active" }).total).toBe(1);
  });

  it("falls through to a direct write for an empty submission (no empty inbox item to loop on)", async () => {
    makeStore();
    store!.setSetting(INTAKE_ENABLED_KEY, "true");

    // No title and no body → nothing to file.
    const res = await remember({ agent_id: "agent-a" });

    expect(text(res)).toMatch(/Memory saved/);
    expect(store!.listMemories({ status: "active" }).total).toBe(1);
    const inboxDir = path.join(dataDir, "vault", "inbox");
    const inboxFiles = fs.existsSync(inboxDir)
      ? fs.readdirSync(inboxDir).filter((f) => f.endsWith(".md"))
      : [];
    expect(inboxFiles).toHaveLength(0);
  });
});
