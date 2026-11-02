"use client";

// Named LLM provider manager (spec 042 §4, B4b) — editorial rebuild.
// One bordered list container with hairline-separated rows. Add reveals
// an inline form at the bottom; Edit replaces the row with its form.
// Delete asks for inline confirmation (with a referenced-by warning when
// the provider is in use) before running.
//
// The token field is WRITE-ONLY and masked: an empty field leaves the
// stored token unchanged (the secret is never round-tripped). Test
// connection probes the endpoint without ever revealing the token.

import type { LlmProvider } from "@librarian/core";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ProviderListResult, TestConnectionResult } from "@/app/curator/actions";
import { Button } from "@/components/ui-v2/button";
import { Input } from "@/components/ui-v2/input";
import { Pill } from "@/components/ui-v2/pill";
import { SectionLabel } from "@/components/ui-v2/section-label";

export interface ProviderManagerActions {
  onAdd: (input: { name: string; endpoint: string; token?: string }) => Promise<ProviderListResult>;
  onUpdate: (input: {
    id: string;
    name?: string;
    endpoint?: string;
    token?: string;
  }) => Promise<ProviderListResult>;
  onDelete: (id: string) => Promise<ProviderListResult>;
  onTest: (input: {
    providerId?: string;
    endpoint?: string;
    token?: string;
  }) => Promise<TestConnectionResult>;
}

export function ProviderManager({
  initialProviders,
  references,
  actions,
}: {
  initialProviders: LlmProvider[];
  /** Per-provider list of consumer labels currently referencing this provider
   *  ("Intake", "Grooming"). Used by the Delete confirm to warn what breaks. */
  references: Record<string, readonly string[]>;
  actions: ProviderManagerActions;
}) {
  const router = useRouter();
  const [providers, setProviders] = useState<LlmProvider[]>(initialProviders);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const apply = (result: ProviderListResult) => {
    if (result.ok) {
      setProviders(result.providers);
      setEditingId(null);
      setConfirmingDeleteId(null);
      setAdding(false);
      router.refresh();
    }
    return result;
  };

  return (
    <section
      className="flex flex-col gap-4"
      aria-label="LLM providers"
      aria-labelledby="providers-heading"
    >
      <header className="flex items-center justify-between">
        <SectionLabel as="h2" id="providers-heading" className="text-foreground/70">
          LLM providers
        </SectionLabel>
        {!adding ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setAdding(true);
              setEditingId(null);
              setConfirmingDeleteId(null);
            }}
          >
            Add provider
          </Button>
        ) : null}
      </header>

      <div className="border border-ink-hairline bg-ink-surface">
        {providers.length === 0 && !adding ? (
          <p className="px-4 py-6 text-sm text-foreground/70">
            No providers yet. Add one to configure the Intake and Grooming models.
          </p>
        ) : null}

        <ul className="flex flex-col">
          {providers.map((provider, i) => {
            const isEditing = editingId === provider.id;
            const isConfirming = confirmingDeleteId === provider.id;
            const usedBy = references[provider.id] ?? [];
            return (
              <li key={provider.id} className={i > 0 ? "border-t border-ink-hairline" : ""}>
                {isEditing ? (
                  <ProviderForm
                    initial={provider}
                    submitLabel="Save"
                    onSubmit={async (input) =>
                      apply(await actions.onUpdate({ id: provider.id, ...input }))
                    }
                    onCancel={() => setEditingId(null)}
                    onTest={actions.onTest}
                  />
                ) : isConfirming ? (
                  <DeleteConfirm
                    name={provider.name}
                    usedBy={usedBy}
                    onCancel={() => setConfirmingDeleteId(null)}
                    onConfirm={async () => apply(await actions.onDelete(provider.id))}
                  />
                ) : (
                  <ProviderRow
                    provider={provider}
                    onEdit={() => {
                      setEditingId(provider.id);
                      setConfirmingDeleteId(null);
                      setAdding(false);
                    }}
                    onDelete={() => {
                      setConfirmingDeleteId(provider.id);
                      setEditingId(null);
                    }}
                  />
                )}
              </li>
            );
          })}

          {adding ? (
            <li className={providers.length > 0 ? "border-t border-ink-hairline" : ""}>
              <ProviderForm
                submitLabel="Add"
                onSubmit={async (input) => apply(await actions.onAdd(input))}
                onCancel={() => setAdding(false)}
                onTest={actions.onTest}
              />
            </li>
          ) : null}
        </ul>
      </div>
    </section>
  );
}

