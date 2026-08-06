import { afterEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn();
const updateMock = vi.fn();
const archiveMock = vi.fn();
const moveMock = vi.fn();
const proposeMoveMock = vi.fn();
const recallMock = vi.fn();
const bulkUpdateMock = vi.fn();
const searchRefsMock = vi.fn();
const revalidateMock = vi.fn();

vi.mock("@/lib/trpc-server", () => ({
  serverTRPC: {
    memories: {
      create: { mutate: createMock },
      update: { mutate: updateMock },
      archive: { mutate: archiveMock },
      move: { mutate: moveMock },
      proposeMove: { mutate: proposeMoveMock },
      recall: { mutate: recallMock },
      bulkUpdate: { mutate: bulkUpdateMock },
    },
    vault: {
      searchReferences: { mutate: searchRefsMock },
    },
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: revalidateMock,
}));

const actions = await import("../app/(memories)/actions");

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

describe("memories actions", () => {
  afterEach(() => {
    createMock.mockReset();
    updateMock.mockReset();
    archiveMock.mockReset();
    moveMock.mockReset();
    proposeMoveMock.mockReset();
    recallMock.mockReset();
    bulkUpdateMock.mockReset();
    searchRefsMock.mockReset();
    revalidateMock.mockReset();
  });

  it("createMemoryAction forwards form fields and revalidates", async () => {
    createMock.mockResolvedValueOnce({ id: "mem_1" });
    const result = await actions.createMemoryAction(form({ title: "T", body: "B", tags: "a, b" }));
    expect(result).toEqual({ ok: true });
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "T",
        body: "B",
        tags: ["a", "b"],
      }),
    );
    expect(revalidateMock).toHaveBeenCalledWith("/");
  });

  it("updateMemoryAction wraps fields in a patch", async () => {
    updateMock.mockResolvedValueOnce({});
    await actions.updateMemoryAction("mem_1", form({ title: "X" }));
    expect(updateMock).toHaveBeenCalledWith({
      id: "mem_1",
      patch: expect.objectContaining({ title: "X" }),
    });
  });

  it("archiveMemoryAction passes the id", async () => {
    archiveMock.mockResolvedValueOnce({});
    await actions.archiveMemoryAction("mem_1");
    expect(archiveMock).toHaveBeenCalledWith({ id: "mem_1" });
  });

  it("moveMemoryAction moves directly and refreshes the active list", async () => {
    moveMock.mockResolvedValueOnce({});
    await expect(actions.moveMemoryAction("mem_1", "team")).resolves.toEqual({ ok: true });
    expect(moveMock).toHaveBeenCalledWith({ id: "mem_1", shelf: "team" });
    expect(revalidateMock).toHaveBeenCalledWith("/");
  });

  it("moveMemoryAction returns the server's non-blocking project warning", async () => {
    moveMock.mockResolvedValueOnce({
      move_warnings: [
        {
          code: "missing-active-projects",
          project_keys: ["source-only"],
          message: "The move succeeded; associations were preserved.",
        },
      ],
    });
    await expect(actions.moveMemoryAction("mem_1", "team")).resolves.toEqual({
      ok: true,
      warning: "The move succeeded; associations were preserved.",
    });
  });

  it("proposeMoveAction queues the optional rationale and refreshes proposals", async () => {
    proposeMoveMock.mockResolvedValueOnce({});
    await expect(
      actions.proposeMoveAction("mem_1", "team", "Belongs with the team"),
    ).resolves.toEqual({ ok: true });
    expect(proposeMoveMock).toHaveBeenCalledWith({
      id: "mem_1",
      shelf: "team",
      rationale: "Belongs with the team",
    });
    expect(revalidateMock).toHaveBeenCalledWith("/proposals");
  });

  it("proposeMoveAction omits a blank rationale and returns teaching errors", async () => {
    proposeMoveMock.mockRejectedValueOnce(new Error("That move is already proposed"));
    const result = await actions.proposeMoveAction("mem_1", "team", "   ");
    expect(proposeMoveMock).toHaveBeenCalledWith({ id: "mem_1", shelf: "team" });
    expect(result).toEqual({ ok: false, error: "That move is already proposed" });
  });

  it("recallAction returns ok and memories on success", async () => {
    const memories = [{ id: "mem_1" }, { id: "mem_2" }];
    recallMock.mockResolvedValueOnce({ memories });
    const result = await actions.recallAction("hello");
    expect(result).toEqual({ ok: true, memories });
    expect(recallMock).toHaveBeenCalledWith({ query: "hello", limit: 12 });
  });

  it("recallAction forwards tags and an explicit limit when given", async () => {
    recallMock.mockResolvedValueOnce({ memories: [] });
    await actions.recallAction("hello", { tags: ["drink"], limit: 5 });
    expect(recallMock).toHaveBeenCalledWith({ query: "hello", tags: ["drink"], limit: 5 });
  });

  it("recallAction rejects empty queries", async () => {
    const result = await actions.recallAction("   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/empty/i);
    expect(recallMock).not.toHaveBeenCalled();
  });

  it("searchReferencesAction returns ok, references and the searched count", async () => {
    const references = [
      { id: "references/AI/Gentle Codeing.md", score: 0.9, section: "## Gentle coding" },
    ];
    searchRefsMock.mockResolvedValueOnce({ references, searched: 12 });
    const result = await actions.searchReferencesAction("gentle coding");
    expect(result).toEqual({ ok: true, references, searched: 12 });
    expect(searchRefsMock).toHaveBeenCalledWith({ query: "gentle coding" });
  });

  it("searchReferencesAction forwards an explicit limit", async () => {
    searchRefsMock.mockResolvedValueOnce({ references: [] });
    await actions.searchReferencesAction("gentle coding", 5);
    expect(searchRefsMock).toHaveBeenCalledWith({ query: "gentle coding", limit: 5 });
  });

  it("searchReferencesAction rejects empty queries", async () => {
    const result = await actions.searchReferencesAction("   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/empty/i);
    expect(searchRefsMock).not.toHaveBeenCalled();
  });

  it("searchReferencesAction surfaces upstream errors", async () => {
    searchRefsMock.mockRejectedValueOnce(new Error("index boom"));
    const result = await actions.searchReferencesAction("gentle coding");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("index boom");
  });

  it("createMemoryAction surfaces upstream errors", async () => {
    createMock.mockRejectedValueOnce(new Error("upstream boom"));
    const result = await actions.createMemoryAction(form({ title: "T" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("upstream boom");
  });

  it("bulkUpdateMemoriesAction forwards ids + patch and returns the txn (D1.1)", async () => {
    bulkUpdateMock.mockResolvedValueOnce({ transaction_id: "txn_abc", updated: 3 });
    const result = await actions.bulkUpdateMemoriesAction(["a", "b", "c"], {
      agent_id: "new-home",
    });
    expect(result).toEqual({ ok: true, updated: 3, transaction_id: "txn_abc" });
    expect(bulkUpdateMock).toHaveBeenCalledWith({
      ids: ["a", "b", "c"],
      patch: { agent_id: "new-home" },
    });
  });

  it("bulkUpdateMemoriesAction rejects an empty selection (D1.1)", async () => {
    const result = await actions.bulkUpdateMemoriesAction([], { agent_id: "x" });
    expect(result.ok).toBe(false);
    expect(bulkUpdateMock).not.toHaveBeenCalled();
  });

  it("bulkUpdateMemoriesAction rejects an empty patch (D1.1)", async () => {
    const result = await actions.bulkUpdateMemoriesAction(["a"], {});
    expect(result.ok).toBe(false);
    expect(bulkUpdateMock).not.toHaveBeenCalled();
  });
});
