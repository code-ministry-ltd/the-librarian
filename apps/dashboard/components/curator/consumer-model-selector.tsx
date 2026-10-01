"use client";

// Per-consumer (intake / grooming / Chronicle) provider + model selector — editorial
// rebuild. Provider dropdown + model field (datalist-backed: picks from
// the provider's listModels, accepts free text when the probe yields
// nothing), plus the job's output limit and optional thinking level. No card
// chrome; the parent tab owns the container.

import type {
  ConfigurableJobConsumer,
  ConsumerConfig,
  LlmProvider,
  ReasoningEffort,
} from "@librarian/core";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { ConsumerConfigResult, ModelsResult } from "@/app/curator/actions";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";
import { SectionLabel } from "@/components/ui-v2/section-label";
import { Select } from "@/components/ui-v2/select";

type ThinkingChoice = ReasoningEffort | "";

const THINKING_OPTIONS: { value: ThinkingChoice; label: string }[] = [
  { value: "", label: "Provider default" },
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const CONSUMER_LABEL: Record<ConfigurableJobConsumer, string> = {
  intake: "Intake",
  grooming: "Grooming",
  chronicle: "Chronicle",
};

export function ConsumerModelSelector({
  consumer,
  config,
  providers,
  onSave,
  onListModels,
}: {
  consumer: ConfigurableJobConsumer;
  config: ConsumerConfig;
  providers: LlmProvider[];
  onSave: (
    consumer: ConfigurableJobConsumer,
    patch: {
      providerId?: string;
      model?: string;
      maxOutputTokens?: number;
      reasoningEffort?: ThinkingChoice;
    },
  ) => Promise<ConsumerConfigResult>;
  onListModels: (input: { providerId: string }) => Promise<ModelsResult>;
}) {
  const router = useRouter();
  const [providerId, setProviderId] = useState(config.providerId);
  const [model, setModel] = useState(config.model);
  const [maxOutputTokens, setMaxOutputTokens] = useState(String(config.maxOutputTokens));
  const [thinking, setThinking] = useState<ThinkingChoice>(config.reasoningEffort ?? "");
  const [models, setModels] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!saved) return;
    const id = window.setTimeout(() => setSaved(false), 5000);
    return () => window.clearTimeout(id);
  }, [saved]);

  // Populate the model dropdown whenever a provider is selected. Fail-soft: [] on
  // any error leaves only the free-text input, never blocking the form.
  useEffect(() => {
    let cancelled = false;
    if (!providerId) {
      setModels([]);
      return;
    }
    void onListModels({ providerId }).then((result) => {
      if (!cancelled) setModels(result.models);
    });
    return () => {
      cancelled = true;
    };
  }, [providerId, onListModels]);

  const clearStatus = () => {
    setSaved(false);
    setError(null);
  };

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    clearStatus();
    const limit = Number(maxOutputTokens);
    if (!maxOutputTokens.trim() || !Number.isInteger(limit) || limit <= 0) {
      setError(`Output limit must be a whole number of tokens; got '${maxOutputTokens}'.`);
      return;
    }
    startTransition(async () => {
      const result = await onSave(consumer, {
        providerId,
        model,
        maxOutputTokens: limit,
        reasoningEffort: thinking,
      });
      if (result.ok) {
        setSaved(true);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  const options = model && !models.includes(model) ? [model, ...models] : models;
  const listId = `models-${consumer}`;
  const noProviders = providers.length === 0;
  const providerMissing = !config.providerExists && !!config.providerId;

  return (
    <form
      onSubmit={save}
      className="flex flex-col gap-4"
      aria-label={`${CONSUMER_LABEL[consumer]} model selection`}
      noValidate
    >
      {noProviders ? (
        <p
          role="status"
          className="border border-ink-copper/40 bg-ink-copper/[0.06] p-3 text-sm text-foreground"
        >
          Add an LLM provider above before picking a {consumer} model.
        </p>
      ) : null}
      {providerMissing ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          The previously-saved provider was deleted. Pick another.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <SectionLabel as="label" htmlFor={`${consumer}-provider`}>
            Provider
          </SectionLabel>
          <Select
            id={`${consumer}-provider`}
            aria-label={`${consumer} provider`}
            value={providerId}
            onChange={(e) => {
              setProviderId(e.target.value);
              clearStatus();
            }}
            disabled={noProviders}
          >
            <option value="">— none —</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <SectionLabel as="label" htmlFor={`${consumer}-model`}>
            Model (pick or type)
          </SectionLabel>
          <Input
            id={`${consumer}-model`}
            aria-label={`${consumer} model`}
            variant="mono"
            list={listId}
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              clearStatus();
            }}
            placeholder="gpt-4o-mini"
            disabled={noProviders}
          />
          <datalist id={listId}>
            {options.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <SectionLabel as="label" htmlFor={`${consumer}-max-output-tokens`}>
            Output limit (tokens)
          </SectionLabel>
          <Input
            id={`${consumer}-max-output-tokens`}
            variant="mono"
            type="number"
            inputMode="numeric"
            min={256}
            step={1024}
            value={maxOutputTokens}
            onChange={(e) => {
              setMaxOutputTokens(e.target.value);
              clearStatus();
            }}
            aria-describedby={`${consumer}-max-output-tokens-hint`}
          />
          <p id={`${consumer}-max-output-tokens-hint`} className="text-xs text-foreground/70">
            Stops a runaway model. Thinking counts towards it. A reply that hits the limit is
            discarded and retried, never stored.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <SectionLabel as="label" htmlFor={`${consumer}-thinking`}>
            Thinking level
          </SectionLabel>
          <Select
            id={`${consumer}-thinking`}
            value={thinking}
            onChange={(e) => {
              setThinking(e.target.value as ThinkingChoice);
              clearStatus();
            }}
            aria-describedby={`${consumer}-thinking-hint`}
          >
            {THINKING_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <p id={`${consumer}-thinking-hint`} className="text-xs text-foreground/70">
            Sent as <code>reasoning_effort</code>. Leave on provider default unless your model
            supports it.
          </p>
        </div>
      </div>

      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          Error: {error}
        </p>
      ) : null}
      {saved ? (
        <p
          role="status"
          className="border border-ink-accent/40 bg-ink-accent/[0.06] p-3 text-sm text-foreground"
        >
          Saved.
        </p>
      ) : null}

      <Button
        type="submit"
        variant="primary"
        className="self-start"
        disabled={pending || noProviders}
      >
        {pending ? "Saving…" : "Save model"}
      </Button>
    </form>
  );
}
