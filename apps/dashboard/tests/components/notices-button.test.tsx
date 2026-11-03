// The notices bell (spec 084): unread count in words, the popover, marking read on open.

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listMock = vi.fn();
const mutate = vi.fn();

vi.mock("@/lib/trpc-client", () => ({
  trpc: {
    useUtils: () => ({ notices: { list: { invalidate: vi.fn() } } }),
    notices: {
      list: { useQuery: () => listMock() },
      markRead: { useMutation: () => ({ mutate }) },
    },
  },
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { NoticesButton } = await import("@/components/notices-button");

const remote = { enabled: true, forcedOff: false, status: { kind: "ok" } };

function notice(over: Record<string, unknown> = {}) {
  return {
    id: "n1",
    created: "2026-11-03",
    severity: "info",
    title: "A title",
    body: "A body",
    source: "remote",
    read: false,
    ...over,
  };
}

describe("NoticesButton", () => {
  beforeEach(() => vi.clearAllMocks());

  it("says how many are unread, in words", () => {
    listMock.mockReturnValue({ data: { notices: [notice()], unread: 1, remote } });
    render(<NoticesButton />);
    expect(screen.getByRole("button", { name: "Notices: 1 unread" })).toBeInTheDocument();
  });

  it("calls out an unread security notice", () => {
    listMock.mockReturnValue({
      data: { notices: [notice({ severity: "security" })], unread: 1, remote },
    });
    render(<NoticesButton />);
    expect(
      screen.getByRole("button", { name: "Notices: 1 unread, including a security notice" }),
    ).toBeInTheDocument();
  });

  it("opens the popover, labels new ones, and marks them read", () => {
    listMock.mockReturnValue({
      data: {
        notices: [
          notice(),
          notice({ id: "n2", read: true, title: "Old one" }),
          notice({
            id: "local:primer-review",
            source: "local",
            link: { href: "/settings/primer", label: "Open Settings → Primer" },
          }),
        ],
        unread: 2,
        remote,
      },
    });
    render(<NoticesButton />);
    fireEvent.click(screen.getByTestId("notices-button"));
    expect(screen.getByRole("dialog", { name: "Notices" })).toBeInTheDocument();
    expect(screen.getAllByText("New")).toHaveLength(2);
    expect(screen.getAllByText("03/11/2026")).toHaveLength(3);
    expect(screen.getByRole("link", { name: "Open Settings → Primer" })).toHaveAttribute(
      "href",
      "/settings/primer",
    );
    expect(mutate).toHaveBeenCalledWith({ ids: ["n1", "local:primer-review"] });
  });

  it("says when there are none, and when fetching is off", () => {
    listMock.mockReturnValue({
      data: { notices: [], unread: 0, remote: { ...remote, enabled: false } },
    });
    render(<NoticesButton />);
    fireEvent.click(screen.getByRole("button", { name: "Notices: none unread" }));
    expect(screen.getByText("No notices.")).toBeInTheDocument();
    expect(screen.getByText(/Fetching notices from GitHub is off/)).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    listMock.mockReturnValue({ data: { notices: [], unread: 0, remote } });
    render(<NoticesButton />);
    fireEvent.click(screen.getByTestId("notices-button"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
