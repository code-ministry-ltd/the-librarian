// Curator configuration cockpit (Phase 4 rebuild). Shared LLM providers on
// top, two tabbed jobs (Intake / Grooming) below. Each tab holds the
// Enablement & schedule, Model, and Recent runs sections — flat layout,
// hairline-separated, no nested cards.

import type { ConfigurableJobConsumer } from "@librarian/core";
import {
  addProviderAction,
  deleteProviderAction,
  listModelsAction,
  loadIntakeOperationsAction,
  runGroomingNowAction,
  runIntakeNowAction,
  saveGroomingConfigAction,
  saveJournalConfigAction,
  setConsumerConfigAction,
  setIntakeConfigAction,
  testConnectionAction,
  updateProviderAction,
} from "@/app/curator/actions";
import { GroomingConfigForm } from "@/components/curator/config-form";
import { ConsumerModelSelector } from "@/components/curator/consumer-model-selector";
import { IntakeConfigForm } from "@/components/curator/intake-config-form";
import { IntakeRunsTable } from "@/components/curator/intake-runs-table";
import { JournalConfigForm } from "@/components/curator/journal-config-form";
import { ProviderManager } from "@/components/curator/provider-manager";
import {
  RunNowButton,
  renderGroomingResult,
  renderIntakeResult,
} from "@/components/curator/run-now-button";
import { GroomingRunsTable } from "@/components/curator/runs-table";
import { CuratorTabs } from "@/components/curator/tabs-shell";
import { Hairline } from "@/components/ui-v2/hairline";
import { SectionLabel } from "@/components/ui-v2/section-label";
import { serverTRPC } from "@/lib/trpc-server";

export const dynamic = "force-dynamic";

