import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The flagged review queue is a client view: it reads the queue from
// trpc.memories.listFlagged and adjudicates each row through the
// resolveFlagAction server action. Both are mocked so this stays a fast
// component-only check — no QueryClient/TRPC provider, no real server.
const refetch = vi.fn();
let queryState: {
  data?: { memories: unknown[] };
  isLoading: boolean;
  isError: boolean;
  error?: { message: string };
};

vi.mock("@/lib/trpc-client", () => ({
  trpc: {
    memories: {
      listFlagged: {
        useQuery: () => ({ ...queryState, refetch }),
      },
    },
  },
}));

const resolveFlagAction = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@/app/(memories)/actions", () => ({
  resolveFlagAction: (id: string, shelfId: string, action: "dismiss" | "archive") =>
    resolveFlagAction(id, shelfId, action),
}));

const { FlaggedView } = await import("@/components/memories/flagged-view");

function flaggedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "mem_1",
    title: "Outdated deploy note",
    body: "Deploy with the old script.",
    agent_id: "bede",
    tags: ["deployment", "outdated"],
    updated_at: "2026-06-01T00:00:00.000Z",
    shelfId: "shelf-1",
    shelfWritable: true,
    flags: [
      {
        agent_id: "scribe",
        reason: "the deploy script was replaced",
        created_at: "2026-06-02T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  refetch.mockReset();
  resolveFlagAction.mockReset().mockResolvedValue({ ok: true });
  queryState = { data: { memories: [flaggedRow()] }, isLoading: false, isError: false };
});

describe("FlaggedView", () => {
  it("renders each flagged memory with its title, body, reason and flagger", () => {
    render(<FlaggedView />);
    expect(screen.getByText("Outdated deploy note")).toBeInTheDocument();
    expect(screen.getByText("Deploy with the old script.")).toBeInTheDocument();
    expect(screen.getByText(/the deploy script was replaced/)).toBeInTheDocument();
    expect(screen.getByText(/scribe/)).toBeInTheDocument();
    expect(screen.getByText("deployment").tagName).toBe("SPAN");
    expect(screen.queryByRole("button", { name: "Filter by tag deployment" })).toBeNull();
  });

  it("shows when correction work is queued", () => {
    queryState = {
      data: {
        memories: [flaggedRow({ correction_work: [{ shelf_id: "shelf-1", status: "pending" }] })],
      },
      isLoading: false,
      isError: false,
    };
    render(<FlaggedView />);
    expect(screen.getByRole("status")).toHaveTextContent("Correction review is queued.");
  });

  it("shows when correction work needs manual review", () => {
    queryState = {
      data: {
        memories: [
          flaggedRow({ correction_work: [{ shelf_id: "shelf-1", status: "manual_review" }] }),
        ],
      },
      isLoading: false,
      isError: false,
    };
    render(<FlaggedView />);
    expect(screen.getByRole("status")).toHaveTextContent(/manual review is needed/i);
  });

  it("links a pending correction proposal from the flagged row", () => {
    queryState = {
      data: {
        memories: [
          flaggedRow({
            correction_work: [{ shelf_id: "shelf-1", status: "proposal_pending" }],
            correction_proposal: { id: "proposal-1" },
          }),
        ],
      },
      isLoading: false,
      isError: false,
    };
    render(<FlaggedView />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "A partial correction is waiting for approval",
    );
    expect(screen.getByRole("link", { name: "Review proposal" })).toHaveAttribute(
      "href",
      "/proposals",
    );
  });

  it("does not offer proposal approval while a missing proposal is being recovered", () => {
    queryState = {
      data: {
        memories: [
          flaggedRow({ correction_work: [{ shelf_id: "shelf-1", status: "proposal_pending" }] }),
        ],
      },
      isLoading: false,
      isError: false,
    };
    render(<FlaggedView />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "The correction proposal is being recovered; no review action is available yet.",
    );
    expect(screen.queryByRole("link", { name: "Review proposal" })).not.toBeInTheDocument();
  });

  it("shows the empty state when nothing is flagged", () => {
    queryState = { data: { memories: [] }, isLoading: false, isError: false };
    render(<FlaggedView />);
    expect(screen.getByText("No flagged memories.")).toBeInTheDocument();
  });

  it("dismisses a flag and refetches the queue", async () => {
    render(<FlaggedView />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(resolveFlagAction).toHaveBeenCalledWith("mem_1", "shelf-1", "dismiss"),
    );
    await waitFor(() => expect(refetch).toHaveBeenCalled());
  });

  it("archives a flagged memory and refetches the queue", async () => {
    render(<FlaggedView />);
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(resolveFlagAction).toHaveBeenCalledWith("mem_1", "shelf-1", "archive"),
    );
    await waitFor(() => expect(refetch).toHaveBeenCalled());
  });
});
