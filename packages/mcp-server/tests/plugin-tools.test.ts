// Plugin tool registration (spec 060 T3, SC 4 + SC 7).
//
// Proves a build-time plugin's MCP tools JOIN the registry the dispatcher uses:
// they list (with the same role-filtering core tools get), dispatch through
// tools/call, and receive the identical (store, args, context) handler contract —
// and that a colliding registration is a LOUD construction-time refusal that names
// the offending plugin. Core behaviour with no plugins stays byte-identical (the
// unedited existing suites are the proof; this file only adds the plugin cases).
//
// Dispatch is exercised through the SAME `handleMcpPayload` the /mcp route calls,
// threaded with the merged registry `buildToolRegistry` produces — so it tests the
// real dispatch path, not a stand-in. Collisions are exercised through the real
// factory, `createLibrarianServer`, per the task's "throws at construction time".
//
// Imports the compiled artifacts (../dist), like the other internal-module suites.

import { type ToolDefinition, handleMcpPayload } from "@librarian/mcp-server";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir, withStore } from "../../../test/helpers.js";
import { type LibrarianServerOptions, createLibrarianServer } from "../dist/librarian-server.js";
import { coreToolRegistry } from "../dist/mcp/tools/index.js";
import {
  type LibrarianPlugin,
  assertUniquePluginNames,
  buildToolRegistry,
} from "../dist/plugin.js";

// A tool that records the exact (store, args, context) it was handed, so the
// handler-contract assertion can compare against what the caller passed in.
interface Captured {
  store: unknown;
  args: Record<string, unknown>;
  context: unknown;
}

function makeEchoTool(sink: { captured?: Captured }): ToolDefinition {
  return {
    name: "test_echo",
    description: "Echo the args back (test plugin).",
    inputSchema: { type: "object", properties: {} },
    handler: (store, args, context) => {
      sink.captured = { store, args, context };
      return { content: [{ type: "text", text: `echo:${JSON.stringify(args)}` }] };
    },
  };
}

// A trivial tool with a given name, for the collision cases.
function makeNamedTool(name: string): ToolDefinition {
  return {
    name,
    description: `Test tool ${name}.`,
    inputSchema: { type: "object", properties: {} },
    handler: () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

const ADMIN_ONLY_TOOL: ToolDefinition = {
  name: "test_admin_only",
  description: "An adminOnly test tool (dead surface over HTTP, SC 4).",
  inputSchema: { type: "object", properties: {} },
  adminOnly: true,
  handler: () => ({ content: [{ type: "text", text: "admin" }] }),
};

// Base factory options with every scheduler timer OFF and loopback binds, so a
// constructed server never binds a listener (start() is never called) and a
// throwing construction never opens a store (validation runs first).
function baseOptions(dataDir: string): LibrarianServerOptions {
  return {
    dataDir,
    secretKey: null,
    host: "127.0.0.1",
    port: 0,
    trpcHost: "127.0.0.1",
    trpcPort: 0,
    adminToken: "",
    agentToken: "",
    agentTokenMap: new Map(),
    allowedOrigins: [],
    allowNoAuth: true,
    maxBodyBytes: 1024 * 1024,
    backupTickMs: 0,
    intakePollMs: 0,
    groomingPollMs: 0,
    transcriptSweepTickMs: 0,
  };
}

interface ListResult {
  result: { tools: { name: string }[] };
}
interface CallResult {
  result: { content: { text: string }[] };
}

async function listToolNames(
  store: Parameters<typeof handleMcpPayload>[0],
  role: "admin" | "agent",
  registry: ReturnType<typeof buildToolRegistry>,
): Promise<string[]> {
  const list = (await handleMcpPayload(
    store,
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    { role },
    registry,
  )) as unknown as ListResult;
  return list.result.tools.map((tool) => tool.name);
}

describe("plugin tool registration — merge into the registry (spec 060 SC 4)", () => {
  it("returns the core registry unchanged when no plugin contributes a tool", () => {
    // A plugin with no tools adds nothing — the default surface is the SAME object.
    expect(buildToolRegistry([])).toBe(coreToolRegistry);
    expect(buildToolRegistry([{ name: "empty" }])).toBe(coreToolRegistry);
  });

  it("lists a plugin tool alongside the core tools, role-filtered like core", async () => {
    await withStore(async (store) => {
      const plugin: LibrarianPlugin = {
        name: "test-plugin",
        tools: [makeEchoTool({}), ADMIN_ONLY_TOOL],
      };
      const registry = buildToolRegistry([plugin]);

      const agentNames = await listToolNames(store, "agent", registry);
      // The plugin's agent tool lists; the core tools are still all present.
      expect(agentNames).toContain("test_echo");
      expect(agentNames).toContain("recall");
      expect(agentNames).toContain("remember");
      // adminOnly is filtered out for an agent, exactly as a core adminOnly tool
      // would be (SC 4 role-filtering parity).
      expect(agentNames).not.toContain("test_admin_only");

      // The admin role sees the adminOnly plugin tool too.
      const adminNames = await listToolNames(store, "admin", registry);
      expect(adminNames).toContain("test_echo");
      expect(adminNames).toContain("test_admin_only");
    });
  });

  it("dispatches a plugin tool through tools/call with the (store, args, context) contract", async () => {
    await withStore(async (store) => {
      const sink: { captured?: Captured } = {};
      const registry = buildToolRegistry([{ name: "test-plugin", tools: [makeEchoTool(sink)] }]);

      const call = (await handleMcpPayload(
        store,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "test_echo", arguments: { hello: "world" } },
        },
        { role: "agent", agentId: "codex" },
        registry,
      )) as unknown as CallResult;

      // The handler ran and its result rode back through the JSON-RPC envelope.
      expect(call.result.content[0].text).toBe('echo:{"hello":"world"}');
      // The identical handler contract core tools get: the SAME store instance, the
      // raw args, and the resolved context. Spec 061 T2: the context now carries the caller
      // `principal` (the one identity currency), with `role`/`agentId` kept as the deprecated
      // derived mirror. The `{ role: "agent", agentId: "codex" }` dispatch input is lifted to
      // the equivalent bound principal (actorId === boundActorId === "codex").
      expect(sink.captured?.store).toBe(store);
      expect(sink.captured?.args).toEqual({ hello: "world" });
      expect(sink.captured?.context).toEqual({
        principal: { kind: "agent", actorId: "codex", boundActorId: "codex", roles: ["agent"] },
        role: "agent",
        agentId: "codex",
      });
    });
  });

  it("refuses to dispatch an adminOnly plugin tool to an agent, allows it for admin", async () => {
    await withStore(async (store) => {
      const registry = buildToolRegistry([{ name: "test-plugin", tools: [ADMIN_ONLY_TOOL] }]);

      const asAgent = (await handleMcpPayload(
        store,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "test_admin_only", arguments: {} },
        },
        { role: "agent" },
        registry,
      )) as unknown as { error: { message: string } };
      expect(asAgent.error.message).toMatch(/requires admin authorization/i);

      const asAdmin = (await handleMcpPayload(
        store,
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "test_admin_only", arguments: {} },
        },
        { role: "admin" },
        registry,
      )) as unknown as CallResult;
      expect(asAdmin.result.content[0].text).toBe("admin");
    });
  });
});

