// Dashboard handoff component tests (sessions-rethink §6.7).
//
// Claim is an MCP-only agent operation (no claim button); permanent delete
// is the dashboard's one write path (server action → handoffs.purge). We
// mock the tRPC client and the server action so the tests stay pure.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listMock = vi.fn();
const byIdMock = vi.fn();
const deleteHandoffAction = vi.fn().mockResolvedValue({ ok: true });

vi.mock("@/lib/trpc-client", () => ({
  trpc: {
    handoffs: {
      list: { useQuery: (...args: unknown[]) => listMock(...args) },
      byId: { useQuery: (...args: unknown[]) => byIdMock(...args) },
    },
  },
}));

vi.mock("@/app/handoffs/actions", () => ({
  deleteHandoffAction: (...args: unknown[]) => deleteHandoffAction(...args),
}));

// The detail view uses next/navigation's useRouter for the Esc-back shortcut
// and the post-delete return trip.
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

const { HandoffsListView } = await import("@/components/handoffs/list-view");
const { HandoffDetailView } = await import("@/components/handoffs/detail-view");

const sampleHandoff = {
  handoff_id: "hdo_abc",
  title: "Continue the migration",
  project_key: "proj-x",
  source_ref: null,
  cwd: "/repo",
  created_by_agent_id: "agent-a",
  created_in_harness: "claude-code",
  tags: ["migration"],
  created_at: "2026-05-28T12:00:00.000Z",
  claimed_at: null,
  claimed_by: null,
};

