# Tech debt & deferred work

Consolidated **2026-06-05** from the local `AUTONOMOUS-BUILD-NOTES-*.md` scratch
files (gitignored) so every non-blocking follow-up flagged during the autonomous
builds lives in one reviewable, prioritisable place.

- **Scope:** code/maintenance debt only. Roadmap and feature ideas live in
  [`docs/TODO.md`](./TODO.md); this file is the "we shipped X but owe Y" list.
- **Priorities** (`High` / `Med` / `Low`) are a first-cut for triage — re-rank freely.
- **Line numbers** were accurate when flagged but earlier merges may have shifted
  them; re-grep the symbol before editing.
- Items here were **cut** from the source notes files (not copied); the notes
  retain their historical per-PR build logs and point here for follow-ups.

---

## Auth — dashboard-managed auth (build 2026-05-25)

- **[Low] `"15 minutes"` setup-link TTL is duplicated as a human string.**
  Hardcoded at `packages/cli/src/commands/auth.ts:50` and `:55` and again on the
  `/settings/auth/reset` page, while the real value lives in `SETUP_LINK_TTL_MS`
  (`auth.ts:34`). Derive the human string from the constant (or share a formatter)
  so they can't drift.
- **[Low] `setEnabled(store, true)` stays exported but bypasses the `enableAuth`
  gate** — it's the ungated break-glass disable path (`enableAuth` is the gated ON
  path). By design; flagged so nobody "fixes" it by routing it through the gate.
  Worth a doc-comment reaffirming the intent if it isn't already explicit.
- **[Low] Restore master-key prompt reads with echo off.** Secure default; some
  operators paste long keys and want to see them. One-line flip if we decide
  paste-visibility beats shoulder-surfing resistance at restore time.
- **[Low] Restore opens a fresh store per key attempt** (re-runs migrations).
  Cheap at restore time; flagged only as a known inefficiency.

---

## Backup / restore — git-native backup (spec 040, builds 2026-06-04)

- **[Med] Vault git *history* is never scanned for secrets.**
  `scripts/check-no-secrets-in-vault.mjs:11` scans the vault working tree only, but
  the whole repo (including history) is what gets pushed — so a secret ever
  committed and later removed would persist in history and ship to the backup
  remote. Privacy is the product; a `git log -p` forensic scan is the heavier
  follow-up the script's own comment calls out.
