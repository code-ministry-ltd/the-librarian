import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryRow, RouterOutputs } from "@/components/memories/types";

const moveMemoryAction = vi.fn().mockResolvedValue({ ok: true });
const proposeMoveAction = vi.fn().mockResolvedValue({ ok: true });

vi.mock("@/app/(memories)/actions", () => ({
  moveMemoryAction: (...args: unknown[]) => moveMemoryAction(...args),
  proposeMoveAction: (...args: unknown[]) => proposeMoveAction(...args),
}));

const { MoveMemoryDialog } = await import("@/components/memories/move-memory-dialog");

type Shelves = RouterOutputs["vault"]["shelves"];

function memory(over: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: "mem_coffee",
    title: "Coffee",
    body: "Espresso, one sugar.",
    status: "active",
    tags: [],
    applies_to: [],
    supersedes: [],
    conflicts_with: [],
    flags: [],
    confidence: "high",
    updated_at: "2026-07-18T00:00:00.000Z",
    curator_note: null,
    is_global: false,
    requires_approval: false,
    shelfId: "personal",
    shelfLabel: "My shelf",
    ...over,
  } as MemoryRow;
}

const shelves = [
  { id: "personal", label: "My shelf", writable: true },
  { id: "team", label: "Team knowledge", writable: true },
  { id: "reference", writable: false },
] satisfies Shelves;

beforeEach(() => {
  moveMemoryAction.mockReset().mockResolvedValue({ ok: true });
  proposeMoveAction.mockReset().mockResolvedValue({ ok: true });
});

describe("MoveMemoryDialog", () => {
  it("is absent while shelf/access data is unavailable and for a single shelf", () => {
    const { rerender } = render(
      <MoveMemoryDialog
        memory={memory()}
        shelves={undefined}
        canDirectMove={undefined}
        onSuccess={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /move/i })).not.toBeInTheDocument();

    rerender(
      <MoveMemoryDialog
        memory={memory()}
        shelves={[shelves[0]!]}
        canDirectMove
        onSuccess={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /move/i })).not.toBeInTheDocument();
  });

  it("offers other shelves with labels and id tooltips", async () => {
    await userEvent.click(
      render(
        <MoveMemoryDialog memory={memory()} shelves={shelves} canDirectMove onSuccess={vi.fn()} />,
      ).getByRole("button", { name: "Move…" }),
    );
    expect(screen.queryByRole("option", { name: "My shelf" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Team knowledge" })).toHaveAttribute("title", "team");
    expect(screen.getByRole("option", { name: "reference" })).toHaveAttribute("title", "reference");
  });

  it("moves directly when an admin selects a writable destination", async () => {
    const onSuccess = vi.fn();
    render(
      <MoveMemoryDialog memory={memory()} shelves={shelves} canDirectMove onSuccess={onSuccess} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Move…" }));
    await userEvent.selectOptions(screen.getByLabelText("Destination shelf"), "team");
    await userEvent.click(screen.getByRole("button", { name: "Move memory" }));
    await waitFor(() => expect(moveMemoryAction).toHaveBeenCalledWith("mem_coffee", "team"));
    expect(proposeMoveAction).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalled();
  });

  it("keeps a successful move warning visible without treating it as a failure", async () => {
    moveMemoryAction.mockResolvedValueOnce({
      ok: true,
      warning: "Moved, but source-only has no active project on Team knowledge.",
    });
    const onSuccess = vi.fn();
    render(
      <MoveMemoryDialog memory={memory()} shelves={shelves} canDirectMove onSuccess={onSuccess} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Move…" }));
    await userEvent.selectOptions(screen.getByLabelText("Destination shelf"), "team");
    await userEvent.click(screen.getByRole("button", { name: "Move memory" }));

    expect(await screen.findByRole("status")).toHaveTextContent("source-only");
    expect(onSuccess).toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("proposes a move with rationale for a member or read-only destination", async () => {
    render(
      <MoveMemoryDialog
        memory={memory()}
        shelves={shelves}
        canDirectMove={false}
        onSuccess={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Propose move…" }));
    await userEvent.selectOptions(screen.getByLabelText("Destination shelf"), "team");
    await userEvent.type(screen.getByLabelText("Rationale (optional)"), "Shared team context");
    await userEvent.click(screen.getByRole("button", { name: "Propose move" }));
    await waitFor(() =>
      expect(proposeMoveAction).toHaveBeenCalledWith("mem_coffee", "team", "Shared team context"),
    );
    expect(moveMemoryAction).not.toHaveBeenCalled();
  });

  it("offers every shelf without shelf attribution and surfaces the server refusal", async () => {
    moveMemoryAction.mockResolvedValueOnce({
      ok: false,
      error: "The memory is already on personal",
    });
    const unattributed = memory();
    delete unattributed.shelfId;
    delete unattributed.shelfLabel;
    render(
      <MoveMemoryDialog
        memory={unattributed}
        shelves={shelves}
        canDirectMove
        onSuccess={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Move…" }));
    expect(screen.getByRole("option", { name: "My shelf" })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Destination shelf"), "personal");
    await userEvent.click(screen.getByRole("button", { name: "Move memory" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already on personal");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
