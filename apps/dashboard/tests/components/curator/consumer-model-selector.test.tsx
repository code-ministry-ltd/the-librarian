import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConsumerConfig } from "@librarian/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { ConsumerModelSelector } = await import("@/components/curator/consumer-model-selector");

const config: ConsumerConfig = {
  consumer: "intake",
  enabled: true,
  providerId: "p1",
  providerExists: true,
  endpoint: "http://marvin:8033/v1",
  model: "subagent",
  timeoutMs: 300_000,
  maxOutputTokens: 16_384,
  reasoningEffort: null,
  hasToken: true,
  isOperational: true,
};
const providers = [
  { id: "p1", name: "Marvin", endpoint: "http://marvin:8033/v1", hasToken: true },
] as never;

let onSave: ReturnType<typeof vi.fn>;

beforeEach(() => {
  onSave = vi.fn().mockResolvedValue({ ok: true, config });
});

function renderSelector() {
  render(
    <ConsumerModelSelector
      consumer="intake"
      config={config}
      providers={providers}
      onSave={onSave as never}
      onListModels={async () => ({ models: [] })}
    />,
  );
}

// Marvin incident (2026-10-01): a looping local model needs a per-job output limit
// and an optional thinking level, editable next to the model.
describe("ConsumerModelSelector output limit and thinking level", () => {
  it("shows the job's current output limit and provider-default thinking", () => {
    renderSelector();
    expect(screen.getByLabelText("Output limit (tokens)")).toHaveValue(16_384);
    expect(screen.getByLabelText("Thinking level")).toHaveValue("");
  });

  it("saves a changed output limit and thinking level with the model", async () => {
    renderSelector();
    fireEvent.change(screen.getByLabelText("Output limit (tokens)"), {
      target: { value: "24000" },
    });
    fireEvent.change(screen.getByLabelText("Thinking level"), { target: { value: "low" } });
    fireEvent.click(screen.getByRole("button", { name: "Save model" }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith("intake", {
        providerId: "p1",
        model: "subagent",
        maxOutputTokens: 24_000,
        reasoningEffort: "low",
      }),
    );
  });

  it("refuses a non-numeric output limit before saving", async () => {
    renderSelector();
    fireEvent.change(screen.getByLabelText("Output limit (tokens)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save model" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/whole number of tokens/);
    expect(onSave).not.toHaveBeenCalled();
  });
});