- **[Low] `backup.github.repo` validation — env/read-path residual.** The tRPC write
  boundary now validates the `owner/repo` slug with a teaching error (PR #311). Residual:
  `resolveBackupRemote`/`resolveGithubSyncConfig` don't re-validate, so the
  `LIBRARIAN_BACKUP_GITHUB_REPO` env path and the read-time URL build stay unchecked —
  defense-in-depth only (the host is fixed before interpolation, so a bad value is a
  confusing failure, not token exfil). _(2026-06-05 code review, finding #25 —
  the review docs now live in git history only.)_
- **[Med] `BackupRun` shape carries vestigial bundle-era fields.**
  `packages/core/src/backup/runs.ts:23-25` — `bundle` is now repurposed to hold the
  pushed commit SHA, and `bytes`/`synced` are leftovers from the gzip-bundle era.
  Works and is tested, but the names lie. Rename `bundle → commit` and drop
  `bytes`/`synced`. Touches the `BackupRun` type + the dashboard runs-table.
- **[Low] Apply-failure log doesn't name `vault.pre-restore.bak`.** Only matters in
  the extreme double-rename fault where live data ends up in the `.bak`; a code
  comment notes it. Name the `.bak` path in the failure log so a panicked operator
  knows where their data is.
- **[Low] Concurrent `stageRestore` calls race on the staging dir.** Single-admin
  and recoverable today; a per-stage temp subdir or an in-process lock would harden
  it if multi-admin restore ever becomes real.
- **[Low / conditional] If the recall index is ever persisted under
  `<vault>/.index/`, add a `.gitignore` for it.** The index is in-memory today, so
  not yet load-bearing — but a future increment that writes it to disk must keep it
  out of the pushed vault.

---

## Storage / schema residue — SQLite removal (spec 040, build 2026-06-04)

- **[Low] `memory-types.ts` header still flags a follow-up.** The `Memory` type is
  "intentionally loose; tightening to the Zod-derived `Memory` is a follow-up."
  Accurate today — revisit (and update the comment) when that tightening lands.

---

## Curator arc + awareness primer (plan 045, builds 2026-06-05/06)

Specs 042 (LLM provider config), 043 (curator unification), 044 (self-improving
curator), 041 (awareness primer) — all shipped (#314–#340 here + the 5 plugin PRs).
Non-blocking follow-ups flagged during the build:

- **[Low] Intake decision-log `target_id` is singular.** A 044-C4 intake `split`
  proposal records only the source candidate as `target_id`; the spun-out replacement
  proposal ids aren't individually logged (they're discoverable in the proposals queue).
  If the unified dashboard ever wants the spun-out ids surfaced, extend the
  `consolidation-runs` op schema to a `target_ids` array.

---

## Resolved since first flagged (kept for the record)

These were flagged as deferred in the notes and have since shipped — listed so they
aren't re-investigated:

- **[Low] One-time admin-token bootstrap log interpolates the token** — **obsolete**:
  [ADR 0008](./adr/0008-auth-secrets-model.md) dropped the admin token as a network
  gate, so the server no longer auto-generates or logs an admin token at boot. There
  is no admin-token bootstrap log left to harden.
- Dead `CONSOLIDATOR_REQUIRES_MARKDOWN` / `unsupported_backend` skip path — removed
  in `3fbae36` (post-SQLite dead-code PR).
- Vacuous `store.backend === "markdown"` / `!== "markdown"` guards
  (`remember.ts`, `scripts/seed/lib.mjs`) — removed in `3fbae36`.
- Orphaned `test/fixtures/pre-migration/{events,sessions}.jsonl` — deleted (dir gone).
- Dashboard `/logs` + `/recall` event-ledger views and the empty By-category /
  By-scope analytics dimensions — removed in `be4c839`.
- The 14 `MemoryLedgerEntry` Zod schemas + the `MemoryEventType` enum /
  `MemoryEventTypeSchema` (the retired event-ledger schema layer) — removed in
  **#309** (2026-06-05).
- Cross-impl equivalence test between core `isAuthConfigComplete` and dashboard
  `configComplete` — added in **#310** (16-row table; the two agree everywhere).
- `backup.github.repo` `owner/repo` validation at the tRPC write boundary — added in
  **#311** (env/read-path residual re-filed above as [Low]).
- PR #143 (memories detail modal) — merged after the auth initiative; the
  memories-overflow e2e regression was fixed (`[&>*]:min-w-0` restored).
- The retired event-ledger store seam (`appendEvent`/`listEvents` throwing
  `LEDGER_RETIRED`, plus the barrel's missing event types) — the seam and the
  event types were deleted outright in the 2026-06-12 rethink (T6); the
  dashboard's git-backed vault activity feed (T21) is the replacement
  audit-trail surface.
- The five-plugin lockstep verification items (Workstream C conv-state sync,
  OpenCode `chat.system.transform` live-reach) — moot: the rethink (D10/D14)
  deleted the per-turn injection machinery and moved all harness surfaces
  in-tree under `integrations/`; the external plugin repos are archived.

---

## Read log (spec 080, 2026-11-03)

- **[Low] The refusal log still carries its own copy of the bounded NDJSON engine.**
  `packages/core/src/store/sidecar/ndjson-sidecar.ts` was lifted from
  `refusal-log.ts` for the read log; the refusal log was deliberately left untouched in
  that PR. Migrate it onto the engine behind its existing test suite so the two can't drift.
- **[Low] Read-log rows carry rank order but not scores.** `recallForPrincipal` returns
  ranked memories without their scores; exposing them needs a store return-type change.
- **[Low] No session id joins a read row to a transcript.** Analysis joins on actor and
  time, which is ambiguous when two sessions of one agent overlap.
