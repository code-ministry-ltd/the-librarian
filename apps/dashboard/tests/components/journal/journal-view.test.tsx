import type { JournalSearchHit, JournalViewPeriod } from "@librarian/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JournalView } from "@/components/journal/journal-view";
import { localToday } from "@/components/journal/timeline";

const entriesMock = vi.fn();
const searchMock = vi.fn();
const deleteMock = vi.fn();

vi.mock("@/lib/trpc-client", () => ({
  trpc: {
    journal: {
      entries: { useQuery: (...args: unknown[]) => entriesMock(...args) },
      search: { useQuery: (...args: unknown[]) => searchMock(...args) },
    },
  },
}));
vi.mock("@/app/journal/actions", () => ({
  deleteJournalAction: (...args: unknown[]) => deleteMock(...args),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const today = localToday();

const periods: JournalViewPeriod[] = [
  {
    tier: "day",
    label: today,
    first: today,
    last: today,
    path: `days/${today}.md`,
    episodes: [
      {
        key: "a#s1",
        time: "09:00–10:15",
        harness: "claude",
        project: "the-librarian",
        bullets: ["Decided the journal gets a timeline.", "<b>not bold</b> stays text."],
      },
    ],
    body: null,
  },
  {
    tier: "week",
    label: "2026-W30",
    first: "2026-07-20",
    last: "2026-07-26",
    path: "weeks/2026-W30.md",
    episodes: [],
    body: "- **alpha**: shipped the importer.\n- ![tracker](https://evil.example/p.png)",
  },
];

function loaded(data: { active: boolean; periods: JournalViewPeriod[] }) {
  entriesMock.mockReturnValue({ data, isLoading: false, error: null, refetch: vi.fn() });
}

beforeEach(() => {
  entriesMock.mockReset();
  searchMock.mockReset();
  deleteMock.mockReset();
  searchMock.mockReturnValue({ data: undefined, isFetching: false, error: null });
});

describe("JournalView", () => {
  it("reads like a journal: headings, times, harness and project, entries as plain text", () => {
    loaded({ active: true, periods });
    render(<JournalView />);
    expect(screen.getByRole("heading", { level: 2, name: "Week 30" })).toBeInTheDocument();
    expect(screen.getByText("09:00–10:15")).toBeInTheDocument();
    expect(screen.getAllByText("the-librarian").length).toBeGreaterThan(0);
    expect(screen.getByText("<b>not bold</b> stays text.")).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Summarised by week" })).toBeInTheDocument();
  });

  it("never renders an image from a summary", () => {
    loaded({ active: true, periods });
    const { container } = render(<JournalView />);
    expect(container.querySelector("img")).toBeNull();
  });

  it("exposes the timeline as a keyboard slider that says where you are", () => {
    loaded({ active: true, periods });
    render(<JournalView />);
    const [slider] = screen.getAllByRole("slider", { name: "Journal timeline" });
    expect(slider).toHaveAttribute("aria-valuemax", "1");
    expect(slider!.getAttribute("aria-valuetext")).toMatch(/\d{4}$/);
    window.scrollTo = vi.fn();
    fireEvent.keyDown(slider!, { key: "End" });
    expect(window.scrollTo).toHaveBeenCalled();
  });

  it("searches with the agents' engine and plots the matches on the timeline", async () => {
    loaded({ active: true, periods });
    const hit: JournalSearchHit = {
      tier: "day",
      label: today,
      first: today,
      last: today,
      path: `days/${today}.md`,
      episodeKey: "a#s1",
      time: "09:00–10:15",
      harness: "claude",
      project: "the-librarian",
      matchedByText: false,
      score: 2,
    };
    searchMock.mockImplementation((input: { query: string }) =>
      input.query
        ? { data: { from: "2025-11-02", to: today, hits: [hit] }, isFetching: false, error: null }
        : { data: undefined, isFetching: false, error: null },
    );
    render(<JournalView />);
    await userEvent.type(screen.getByRole("searchbox"), "timeline");
    expect(await screen.findByText(/1 best match/)).toBeInTheDocument();
    expect(searchMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: "timeline", limit: 50 }),
      { enabled: true },
    );
    expect(screen.getAllByRole("button", { name: /Jump to match/ }).length).toBeGreaterThan(0);
  });

  it("confirms before deleting an entry, naming it", async () => {
    loaded({ active: true, periods });
    deleteMock.mockResolvedValue({ ok: true });
    render(<JournalView />);
    await userEvent.click(screen.getByRole("button", { name: /Delete the 09:00–10:15 entry/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Delete the 09:00–10:15 entry on/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(deleteMock).toHaveBeenCalledWith({ kind: "episode", date: today, key: "a#s1" });
  });

  it("explains how to turn the journal on when it is off", () => {
    loaded({ active: false, periods: [] });
    render(<JournalView />);
    expect(screen.getByText("The journal is off")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Settings → Curator/ })).toHaveAttribute(
      "href",
      "/settings/curator",
    );
  });

  it("explains when entries will appear once it is on", () => {
    loaded({ active: true, periods: [] });
    render(<JournalView />);
    expect(screen.getByText("Nothing in the journal yet")).toBeInTheDocument();
  });
});