export default async function CuratorSettingsPage() {
  let config: Awaited<ReturnType<typeof serverTRPC.grooming.config.query>> | null = null;
  let runs: Awaited<ReturnType<typeof serverTRPC.grooming.runs.query>> = [];
  let providers: Awaited<ReturnType<typeof serverTRPC.llm.listProviders.query>> = [];
  let intakeConfig: Awaited<ReturnType<typeof serverTRPC.intake.config.query>> | null = null;
  let intakeRuns: Awaited<ReturnType<typeof serverTRPC.intake.runs.query>> = [];
  let intakeConsumer: Awaited<ReturnType<typeof serverTRPC.llm.consumerConfig.query>> | null = null;
  let grooming: Awaited<ReturnType<typeof serverTRPC.llm.consumerConfig.query>> | null = null;
  let journalConfig: Awaited<ReturnType<typeof serverTRPC.journal.config.query>> | null = null;
  let error: string | null = null;
  try {
    [config, runs, providers, intakeConfig, intakeRuns, intakeConsumer, grooming, journalConfig] =
      await Promise.all([
        serverTRPC.grooming.config.query(),
        serverTRPC.grooming.runs.query({ limit: 50 }),
        serverTRPC.llm.listProviders.query(),
        serverTRPC.intake.config.query(),
        serverTRPC.intake.runs.query({ limit: 50 }),
        serverTRPC.llm.consumerConfig.query({ consumer: "intake" }),
        serverTRPC.llm.consumerConfig.query({ consumer: "grooming" }),
        serverTRPC.journal.config.query(),
      ]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // Per-provider list of which consumer labels currently reference it; the
  // Delete confirm reads this so the operator sees what breaks.
  const references: Record<string, readonly string[]> = {};
  function addRef(consumer: ConfigurableJobConsumer, providerId: string | null | undefined) {
    if (!providerId) return;
    const label = { intake: "Intake", grooming: "Grooming" }[consumer];
    references[providerId] = [...(references[providerId] ?? []), label];
  }
  addRef("intake", intakeConsumer?.providerId);
  addRef("grooming", grooming?.providerId);

  const intakeLastRun = intakeRuns[0];
  const groomingLastRun = runs[0];

  return (
    <main className="flex flex-col gap-8 p-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-xl text-foreground">Curator</h1>
        <p className="text-sm text-foreground/60">
          Two jobs keep the corpus useful: <strong>Intake</strong> files new submissions and{" "}
          <strong>Grooming</strong> curates the corpus. The journal is set up on the Intake tab.
          They share the LLM providers below.
        </p>
      </header>

      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      <ProviderManager
        initialProviders={providers}
        references={references}
        actions={{
          onAdd: addProviderAction,
          onUpdate: updateProviderAction,
          onDelete: deleteProviderAction,
          onTest: testConnectionAction,
        }}
      />

      <CuratorTabs
        intake={
          <section className="flex flex-col gap-8" aria-label="Intake">
            <section className="flex flex-col gap-3" aria-label="Intake enablement and schedule">
              <SectionLabel as="h3">Enablement &amp; schedule</SectionLabel>
              {intakeConfig ? (
                <IntakeConfigForm
                  enabled={intakeConfig.enabled}
                  intervalMinutes={intakeConfig.intervalMinutes}
                  applyConfidenceThreshold={intakeConfig.applyConfidenceThreshold}
                  onSave={setIntakeConfigAction}
                />
              ) : null}
            </section>

            <Hairline />

            <section className="flex flex-col gap-3" aria-label="Intake model">
              <header className="flex flex-col gap-1">
                <SectionLabel as="h3">Model</SectionLabel>
                <p className="max-w-3xl text-xs text-foreground/70">
                  Used by both intake and the journal below.
                </p>
              </header>
              {intakeConsumer ? (
                <ConsumerModelSelector
                  consumer="intake"
                  config={intakeConsumer}
                  providers={providers}
                  onSave={setConsumerConfigAction}
                  onListModels={listModelsAction}
                />
              ) : null}
            </section>

            <Hairline />

            <section className="flex flex-col gap-3" aria-label="Journal">
              <header className="flex flex-col gap-1">
                <SectionLabel as="h3">Journal</SectionLabel>
                <p className="max-w-3xl text-xs text-foreground/60">
                  A dated history of what you and your agents talked about, written from captured
                  conversations. Agents can read it at the start of a session. It works with or
                  without intake: turning either on captures conversations.
                </p>
              </header>
              {journalConfig ? (
                <JournalConfigForm initial={journalConfig} onSave={saveJournalConfigAction} />
              ) : null}
            </section>

            <Hairline />

            <section className="flex flex-col gap-3" aria-label="Intake run history">
              <header className="flex flex-wrap items-center justify-between gap-3">
                <SectionLabel as="h3">Recent runs</SectionLabel>
                <RunNowButton
                  onRun={runIntakeNowAction}
                  renderResult={renderIntakeResult}
                  label="Run intake now"
                  ariaLabel="Run intake now"
                />
              </header>
              {intakeLastRun ? (
                <p className="text-xs text-foreground/60">
                  Last run: {renderIntakeResultDigest(intakeLastRun)}
                </p>
              ) : null}
              <IntakeRunsTable runs={intakeRuns} onLoadOperations={loadIntakeOperationsAction} />
            </section>
          </section>
        }
        grooming={
          <section className="flex flex-col gap-8" aria-label="Grooming">
            <section className="flex flex-col gap-3" aria-label="Grooming enablement and schedule">
              <SectionLabel as="h3">Enablement &amp; schedule</SectionLabel>
              {config ? (
                <GroomingConfigForm initial={config} onSave={saveGroomingConfigAction} />
              ) : null}
            </section>

            <Hairline />

            <section className="flex flex-col gap-3" aria-label="Grooming model">
              <SectionLabel as="h3">Model</SectionLabel>
              {grooming ? (
                <ConsumerModelSelector
                  consumer="grooming"
                  config={grooming}
                  providers={providers}
                  onSave={setConsumerConfigAction}
                  onListModels={listModelsAction}
                />
              ) : null}
            </section>

            <Hairline />

            <section className="flex flex-col gap-3" aria-label="Grooming run history">
              <header className="flex flex-wrap items-center justify-between gap-3">
                <SectionLabel as="h3">Recent runs</SectionLabel>
                <RunNowButton
                  onRun={runGroomingNowAction}
                  renderResult={renderGroomingResult}
                  label="Run grooming now"
                  ariaLabel="Run grooming now"
                />
              </header>
              {groomingLastRun ? (
                <p className="text-xs text-foreground/60">
                  Last run: {renderGroomingRunDigest(groomingLastRun)}
                </p>
              ) : null}
              <GroomingRunsTable runs={runs} />
            </section>
          </section>
        }
      />
    </main>
  );
}

function renderIntakeResultDigest(run: { summary: string | null; status: string }): string {
  if (run.status !== "completed") return `${run.status} — ${run.summary ?? "no summary"}`;
  return run.summary ?? "completed";
}

function renderGroomingRunDigest(run: { summary: string | null; status: string }): string {
  if (run.status !== "completed") return `${run.status} — ${run.summary ?? "no summary"}`;
  return run.summary ?? "completed";
}