function ProviderRow({
  provider,
  onEdit,
  onDelete,
}: {
  provider: LlmProvider;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">{provider.name}</p>
        <p className="truncate font-mono text-xs text-foreground/60">{provider.endpoint}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {provider.hasToken ? (
          <Pill variant="accent">Token set</Pill>
        ) : (
          <span className="text-xs text-foreground/55">No token</span>
        )}
        <Button type="button" variant="outline" onClick={onEdit}>
          Edit
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="text-destructive hover:bg-destructive/[0.06]"
          onClick={onDelete}
          aria-label={`Delete ${provider.name}`}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

function DeleteConfirm({
  name,
  usedBy,
  onCancel,
  onConfirm,
}: {
  name: string;
  usedBy: readonly string[];
  onCancel: () => void;
  onConfirm: () => Promise<unknown>;
}) {
  const [pending, startTransition] = useTransition();
  const usage =
    usedBy.length === 0
      ? "This provider is not currently in use."
      : usedBy.length === 1
        ? `Used by ${usedBy[0]} — it will lose its model.`
        : `Used by ${usedBy.slice(0, -1).join(", ")} and ${usedBy.at(-1)} — they will lose their model.`;
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3" aria-label={`Delete ${name}`}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">Delete {name}?</p>
        <p className={`text-xs ${usedBy.length > 0 ? "text-destructive" : "text-foreground/60"}`}>
          {usage}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={pending}
          onClick={() => startTransition(() => void onConfirm())}
        >
          {pending ? "Deleting…" : "Delete"}
        </Button>
      </div>
    </div>
  );
}

function ProviderForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  onTest,
}: {
  initial?: LlmProvider;
  submitLabel: string;
  onSubmit: (input: {
    name: string;
    endpoint: string;
    token?: string;
  }) => Promise<ProviderListResult>;
  onCancel: () => void;
  onTest: ProviderManagerActions["onTest"];
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [endpoint, setEndpoint] = useState(initial?.endpoint ?? "");
  const [token, setToken] = useState("");
  const [pending, startTransition] = useTransition();
  const [testing, startTest] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setStatus(null);
    startTransition(async () => {
      const input: { name: string; endpoint: string; token?: string } = { name, endpoint };
      if (token.length > 0) input.token = token;
      const result = await onSubmit(input);
      if (!result.ok) setError(result.error);
    });
  };

  const test = () =>
    startTest(async () => {
      setError(null);
      setStatus("Testing…");
      const probe =
        initial && token.length === 0
          ? { providerId: initial.id }
          : { endpoint, ...(token ? { token } : {}) };
      const result = await onTest(probe);
      if (result.ok) {
        setStatus("Connection OK.");
      } else {
        setStatus(null);
        setError(`Connection failed: ${result.error ?? "unreachable"}`);
      }
    });

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 bg-foreground/[0.02] px-4 py-3"
      aria-label={initial ? `Edit provider ${initial.name}` : "Add provider"}
      noValidate
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <SectionLabel as="label" htmlFor={`pf-name-${initial?.id ?? "new"}`}>
            Name
          </SectionLabel>
          <Input
            id={`pf-name-${initial?.id ?? "new"}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="OpenAI"
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <SectionLabel as="label" htmlFor={`pf-endpoint-${initial?.id ?? "new"}`}>
            Endpoint
          </SectionLabel>
          <Input
            id={`pf-endpoint-${initial?.id ?? "new"}`}
            variant="mono"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://api.openai.com/v1"
            required
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <SectionLabel as="label" htmlFor={`pf-token-${initial?.id ?? "new"}`}>
          API token (blank = keep current)
        </SectionLabel>
        <Input
          id={`pf-token-${initial?.id ?? "new"}`}
          type="password"
          variant="mono"
          value={token}
          placeholder={initial?.hasToken ? "•••••• (configured)" : "not set"}
          onChange={(e) => setToken(e.target.value)}
        />
      </div>

      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {status ? (
        <p role="status" className="text-sm text-foreground/70">
          {status}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={test}
          disabled={testing || endpoint.length === 0}
        >
          {testing ? "Testing…" : "Test connection"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
