// `librarian import` (spec 079 §4): send this machine's past conversations through the
// server's memory intake and journal.
//
//   1. Ask the server what it will accept (GET /import/policy). Both steps off → say so
//      and stop, without reading a single transcript.
//   2. Read each harness's history on this machine.
//   3. Ask the server for a plan (POST /import/plan — ids and end times only, no text)
//      and show it: per harness, what each step would take and why the rest is skipped.
//   4. Unless --dry-run, confirm (or --yes), then send each queued conversation, oldest
//      first. The SERVER decides the steps and enforces the allowance; this preview is
//      only a preview.
//
// The bearer token rides the Authorization header only, and every request refuses
// redirects, so a 3xx can't carry it anywhere else.

import type { Prompter } from "../prompt.js";
import {
  IMPORT_HARNESSES,
  type Conversation,
  type Env,
  type HarnessId,
  readHarness,
} from "./readers.js";

export interface ImportOptions {
  serverUrl: string;
  token: string;
  home: string;
  env?: Env;
  only?: "memories" | "journal";
  harnesses?: HarnessId[];
  dryRun?: boolean;
  yes?: boolean;
  prompter?: Prompter;
  fetchImpl?: typeof fetch;
  /** Progress line sink (stdout in the real CLI). */
  log?: (line: string) => void;
}

export interface ImportOutcome {
  ok: boolean;
  output: string;
}

interface Policy {
  intake: "enabled" | "disabled";
  journal: "enabled" | "disabled";
  memoriesCutoff: string | null;
  journalCutoff: string | null;
  maxAgeDays: number;
  allowanceRemaining: number;
}

interface PlanRow {
  conv_id: string;
  harness: string;
  memories: string;
  journal: string;
}

const QUEUED = "queued";
const PLAN_BATCH = 500;

class ServerError extends Error {}

async function call<T>(
  opts: ImportOptions,
  method: "GET" | "POST",
  route: string,
  body?: unknown,
): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(new URL(route, opts.serverUrl), {
      method,
      redirect: "error",
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    throw new ServerError(
      `couldn't reach the Librarian at ${opts.serverUrl} (${(error as Error).message})`,
    );
  }
  if (res.status === 404) {
    throw new ServerError(
      `the Librarian at ${opts.serverUrl} doesn't support import yet — update the server to 1.42.0 or later`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new ServerError(
      "the server refused this machine's token — check it with `librarian config`",
    );
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ServerError(json.error ?? `the server answered ${res.status}`);
  return json;
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "not set (never run)";
}

/** Group skip reasons so the summary reads "12 × ended after the journal cutoff…". */
function reasonCounts(rows: PlanRow[], step: "memories" | "journal"): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r[step] === QUEUED) continue;
    // Collapse per-conversation dates so one reason groups.
    const reason = r[step]
      .replace(/^ended \d{4}-\d{2}-\d{2}, /, "ended ")
      .replace(/on \d{4}-\d{2}-\d{2}$/, "earlier");
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `      ${n} × ${reason}`);
}

