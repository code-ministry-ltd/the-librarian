import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMAND_SPECS, registerCommands } from "../extensions/librarian/commands.js";
import librarian from "../extensions/librarian/index.js";

interface CapturedCommand {
  name: string;
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

function capturePi() {
  const tools: { name: string }[] = [];
  const commands: CapturedCommand[] = [];
  const events: string[] = [];
  const sent: string[] = [];
  const pi = {
    registerTool: (t: { name: string }) => tools.push(t),
    registerCommand: (name: string, def: Omit<CapturedCommand, "name">) =>
      commands.push({ name, ...def }),
    on: (event: string) => events.push(event),
    sendUserMessage: (content: string) => sent.push(content),
  } as unknown as ExtensionAPI;
  return { pi, tools, commands, events, sent };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("librarian extension factory", () => {
  it("stays dormant without configuration: commands explain, nothing else registers", async () => {
    vi.stubEnv("LIBRARIAN_MCP_URL", "");
    vi.stubEnv("LIBRARIAN_AGENT_TOKEN", "");
    const { pi, tools, commands, events } = capturePi();

    librarian(pi);

    expect(tools).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(commands.map((c) => c.name).sort()).toEqual([
      "handoff",
      "learn",
      "takeover",
      "toggle-private",
    ]);

    const notify = vi.fn();
    await commands[0]!.handler("", { ui: { notify } });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("LIBRARIAN_MCP_URL"), "warning");
  });

  it("when configured registers the 7 tools, the primer + capture hooks, and the 4 commands", () => {
    vi.stubEnv("LIBRARIAN_MCP_URL", "http://127.0.0.1:9/mcp");
    vi.stubEnv("LIBRARIAN_AGENT_TOKEN", "tok-test");
    const { pi, tools, commands, events } = capturePi();

    librarian(pi);

    expect(tools.map((t) => t.name).sort()).toEqual([
      "claim_handoff",
      "flag_memory",
      "list_handoffs",
      "recall",
      "remember",
      "search_references",
      "store_handoff",
    ]);
    // The primer injection (before_agent_start) + the Phase 2B auto-capture hook
    // (agent_end) are both wired when configured.
    expect(events.sort()).toEqual(["agent_end", "before_agent_start"]);
    expect(commands.map((c) => c.name).sort()).toEqual([
      "handoff",
      "learn",
      "takeover",
      "toggle-private",
    ]);
  });

  it("wires the agent_end auto-capture hook (default-on, Phase 2B)", () => {
    vi.stubEnv("LIBRARIAN_MCP_URL", "http://127.0.0.1:9/mcp");
    vi.stubEnv("LIBRARIAN_AGENT_TOKEN", "tok-test");
    const { pi, events } = capturePi();

    librarian(pi);

    expect(events).toContain("agent_end");
  });

  it("still registers the capture hook with LIBRARIAN_AUTO_SAVE=false (the kill-switch is a fire-time gate)", () => {
    // Registration is unconditional when configured; the kill-switch suppresses
    // the SHIP at fire time inside runCapture, not the subscription. This keeps a
    // mid-session env change effective without a re-install.
    vi.stubEnv("LIBRARIAN_MCP_URL", "http://127.0.0.1:9/mcp");
    vi.stubEnv("LIBRARIAN_AGENT_TOKEN", "tok-test");
    vi.stubEnv("LIBRARIAN_AUTO_SAVE", "false");
    const { pi, events } = capturePi();

    librarian(pi);

    expect(events).toContain("agent_end");
  });

  it("registers NO hooks when dormant (no capture hook without config)", () => {
    vi.stubEnv("LIBRARIAN_MCP_URL", "");
    vi.stubEnv("LIBRARIAN_AGENT_TOKEN", "");
    const { pi, events } = capturePi();

    librarian(pi);

    expect(events).not.toContain("agent_end");
    expect(events).toEqual([]);
  });
});

describe("registerCommands (the four-verb sugar, docs/slash-commands.md)", () => {
  it("each command injects its prompt template as a user message (drives a turn)", async () => {
    const { pi, commands, sent } = capturePi();
    registerCommands(pi);

    for (const spec of COMMAND_SPECS) {
      const command = commands.find((c) => c.name === spec.name)!;
      await command.handler("", {});
      expect(sent.at(-1)).toBe(spec.prompt);
    }
  });

  it("appends user-supplied arguments to the template", async () => {
    const { pi, commands, sent } = capturePi();
    registerCommands(pi);

    const takeover = commands.find((c) => c.name === "takeover")!;
    await takeover.handler("hof_123", {});
    expect(sent.at(-1)).toContain("User input: hof_123");
  });

  it("warns that private mode cannot cancel correction work already queued in public context", () => {
    const prompt = COMMAND_SPECS.find((spec) => spec.name === "toggle-private")!.prompt;
    expect(prompt).toContain("server cannot verify its marker");
    expect(prompt).toContain("from public context may still finish after switching private");
    expect(prompt).toContain("does not cancel queued work");
  });

  it("the /handoff template names all five required headings", () => {
    const handoff = COMMAND_SPECS.find((s) => s.name === "handoff")!;
    for (const heading of [
      "Start & intent",
      "Journey",
      "Current state",
      "What's left",
      "Open questions",
    ]) {
      expect(handoff.prompt).toContain(heading);
    }
  });

  it("the four verbs are routed to the surviving tool surface only", () => {
    const all = COMMAND_SPECS.map((s) => s.prompt).join("\n");
    // The retired session verbs must not be taught anywhere.
    expect(all).not.toContain("conv_state");
    expect(all).not.toContain("start_context");
    expect(all).toContain("store_handoff");
    expect(all).toContain("list_handoffs");
    expect(all).toContain("claim_handoff");
    expect(all).toContain("remember");
  });
});
