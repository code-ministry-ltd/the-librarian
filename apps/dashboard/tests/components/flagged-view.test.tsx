import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The flagged review queue is a client view: it reads the queue from
// trpc.memories.listFlagged, shows what the curator did about each memory's
// flags (ADR 0013), and adjudicates rows through server actions. Both are
// mocked so this stays a fast component-only check — no QueryClient/TRPC
// provider, no real server.
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
const askCuratorAgainAction = vi.fn().mockResolvedValue({ ok: true });
const updateMemoryAction = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@/app/(memories)/actions", () => ({
  resolveFlagAction: (id: string, shelfId: string, action: "dismiss" | "archive") =>
    resolveFlagAction(id, shelfId, action),
  askCuratorAgainAction: (id: string, shelfId: string) => askCuratorAgainAction(id, shelfId),
  updateMemoryAction: (id: string, form: FormData, options: unknown) =>
    updateMemoryAction(id, form, options),
}));
// The shared edit form lives beside the detail view, whose other imports need a
// TRPC provider; only the form is used here.
vi.mock("@/app/curator/actions", () => ({}));

const { FlaggedView } = await import("@/components/memories/flagged-view");

const FLAG = {
  agent_id: "scribe",
  reason: "the deploy script was replaced",
  created_at: "2026-06-02T00:00:00.000Z",
};

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
    flags: [FLAG],
    ...overrides,
  };
}

function reviewed(review: Record<string, unknown>) {
  return flaggedRow({
    flags: [{ ...FLAG, review: { at: "2026-06-03T00:00:00.000Z", ...review } }],
  });
}

function showing(row: unknown) {
  queryState = { data: { memories: [row] }, isLoading: false, isError: false };
}

beforeEach(() => {
  refetch.mockReset();
  resolveFlagAction.mockReset().mockResolvedValue({ ok: true });
  askCuratorAgainAction.mockReset().mockResolvedValue({ ok: true });
  updateMemoryAction.mockReset().mockResolvedValue({ ok: true });
  showing(flaggedRow());
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

  it("says the curator has not looked yet while a flag is unreviewed", () => {
    render(<FlaggedView />);
    expect(screen.getByRole("status")).toHaveTextContent(/Waiting for the curator/);
    expect(screen.queryByRole("button", { name: "Ask the curator again" })).toBeNull();
  });

  it("links to the proposal when the curator proposed a correction", () => {
    showing(reviewed({ outcome: "proposed", proposal_id: "mem_fix" }));
    render(<FlaggedView />);
    expect(screen.getByRole("status")).toHaveTextContent(/proposed a correction/);
    expect(screen.getByRole("link", { name: "Review proposal" })).toHaveAttribute(
      "href",
      "/proposals",
    );
  });

  it("shows the curator's reason when it made no change, and offers to ask again", async () => {
    showing(reviewed({ outcome: "no_change", rationale: "Still accurate." }));
    render(<FlaggedView />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "The curator reviewed this and made no change: “Still accurate.”",
    );
    fireEvent.click(screen.getByRole("button", { name: "Ask the curator again" }));
    await waitFor(() => expect(askCuratorAgainAction).toHaveBeenCalledWith("mem_1", "shelf-1"));
    await waitFor(() => expect(refetch).toHaveBeenCalled());
  });

  it.each([
    ["declined", /You rejected the curator's correction/],
    ["too_long", /too long for the curator to rewrite safely/],
  ])("explains a %s outcome", (outcome, text) => {
    showing(reviewed({ outcome }));
    render(<FlaggedView />);
    expect(screen.getByRole("status")).toHaveTextContent(text);
    expect(screen.getByRole("button", { name: "Ask the curator again" })).toBeInTheDocument();
  });

  it("explains a curator archive proposal", () => {
    showing(
      flaggedRow({
        flags: [
          {
            agent_id: "system-memory-curator",
            reason: "curator proposes archive: obsolete",
            created_at: "2026-06-02T00:00:00.000Z",
          },
        ],
      }),
    );
    render(<FlaggedView />);
    expect(screen.getByRole("status")).toHaveTextContent(/proposes archiving this whole memory/);
  });

  it("Edit saves the admin's fix and closes the flags", async () => {
    render(<FlaggedView />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByDisplayValue("Deploy with the old script."), {
      target: { value: "Deploy with the new script." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and close flags" }));
    await waitFor(() =>
      expect(updateMemoryAction).toHaveBeenCalledWith("mem_1", expect.any(FormData), {
        resolveFlags: true,
      }),
    );
    const form = updateMemoryAction.mock.calls[0]![1] as FormData;
    expect(form.get("body")).toBe("Deploy with the new script.");
  });

  it("disables every action on a read-only shelf", () => {
    showing(flaggedRow({ shelfWritable: false }));
    render(<FlaggedView />);
    for (const name of ["Edit", "Dismiss", "Archive"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
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

  it("surfaces an action error on the card", async () => {
    askCuratorAgainAction.mockResolvedValue({ ok: false, error: "No agent flags to look at." });
    showing(reviewed({ outcome: "no_change" }));
    render(<FlaggedView />);
    fireEvent.click(screen.getByRole("button", { name: "Ask the curator again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No agent flags to look at.");
  });
});
