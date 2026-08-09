# TODO / deferred follow-ups

The project's single backlog of deferred, non-blocking work — surfaced during the
autonomous builds (including the 2026-06-12 rethink run) and from
session/operator follow-ups. Each item is a focused follow-up PR or chore.
Grouped by theme, roughly highest-value first within each group. Remove an item
when its PR merges; resolved items are dropped rather than struck — git history
holds the record.

## Security & hardening

- **`/healthz` info disclosure.** `GET /healthz` returns auth-posture booleans
  (`mcp_auth`, etc.) unauthenticated. Keep `{status:"ok"}` public; move the
  auth-posture fields behind admin auth. Touches the `/healthz` contract,
  `packages/mcp-server/tests/http/routes.test.ts`, and the healthcheck script.
  _(deploy review)_
- **Rate-limit the `/mcp` auth surface.** No throttling on bearer-token
  verification → online guessing isn't slowed. (The dashboard credentials route is
  rate-limited as of D3.2; `/mcp` bearer auth is not.) Add per-IP/token rate limiting
  in a focused hardening PR. _(A3 review)_
- **Master-key rotation (`the-librarian rekey`).** There is **no built-in way to
  change `LIBRARIAN_SECRET_KEY` / `secret.key`** today. `secret-crypto.ts` states
  rotation is a manual "decrypt-all + re-encrypt under the new key"; the `gcm1`
  payload format deliberately reserves room for a future `gcm2` (key-id envelope)
  for online rotation, but it's unbuilt. **Suggestion:** a
  `rekey --old-key <k> --new-key <k>` CLI that walks every secret settings row,
  `decryptSecret(old)` → `encryptSecret(new)`, writes them back, then swaps
  `secret.key` — guarded (`--force`, store-closed). **Warn loudly** that the
  dashboard JWT secret is HKDF-derived from the master key
  (`auth/auth-config.ts`: "rotating the master key rotates sessions"), so
  rotation invalidates all dashboard logins (re-login required). Touches
  `secret-crypto.ts`, `store/settings-store.ts`, `packages/cli`. _(spec 033
  review; parked at owner's request)_
- **Vault git *history* is never scanned for secrets.**
  `scripts/check-no-secrets-in-vault.mjs` scans the working tree only, but the
  whole repo (including history) is what gets pushed to the backup remote — a
  secret ever committed and later removed persists in history. Privacy is the
  product; a `git log -p` forensic scan is the heavier follow-up the script's
  own comment calls out. _(also tracked in tech-debt.md)_

## Correctness & robustness

- **Memoize the runs-file read within one grooming pass.** A scheduled grooming
  pass iterates **every** slice; each slice does ~2 full `readAll()` of the
  curation-runs sidecar (the `findRunningRun` lock check + the
  `findCompletedApplyRun` idempotency check) — ~2N whole-file reads/parses per
  pass even when nothing changed. LLM cost is correctly bounded (idempotency
  skips unchanged slices before any LLM call) — this is I/O amplification only,
  negligible at tens of slices but it grows with projects×agents. Fix: snapshot
  the **completed-runs** read once per pass for the idempotency check (safe — a
  serial pass only adds runs for *other* slices), leaving the cross-process lock
  read live. Wants its own focused PR with a regression test — it touches
  lock/idempotency concurrency. _(plan 046 PR-1 review, finding #1)_
- **Grooming wire contract still carries zombie `category`/`scope` fields** on
  `MemoryInput`/`MemoryPatch` (legacy columns kept optional post-4d.2). Removing
  them changes prompt bytes → batch with the next deliberate prompt-version bump
  rather than burning a grooming idempotency-hash invalidation on it alone.
  _(rethink Phase 1 review, S1)_
- **Activity feed misattributes admin memory edits.** Dashboard memory-browser
  edits share the curator's `memory: update …` commit-subject path, so
  `classifyVaultCommit` badges them `curator` in the vault activity feed. Needs
  an actor plumbed through the memory store's commit subjects — not one-line;
  documented in the classifier docstring. Revisit if operators are confused.
  _(rethink Phase 3 review)_

## Testing

- **Enforcement-ON Playwright e2e.** Password sign-in + lockout
  (`e2e/auth-password.spec.ts`) and the setup wizard (`e2e/auth-setup.spec.ts`) are
  e2e-covered via a globalSetup that configures auth methods with enforcement
  OFF. The remaining gap is the enforcement-ON unauth→`/login` redirect / fail-closed
  block — enabling enforcement on the shared webServer would redirect every other
  spec, so it needs a dedicated Playwright project + auth-enabled server. The decision
  logic is unit-tested (`tests/auth-gate`, `tests/trpc-proxy-gate`). _(A2 / D3 / D5)_
- **intake-eval prints `Gate: FAIL (tolerance 0.05)` from inside a passing
  test** — pre-existing oddity, predates the rethink run. Worth a look.

## Curator eval harness

- **Generalize `@librarian/intake-eval` to evaluate the unified curator prompt
  (rethink spec §6.4).** Descoped during the run via the spec's hatch: the
  fixture schema, metrics, and CLI are intake-shaped, not a mechanical rename.
  It still compiles and evaluates the intake mode of the unified prompt core;
  grooming-mode fixtures + a rename to `curator-eval` are the follow-up.
  `TODO(rethink §6.4)` markers sit in its README and `src/index.ts`.

## Integrations polish

- **Hermes: consider passing server prose through unwrapped.**
  `handle_tool_call` wraps every result in `{"ok":true,"result":…}` —
  `list_handoffs`/`claim_handoff` results are themselves JSON, so models see
  double-encoded JSON. Defensible (uniform ABC string contract), but revisit if
  Hermes models stumble. _(rethink Phase 2 review)_
- **Pi command templates don't restate the privacy gate** the Claude/OpenCode
  command files carry ("if private=on, confirm before writing") — the primer
  carries the contract; fine while the templates stay skeletal. _(rethink
  Phase 2 review)_
- **`healthcheck.js --remote` probes `/healthz` + `/mcp` only** — a
  `GET /primer.md` probe (200 + text/markdown) would be a cheap addition if
  remote drift coverage ever matters. _(rethink Phase 2 observation)_

## Operator / verification chores

These are deployment-specific exercises against the canonical instance, not code.

- **Exercise private mode end-to-end on a live harness.** Private mode is now a
  pure in-conversation marker (rethink D11) taught by the primer. Send "off the
  record …" mid-session, confirm no `remember`/`store_handoff`/`flag_memory`
  calls land until toggled back, and confirm recall still works.

## Dashboard / UI polish

Deliberate carve-outs from the dashboard redesign (D1.x) that needed a more careful
landing than the autonomous run had room for.

- **Inline KeyHint on every primary button.** The ⌘K palette + shortcuts overlay
  shipped; per-button KeyHints land alongside the full per-surface keyboard binding
  map (j/k navigation, `a` archive, …).
- **Licensed PP Editorial New + PP Neue Montreal fonts.** Currently the free
  fallback (Fraunces / Newsreader); swap-in is a one-liner once the licence is bought.
- **Full editorial table rewrite + three-tab view switcher + remaining filter
  dropdowns** (priority, date range, usefulness, has-duplicates) for Memories.
- Add links to the GitHub and Google pages where users should register the OAuth
  callbacks.
- **Vault explorer performance/ergonomics follow-ups** _(rethink Phase 3
  review)_: `vault.read` rebuilds the vault-wide link index twice per read
  (outbound + backlinks) — fine at human-scale admin traffic, share a
  per-request index if large vaults make file views sluggish; `DiffView`
  renders one `<span>` per diff line with no length bound — a diff over a 500KB
  reference makes a heavy DOM (truncate-with-download if it bites); wikilink
  rewriting in `markdown-content.tsx` also rewrites `[[…]]` inside fenced code
  blocks (cosmetic).

## Deploy & ops

- **Verify `fly.toml` against the current Fly schema.** It's a starter template;
  the schema (`auto_stop_machines` value type, `[mounts]` form,
  `[[services]]`/`[http_service]`) was not live-verified — see the header note in
  `fly.toml` and DEPLOYMENT.md. The host-agnostic `docker run` one-liner is the
  primary path.

## Auth enhancements (optional)

- **GitHub verified-email allowlisting.** The email allowlist
  (`LIBRARIAN_OWNER_EMAILS`) is honored only for provider-verified emails; GitHub
  carries no `email_verified`, so it's effectively Google-only and GitHub owners
  must use the GitHub account id. If GitHub email allowlisting is wanted, fetch
  verified emails from `GET /user/emails` (extra scope + API call). Skipped for
  single-owner where the account id is the robust key. _(A1)_
- **Full browser-based MCP OAuth** remains explicitly out of scope (spec 017,
  single-owner auth) — revisit via a managed provider only when there are
  non-technical users or many clients.

## Features / functional improvements

- **Vault "maps" for intake navigation (parked — iterate later).** The
  curator's `navigate` step hands the judge ~K=8 recall candidates + a flat,
  title-only ToC, so finding the right place to file relies on semantic recall
  alone. Idea: auto-generate markdown "map of content" / hub notes that describe
  the vault's structure (frontmatter + wikilinks) so the LLM judge can navigate
  structurally, not just by recall. Relatedly, a structured graph-query layer
  (Dataview-style queries over frontmatter + links — orphans, broken backlinks,
  overloaded nodes) would serve whole-graph grooming. Connects to spec 039
  (hub-and-spoke). _(operator idea, 2026-06-05)_
- Look at offering a tiny local LLM as an alternative to cloud / API LLM for the
  curator (see https://github.com/tgrytnes/mnemosyne).
- Improve memory storage & retrieval with polyphonic recall (see
  https://github.com/tgrytnes/mnemosyne).
- **`remember` should surface a handle for the write.** Today `remember` is
  fire-and-forget into the intake inbox, so there is no synchronous memory id —
  the curator mints it on the next tick, and an agent that wants the id has to
  `recall include_ids:true` later. If a write→reference chain ever matters,
  echo the inbox item id in the result text (e.g. "Submitted (inb_…)") or have
  the dashboard surface the resulting memory/proposal per submission.
- **Memory frontmatter field diet.** Which ranking signals actually move recall
  quality (priority / confidence / usefulness_score / conflicts_with /
  supersedes / aliases / applies_to)? Trim the ones that don't. _(rethink
  parking lot)_
- **Monitor recall/remember frequency post-cutover** (dashboard analytics); add
  a per-turn nudge in hook-capable harnesses only if usage sags — the primer now
  rides connect-time channels only (rethink D10 residual risk).

## References / recall follow-ups

Salvaged from the deleted `proposals/hybrid-recall.md` (the rest of that
proposal — FTS5/BM25 over a SQLite projection, JSONL-canonical boundaries —
was made obsolete by the markdown vault + hybrid keyword+vector RRF index):

- **Structured-signal ranker in hybrid recall**: fold metadata boosts
  (exact `project_key` match, priority band, confidence, usefulness) into
  the index-backed RRF path the way the keyword fallback already does, so
  the two paths rank consistently.
- **Recency/staleness weighting**: boost recently-useful memories;
  penalise stale ones beyond the existing flag soft-demote.
- **`explain` mode (admin/debug only)**: optional scoring breakdown on
  recall for the dashboard — normal agents keep clean prose, never ids +
  scoring internals.
- **Retrieval benchmark fixture**: a noisy-corpus fixture + benchmark
  (exact commands, filenames, project filtering, stale-memory penalties)
  so ranking changes are proven, not vibed.
- **Date-range filters on recall** (`from`/`to`) for time-scoped queries.
- **In-memory index cache for reference search**: embeddings persist in the
  sidecar cache (rethink T23), but the keyword/RRF index *structures* are
  rebuilt per `search_references` call. Cheap; only needed if reference search
  becomes hot.