describe("plugin registration refusals — loud, at construction time (spec 060 SC 7)", () => {
  it("throws naming the plugin when a plugin tool collides with a CORE tool", () => {
    const dataDir = makeTempDir();
    try {
      expect(() =>
        createLibrarianServer({
          ...baseOptions(dataDir),
          plugins: [{ name: "collider", tools: [makeNamedTool("recall")] }],
        }),
      ).toThrow(/Plugin "collider" registers a tool named "recall".*the core registry/s);
    } finally {
      cleanupTempDir(dataDir);
    }
  });

  it("throws naming the offending plugin when two PLUGINS register the same tool name", () => {
    const dataDir = makeTempDir();
    try {
      expect(() =>
        createLibrarianServer({
          ...baseOptions(dataDir),
          plugins: [
            { name: "first", tools: [makeNamedTool("shared_tool")] },
            { name: "second", tools: [makeNamedTool("shared_tool")] },
          ],
        }),
      ).toThrow(/Plugin "second" registers a tool named "shared_tool".*plugin "first"/s);
    } finally {
      cleanupTempDir(dataDir);
    }
  });

  it("throws naming the duplicated plugin name when two plugins share a name", () => {
    const dataDir = makeTempDir();
    try {
      expect(() =>
        createLibrarianServer({
          ...baseOptions(dataDir),
          plugins: [{ name: "twins" }, { name: "twins" }],
        }),
      ).toThrow(/Plugin name collision: two registered plugins share the name "twins"/);
    } finally {
      cleanupTempDir(dataDir);
    }
  });

  it("the same refusals fire from the helpers the factory calls", () => {
    // assertUniquePluginNames is the plugin-name gate; buildToolRegistry is the
    // tool-name gate. The factory calls both — exercised directly here too so the
    // refusal isn't only observable through the heavier factory path.
    expect(() => assertUniquePluginNames([{ name: "x" }, { name: "x" }])).toThrow(
      /Plugin name collision/,
    );
    expect(() =>
      buildToolRegistry([{ name: "collider", tools: [makeNamedTool("remember")] }]),
    ).toThrow(/Plugin "collider" registers a tool named "remember"/);
  });

  it("constructs cleanly with a well-formed plugin (no collision)", () => {
    const dataDir = makeTempDir();
    try {
      const server = createLibrarianServer({
        ...baseOptions(dataDir),
        plugins: [{ name: "test-plugin", tools: [makeNamedTool("test_ok")] }],
      });
      try {
        expect(server.store).toBeDefined();
      } finally {
        server.store.close();
      }
    } finally {
      cleanupTempDir(dataDir);
    }
  });
});