export async function runImport(opts: ImportOptions): Promise<ImportOutcome> {
  const lines: string[] = [];
  const out = (line = ""): void => {
    lines.push(line);
  };
  try {
    const policy = await call<Policy>(opts, "GET", "/import/policy");
    const wantMemories = opts.only !== "journal";
    const wantJournal = opts.only !== "memories";
    const memoriesOn = policy.intake === "enabled" && wantMemories;
    const journalOn = policy.journal === "enabled" && wantJournal;
    if (!memoriesOn && !journalOn) {
      out("Nothing to import into: curator intake and the journal are both off on the server");
      out("(or off for the steps you asked for with --only). Turn either on under");
      out("Settings → Curator → Intake in the dashboard, then run this again.");
      return { ok: true, output: lines.join("\n") };
    }
    if (wantMemories && policy.intake !== "enabled")
      out("Note: curator intake is off on the server, so no memories will be filed.");
    if (wantJournal && policy.journal !== "enabled")
      out("Note: the journal is off on the server, so no journal entries will be written.");
    out(
      `Server: memories cutoff ${day(policy.memoriesCutoff)} · journal cutoff ${day(policy.journalCutoff)} · max age ${policy.maxAgeDays} days · allowance ${policy.allowanceRemaining} conversations`,
    );
    out();

    // Read every harness's history on this machine.
    const harnesses = opts.harnesses?.length ? opts.harnesses : [...IMPORT_HARNESSES];
    const all: Conversation[] = [];
    for (const harness of harnesses) {
      const result = await readHarness(harness, opts.home, opts.env ?? {});
      if (!result.source) {
        out(`${harness}: no history on this machine`);
        continue;
      }
      out(`${harness}: ${result.conversations.length} conversation(s) in ${result.source}`);
      for (const problem of result.problems.slice(0, 5)) out(`    skipped unreadable: ${problem}`);
      if (result.problems.length > 5)
        out(`    … and ${result.problems.length - 5} more unreadable`);
      all.push(...result.conversations);
    }
    if (all.length === 0) {
      out();
      out("No conversations found to import.");
      return { ok: true, output: lines.join("\n") };
    }

    // Ask the server's plan: ids and end times only, never text.
    all.sort((a, b) => a.endedAt.localeCompare(b.endedAt));
    const only = opts.only ? [opts.only] : undefined;
    const plans: PlanRow[] = [];
    for (let i = 0; i < all.length; i += PLAN_BATCH) {
      const batch = all
        .slice(i, i + PLAN_BATCH)
        .map((c) => ({ conv_id: c.convId, harness: c.harness, ended_at: c.endedAt }));
      const res = await call<{ plans: PlanRow[] }>(opts, "POST", "/import/plan", {
        conversations: batch,
        ...(only ? { only } : {}),
      });
      plans.push(...res.plans);
    }

    out();
    out("Plan (the server decides; this is its preview):");
    const queued = all.filter(
      (_, i) => plans[i]?.memories === QUEUED || plans[i]?.journal === QUEUED,
    );
    for (const harness of harnesses) {
      const rows = plans.filter((p) => p.harness === harness);
      if (rows.length === 0) continue;
      out(`  ${harness}:`);
      for (const step of ["memories", "journal"] as const) {
        const n = rows.filter((r) => r[step] === QUEUED).length;
        out(`    ${step}: ${n} to import`);
        for (const line of reasonCounts(rows, step)) out(line);
      }
    }
    out();
    if (queued.length === 0) {
      out(
        "Nothing to import: every conversation is already covered, or outside the server's limits.",
      );
      return { ok: true, output: lines.join("\n") };
    }
    out(`${queued.length} conversation(s) to send.`);
    if (opts.dryRun) {
      out("Dry run: nothing was sent. Run again without --dry-run to import.");
      return { ok: true, output: lines.join("\n") };
    }
    if (!opts.yes) {
      opts.log?.(lines.join("\n"));
      lines.length = 0;
      const answer = opts.prompter
        ? (
            await opts.prompter.promptText(
              `Send ${queued.length} conversation(s) to the Librarian? [y/N]`,
              { default: "n" },
            )
          )
            .trim()
            .toLowerCase()
        : "n";
      if (answer !== "y" && answer !== "yes") {
        out("Cancelled: nothing was sent. (Use --yes to skip this question.)");
        return { ok: true, output: lines.join("\n") };
      }
    }

    // Send, oldest first. The server re-checks everything.
    let accepted = 0;
    let skipped = 0;
    for (const [index, c] of queued.entries()) {
      const res = await call<{
        accepted: boolean;
        reason?: string;
        steps?: { memories: string; journal: string };
      }>(opts, "POST", "/import", {
        conv_id: c.convId,
        harness: c.harness,
        ...(c.project ? { project: c.project } : {}),
        ended_at: c.endedAt,
        turns: c.turns,
        ...(only ? { only } : {}),
      });
      if (res.accepted) {
        accepted += 1;
      } else {
        skipped += 1;
        const why =
          res.reason ?? [res.steps?.memories, res.steps?.journal].filter(Boolean).join("; ");
        if (/allowance is used up/.test(why)) {
          out(
            `Stopped after ${accepted} conversation(s): the server's import allowance is used up.`,
          );
          out(
            `${queued.length - index} left. Raise the allowance on Settings → Curator → Import, then run this again.`,
          );
          return { ok: true, output: lines.join("\n") };
        }
      }
      if ((index + 1) % 25 === 0) opts.log?.(`  sent ${index + 1}/${queued.length}…`);
    }
    out(
      `Done: ${accepted} conversation(s) queued on the server${skipped ? `, ${skipped} refused` : ""}.`,
    );
    out(
      "They're processed a few at a time, after live capture, so they appear in your memories and",
    );
    out("journal over the next hours rather than at once.");
    return { ok: true, output: lines.join("\n") };
  } catch (error) {
    if (error instanceof ServerError) {
      out(`librarian import: ${error.message}`);
      return { ok: false, output: lines.join("\n") };
    }
    throw error;
  }
}