describe("HandoffsListView", () => {
  beforeEach(() => {
    deleteHandoffAction.mockReset().mockResolvedValue({ ok: true });
  });

  it("renders empty-state when no rows arrive", () => {
    listMock.mockReturnValue({ data: [], isLoading: false });
    render(<HandoffsListView />);
    expect(screen.getByText(/no handoffs/i)).toBeInTheDocument();
  });

  it("renders one row per handoff with a link to the detail view", () => {
    listMock.mockReturnValue({
      data: [sampleHandoff, { ...sampleHandoff, handoff_id: "hdo_xyz", title: "Another" }],
      isLoading: false,
    });
    render(<HandoffsListView />);
    expect(screen.getByText("Continue the migration").closest("a")).toHaveAttribute(
      "href",
      "/handoffs/hdo_abc",
    );
    expect(screen.getByText("Another").closest("a")).toHaveAttribute("href", "/handoffs/hdo_xyz");
  });

  it("ends every row with a delete button named after the handoff", () => {
    listMock.mockReturnValue({
      data: [sampleHandoff, { ...sampleHandoff, handoff_id: "hdo_xyz", title: "Another" }],
      isLoading: false,
    });
    render(<HandoffsListView />);
    expect(
      screen.getByRole("button", { name: 'Delete handoff "Continue the migration"' }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: 'Delete handoff "Another"' })).toBeInTheDocument();
  });

  it("confirming the dialog deletes once and refetches the list", async () => {
    const refetch = vi.fn();
    listMock.mockReturnValue({ data: [sampleHandoff], isLoading: false, refetch });
    const user = userEvent.setup();
    render(<HandoffsListView />);

    await user.click(
      screen.getByRole("button", { name: 'Delete handoff "Continue the migration"' }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Continue the migration");
    expect(dialog).toHaveTextContent(/permanently/i);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteHandoffAction).toHaveBeenCalledTimes(1));
    expect(deleteHandoffAction).toHaveBeenCalledWith("hdo_abc");
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
  });

  it("canceling the dialog never calls the delete action", async () => {
    listMock.mockReturnValue({ data: [sampleHandoff], isLoading: false, refetch: vi.fn() });
    const user = userEvent.setup();
    render(<HandoffsListView />);

    await user.click(
      screen.getByRole("button", { name: 'Delete handoff "Continue the migration"' }),
    );
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(deleteHandoffAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("surfaces a failed delete inline and keeps the row", async () => {
    deleteHandoffAction.mockResolvedValueOnce({ ok: false, error: "Handoff not found: hdo_abc" });
    listMock.mockReturnValue({ data: [sampleHandoff], isLoading: false, refetch: vi.fn() });
    const user = userEvent.setup();
    render(<HandoffsListView />);

    await user.click(
      screen.getByRole("button", { name: 'Delete handoff "Continue the migration"' }),
    );
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Handoff not found: hdo_abc");
    // The dialog stays open and the row is still there — nothing was deleted.
    // (The row's button is aria-hidden while the dialog locks focus, so assert
    // via the title text: row link + dialog description = two matches.)
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByText("Continue the migration")).toHaveLength(2);
  });
});

describe("HandoffDetailView", () => {
  beforeEach(() => {
    deleteHandoffAction.mockReset().mockResolvedValue({ ok: true });
    pushMock.mockReset();
  });

  it("renders the document markdown and metadata sidebar", () => {
    byIdMock.mockReturnValue({
      data: {
        ...sampleHandoff,
        document_md: "# Handoff: test\n\n## Start & intent\nstart here.",
      },
      isLoading: false,
    });
    render(<HandoffDetailView handoffId="hdo_abc" />);
    expect(screen.getByText(/Continue the migration/)).toBeInTheDocument();
    expect(screen.getByText(/Start & intent/)).toBeInTheDocument();
    expect(screen.getByText("hdo_abc")).toBeInTheDocument();
    // Status surfaces twice — as a Pill in the page header and in the
    // sidebar Status row. Both should read "unclaimed".
    expect(screen.getAllByText("unclaimed")).toHaveLength(2);
  });

  it("deletes once and returns to the list on success", async () => {
    byIdMock.mockReturnValue({
      data: {
        ...sampleHandoff,
        document_md: "# Handoff: test\n\n## Start & intent\nstart here.",
      },
      isLoading: false,
    });
    const user = userEvent.setup();
    render(<HandoffDetailView handoffId="hdo_abc" />);

    await user.click(screen.getByRole("button", { name: "Delete handoff" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Continue the migration");

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteHandoffAction).toHaveBeenCalledTimes(1));
    expect(deleteHandoffAction).toHaveBeenCalledWith("hdo_abc");
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/handoffs"));
  });

  it("keeps the detail page and the error visible when the delete fails", async () => {
    deleteHandoffAction.mockResolvedValueOnce({ ok: false, error: "Handoff not found: hdo_abc" });
    byIdMock.mockReturnValue({
      data: {
        ...sampleHandoff,
        document_md: "# Handoff: test\n\n## Start & intent\nstart here.",
      },
      isLoading: false,
    });
    const user = userEvent.setup();
    render(<HandoffDetailView handoffId="hdo_abc" />);

    await user.click(screen.getByRole("button", { name: "Delete handoff" }));
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Handoff not found: hdo_abc");
    // No navigation on failure — the detail page (and the dialog) stay put.
    // Title appears twice: the page h1 and the dialog description.
    expect(pushMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByText("Continue the migration")).toHaveLength(2);
  });

  it("Escape closes the dialog without navigating while it is open", async () => {
    byIdMock.mockReturnValue({
      data: {
        ...sampleHandoff,
        document_md: "# Handoff: test\n\n## Start & intent\nstart here.",
      },
      isLoading: false,
    });
    const user = userEvent.setup();
    render(<HandoffDetailView handoffId="hdo_abc" />);

    await user.click(screen.getByRole("button", { name: "Delete handoff" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");

    // The dialog closes and the user stays on the detail page — Esc meant
    // "cancel", not "leave".
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(pushMock).not.toHaveBeenCalledWith("/handoffs");
    expect(deleteHandoffAction).not.toHaveBeenCalled();
  });

  it("renders not-found when the query has no data", () => {
    byIdMock.mockReturnValue({ data: undefined, isLoading: false });
    render(<HandoffDetailView handoffId="hdo_ghost" />);
    expect(screen.getByText(/handoff not found/i)).toBeInTheDocument();
  });
});
