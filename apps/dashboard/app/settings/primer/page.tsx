// Primer settings (spec 041 A1, repointed by rethink T11, reshaped by spec 083). The primer is
// the shipped default, which every install sends and nobody can edit, followed by the operator's
// optional addendum (vault/primer.md). This page edits the addendum and previews the complete
// primer agents receive. Gated like the rest of the dashboard.

import { dismissPrimerReviewAction, savePrimerAddendumAction } from "@/app/settings/primer/actions";
import { AwarenessPrimerForm } from "@/components/settings/awareness-primer-form";
import { serverTRPC } from "@/lib/trpc-server";

export const metadata = { title: "Primer · Librarian" };
export const dynamic = "force-dynamic";

async function loadPrimer() {
  try {
    return await serverTRPC.awareness.primer.query();
  } catch {
    return null;
  }
}

export default async function PrimerSettingsPage() {
  const view = await loadPrimer();

  return (
    <main className="flex flex-col gap-8 p-6">
      {view ? (
        <AwarenessPrimerForm
          defaultPrimer={view.defaultPrimer}
          initialAddendum={view.addendum}
          addendumMaxBytes={view.addendumMaxBytes}
          reviewPending={view.reviewPending}
          onSave={savePrimerAddendumAction}
          onDismissReview={dismissPrimerReviewAction}
        />
      ) : (
        <p role="alert" className="text-sm text-destructive">
          Couldn&apos;t load the primer from the server. Reload to try again.
        </p>
      )}
    </main>
  );
}
