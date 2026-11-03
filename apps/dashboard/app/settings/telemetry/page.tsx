// Settings → Telemetry (spec 085): the usage-stats switch, exactly what is sent and how often,
// the last ping and the next one due.

import { resetInstallIdAction, setTelemetryAction } from "@/app/settings/telemetry/actions";
import { TelemetryPanel } from "@/components/settings/telemetry-panel";
import { serverTRPC } from "@/lib/trpc-server";

export const metadata = { title: "Telemetry · Librarian" };
export const dynamic = "force-dynamic";

export default async function TelemetrySettingsPage() {
  let status: Awaited<ReturnType<typeof serverTRPC.telemetry.status.query>> | null = null;
  let error: string | null = null;
  try {
    status = await serverTRPC.telemetry.status.query();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="flex flex-col gap-6 p-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-display text-xl text-foreground">Telemetry</h1>
        <p className="max-w-3xl text-sm text-foreground/60">
          Anonymous usage stats tell the project roughly how many Librarians are running and what
          they run on. Nothing here identifies you, and nothing from your memories is ever sent.
        </p>
      </header>
      {error ? (
        <p
          role="alert"
          className="border border-destructive/40 bg-destructive/[0.06] p-3 text-sm text-destructive"
        >
          Failed to load: {error}
        </p>
      ) : null}
      {status ? (
        <TelemetryPanel
          status={status}
          onToggle={setTelemetryAction}
          onResetId={resetInstallIdAction}
        />
      ) : null}
    </main>
  );
}
