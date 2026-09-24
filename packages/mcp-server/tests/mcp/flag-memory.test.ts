// flag_memory verb (spec 047 / ADR 0006) — and the retirement of verify_memory.
//
// An agent flags a memory as incorrect/misleading/outdated with a free-text
// reason. The tool durably queues targeted asynchronous correction review but
// does not wait for it or change the memory's status in the flagging turn. The
// flagger is resolved server-side, never client-supplied. Dispatched through
// handleMcpPayload over a real markdown-backed store.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SHELF,
  type LibrarianStore,
  type VaultRouter,
  createLibrarianStore,
} from "@librarian/core";
import { handleMcpPayload } from "@librarian/mcp-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let store: LibrarianStore | null = null;
let dataDir = "";

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-flag-"));
  store = createLibrarianStore({ dataDir });
});

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
type ErrResult = { error: { code: number; message: string } };

const call = (
  name: string,
  args: Record<string, unknown>,
  context: Parameters<typeof handleMcpPayload>[2] = {},
): Promise<unknown> =>
  handleMcpPayload(
    store as never,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
    context,
  );

const listToolNames = async (): Promise<string[]> => {
  const res = (await handleMcpPayload(store as never, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  })) as { result: { tools: { name: string }[] } };
  return res.result.tools.map((t) => t.name);
};

const text = (res: unknown): string => (res as CallResult).result.content[0]!.text;

describe("flag_memory verb", () => {
  it("records a free-text flag without changing the memory's status", async () => {
    const { memory } = store!.createMemory({ agent_id: "codex", title: "Old fact", body: "stale" });

    const res = await call("flag_memory", {
      agent_id: "codex",
      memory_id: memory.id,
      reason: "this is outdated",
    });

    expect(text(res)).toMatch(
      /targeted correction review was queued; no correction has completed yet/i,
    );
    expect(text(res)).toMatch(/tell the user it is queued, not already corrected/i);
    const after = store!.getMemory(memory.id)!;
    expect(after.status).toBe("active"); // route-to-review, never archive
    expect(after.flags).toHaveLength(1);
    expect(after.flags[0]).toMatchObject({ reason: "this is outdated" });
    expect(after.correction_work?.at(-1)).toMatchObject({
      status: "pending",
      shelf_id: "main",
    });
  });

  it("reports uncertain persistence when a write error occurs after the flag lands", async () => {
    const { memory } = store!.createMemory({ agent_id: "codex", title: "Old fact", body: "stale" });
    const originalForShelf = store!.forShelf.bind(store!);
    vi.spyOn(store!, "forShelf").mockImplementation((shelf, principal) => {
      const scoped = originalForShelf(shelf, principal);
      const originalFlag = scoped.flagMemoryForCorrection.bind(scoped);
      scoped.flagMemoryForCorrection = (input) => {
        originalFlag(input);
        throw new Error("simulated commit failure after persistence");
      };
      return scoped;
    });

    const response = await call("flag_memory", {
      memory_id: memory.id,
      reason: "the source is outdated",
    });

    expect(text(response)).toMatch(/may already be recorded/i);
    expect(text(response)).not.toMatch(/no flag was recorded/i);
    const persisted = store!.getMemory(memory.id)!;
    expect(persisted.flags).toHaveLength(1);
    expect(persisted.correction_work?.at(-1)).toMatchObject({ status: "pending" });
  });

  it("wakes correction work only after the durable marker is visible", async () => {
    const { memory } = store!.createMemory({ agent_id: "codex", title: "Old fact", body: "stale" });
    let wake: { memory_id: string; snapshot_digest: string } | undefined;
    let observedStatus: string | undefined;

    await call(
      "flag_memory",
      { memory_id: memory.id, reason: "this is outdated" },
      {
        principal: { kind: "agent", actorId: "claude", roles: ["agent"] },
        wakeMemoryCorrection(request) {
          wake = request;
          observedStatus = store!.getMemory(memory.id)?.correction_work?.at(-1)?.status;
        },
      },
    );

    expect(observedStatus).toBe("pending");
    expect(wake).toMatchObject({ memory_id: memory.id });
    expect(wake?.snapshot_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("routes custom-router flags to manual review without inferring synthetic admin authority", async () => {
    const customRouter = {
      shelves: () => [DEFAULT_SHELF],
      writeTarget: () => DEFAULT_SHELF,
    } satisfies VaultRouter;
    store!.close();
    store = createLibrarianStore({ dataDir, vaultRouter: customRouter });
    const { memory } = store.createMemory({ agent_id: "codex", title: "Old fact", body: "stale" });

    const result = await call(
      "flag_memory",
      {
        memory_id: memory.id,
        reason: "this is outdated",
      },
      {
        principal: { kind: "agent", actorId: "claude", roles: ["agent"] },
      },
    );

    expect(text(result)).toMatch(/custom vault-router authority cannot be independently verified/i);
    expect(store.getMemory(memory.id)?.status).toBe("active");
    expect(store.getMemory(memory.id)?.correction_work?.at(-1)).toMatchObject({
      status: "manual_review",
      reason_code: "custom_router_unverified",
    });
  });

  it("stamps the flag with the calling agent resolved from the authenticated context", async () => {
    const { memory } = store!.createMemory({ agent_id: "codex", title: "X", body: "y" });

    // The caller is authenticated as "claude"; the flagger is taken from that
    // context, not from anything the client could put in the body.
    await handleMcpPayload(
      store as never,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "flag_memory",
          arguments: { memory_id: memory.id, reason: "stale" },
        },
      },
      { role: "agent", agentId: "claude" },
    );

    const after = store!.getMemory(memory.id)!;
    expect(after.flags).toHaveLength(1);
    expect(after.flags[0]!.agent_id).toBe("claude");
  });

  it("rejects an impersonation attempt where a forged agent_id contradicts the authenticated caller", async () => {
    const { memory } = store!.createMemory({ agent_id: "codex", title: "X", body: "y" });

    const res = (await handleMcpPayload(
      store as never,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "flag_memory",
          arguments: { agent_id: "spoofed-victim", memory_id: memory.id, reason: "nope" },
        },
      },
      { role: "agent", agentId: "claude" },
    )) as { error: { message: string } };

    // The caller-identity resolver refuses to flag under a contradicting id, and
    // no flag is recorded.
    expect(res.error.message).toMatch(/impersonation|does not match/i);
    expect(store!.getMemory(memory.id)!.flags).toEqual([]);
  });

  it("rejects a flag with a blank reason and records nothing", async () => {
    const { memory } = store!.createMemory({ agent_id: "codex", title: "X", body: "y" });
    const res = await call("flag_memory", {
      agent_id: "codex",
      memory_id: memory.id,
      reason: "   ",
    });
    expect(text(res)).toMatch(/reason.*required/i);
    expect(store!.getMemory(memory.id)!.flags).toEqual([]);
  });

  it("advertises flag_memory in tools/list", async () => {
    expect(await listToolNames()).toContain("flag_memory");
  });
});

describe("verify_memory retirement", () => {
  it("no longer advertises verify_memory under any role", async () => {
    expect(await listToolNames()).not.toContain("verify_memory");
  });

  it("returns a tool-not-found error when verify_memory is called", async () => {
    const res = (await call("verify_memory", {
      memory_id: "mem_x",
      result: "useful",
    })) as ErrResult;
    expect(res.error.message).toMatch(/Unknown tool: verify_memory/);
  });
});
