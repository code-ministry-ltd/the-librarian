// MCP dispatch behaviour tests.
//
// Migrated from packages/mcp-server/tests/mcp.test.js as part of T4.2.
// Behaviour coverage is identical to the pre-migration suite — these
// tests exercise the tool registry, role gating, JSON-RPC error
// envelope, and resource visibility through `handleMcpPayload`.

import { handleMcpPayload } from "@librarian/mcp-server";
import { describe, expect, it } from "vitest";
import { withStore } from "../../../../test/helpers.js";

describe("MCP dispatch", () => {
  it("exposes the expected server identity and tool surface", async () => {
    await withStore(async (store) => {
      const init = (await handleMcpPayload(store, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      })) as { result: { serverInfo: { name: string } } };
      expect(init.result.serverInfo.name).toBe("the-librarian");

      const list = (await handleMcpPayload(store, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      })) as { result: { tools: { name: string }[] } };
      const toolNames = list.result.tools.map((tool) => tool.name);
      for (const expected of [
        "recall",
        "remember",
        "flag_memory",
        "search_references",
        "store_handoff",
        "list_handoffs",
        "claim_handoff",
        "journal",
      ]) {
        expect(toolNames).toContain(expected);
      }
      // Retired by ADR 0006 (find_skills/session_manifest) and rethink T1
      // (the whole skills subsystem, list_skills/get_skill included).
      expect(toolNames).not.toContain("find_skills");
      expect(toolNames).not.toContain("session_manifest");
      expect(toolNames).not.toContain("list_skills");
      expect(toolNames).not.toContain("get_skill");
      // Retired by rethink T2 (D10) — conv_state is deleted, not hidden.
      expect(toolNames).not.toContain("conv_state_get");
      expect(toolNames).not.toContain("conv_state_upsert");
      expect(toolNames).not.toContain("conv_state_clear");
      // Removed in ADR 0006 PR-4 — redundant/admin verbs whose capabilities
      // now live only on the dashboard tRPC surface. Gone under EVERY role.
      for (const removed of [
        "start_context",
        "propose_memory",
        "update_memory",
        "archive_memory",
        "list_proposals",
        "approve_proposal",
      ]) {
        expect(toolNames).not.toContain(removed);
      }
      // Retired in V1.2 — should no longer be advertised under any role.
      expect(toolNames).not.toContain("delete_memory");
      expect(toolNames).not.toContain("resolve_conflict");

      const adminList = (await handleMcpPayload(
        store,
        { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
        { role: "admin" },
      )) as { result: { tools: { name: string }[] } };
      const adminToolNames = adminList.result.tools.map((tool) => tool.name);
      // The admin role lists the same agent surface — the removed admin verbs
      // are not re-exposed to admins either.
      for (const removed of [
        "approve_proposal",
        "archive_memory",
        "delete_memory",
        "resolve_conflict",
      ]) {
        expect(adminToolNames).not.toContain(removed);
      }
    });
  });

  it("remember lands identity memories as active (Section 4d.3 — legacy category gate retired)", async () => {
    await withStore(async (store) => {
      const write = (await handleMcpPayload(store, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "remember",
          arguments: {
            agent_id: "codex",
            title: "User wants reviewed identity",
            body: "Identity memories should be reviewed before activation.",
            category: "identity",
            visibility: "common",
            scope: "global",
          },
        },
      })) as { result: { content: { text: string }[] } };

      // Section 4d.3 — agents no longer get protected routing for free
      // via `category=identity`. The memory lands at status=active.
      // Sensitive content is instead handled by the operator via the
      // dashboard's explicit approval flow.
      expect(write.result.content[0].text).toMatch(/Memory saved/);
      expect(store.listAll({ status: "active" }).length).toBe(1);

      await handleMcpPayload(store, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "remember",
          arguments: {
            agent_id: "codex",
            title: "MCP endpoint path",
            body: "Remote agents should POST JSON-RPC messages to /mcp.",
            category: "tools",
            visibility: "common",
            scope: "tool",
            tags: ["mcp", "http"],
          },
        },
      });

      const recall = (await handleMcpPayload(store, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "recall",
          arguments: {
            agent_id: "codex",
            query: "remote agents POST JSON-RPC",
            limit: 3,
          },
        },
      })) as { result: { content: { text: string }[] } };

      const text = recall.result.content[0].text;
      expect(text).toMatch(/Remote agents should POST JSON-RPC messages to \/mcp/);
      expect(text).not.toMatch(/mem_[a-f0-9-]+/);
    });
  });

  it("recall prefixes each line with the memory id when include_ids is true", async () => {
    // Lets callers (e.g. the Hermes plugin's `recall` wrapper) plumb ids
    // through to a subsequent `flag_memory` call — the flag-after-recall
    // loop documented in the harness slash-command guide.
    await withStore(async (store) => {
      await handleMcpPayload(store, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "remember",
          arguments: {
            agent_id: "codex",
            title: "Verify-after-recall needs ids",
            body: "Recall must surface memory ids so flag_memory can target one.",
            category: "tools",
            scope: "tool",
          },
        },
      });

      const recall = (await handleMcpPayload(store, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "recall",
          arguments: {
            agent_id: "codex",
            query: "verify after recall",
            include_ids: true,
            limit: 3,
          },
        },
      })) as { result: { content: { text: string }[] } };

      const text = recall.result.content[0].text;
      expect(text).toMatch(/^- \[mem_[a-f0-9-]+\] /m);
      expect(text).toMatch(/Verify-after-recall needs ids/);
    });
  });

  it("store.startContext surfaces approved is_global memories (Section 4d.3 — bucketing is by is_global, not category)", async () => {
    // The `start_context` MCP tool was removed in ADR 0006 PR-4, but the
    // underlying `store.startContext` capability stays (the dashboard / primer
    // depend on it), so the behaviour is still pinned here against the store.
    await withStore(async (store) => {
      // Dashboard-style write: explicitly opted into requires_approval
      // so the memory enters the proposal queue, plus the admin-decided
      // is_global flag (via the trusted options channel).
      const identity = store.createMemory(
        {
          agent_id: "dashboard",
          title: "User identity baseline",
          body: "The user is building a portable memory system for agents.",
          category: "identity",
        },
        { requires_approval: true, is_global: true },
      );
      const relationship = store.createMemory(
        {
          agent_id: "dashboard",
          title: "Relationship baseline",
          body: "The user wants memory behavior to preserve continuity without noisy bookkeeping.",
          category: "relationship",
        },
        { requires_approval: true, is_global: true },
      );
      store.approveProposal(identity.memory.id, "approve", {}, "dashboard");
      store.approveProposal(relationship.memory.id, "approve", {}, "dashboard");

      const context = store.startContext({
        agent_id: "codex",
        task_summary: "write deployment tests",
      });

      const text = context.text;
      expect(text).toMatch(/portable memory system/);
      expect(text).toMatch(/preserve continuity/);
    });
  });

  it("returns JSON-RPC errors for unknown methods instead of throwing outward", async () => {
    await withStore(async (store) => {
      const result = (await handleMcpPayload(store, {
        jsonrpc: "2.0",
        id: 99,
        method: "does/not/exist",
        params: {},
      })) as { id: number; error: { code: number; message: string } };

      expect(result.id).toBe(99);
      expect(result.error.code).toBe(-32000);
      expect(result.error.message).toMatch(/Unsupported method/);
    });
  });

  it("the six redundant/admin verbs removed in ADR 0006 PR-4 are no longer callable", async () => {
    // Their capabilities live on the dashboard tRPC surface now; over the MCP
    // boundary a call to any of them returns a JSON-RPC error (unknown tool),
    // never an admin-gating error and never a side effect on the store.
    await withStore(async (store) => {
      const ordinary = store.createMemory({
        agent_id: "codex",
        title: "Ordinary note",
        body: "Must be untouched by any removed verb.",
        category: "tools",
        visibility: "common",
        scope: "tool",
      });

      const removed = [
        "start_context",
        "propose_memory",
        "update_memory",
        "archive_memory",
        "list_proposals",
        "approve_proposal",
      ];
      let id = 1;
      for (const name of removed) {
        const result = (await handleMcpPayload(
          store,
          {
            jsonrpc: "2.0",
            id: id++,
            method: "tools/call",
            params: { name, arguments: { agent_id: "codex", memory_id: ordinary.memory.id } },
          },
          // even an admin can't reach them — they're gone, not gated.
          { role: "admin" },
        )) as { error: { message: string } };
        expect(result.error.message).toMatch(/Unknown tool/);
      }

      // The seeded memory is untouched — no removed verb had any effect.
      expect(store.getMemory(ordinary.memory.id).status).toBe("active");
    });
  });

  it("memory resource surfaces every active memory (Section 4d.3 — agent-private memory visibility retired)", async () => {
    await withStore(async (store) => {
      store.createMemory({
        agent_id: "dashboard",
        title: "Common memory",
        body: "Common memory should be visible through the resource.",
      });
      store.createMemory({
        agent_id: "codex",
        title: "Codex memory",
        body: "Codex should use pnpm for local workspace commands.",
      });
      store.createMemory({
        agent_id: "claude",
        title: "Claude memory",
        body: "Claude should use uv for isolated Python command checks.",
      });

      const sharedAgent = (await handleMcpPayload(store, {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "librarian://memories" },
      })) as { result: { contents: { text: string }[] } };
      const sharedText = sharedAgent.result.contents[0].text;
      // Section 4d.3 — visibility-based privacy gate retired. All
      // memories are surfaced; per-agent isolation, if needed, must
      // be enforced via tags at the recall surface.
      expect(sharedText).toMatch(/Common memory/);
      expect(sharedText).toMatch(/Codex memory/);
      expect(sharedText).toMatch(/Claude memory/);

      const codexAgent = (await handleMcpPayload(
        store,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "resources/read",
          params: { uri: "librarian://memories" },
        },
        { role: "agent", agentId: "codex" },
      )) as { result: { contents: { text: string }[] } };
      const codexText = codexAgent.result.contents[0].text;
      expect(codexText).toMatch(/Common memory/);
      expect(codexText).toMatch(/Codex memory/);
      expect(codexText).toMatch(/Claude memory/);

      const admin = (await handleMcpPayload(
        store,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "resources/read",
          params: { uri: "librarian://memories" },
        },
        { role: "admin" },
      )) as { result: { contents: { text: string }[] } };
      const adminText = admin.result.contents[0].text;
      expect(adminText).toMatch(/Common memory/);
      expect(adminText).toMatch(/Codex memory/);
      expect(adminText).toMatch(/Claude memory/);
    });
  });
});
