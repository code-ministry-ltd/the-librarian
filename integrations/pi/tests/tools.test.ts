import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createMcpClient, type McpClient } from "../extensions/librarian/mcp-client.js";
import {
  LIBRARIAN_TOOL_NAMES,
  librarianToolSpecs,
  registerLibrarianTools,
} from "../extensions/librarian/tools.js";
import { mcpTextEnvelope, startFakeServer } from "./helpers/fake-server.js";

interface CapturedTool {
  name: string;
  description: string;
  parameters: { type?: string; properties?: Record<string, unknown>; required?: string[] };
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { type: string; text: string }[] }>;
}

function mockPi(): { pi: ExtensionAPI; tools: CapturedTool[] } {
  const tools: CapturedTool[] = [];
  const pi = {
    registerTool: (t: CapturedTool) => tools.push(t),
  } as unknown as ExtensionAPI;
  return { pi, tools };
}

function fakeClient(responder: (name: string, args: Record<string, unknown>) => string): {
  client: McpClient;
  calls: { name: string; args: Record<string, unknown> }[];
} {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client: McpClient = {
    async callTool(name, args) {
      calls.push({ name, args });
      return responder(name, args);
    },
  };
  return { client, calls };
}

describe("registerLibrarianTools", () => {
  it("registers exactly the 7 agent verbs of the rethink contract (§5.1)", () => {
    const { pi, tools } = mockPi();
    registerLibrarianTools(pi, fakeClient(() => "ok").client);
    expect(tools.map((t) => t.name).sort()).toEqual([...LIBRARIAN_TOOL_NAMES].sort());
    expect(tools).toHaveLength(7);
  });

  it("does not register any retired verb", () => {
    const { pi, tools } = mockPi();
    registerLibrarianTools(pi, fakeClient(() => "ok").client);
    const names = new Set(tools.map((t) => t.name));
    for (const retired of [
      "conv_state_get",
      "conv_state_upsert",
      "conv_state_clear",
      "list_skills",
      "get_skill",
      "verify_memory",
      "propose_memory",
    ]) {
      expect(names.has(retired)).toBe(false);
    }
  });

  it("proxies a call to the MCP client, dropping undefined args", async () => {
    const { pi, tools } = mockPi();
    const { client, calls } = fakeClient(() => "Found 2 memories…");
    registerLibrarianTools(pi, client);
    const recall = tools.find((t) => t.name === "recall")!;

    const result = await recall.execute("call-1", { query: "auth", limit: undefined });

    expect(calls[0]).toEqual({ name: "recall", args: { query: "auth" } });
    expect(result.content).toEqual([{ type: "text", text: "Found 2 memories…" }]);
  });

  it("returns the server's prose verbatim for a handoff round-trip", async () => {
    const { pi, tools } = mockPi();
    const { client, calls } = fakeClient(() => "Handoff stored.\n\nhandoff_id: hof_1");
    registerLibrarianTools(pi, client);
    const store = tools.find((t) => t.name === "store_handoff")!;

    const result = await store.execute("call-2", {
      title: "Resume the rethink",
      document_md: "## Start & intent\n…",
    });

    expect(calls[0]!.name).toBe("store_handoff");
    expect(result.content[0]!.text).toContain("hof_1");
  });

  it("every tool fails soft when the client throws — an error string, never a rejection", async () => {
    const { pi, tools } = mockPi();
    const client: McpClient = {
      async callTool() {
        throw new Error("socket hang up");
      },
    };
    registerLibrarianTools(pi, client);

    for (const tool of tools) {
      const result = await tool.execute("call-x", {});
      expect(result.content[0]!.type).toBe("text");
      expect(result.content[0]!.text).toContain("Librarian unavailable");
      // A raw transport error is never echoed into the model's context.
      expect(result.content[0]!.text).not.toContain("socket hang up");
    }
  });

  it("every tool fails soft against a real server that is down", async () => {
    // Bind a real port, then close it: the realistic "server down" shape.
    const probe = await startFakeServer((_req, res) => res.end());
    const endpoint = `${probe.url}/mcp`;
    await probe.close();

    const { pi, tools } = mockPi();
    const client = createMcpClient({ endpoint, token: "tok-".concat("down") });
    registerLibrarianTools(pi, client);

    for (const tool of tools) {
      const result = await tool.execute("call-y", {});
      expect(result.content[0]!.text).toContain("Librarian unavailable");
    }
  });

  it("round-trips through a live fake server end to end", async () => {
    const server = await startFakeServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(mcpTextEnvelope("Noted — queued for consolidation."));
    });
    try {
      const { pi, tools } = mockPi();
      const client = createMcpClient({ endpoint: `${server.url}/mcp`, token: "tok-live" });
      registerLibrarianTools(pi, client);
      const remember = tools.find((t) => t.name === "remember")!;

      const result = await remember.execute("call-3", {
        title: "Prefers pnpm",
        body: "The user uses pnpm across all projects.",
        tags: ["tooling"],
      });

      expect(result.content[0]!.text).toBe("Noted — queued for consolidation.");
      const sent = JSON.parse(server.requests[0]!.body) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      expect(sent.params.name).toBe("remember");
      expect(sent.params.arguments.tags).toEqual(["tooling"]);
    } finally {
      await server.close();
    }
  });
});

describe("librarianToolSpecs (schema shape)", () => {
  it("every schema is a JSON-schema object and none leaks agent_id or conv_id", () => {
    for (const spec of librarianToolSpecs()) {
      const schema = spec.parameters as {
        type?: string;
        properties?: Record<string, unknown>;
      };
      expect(schema.type).toBe("object");
      expect(schema.properties && "agent_id" in schema.properties).toBeFalsy();
      expect(schema.properties && "conv_id" in schema.properties).toBeFalsy();
    }
  });

  it("pins the required fields of each writing/claiming verb", () => {
    const required = new Map(
      librarianToolSpecs().map((spec) => [
        spec.name,
        [...((spec.parameters as { required?: string[] }).required ?? [])].sort(),
      ]),
    );
    expect(required.get("recall")).toEqual([]);
    expect(required.get("remember")).toEqual(["body", "title"]);
    expect(required.get("flag_memory")).toEqual(["memory_id", "reason"]);
    expect(required.get("store_handoff")).toEqual(["document_md", "title"]);
    expect(required.get("list_handoffs")).toEqual([]);
    expect(required.get("claim_handoff")).toEqual(["handoff_id"]);
    expect(required.get("search_references")).toEqual(["query"]);
  });

  it("teaches the handoff protocol in the store_handoff description", () => {
    const spec = librarianToolSpecs().find((s) => s.name === "store_handoff")!;
    for (const heading of [
      "Start & intent",
      "Journey",
      "Current state",
      "What's left",
      "Open questions",
    ]) {
      expect(spec.description).toContain(heading);
    }
  });

  it("store_handoff description: explicit-request-only creation (mirrors the server)", () => {
    const spec = librarianToolSpecs().find((s) => s.name === "store_handoff")!;
    expect(spec.description).toMatch(/only call it when the user has explicitly asked/i);
    expect(spec.description).toMatch(/never spontaneously/i);
    expect(spec.description).not.toContain("Call it when pausing");
  });

  it("keeps every description within the 1KB teaching-surface budget (§5.1)", () => {
    for (const spec of librarianToolSpecs()) {
      expect(Buffer.byteLength(spec.description, "utf8")).toBeLessThanOrEqual(1024);
    }
  });
});
