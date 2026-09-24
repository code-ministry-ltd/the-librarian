import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProposalReviewRow } from "@/components/memories/types";

// The proposal card is a client view: it renders one enriched row from
// memories.proposalsForReview and adjudicates it through the approve/reject
// server actions. Both are mocked so this stays a fast component-only check —
// no QueryClient/TRPC provider, no real server. DiffView is the real component
// (it just classifies a unified-diff string), so a rendered diff proves the
// single-target layout wired it.

const approveProposalAction = vi.fn().mockResolvedValue({ ok: true });
const rejectProposalAction = vi.fn().mockResolvedValue({ ok: true });
const archiveMemoryAction = vi.fn().mockResolvedValue({ ok: true });
const applyProposalPlanAction = vi.fn().mockResolvedValue({ ok: true });
const refresh = vi.fn();

vi.mock("@/app/(memories)/actions", () => ({
  approveProposalAction: (...args: unknown[]) => approveProposalAction(...args),
  rejectProposalAction: (...args: unknown[]) => rejectProposalAction(...args),
  archiveMemoryAction: (id: string) => archiveMemoryAction(id),
  applyProposalPlanAction: (id: string) => applyProposalPlanAction(id),
  distillExampleAction: vi.fn().mockResolvedValue({ ok: false, error: "unused in card tests" }),
  teachExampleAction: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

// The proposal-scoped chat button pulls in the curator server actions and the
// full ChatPanel — both mocked so the card test stays component-only.
vi.mock("@/app/curator/actions", () => ({
  chatAction: vi.fn(),
  confirmActionAction: vi.fn(),
  setAddendumAction: vi.fn(),
}));
vi.mock("@/components/curator/chat-panel", () => ({
  ChatPanel: () => <div data-testid="chat-panel" />,
}));

const { ProposalCard } = await import("@/components/memories/proposal-card");

// Build a MemoryShape-ish row body — only the fields the card reads.
function memory(over: Partial<ProposalReviewRow["proposal"]> = {}): ProposalReviewRow["proposal"] {
  return {
    id: "mem_proposed",
    agent_id: "scribe",
    status: "proposed",
    tags: [],
    applies_to: [],
    supersedes: [],
    conflicts_with: [],
    flags: [],
    title: "Coffee",
    body: "Espresso, one sugar.",
    confidence: "high",
    updated_at: "2026-06-01T00:00:00.000Z",
    curator_note: null,
    is_global: false,
    requires_approval: true,
    shelfId: "shelf-1",
    shelfWritable: true,
    ...over,
  } as ProposalReviewRow["proposal"];
}

function row(over: Partial<ProposalReviewRow> = {}): ProposalReviewRow {
  return {
    proposal: memory(),
    action: null,
    source: null,
    rationale: null,
    targets: [],
    diff: null,
    plan: null,
    ...over,
  } as ProposalReviewRow;
}

// A plan-carrying row's plan (F2) — the enriched shape proposalsForReview returns.
function plan(over: Partial<NonNullable<ProposalReviewRow["plan"]>> = {}) {
  return {
    action: "augment",
    confidence: 0.7,
    guessed_target: { id: "mem_elaine", title: "Elaine", status: "active" },
    guessed_target_reason: null,
    planned_addition: "Now works at [[Acme]].",
    planned_title: null,
    planned_body: null,
    planned_tags: null,
    preview_diff: "--- a\n+++ b\n@@ -1 +1,2 @@\n Lives in Paris.\n+Now works at [[Acme]].",
    ...over,
  } as NonNullable<ProposalReviewRow["plan"]>;
}

function move(over: Partial<NonNullable<ProposalReviewRow["move"]>> = {}) {
  return {
    target: { id: "mem_target", title: "Coffee", status: "active" },
    source_shelf: { id: "personal", label: "My shelf" },
    destination_shelf: { id: "team", label: "Team knowledge" },
    failure_reason: null,
    ...over,
  } as NonNullable<ProposalReviewRow["move"]>;
}

beforeEach(() => {
  approveProposalAction.mockReset().mockResolvedValue({ ok: true });
  rejectProposalAction.mockReset().mockResolvedValue({ ok: true });
  archiveMemoryAction.mockReset().mockResolvedValue({ ok: true });
  applyProposalPlanAction.mockReset().mockResolvedValue({ ok: true });
  refresh.mockReset();
});

describe("ProposalCard — grooming update (single target)", () => {
  const updateRow = () =>
    row({
      action: "update",
      source: "grooming",
      rationale: "Corrected the sugar preference",
      targets: [memory({ id: "mem_target", title: "Coffee", body: "Espresso, no sugar." })],
      diff: "--- a\n+++ b\n@@ -1 +1 @@\n-Espresso, no sugar.\n+Espresso, one sugar.",
      proposal: memory({ title: "Coffee", body: "Espresso, one sugar." }),
    });

  it("renders the Update badge", () => {
    render(<ProposalCard row={updateRow()} />);
    expect(screen.getByText("Update")).toBeInTheDocument();
  });

  it("shows the source chip and the curator's rationale", () => {
    render(<ProposalCard row={updateRow()} />);
    expect(screen.getByText("grooming")).toBeInTheDocument();
    expect(screen.getByText(/Corrected the sugar preference/)).toBeInTheDocument();
  });

  it("shows the target's old body", () => {
    render(<ProposalCard row={updateRow()} />);
    expect(screen.getByText("Espresso, no sugar.")).toBeInTheDocument();
  });

  it("shows the proposed outcome's tags once as informational pills", () => {
    const tagged = updateRow();
    tagged.proposal.tags = ["preference", "coffee"];
    tagged.targets[0]!.tags = ["target-only"];
    render(<ProposalCard row={tagged} />);

    expect(screen.getAllByText("preference")).toHaveLength(1);
    expect(screen.getByText("preference").tagName).toBe("SPAN");
    expect(screen.queryByText("target-only")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Filter by tag preference" })).toBeNull();
  });

  it("renders a DiffView between old and new", () => {
    render(<ProposalCard row={updateRow()} />);
    expect(screen.getByLabelText("Unified diff")).toBeInTheDocument();
  });

  it("labels Approve with the replace-one consequence", () => {
    render(<ProposalCard row={updateRow()} />);
    expect(screen.getByRole("button", { name: "Approve — replaces 1 memory" })).toBeInTheDocument();
  });

  it("approves through the server action and refreshes", async () => {
    render(<ProposalCard row={updateRow()} />);
    fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
    await waitFor(() =>
      expect(approveProposalAction).toHaveBeenCalledWith("mem_proposed", "shelf-1"),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("rejects through the server action", async () => {
    render(<ProposalCard row={updateRow()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() =>
      expect(rejectProposalAction).toHaveBeenCalledWith("mem_proposed", "shelf-1"),
    );
  });
});

describe("ProposalCard — single-target update with an identical body (empty diff)", () => {
  // A real grooming update whose body didn't change yields diff === "" (the
  // server returns "" for identical). The single-target layout must still
  // render — it must NOT fall back to the intake "needs filing" copy.
  const identicalRow = () =>
    row({
      action: "update",
      source: "grooming",
      rationale: "Re-affirmed, body unchanged",
      targets: [memory({ id: "mem_target", title: "Coffee", body: "Espresso, one sugar." })],
      diff: "",
      proposal: memory({ title: "Coffee", body: "Espresso, one sugar." }),
    });

  it("renders the single-target Current/Proposed layout, not the intake needs-filing copy", () => {
    render(<ProposalCard row={identicalRow()} />);
    expect(screen.getByText("Current memory")).toBeInTheDocument();
    expect(screen.getByText("Proposed")).toBeInTheDocument();
    expect(screen.queryByText(/wasn.t sure where this belongs/i)).not.toBeInTheDocument();
  });

  it("shows the DiffView's identical-versions note for an empty diff", () => {
    render(<ProposalCard row={identicalRow()} />);
    expect(screen.getByText(/No changes — versions are identical/i)).toBeInTheDocument();
  });
});

describe("ProposalCard — intake create (no target)", () => {
  const createRow = () =>
    row({
      action: "create",
      source: "intake",
      rationale: "A new fact worth keeping",
      targets: [],
      diff: null,
      proposal: memory({ id: "mem_new", title: "New fact", body: "Worth keeping." }),
    });

  it("renders the honest 'New — needs filing' badge", () => {
    render(<ProposalCard row={createRow()} />);
    expect(screen.getByText("New — needs filing")).toBeInTheDocument();
  });

  it("renders NO diff", () => {
    render(<ProposalCard row={createRow()} />);
    expect(screen.queryByLabelText("Unified diff")).not.toBeInTheDocument();
  });

  it("shows the submission body and a 'review and file' note", () => {
    render(<ProposalCard row={createRow()} />);
    expect(screen.getByText("Worth keeping.")).toBeInTheDocument();
    // Apostrophe-agnostic: the editorial copy uses a typographic apostrophe.
    expect(screen.getByText(/wasn.t sure where this belongs/i)).toBeInTheDocument();
  });

  it("labels Approve plainly (nothing is archived)", () => {
    render(<ProposalCard row={createRow()} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("preserves the curator's guessed action as descriptive text for an intake supersede", () => {
    render(
      <ProposalCard
        row={row({
          action: "supersede",
          source: "intake",
          targets: [],
          diff: null,
          proposal: memory({ title: "Orphan", body: "no target recorded" }),
        })}
      />,
    );
    // The authoritative badge is still the honest one...
    expect(screen.getByText("New — needs filing")).toBeInTheDocument();
    // ...but the curator's guess is preserved somewhere as muted description.
    expect(screen.getByText(/supersede/)).toBeInTheDocument();
  });
});

describe("ProposalCard — merge (>= 2 targets)", () => {
  const mergeRow = () =>
    row({
      action: "merge",
      source: "grooming",
      rationale: "Collapsed two duplicates",
      targets: [
        memory({ id: "mem_a", title: "Dup A", body: "same fact, phrasing A" }),
        memory({ id: "mem_b", title: "Dup B", body: "same fact, phrasing B" }),
      ],
      diff: null,
      proposal: memory({ id: "mem_merged", title: "Merged fact", body: "the merged fact" }),
    });

  it("renders the Merge badge", () => {
    render(<ProposalCard row={mergeRow()} />);
    expect(screen.getByText("Merge")).toBeInTheDocument();
  });

  it("lists both source memories", () => {
    render(<ProposalCard row={mergeRow()} />);
    expect(screen.getByText("Dup A")).toBeInTheDocument();
    expect(screen.getByText("Dup B")).toBeInTheDocument();
  });

  it("renders the merged replacement and NO diff", () => {
    render(<ProposalCard row={mergeRow()} />);
    expect(screen.getByText("Merged fact")).toBeInTheDocument();
    expect(screen.queryByLabelText("Unified diff")).not.toBeInTheDocument();
  });

  it("labels Approve with the merges-N consequence", () => {
    render(<ProposalCard row={mergeRow()} />);
    expect(screen.getByRole("button", { name: "Approve — merges 2 memories" })).toBeInTheDocument();
  });
});

describe("ProposalCard — plan panel (proposal-review rework F2)", () => {
  const augmentRow = () =>
    row({
      action: "augment",
      source: "intake",
      rationale: "extends the Elaine doc",
      proposal: memory({ id: "mem_plan", title: "Elaine works at Acme", body: "raw submission" }),
      plan: plan(),
    });

  it("renders the augment intent line with the resolved target title", () => {
    render(<ProposalCard row={augmentRow()} />);
    expect(screen.getByText(/Wanted to/)).toBeInTheDocument();
    expect(screen.getByText("augment", { selector: "em" })).toBeInTheDocument();
    expect(screen.getByText(/Elaine/, { selector: "strong" })).toBeInTheDocument();
  });

  it("shows the planned addition and the judgment confidence", () => {
    render(<ProposalCard row={augmentRow()} />);
    expect(screen.getByText("Now works at [[Acme]].")).toBeInTheDocument();
    expect(screen.getByText(/confidence 0\.70/)).toBeInTheDocument();
  });

  it("renders the plan's preview diff", () => {
    render(<ProposalCard row={augmentRow()} />);
    expect(screen.getByLabelText("Unified diff")).toBeInTheDocument();
  });

  it("still badges 'New — needs filing' — a guessed target is not a resolved one (D10)", () => {
    render(<ProposalCard row={augmentRow()} />);
    expect(screen.getByText("New — needs filing")).toBeInTheDocument();
  });

  it("does not show the 'wasn't sure' copy when the curator had a plan", () => {
    render(<ProposalCard row={augmentRow()} />);
    expect(screen.queryByText(/wasn.t sure where this belongs/i)).not.toBeInTheDocument();
  });

  it("renders the supersede intent with the planned replacement", () => {
    render(
      <ProposalCard
        row={row({
          action: "supersede",
          source: "intake",
          proposal: memory({ title: "Coffee update", body: "raw" }),
          plan: plan({
            action: "supersede",
            planned_addition: null,
            planned_title: "Coffee",
            planned_body: "Espresso, one sugar.",
            guessed_target: { id: "mem_coffee", title: "Coffee", status: "active" },
          }),
        })}
      />,
    );
    expect(screen.getByText("replace", { selector: "em" })).toBeInTheDocument();
    expect(screen.getByText("Espresso, one sugar.")).toBeInTheDocument();
  });

  it("renders the create intent with the curated title/body", () => {
    render(
      <ProposalCard
        row={row({
          action: "create",
          source: "intake",
          proposal: memory({ title: "raw title", body: "raw body" }),
          plan: plan({
            action: "create",
            guessed_target: null,
            planned_addition: null,
            planned_title: "Elaine — Piano Teacher",
            planned_body: "Teaches on Tuesdays.",
            planned_tags: ["person"],
            preview_diff: null,
          }),
        })}
      />,
    );
    expect(screen.getByText(/file a new memory/)).toBeInTheDocument();
    expect(screen.getByText("Elaine — Piano Teacher")).toBeInTheDocument();
    expect(screen.getByText("Teaches on Tuesdays.")).toBeInTheDocument();
  });

  it("explains an unresolvable guessed target instead of showing a preview", () => {
    render(
      <ProposalCard
        row={row({
          action: "augment",
          source: "intake",
          proposal: memory({ title: "Orphan", body: "raw" }),
          plan: plan({
            guessed_target: null,
            guessed_target_reason: "not_found",
            preview_diff: null,
          }),
        })}
      />,
    );
    expect(screen.getByText(/no longer exists/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Unified diff")).not.toBeInTheDocument();
  });

  it("explains an archived guessed target", () => {
    render(
      <ProposalCard
        row={row({
          action: "augment",
          source: "intake",
          proposal: memory({ title: "Late", body: "raw" }),
          plan: plan({
            guessed_target: { id: "mem_x", title: "Retired doc", status: "archived" },
            guessed_target_reason: "archived",
          }),
        })}
      />,
    );
    expect(screen.getByText(/archived/i)).toBeInTheDocument();
  });

  it("a plan-less proposal renders no plan panel (exactly today's card)", () => {
    render(<ProposalCard row={row({ action: "create", source: "intake" })} />);
    expect(screen.queryByText(/Wanted to/)).not.toBeInTheDocument();
    expect(screen.getByText(/wasn.t sure where this belongs/i)).toBeInTheDocument();
  });
});

describe("ProposalCard — apply-the-plan affordance (F3)", () => {
  const augmentRow = () =>
    row({
      action: "augment",
      source: "intake",
      proposal: memory({ id: "mem_plan", title: "Elaine works at Acme", body: "raw" }),
      plan: plan(),
    });

  it("shows 'Approve as augment of ‹target›' as the primary action", () => {
    render(<ProposalCard row={augmentRow()} />);
    expect(
      screen.getByRole("button", { name: "Approve as augment of Elaine" }),
    ).toBeInTheDocument();
  });

  it("executes the persisted plan through the server action and refreshes", async () => {
    render(<ProposalCard row={augmentRow()} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve as augment of Elaine" }));
    await waitFor(() => expect(applyProposalPlanAction).toHaveBeenCalledWith("mem_plan"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("keeps 'Approve as new' (plain approve) and Reject available", async () => {
    render(<ProposalCard row={augmentRow()} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve as new" }));
    await waitFor(() => expect(approveProposalAction).toHaveBeenCalledWith("mem_plan", "shelf-1"));
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  it("labels a supersede plan 'Approve — replaces ‹target›'", () => {
    render(
      <ProposalCard
        row={row({
          action: "supersede",
          source: "intake",
          proposal: memory({ id: "mem_sup", title: "Coffee update", body: "raw" }),
          plan: plan({
            action: "supersede",
            planned_addition: null,
            planned_title: "Coffee",
            planned_body: "Espresso, one sugar.",
            guessed_target: { id: "mem_coffee", title: "Coffee", status: "active" },
          }),
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "Approve — replaces Coffee" })).toBeInTheDocument();
  });

  it("disables the affordance with the reason when the target is unresolvable", () => {
    render(
      <ProposalCard
        row={row({
          action: "augment",
          source: "intake",
          proposal: memory({ id: "mem_orphan", title: "Orphan", body: "raw" }),
          plan: plan({
            guessed_target: null,
            guessed_target_reason: "not_found",
            preview_diff: null,
          }),
        })}
      />,
    );
    const button = screen.getByRole("button", { name: /Approve as augment/ });
    expect(button).toBeDisabled();
  });

  it("disables the affordance when the target was archived since judgment", () => {
    render(
      <ProposalCard
        row={row({
          action: "augment",
          source: "intake",
          proposal: memory({ id: "mem_late", title: "Late", body: "raw" }),
          plan: plan({
            guessed_target: { id: "mem_x", title: "Retired doc", status: "archived" },
            guessed_target_reason: "archived",
          }),
        })}
      />,
    );
    expect(screen.getByRole("button", { name: /Approve as augment/ })).toBeDisabled();
  });

  it("surfaces a teaching error on the card when applying the plan fails server-side", async () => {
    applyProposalPlanAction.mockResolvedValueOnce({
      ok: false,
      error: "The memory the curator wanted to augment no longer exists",
    });
    render(<ProposalCard row={augmentRow()} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve as augment of Elaine" }));
    await waitFor(() => expect(screen.getByText(/no longer exists/)).toBeInTheDocument());
  });

  it("offers no apply-plan affordance on a create plan (D11 owns that path)", () => {
    render(
      <ProposalCard
        row={row({
          action: "create",
          source: "intake",
          proposal: memory({ title: "raw", body: "raw" }),
          plan: plan({
            action: "create",
            guessed_target: null,
            planned_addition: null,
            planned_title: "Curated",
            planned_body: "Curated body.",
            preview_diff: null,
          }),
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: /augment|replaces/ })).not.toBeInTheDocument();
  });

  it("offers no apply-plan affordance on a plan-less proposal", () => {
    render(<ProposalCard row={row({ action: "create", source: "intake" })} />);
    expect(screen.queryByRole("button", { name: /augment|replaces/ })).not.toBeInTheDocument();
  });
});

describe("ProposalCard — move request (spec 067)", () => {
  const moveRow = (over: Partial<ProposalReviewRow> = {}) =>
    row({
      action: "move",
      source: "dashboard",
      rationale: "This belongs with the team",
      proposal: memory({
        id: "mem_move",
        title: "Move: Coffee",
        body: "This belongs with the team",
      }),
      move: move(),
      ...over,
    });

  it("renders a Move badge, target preview, and labelled source-to-destination shelves", () => {
    render(<ProposalCard row={moveRow()} />);
    expect(screen.getByText("Move")).toBeInTheDocument();
    expect(screen.getByText("Coffee")).toBeInTheDocument();
    expect(screen.getByText("My shelf")).toHaveAttribute("title", "personal");
    expect(screen.getByText("Team knowledge")).toHaveAttribute("title", "team");
    expect(screen.getByText("→")).toBeInTheDocument();
  });

  it("shows no content diff and never offers plain approval", () => {
    render(<ProposalCard row={moveRow()} />);
    expect(screen.queryByLabelText("Unified diff")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument();
  });

  it("applies the move plan and keeps Reject available", async () => {
    render(<ProposalCard row={moveRow()} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply move" }));
    await waitFor(() => expect(applyProposalPlanAction).toHaveBeenCalledWith("mem_move"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  it("fails soft with the reason and leaves only Discuss and Reject resolutions", () => {
    render(
      <ProposalCard
        row={moveRow({
          move: move({
            target: null,
            source_shelf: null,
            failure_reason: "target_not_found",
          }),
        })}
      />,
    );
    expect(screen.getByText(/target memory no longer resolves/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply move" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discuss this proposal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });
});

describe("ProposalCard — create-plan approve-with-patch (D11)", () => {
  const createPlanRow = () =>
    row({
      action: "create",
      source: "intake",
      proposal: memory({ id: "mem_create", title: "raw first line", body: "raw submission" }),
      plan: plan({
        action: "create",
        guessed_target: null,
        planned_addition: null,
        planned_title: "Elaine — Piano Teacher",
        planned_body: "Teaches on Tuesdays.",
        planned_tags: ["person"],
        preview_diff: null,
      }),
    });

  it("default Approve sends the curated title/body/tags as the patch", async () => {
    render(<ProposalCard row={createPlanRow()} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve curated version" }));
    await waitFor(() =>
      expect(approveProposalAction).toHaveBeenCalledWith("mem_create", "shelf-1", {
        title: "Elaine — Piano Teacher",
        body: "Teaches on Tuesdays.",
        tags: ["person"],
      }),
    );
  });

  it("'Approve raw submission' sends no patch (today's behaviour)", async () => {
    render(<ProposalCard row={createPlanRow()} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve raw submission" }));
    await waitFor(() =>
      expect(approveProposalAction).toHaveBeenCalledWith("mem_create", "shelf-1"),
    );
  });

  it("a plan-less proposal keeps the single Approve (no raw-submission secondary)", () => {
    render(<ProposalCard row={row({ action: "create", source: "intake" })} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Approve raw submission" }),
    ).not.toBeInTheDocument();
  });
});

describe("ProposalCard — reject & make an example entry point (F4)", () => {
  it("offers 'Reject & make an example' on an intake-sourced proposal", () => {
    render(<ProposalCard row={row({ action: "create", source: "intake" })} />);
    expect(screen.getByRole("button", { name: "Reject & make an example" })).toBeInTheDocument();
  });

  it("hides it on a grooming-sourced proposal (v1 scope)", () => {
    render(
      <ProposalCard
        row={row({
          action: "update",
          source: "grooming",
          targets: [memory({ id: "mem_t", title: "T", body: "b" })],
          diff: "",
        })}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Reject & make an example" }),
    ).not.toBeInTheDocument();
  });

  it("keeps plain Reject alongside the teach entry point", () => {
    render(<ProposalCard row={row({ action: "create", source: "intake" })} />);
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject & make an example" })).toBeInTheDocument();
  });
});

describe("ProposalCard — proposal-scoped chat entry point (F5)", () => {
  it("offers 'Discuss this proposal' on an intake proposal", () => {
    render(<ProposalCard row={row({ action: "create", source: "intake" })} />);
    expect(screen.getByRole("button", { name: "Discuss this proposal" })).toBeInTheDocument();
  });

  it("offers it on grooming-sourced and legacy plan-less proposals too (D4)", () => {
    render(
      <ProposalCard
        row={row({
          action: "update",
          source: "grooming",
          targets: [memory({ id: "mem_t", title: "T", body: "b" })],
          diff: "",
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "Discuss this proposal" })).toBeInTheDocument();
  });

  it("opens the chat dialog grounded in the proposal", async () => {
    render(<ProposalCard row={row({ action: "create", source: "intake" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Discuss this proposal" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.getByTestId("chat-panel")).toBeInTheDocument();
  });
});

describe("ProposalCard — actor display footer (spec 068)", () => {
  it("shows a resolved display name with the stable actor id in a tooltip", () => {
    render(<ProposalCard row={row({ actorDisplay: "Alice Member" })} />);

    const actor = screen.getByTitle("scribe");
    expect(actor).toHaveTextContent("Alice Member");
    expect(screen.queryByText(/^scribe · /)).not.toBeInTheDocument();
  });

  it("keeps the existing raw-id footer DOM when no display is resolved", () => {
    render(<ProposalCard row={row()} />);

    expect(screen.getByText(/^scribe · /)).toBeInTheDocument();
    expect(screen.queryByTitle("scribe")).not.toBeInTheDocument();
  });
});

describe("ProposalCard — flagged correction review", () => {
  const correctionRow = (
    correctionReview: NonNullable<ProposalReviewRow["correctionReview"]> = {
      source_memory_id: "mem_source",
      shelf_id: "shelf-1",
      status: "ready",
    },
  ) =>
    row({
      action: "update",
      source: "flagged_correction",
      rationale: "Remove the outdated claim only.",
      proposal: memory({
        id: "mem_correction",
        title: "Account",
        body: "Keep the useful fact.",
        curator_note: { source: "flagged_correction", proposed_action: "update" },
      }),
      targets: [
        memory({
          id: "mem_source",
          status: "active",
          title: "Account",
          body: "Keep the useful fact. Old claim.",
          flags: [
            {
              agent_id: "scribe",
              reason: "The second claim is outdated.",
              created_at: "2026-06-02T00:00:00.000Z",
            },
          ],
        }),
      ],
      diff: "--- a\\n+++ b\\n@@ -1 +1 @@\\n-Keep the useful fact. Old claim.\\n+Keep the useful fact.",
      correctionReview,
    });

  it("shows the flags and explains the explicit approval outcome", () => {
    render(<ProposalCard row={correctionRow()} />);

    expect(screen.getByRole("region", { name: "Flagged correction review" })).toHaveTextContent(
      "The second claim is outdated.",
    );
    expect(screen.getByRole("region", { name: "Flagged correction review" })).toHaveTextContent(
      /archives the flagged source/,
    );
    expect(screen.getByRole("button", { name: "Approve correction" })).toBeEnabled();
  });

  it("approves through the exact-shelf action and omits generic discuss/teach paths", async () => {
    render(<ProposalCard row={correctionRow()} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve correction" }));

    await waitFor(() =>
      expect(approveProposalAction).toHaveBeenCalledWith("mem_correction", "shelf-1"),
    );
    expect(screen.queryByRole("button", { name: "Discuss this proposal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject & make an example" })).toBeNull();
  });

  it("blocks approval on a stale baseline but leaves exact-shelf rejection available", async () => {
    render(
      <ProposalCard
        row={correctionRow({
          source_memory_id: "mem_source",
          shelf_id: "shelf-1",
          status: "blocked",
          reason_code: "correction_content_drifted",
        })}
      />,
    );

    expect(screen.getByRole("button", { name: "Approve correction" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() =>
      expect(rejectProposalAction).toHaveBeenCalledWith("mem_correction", "shelf-1"),
    );
  });
});

describe("ProposalCard — fail-soft", () => {
  it("does not throw when the approve action rejects (Librarian/network failure)", async () => {
    approveProposalAction.mockRejectedValueOnce(new Error("network down"));
    render(<ProposalCard row={row({ action: "create", source: "intake" })} />);
    fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
    // The card stays mounted; the badge is still on screen.
    await waitFor(() => expect(approveProposalAction).toHaveBeenCalled());
    expect(screen.getByText("New — needs filing")).toBeInTheDocument();
  });
});

// Spec 072 SC 7 — a proposal whose superseded memory changed while it sat in
// the queue. The card states it, names what moved, and closes every path that
// would activate the proposal. There is deliberately no "approve anyway": an
// override that exists is one that gets clicked through (D3).
function drift(
  over: Partial<NonNullable<ProposalReviewRow["drift"]>> = {},
): NonNullable<ProposalReviewRow["drift"]> {
  return {
    status: "clean",
    sources: [{ id: "mem_target", title: "Coffee", drifted: false }],
    ...over,
  } as NonNullable<ProposalReviewRow["drift"]>;
}

const DRIFTED = drift({
  status: "drifted",
  sources: [{ id: "mem_target", title: "Coffee", drifted: true }],
});

describe("ProposalCard — drift (spec 072 SC 7)", () => {
  it("says the memory changed and names it", () => {
    render(<ProposalCard row={row({ action: "update", drift: DRIFTED })} />);

    const warning = screen.getByRole("alert", { name: "This proposal is out of date" });
    expect(warning).toHaveTextContent("Coffee");
    expect(warning).toHaveTextContent(/has changed/);
  });

  it("promises the curator will re-read it, so rejecting reads as routine", () => {
    render(<ProposalCard row={row({ action: "update", drift: DRIFTED })} />);

    expect(screen.getByRole("alert", { name: "This proposal is out of date" })).toHaveTextContent(
      /next grooming run/,
    );
  });

  it("disables Approve and offers no way through", () => {
    render(<ProposalCard row={row({ action: "update", drift: DRIFTED })} />);

    expect(screen.getByRole("button", { name: /Approve/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /anyway/i })).not.toBeInTheDocument();
  });

  it("leaves Reject live — it is how a stale proposal leaves the queue", () => {
    render(<ProposalCard row={row({ action: "update", drift: DRIFTED })} />);

    expect(screen.getByRole("button", { name: /Reject/ })).not.toBeDisabled();
  });

  it("says nothing and blocks nothing when the sources are clean", () => {
    render(<ProposalCard row={row({ action: "update", drift: drift() })} />);

    expect(screen.queryByRole("alert", { name: "This proposal is out of date" })).toBeNull();
    expect(screen.getByRole("button", { name: /Approve/ })).not.toBeDisabled();
  });

  it("does not block a legacy proposal whose drift cannot be determined", () => {
    render(<ProposalCard row={row({ action: "update", drift: drift({ status: "unknown" }) })} />);

    expect(screen.queryByRole("alert", { name: "This proposal is out of date" })).toBeNull();
    expect(screen.getByRole("button", { name: /Approve/ })).not.toBeDisabled();
  });
});
