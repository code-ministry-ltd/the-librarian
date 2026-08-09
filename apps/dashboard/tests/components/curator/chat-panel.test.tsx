import type { ChatResponse, ProposedAction } from "@librarian/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatPanel } from "@/components/curator/chat-panel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

// A stub chat action that returns a scripted response, recording what it was sent.
function scriptedChat(response: ChatResponse) {
  const calls: { messages: { role: string; content: string }[] }[] = [];
  const action = vi.fn(async (input: { messages: { role: string; content: string }[] }) => {
    calls.push({ messages: input.messages });
    return { ok: true as const, response };
  });
  return { action, calls };
}

const noopConfirm = vi.fn(async () => ({ ok: true as const }));
const noopSetAddendum = vi.fn(async () => ({
  ok: true as const,
  addendum: { content: "x", version: "v" },
}));

function renderPanel(over: Partial<Parameters<typeof ChatPanel>[0]> = {}) {
  const chat = scriptedChat({ kind: "message", text: "Hello from the curator." });
  render(
    <ChatPanel
      onChat={chat.action}
      onConfirmAction={noopConfirm}
      onSetAddendum={noopSetAddendum}
      {...over}
    />,
  );
  return chat;
}

describe("ChatPanel", () => {
  it("sends a turn and renders a prose message response", async () => {
    const chat = renderPanel();
    await userEvent.type(screen.getByRole("textbox", { name: /message/i }), "hi");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(screen.getByText("Hello from the curator.")).toBeTruthy());
    expect(chat.action).toHaveBeenCalledTimes(1);
    // The user's message is appended to the array sent to the server.
    expect(chat.calls[0]!.messages.at(-1)).toEqual({ role: "user", content: "hi" });
  });

  it("shows the base curator prompt read-only above the addendum, collapsed by default", () => {
    renderPanel({
      job: "grooming",
      basePrompt: "BASE-PROMPT-MARKER: preserve, do not destroy.",
      promptVersion: "v5.4",
    });
    expect(screen.getByText(/view the grooming prompt \(read-only\) · v5\.4/i)).toBeTruthy();
    // Closed <details> still renders its children in the DOM.
    expect(screen.getByText(/BASE-PROMPT-MARKER/)).toBeTruthy();
    // Read-only: the prompt is not held in an editable field.
    expect(screen.queryByDisplayValue(/BASE-PROMPT-MARKER/)).toBeNull();
  });

  it("renders a proposed_action as a Confirm card and does NOT auto-execute it", async () => {
    const action: ProposedAction = {
      type: "update",
      id: "mem-1",
      patch: { title: "Fixed title" },
    };
    renderPanel({ onChat: scriptedChat({ kind: "proposed_action", action }).action });
    await userEvent.type(screen.getByRole("textbox", { name: /message/i }), "fix it");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    // The action is shown for review with an explicit Confirm — never auto-run.
    await waitFor(() => expect(screen.getByText(/proposed fix/i)).toBeTruthy());
    const confirm = screen.getByRole("button", { name: /confirm/i });
    expect(confirm).toBeTruthy();
    // Human-in-the-loop: the mutation has NOT run until the admin confirms.
    expect(noopConfirm).not.toHaveBeenCalled();
  });

  it("calls the confirm action with the proposed action only when the admin clicks Confirm", async () => {
    const user = userEvent.setup();
    const action: ProposedAction = { type: "unmerge", id: "mem-merged" };
    const onConfirmAction = vi.fn(async () => ({ ok: true as const }));
    renderPanel({
      onChat: scriptedChat({ kind: "proposed_action", action }).action,
      onConfirmAction,
    });
    await user.type(screen.getByRole("textbox", { name: /message/i }), "undo");
    await user.click(screen.getByRole("button", { name: /send/i }));
    const confirm = await screen.findByRole("button", { name: /confirm/i });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);
    await waitFor(() => expect(onConfirmAction).toHaveBeenCalledTimes(1));
    expect(onConfirmAction).toHaveBeenCalledWith(action);
  });

  it("populates the addendum draft from an addendum_edit response", async () => {
    renderPanel({
      onChat: scriptedChat({
        kind: "addendum_edit",
        job: "grooming",
        candidate: "Prefer keeping project-scoped lessons separate.",
      }).action,
    });
    await userEvent.type(screen.getByRole("textbox", { name: /message/i }), "suggest a rule");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    const draft = (await screen.findByRole("textbox", {
      name: /addendum draft/i,
    })) as HTMLTextAreaElement;
    await waitFor(() =>
      expect(draft.value).toBe("Prefer keeping project-scoped lessons separate."),
    );
  });

  it("warns when an addendum_edit candidate is still over the 2 KB limit", async () => {
    renderPanel({
      onChat: scriptedChat({
        kind: "addendum_edit",
        job: "grooming",
        candidate: "way too long",
        over_limit: true,
      }).action,
    });
    await userEvent.type(screen.getByRole("textbox", { name: /message/i }), "rule");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(screen.getByText(/still over 2 KB/i)).toBeTruthy());
  });

  it("surfaces a chat error (e.g. non-operational LLM) without crashing", async () => {
    const onChat = vi.fn(async () => ({
      ok: false as const,
      error: "The chat LLM is not configured.",
    }));
    renderPanel({ onChat });
    await userEvent.type(screen.getByRole("textbox", { name: /message/i }), "hi");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(screen.getByText(/not configured/i)).toBeTruthy());
  });

  it("seeds the conversation with the memory context when given a memory", async () => {
    const chat = renderPanel({ memoryId: "mem-42", memoryTitle: "Some memory" });
    // The memory id is visible so the admin knows what's grounded.
    expect(screen.getByText(/mem-42/)).toBeTruthy();
    await userEvent.type(screen.getByRole("textbox", { name: /message/i }), "what is this?");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(chat.action).toHaveBeenCalled());
  });

  it("suggests addendum/policy prompts in the general (ungrounded) chat", async () => {
    renderPanel({ job: "grooming" });
    // Capability-aligned: the curator can explain its policy and draft addenda…
    expect(
      screen.getByRole("button", {
        name: /how do you decide whether two memories are duplicates/i,
      }),
    ).toBeTruthy();
    // …and must NOT offer memory-grounded prompts when nothing is grounded.
    expect(screen.queryByRole("button", { name: /is this memory still accurate/i })).toBeNull();
  });

  it("suggests memory-grounded prompts when opened from a memory", async () => {
    renderPanel({ memoryId: "mem-42", memoryTitle: "Some memory", job: "grooming" });
    expect(screen.getByRole("button", { name: /is this memory still accurate/i })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /how do you decide whether two memories/i }),
    ).toBeNull();
  });

  it("commits the addendum draft only on an explicit Commit click", async () => {
    const onSetAddendum = vi.fn(async () => ({
      ok: true as const,
      addendum: { content: "rule", version: "v2" },
    }));
    renderPanel({ onSetAddendum, initialAddendum: "existing rule" });
    const draft = screen.getByRole("textbox", { name: /addendum draft/i });
    await userEvent.clear(draft);
    await userEvent.type(draft, "rule");
    expect(onSetAddendum).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /commit addendum/i }));
    await waitFor(() => expect(onSetAddendum).toHaveBeenCalledTimes(1));
    expect(onSetAddendum).toHaveBeenCalledWith({ job: "grooming", content: "rule" });
  });
});
