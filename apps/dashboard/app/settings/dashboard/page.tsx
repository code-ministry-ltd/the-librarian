// Dashboard settings — server-level controls that aren't a curator job: the read-log switch
// (spec 081), the notices fetch (spec 084) and server auto-update (spec 2026-06-16-server-autoupdate T4), moved
// off the Curator page so it lives with instance-level settings rather than a
// curation job. The dashboard only CONFIGURES auto-update; a timer on the host
// machine performs the update on the cadence set here (spec §2).

// `setAutoUpdateConfigAction` lives in the curator actions module (its only
// consumer now); it revalidates this route after a write.
import { setAutoUpdateConfigAction } from "@/app/curator/actions";
import { setNoticesFetchAction, setReadLogAction } from "@/app/settings/dashboard/actions";
import { AutoUpdateConfigForm } from "@/components/curator/autoupdate-config-form";
import { NoticesFetchForm } from "@/components/settings/notices-fetch-form";
import { ReadLogForm } from "@/components/settings/read-log-form";
import { SectionLabel } from "@/components/ui-v2/section-label";
import { serverTRPC } from "@/lib/trpc-server";

export const dynamic = "force-dynamic";

export default async function DashboardSettingsPage() {
  let autoupdate: Awaited<ReturnType<typeof serverTRPC.autoupdate.get.query>> | null = null;
  let readLog: Awaited<ReturnType<typeof serverTRPC.logs.readLogConfig.query>> | null = null;
  let notices: Awaited<ReturnType<typeof serverTRPC.notices.config.query>> | null = null;
  let error: string | null = null;
  try {
    [autoupdate, readLog, notices] = await Promise.all([
      serverTRPC.autoupdate.get.query(),
      serverTRPC.logs.readLogConfig.query(),
      serverTRPC.notices.config.query(),
    ]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="flex flex-col gap-5 p-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-xl text-foreground">Dashboard</h1>
        <p className="text-sm text-foreground/60">
          Server-level settings for this Librarian instance.
        </p>
      </header>

      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          Failed to load settings: {error}
        </p>
      ) : null}

      <section className="flex flex-col gap-3" aria-label="Read log">
        <header className="flex flex-col gap-1.5">
          <SectionLabel as="h2">Read log</SectionLabel>
          <p className="text-sm text-foreground/60">
            See what agents ask the Librarian for, and whether it has an answer.
          </p>
        </header>
        {readLog ? (
          <ReadLogForm
            enabled={readLog.enabled}
            recording={readLog.recording}
            onSave={setReadLogAction}
          />
        ) : null}
      </section>

      <section id="notices" className="flex flex-col gap-3" aria-label="Notices">
        <header className="flex flex-col gap-1.5">
          <SectionLabel as="h2">Notices</SectionLabel>
          <p className="text-sm text-foreground/60">
            Important messages for whoever runs this Librarian, behind the bell beside the version
            number.
          </p>
        </header>
        {notices ? (
          <NoticesFetchForm
            enabled={notices.enabled}
            forcedOff={notices.forcedOff}
            onSave={setNoticesFetchAction}
          />
        ) : null}
      </section>

      {/* Server auto-update (spec 2026-06-16-server-autoupdate T4). The dashboard
          only configures it; the host timer performs the update (spec §2). */}
      <section className="flex flex-col gap-3" aria-label="Server auto-update">
        <header className="flex flex-col gap-1.5">
          <SectionLabel as="h2">Server auto-update</SectionLabel>
          <p className="text-sm text-foreground/60">
            Keep the server current automatically. The dashboard configures auto-update; a timer on
            the host machine performs the update on the cadence you set.
          </p>
        </header>
        {autoupdate ? (
          <AutoUpdateConfigForm
            enabled={autoupdate.enabled}
            cadence={autoupdate.cadence}
            lastRunAt={autoupdate.lastRunAt}
            version={autoupdate.version}
            latest={autoupdate.latest}
            onSave={setAutoUpdateConfigAction}
          />
        ) : null}
      </section>
    </main>
  );
}
