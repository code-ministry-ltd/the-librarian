# Changelog

All notable changes to **The Librarian** are documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This changelog starts at v0.1.0 — the first version likely to see public
adoption. The pre-v0.1.0 development history lives in the git log; only
changes from this point forward are catalogued here.

## [1.21.1] — 2026-08-09

### Changed

- **Comprehensive dependency upgrade across the monorepo.** vitest 2→4,
  vite 5→8, eslint 9→10, typescript 5→6, eslint-plugin-unicorn 57→73,
  globals 15→17, lefthook 1→2, jsdom 25→30, @types/node 22→26, diff 8→9,
  tailwind-merge 2→3, lucide-react 0.4→1, @testing-library/jest-dom 6→7,
  @types/chrome 0.0.287→0.2.5, astro 7.0→7.2, esbuild 0.21→0.28, and
  numerous other packages. All 9 pnpm audit vulnerabilities resolved.
- **Removed eslint-plugin-import** (2.x does not support eslint 10).
  Dropped import/no-duplicates, import/newline-after-import, import/order
  rules (style-only, not correctness).
- **Migrated vitest config from `environmentMatchGlobs` to `projects` API**
  (breaking change in vitest 4).
- **Added `types: ["node"]` to tsconfig.base.json** (TypeScript 6 defaults
  `types` to empty array instead of auto-discovering @types packages).
- **Added `typescript: ^6.0.3` pnpm override** to prevent peer dependencies
  (e.g., i18next) from pulling in TypeScript 7.x, which breaks typescript-eslint
  due to missing programmatic API in the Go-based compiler.

## [1.21.0] — 2026-08-09

### Added

- **Stable server installs and updates now consume the published all-in-one
  image.** With no `--ref`, the CLI resolves the latest stable release; an exact
  `vX.Y.Z` selects that release directly. It pulls the versioned GHCR image,
  validates its platform and OCI metadata, matches its source commit to the
  GitHub tag and its digest to the release receipt, then runs the immutable
  digest without requiring Git or a source checkout.
- **Managed deployment state records image provenance.** Status distinguishes
  `published <version> (<short digest>)`, `source <ref>`, and legacy deployments
  without making Git a requirement for normal Docker-only lifecycle commands.

### Changed

- **`server update` is now a recoverable transition.** Pulls, source builds,
  image inspection, credential preparation, and configuration capture finish
  before the current container is stopped. A failed replacement restores and
  health-checks the previous immutable image and leaves deploy state unchanged;
  migration failures explicitly distinguish executable recovery from persistent
  data rollback.
- **Development refs retain the source path.** `--ref main` and other non-release
  refs still clone/fetch and build locally, and therefore require Git. Registry,
  authentication, network, provenance, and architecture failures never silently
  fall back to a source build.
- **Automatic updates use the same exact-image and recovery path as manual
  updates.** They retain the existing schedule, lock, fail-soft reporting, and
  last-run behavior while avoiding Git and local builds for stable releases.

## [1.20.1] — 2026-08-09

### Added

- **The all-in-one server and dashboard image is now published to GHCR.** Every
  release has an immutable `ghcr.io/code-ministry-ltd/the-librarian:vX.Y.Z`
  tag, with `latest` promoted only after the published image passes both health
  probes.
- **An image-only Compose deployment needs no source checkout or local build.**
  It includes a protected env-file template, loopback-only ports by default,
  persistent named-volume or bind-mount storage, and version-pinned upgrade and
  rollback instructions.

### Changed

- **A release is not complete until its container image survives a registry
  round trip.** The release workflow now builds the versioned image once, pulls
  and smoke-tests it, verifies its source/version labels, records its immutable
  digest on the GitHub release, and only then publishes npm packages. Interrupted
  releases can be safely rerun without overwriting the versioned image.

### Fixed

- **Docker builds ignore local TypeScript incremental metadata.** A prior host
  build could leave `*.tsbuildinfo` files in the context while generated `dist`
  directories stayed excluded, causing the image build to skip core output and
  fail when the MCP server resolved `@librarian/core`.

### Security

- Updated Auth.js to `next-auth` 5.0.0-beta.32 / `@auth/core` 0.41.3 so a
  server-side configuration error cannot produce a truthy auth object and make
  an existence-based session check fail open. Next.js 15.5.21 closes its current
  Server Action SSRF/denial-of-service advisories; workspace resolutions pin
  patched `js-yaml`, `nanoid`, `postcss`, `sharp`, `svgo`, and `tar` releases.

## [1.20.0] — 2026-08-06

### Added

- **The Chronicle turns each week into a durable, searchable review.** It writes
  one `references/chronicle/YYYY-Www.md` entry per writable system shelf from
  vault changes, memory lifecycle facts, handoffs, open questions, and safely
  attributable Curator outcomes. The deterministic evidence digest always works;
  an optional LLM adds a narrative and up to three possible blog seeds, failing
  soft to digest-only output.
- **Chronicle is controllable and observable from a third Settings → Curator
  tab.** It is off by default, runs weekly on a configurable local weekday/time,
  catches up after missed schedule polls, and supports a manual partial-week run.
  Per-shelf history records status, narration mode, model usage, duration, and the
  written path. The admin API and trigger remain on the internal listener only.
- **Transcript capture now preserves harness attribution through the settle
  sweep.** Extracted facts carry a normalized `harness:<name>` tag using a
  fail-soft sidecar, so Chronicle can report where captured knowledge came from.
- **Memory tags are visible wherever operators review knowledge.** Browse,
  Recall, Proposals, Flagged, and Archive show the first three stored tags in
  order, with a bounded `+N more` summary for the remainder.
- **Browse has an exact-tag filter with active-memory counts.** The searchable
  picker covers the caller's complete authorised recall corpus, composes with
  existing filters, and can also be activated from a tag on a Browse card.

### Security

- Chronicle never crosses shelf boundaries, skips read-only shelves, includes
  only shelf-attributed Intake and Grooming aggregates in each review, redacts
  full fact fields before prompt bounding, and writes only value-free failure
  labels to its run history and server logs.
- Tag counts are computed only after the caller's recall shelves are authorised,
  with duplicate memory ids resolved before counting so neither hidden shelves
  nor lower-precedence copies can affect the catalogue.

### Docs

- Added **The Chronicle** guide covering evidence, optional narration, schedule
  semantics, manual partial reviews, shelf isolation, and run history.

## [1.17.5] — 2026-08-06

### Fixed

- **The test-count guard now names the tests that failed.** On a non-zero
  Vitest exit it previously discarded the captured JSON report, leaving CI with
  only an exit code. The guard now lists each failed test with its file and the
  first line of its message, and explicitly reports when a runner failed without
  naming a test, such as a configuration error or worker crash.
- **The test-count guard is now importable and directly tested.** Its entry-point
  work no longer runs at module import time, and its fail-soft multi-workspace
  report parsing has focused coverage.

## [1.17.4] — 2026-08-06

### Security

- **Curator chat now redacts complete search-result bodies before truncating
  them for the LLM prompt.** A quoted secret whose closing delimiter fell
  beyond the per-result size limit could previously evade the assignment
  redactor and expose its prefix to the configured model provider.

## [1.17.3] — 2026-08-02

### Fixed

- **Moving multiple Vault files no longer requires a page refresh.** Opening the
  Move dialog after selecting a different file now resets its folder and filename
  to the current selection instead of retaining the previously moved file.

## [1.17.2] — 2026-07-30

### Changed

- **The canonical repository moved to the `code-ministry-ltd` GitHub org.** Every
  reference to `github.com/JimJafar/the-librarian` now points at
  `github.com/code-ministry-ltd/the-librarian`: the published packages' metadata
  (`@the-librarian/pi-extension`'s `homepage`/`repository`, and a new
  `homepage`/`repository` on `@the-librarian/cli`, which previously had none), the
  runtime GitHub endpoints the CLI and server hit (release-version checks, the
  Hermes/Codex/OpenCode adapter tarball downloads, the Claude Code marketplace
  slug), the ingest fetcher's user-agent, the docs, and the READMEs. The npm
  package names are unchanged — they keep the `@the-librarian/*` scope. The old
  GitHub URLs continue to work via GitHub's automatic redirect after the repo
  transfer; this change stops relying on that redirect. The archived standalone
  plugin repos (`the-librarian-claude-plugin` and friends) are a separate concern
  and are intentionally left as-is.

## [1.17.1] — 2026-07-26

### Fixed

- **Server auto-update actually runs now.** The host timer installed by
  `librarian server autoupdate enable` ran as root, so it looked for the
  deploy in root's home — on any server set up as a normal user, every hourly
  fire failed with "No deploy-state found", silently (the wrapper is fail-soft
  by design and the failure only appeared in the root-readable system
  journal, while `autoupdate status` reported everything healthy). The
  generated unit now runs as the enabling user with the deploy dir pinned
  explicitly (`--dir`), which also fixes git's dubious-ownership refusal and
  uses that user's docker access. **Existing installs: upgrade the CLI and
  re-run `librarian server autoupdate enable` once, as the user who ran
  `server up`** — re-running rewrites the units in place. `enable` now also
  refuses up front, with an explanation, when it can't find the deploy state
  where it's looking — the silent 3 a.m. failure is now a loud enable-time
  error.
- **A manual `server update` and an auto-update fire can no longer collide.**
  The exclusive update lock was only taken by the timer wrapper, despite its
  own comment claiming otherwise — a manual update could interleave
  stop/rm/run with a fire and leave a window with no running container. The
  lock now lives inside `server update` itself: one acquisition point covers
  every caller, a held lock is a clear "another update is already in
  progress" message, and the lock is released on success and failure alike.
- **Auto-update outcomes no longer appear twice in the journal.** The wrapper
  logged each outcome to stderr while the CLI printed the same line to
  stdout; systemd journals both streams. One line per fire now.

### Docs

- The Settings page no longer claims the dashboard toggle alone keeps the
  server updated (the host timer is what acts) and no longer offers a
  "monthly" cadence that never existed (daily|weekly). The self-host guide
  gains an **Automatic updates** walkthrough: enabling as the right user,
  status/disable/uninstall, the rollback guarantee, and the
  `sudo journalctl` diagnostic for "auto-update seems to do nothing".

## [1.17.0] — 2026-07-25

### Added

- **You can finally put a reference in.** References are one of the three note
  types — the long background documents agents search with `search_references` —
  but until now the only ways in were the browser/phone clippers and
  hand-writing a file into the vault. The docs even promised an upload that did
  not exist. Now there are four doors, all landing in the same place:
  - **The dashboard.** The References tab has an **Add reference** control:
    fetch a URL, choose a `.md` file, or paste Markdown.
  - **`the-librarian refs add <file.md>`** — file a local Markdown document.
    Add `--move` to have the original removed once it is safely filed.
  - **`the-librarian refs add <url>`** — fetch and convert a web page, through
    the same SSRF-guarded pipeline the browser clipper uses.
  - **`the-librarian refs import <dir>`** — file every Markdown file under a
    folder, mirroring its structure. Re-running imports only what is new and
    reports what it skipped, so pointing it at a growing Obsidian vault is safe.
- **Importing keeps your frontmatter.** A file's own `title`, `tags` and
  `aliases` survive; only the missing fields are added. An Obsidian folder
  imports with its metadata intact.
- **A "Working with references" guide** — what belongs in a reference rather
  than a memory, how agents reach them, every way to get material in, and what
  helps retrieval.

### Fixed

- **Command-line flags no longer misread their arguments.** `--flag=value` was
  not understood: `the-librarian migrate-data-dir --data-dir=/srv/librarian`
  silently ran against the *default* data dir, and `restore --secret-key=…`
  silently ignored the key, because the whole `key=value` string became a flag
  name and the real flag went unset. Switches also swallowed whatever followed
  them, so a flag written before a path consumed the path. Both are fixed in the
  server CLI and the installer CLI.

## [1.16.1] — 2026-07-25

### Fixed

- **The smoke check no longer fails at random.** `pnpm smoke` passed and then
  crashed while cleaning up (`ENOTEMPTY`), reddening the whole lint/test/build
  job on roughly one run in three. The spawned stdio and HTTP servers were sent
  SIGTERM but never waited for, so the temp directory was deleted while a live
  process was still writing into it. Both servers are now awaited to exit —
  escalating to SIGKILL if one overstays, so a genuinely hung server fails
  loudly rather than hanging the run. Developer tooling only; no shipped
  behaviour changes.

## [1.16.0] — 2026-07-24

### Fixed

- **Approving two proposals about the same memory no longer leaves two divergent
  memories.** Two open proposals could each supersede the same memory; approving
  both activated both and archived the source only once (the second archive
  silently no-ops), leaving the corpus with two live memories claiming to replace
  it. Approving an update, supersede or merge now withdraws every other open
  proposal that would have replaced the memories it just archived — archived with
  a note recording which approval superseded them, never deleted. Split
  replacements are untouched: a split archives nothing, so nothing it does can
  make its siblings stale.
- **A proposal can no longer silently overwrite an edit made while it waited.**
  Proposals now record a content digest of each memory they supersede at the
  moment they are drafted. If one of those memories changes before the proposal
  is reviewed, the card marks it **Out of date**, names the memory that moved,
  and approve is refused — with no override, because a warning you can click past
  is one you learn to click past. Rejecting is the way out and costs nothing: the
  edit itself is what brings the curator back to that memory on its next grooming
  run. Proposals drafted before this release have nothing recorded to compare
  against, so they are neither marked nor blocked.
- **Grooming no longer re-proposes what is already in the queue.** A filed
  proposal used to change the run's input hash, so the very next sweep looked
  novel and spent an LLM call re-deriving the judgement it had just filed.
  Proposals are now evidence rather than a trigger — still shown to the curator,
  no longer a reason to re-run — and a run that reaches an identical judgement
  (same action, same memories) records an audited skip instead of filing a
  duplicate.
- **Discussing a proposal now shows the curator what that proposal replaces.**
  Proposal-grounded chat read an intake-only key that grooming proposals never
  set, so merges and updates — the ones most worth discussing — reached the model
  without the memories under discussion. It now carries their current text,
  bounded so a wide merge cannot blow out the prompt.

## [1.15.0] — 2026-07-24

### Added

- **Consolidated specs 066–071 into one releasable cross-surface update.**
  Shelf-aware browsing, cross-shelf moves, actor display resolution, single-port
  agent routes, first-owner bootstrap claims, and bounded refusal evidence now
  ship together. Detailed feature notes remain in the entries below.

### Security

- **Authentication and refusal handling are hardened end to end.** Proxy
  boundaries, bootstrap provisioning, refusal evidence, secret redaction,
  throttling, and fail-open logging are covered across the server, dashboard,
  CLI, and deployment surfaces.

### Fixed

- **Cross-shelf moves work on filesystems without hard links.** `moveFile` falls
  back to an exclusive copy (`COPYFILE_EXCL`) when `link(2)` is unsupported
  (exFAT, most SMB/CIFS mounts), keeping the no-clobber guarantee while
  restoring intake claims, vault renames, and memory moves for self-hosters on
  such mounts.
- **A move is refused when the destination shelf already bears the memory's id
  under a different filename** — previously only a same-filename path collision
  was caught, so a drifted copy could leave two files with one logical id.
- **The dashboard query cache survives ordinary navigation.** The provider
  remount key now uses the auth-boundary flag instead of the raw pathname, so
  the React Query cache is dropped only on an identity change or when crossing
  the login/claim boundary.
- **Shutdown can no longer hang on a wedged refusal-log volume.** The final
  refusal flush races a 2-second deadline before the store and listeners close.
- **The claim form fails closed on redirects.** The credential-carrying
  redemption request now sets `redirect: "error"`; the unused server-action
  redemption path and its hidden token input were removed (the API route is the
  single entry point, its tests re-pointed accordingly).
- **The auth probe answers about anonymous admission, whoever asks.**
  `/healthz?auth_probe=1` now evaluates the provider against a
  credential-stripped view of the request, so an operator probing with their
  own valid bearer is no longer told `mcp_auth: "disabled"` on a
  token-enforcing server.
- **Refusal attribution is derived in one place.** A shared
  `principalRefusalEvidence` helper replaces nine hand-rolled copies of the
  principal→evidence mapping across the store, tRPC gates, and HTTP routes;
  `proposeMove` now reuses the same memory-location and destination-resolution
  helpers as the review card and executor.

## [1.14.0] — 2026-07-18

### Added

- **Bounded refusal evidence (spec 071).** The HTTP server now records typed,
  versioned authn/authz, credential-ceremony, rate-limit, and shelf-routing
  denials in a `0600` NDJSON sidecar. Rows carry safe request or principal
  attribution without widening the success-only `AuditEvent` contract.
- **Admin refusal reader.** `activity.refusals` returns newest-first,
  filter-before-offset pages across the current and rotated generations, including
  counted drop totals and page-scoped actor display names. Member and anonymous
  callers are refused—and that refusal is itself recorded.

### Security

- **Presented secrets never enter refusal evidence.** Bearers become truncated
  SHA-256 fingerprints; unknown attempted usernames become `"<unknown-user>"`;
  passwords and raw bearer, admin, setup-link, and bootstrap-claim credentials are
  excluded and canary-tested across every wired boundary. Every persisted string is
  length-bounded, secret-redacted, and stripped of unsafe controls; network headers
  reduce to canonical origins and valid IP annotations.
- **Evidence is bounded and fail-open.** One 5 MB current generation plus one
  rotated generation caps disk use; a 120-row-capacity, two-row-per-second bucket
  and a bounded append queue record counted drops under flood. Reads and orderly
  shutdown flush finite drop bursts, and the next append repairs a torn tail before
  writing. `LIBRARIAN_REFUSAL_LOG=false` disables the default-on sink. Only the HTTP
  process arms it, and evidence I/O can never change a denial into a 500.

## [1.13.0] — 2026-07-18

### Added

- **One-shot first-owner bootstrap claims (spec 070).** An optional
  `LIBRARIAN_BOOTSTRAP_CLAIM_SECRET` arms a dormant-by-default owner-claim flow.
  While armed, the dashboard closes its unauthenticated setup window and routes the
  first owner through a chrome-free `/claim` page that verifies a short-lived HMAC
  claim, creates the password owner, enables enforcement, burns a durable one-shot
  flag, and establishes the owner's session. Self-hosters can mint compatible,
  email-normalising links with `the-librarian auth mint-claim`.
- **Provisioner receipts and recovery.** Verified HTTPS return targets receive a
  signed claim receipt after success, and the documented re-arm ceremony lets a host
  operator recover from owner lockout without weakening the default path.

### Security

- **Claim state fails closed and survives partial failure.** Store outages block
  before claim routing; weak arming secrets fail at boot; the enabled-owner and burn
  gates independently refuse reuse; and a crash after password creation but before
  enablement remains locked down and safely re-redeemable. The redemption path logs
  no token, password, MAC, or arming-secret material.
- **Provisioning transitions cannot go stale.** Compose's explicit empty default is
  dormant; the managed `server up` path persists an operator-supplied arming secret
  only in its `0600` deploy file and `server update` preserves it; claim-pending
  dashboard configuration bypasses the normal TTL cache so the newly established
  owner session is not redirected back into the spent claim flow.
- **Claim throttling is a real transport boundary.** The claim form submits to a
  dedicated, cache-disabled server route, so an over-limit client receives HTTP 429
  rather than a successful Server Action transport carrying a decorative status
  field. Redemption, receipt validation, and session establishment remain server-only.

## [1.12.0] — 2026-07-18

### Added

- **Opt-in single-port deployment (spec 069).** The dashboard can proxy the full
  five-route public agent surface at clean same-origin URLs, letting hosted and
  reverse-proxied deployments expose only their HTTPS dashboard port. The default
  remains inert: all five paths return 404 until `LIBRARIAN_SINGLE_PORT=true`.
  Compose, Fly, the example environment, and deployment guides document the public
  URL, browser-origin, TLS, and client-migration requirements.

### Security

- **Bearer auth remains the public boundary.** The proxy strips dashboard cookies
  and identity assertions while preserving agent bearer and origin headers. Protected
  routes refuse to forward unless the active upstream principal provider rejects an
  unauthenticated probe; proxy-marked requests cannot use the server's localhost
  no-auth fallback. Bounded request bodies, redirect refusal, timeouts, and
  cache-disabled responses keep the passthrough fail-closed.

## [1.11.0] — 2026-07-18

### Added

- **Shelf-aware memory browsing (spec 066).** Member-scoped callers can enumerate their
  deduplicated shelf inventory and filter memory browsing by shelf without gaining an
  existence oracle. Multi-shelf results carry shelf attribution through list, reference,
  inspector, and bottom-sheet surfaces; the dashboard only offers a shelf filter when
  more than one shelf is visible. The default single-shelf deployment keeps its existing
  payload shape and UI.
- **Cross-shelf memory moves (spec 067).** Admins can move a memory between visible,
  writable shelves directly from its detail view, while members can submit a scoped move
  proposal for review. Moves preserve the document bytes and filename, refuse destination
  collisions, invalidate both shelf indexes, and emit shelf-safe departure/arrival audit
  events. Move proposals have dedicated review cards and execution semantics; the
  dashboard exposes only the narrow capability bit needed to choose direct versus
  proposal mode.
- **Actor display resolution (spec 068).** Build-time plugins can supply the stable,
  synchronous batch `ActorDisplayProvider` to attach sanitised member names beside
  already-visible actor ids. Audit exports carry a page-level display map without
  changing their strict event rows; proposal review rows carry an optional display
  rendered with the stable id in a tooltip. No provider leaves payloads and dashboard
  rendering unchanged.

### Fixed

- **Multi-shelf browse identity stays unambiguous.** Duplicate logical memory ids are
  resolved by router precedence before sorting and paging, so `total` counts unique rows;
  shelf labels must contain visible text; and dashboard query caches are remounted when
  either the signed-in principal or route changes.
- **Move audit attribution survives real Git edge cases.** Git pathspecs are literal, and
  an exact move commit whose dirty source file defeats rename detection still exports the
  intended shelf departure/arrival pair without reclassifying unrelated add/delete commits.

### Security

- **Cross-shelf moves fail closed.** Moves refuse symbolic-link traversal and non-regular
  files, use an atomic no-clobber destination claim, and restore both the working tree and
  Git index if the move commit fails.
- **Proposal moderation is principal-scoped end to end.** Review previews, plan targets,
  approval, rejection, and resolution all use the acting admin's validated shelf set.
  Admins can still moderate a visible proposal stored on a read-only shelf through a
  narrow core capability, without gaining arbitrary write access to that shelf.
- **Actor displays remain untrusted chrome.** Resolution ignores ids outside the original
  scoped payload, fails soft across provider iteration and sanitisation, strips bidi and
  line controls, and bounds every accepted value to 64 safe Unicode code points.

## [1.10.2] — 2026-07-19

### Fixed

- **Transcript harvesting now preserves the complete set of high-value
  knowledge without turning conversations into inventories.** The extractor
  prioritises durable intent, lessons, history, direction, rejected options,
  conditions, open questions, and ownership boundaries while rejecting facts
  cheaply recoverable from code and other artefacts. A final coverage and
  compression pass groups related roles, keeps decisions with their rationale,
  removes explicitly disposable details, and uses a worked retention-boundary
  example to avoid copying forbidden identifiers.
- **Grooming now produces focused retrieval units instead of entity-wide
  dossiers.** Merge proposals must answer the same future recall question,
  preserve every source claim, remain entailed by source bodies, keep
  proposed/rejected/current/open status intact, and avoid converting metadata
  timestamps into event dates. Code-only memories are archived rather than
  folded into durable business knowledge.
- **Intake now audits routing and content before filing.** It resolves active
  contradictions before related additions, files under the primary durable
  subject instead of a contextual entity, distinguishes scoped history from a
  live contradiction, and checks a claim ledger so related incidents,
  rationale, owners, exceptions, adopted responses, and unresolved questions
  survive without brittle implementation identifiers or invented dates.

## [1.10.1] — 2026-07-19

### Fixed

- **Curator responses now restate the strict fields production accepts.**
  Intake explicitly limits tags to creates and split replacements, preventing
  otherwise useful supersede judgments from being discarded for an extra
  `tags` field. Grooming now distinguishes numeric operation confidence from
  the `tentative` / `working` / `strong` stored-memory confidence enum, and
  gives the complete nested memory shapes including array-only `applies_to`
  and `tags`. The shared tagging guidance no longer conflicts with action
  shapes that omit tags, and every complete grooming replacement now explicitly
  requires the production `visibility: "common"` field.

## [1.10.0] — 2026-07-17

### Added

- **The typed audit export — the read half of the attribution substrate
  (spec 064 T6–T9, seam S5).** `store.exportAudit(principal, opts)` and the
  `activity.auditExport` tRPC procedure turn the vault's git history into a
  stream of typed **`AuditEvent`**s answering *"who **successfully** changed
  what, when, on which shelf"* — no consumer ever parses git. `AuditEvent`, the
  **closed, permanent `AuditAction` union**, the zod schema, and the
  `AuditSourceError`/`AuditCursorError` classes are published from
  `@librarian/core` and re-exported from the stable
  `@librarian/mcp-server/extension` surface (a plugin validates the wire shape
  and `instanceof`-checks the errors). The export is **shelf-safe and
  escalation-free**: scoped to `shelves(principal, "recall")`; `paths`,
  `renames` and `diff` are admin-only (a memory filename encodes its title); a
  cross-shelf promotion emits a `shelf.departure`/`shelf.arrival` pair, each
  redacting the far side; a non-ASCII filename can no longer evade the shelf
  filter (`core.quotePath=false` on every export read). Pagination is
  **commit-addressed** (a 100-commit page, `nextCursor` = the oldest commit
  scanned), so a page that filters to zero events still advances; a stale cursor
  is a typed client error, a broken `.git` a source error — the states
  git-history used to collapse to `[]`.

### Security

- **The audit "who" column is un-forgeable.** Read-side (SC 7c): a commit
  carrying **≠ 1** `Librarian-Actor` trailer exports `actor: null`, never
  `actors[0]` — a forged or duplicated trailer is never believed. Write-side
  (F3): the memory **owner** (frontmatter `agent_id`, legitimately settable by
  an admin merge/split) is now threaded separately from the **audit actor** (the
  trailer + `updated_by`, always the acting principal) — a request-body
  `agent_id` can no longer forge the audit actor on
  update/archive/resolveFlag/bulkUpdate/purge/unmerge/merge/split. (F4) a memory
  written through the vault editor has its `updated_by` re-stamped from the
  resolved actor, so a hand-crafted false last-writer never survives.

## [1.9.0] — 2026-07-16

### Added

- **Attributable writes — the audit substrate (spec 064, seam S5, ADR 0011).**
  The Librarian can now say **who successfully changed what**. Every
  actor-bearing write commits with a sanitised `Librarian-Actor` git trailer
  naming the acting principal, and a memory records the **last writer** in an
  additive `updated_by` frontmatter field. This finishes spec 061's identity
  migration (the store used to thread the actor to the write path and discard
  it) and is OSS value on its own — an operator can read attribution straight
  from `git log`, no export needed.
  - **Two commit primitives, and the axis is *"did this actor cause these
    bytes"*.** Attributed writes get a **pathspec-limited** commit
    (`git commit -- <paths>`, not just a scoped `git add`) so a concurrent
    edit staged by another process (the CLI is a second process with no lock)
    can never ride into an actor's trailered commit — a false name is worse
    than an honest null. Whole-tree system sweeps (backup snapshot,
    pre-restore snapshot, the migration sweeps) keep a separate primitive and
    are **untrailered**, exporting the actor as an honest `null`: they capture
    other people's out-of-band bytes. The two sweeps whose bytes an actor
    *does* own — a whole-vault **restore** (the admin) and the intake
    **consolidate sweep** (`system-consolidator`) — are trailered.
  - **Attribution is trustworthy.** The actor is charset-validated
    (canonical-id-or-nothing) before it reaches `--trailer`, and
    `trailer.ifexists` is pinned, so neither a forged actor id nor a hostile
    git config can forge or drop the "who" column. Commit subjects strip CR/LF
    so a crafted path can't smuggle a second trailer line.
  - **Published from `@librarian/core`** (additive): `commitSubject` (the owned
    commit-subject vocabulary), `actorTrailerValue` (trailer eligibility), and
    `channelForActor` (the `ActorKind → channel` table).
- **The vault-file, primer and curator write surfaces became attributable.**
  The dashboard's vault editor, the primer, and the curator addendum/examples
  writes now carry the acting admin. Vault-file methods gained an
  **optional-last `actorId`** parameter — a non-breaking migration.

### Changed

- **Whole-tree `commitAll` and the vault-file committer take an optional
  actor.** Existing behaviour is unchanged when no actor is supplied (an
  untrailered commit).
- **Retired `createGitOps`** — a public, async git surface in
  `@librarian/core` with zero callers (superseded by the synchronous
  `createSyncGitOps`).
- **Dashboard nav unified onto one canonical route table (spec 063, seam S4).**
  The dashboard's route set had been enumerated in **six** overlapping places —
  the nav tabs (`TABS`), the settings menu (`SETTINGS_ITEMS`), the chrome-free
  predicate (`isChromeFree`), the command-palette targets (`NAV_ITEMS`), the
  `g`-jump map, and the docs deep-link map (`ROUTE_DOCS_SLUG`) — plus the mobile
  drawer and settings dropdown that re-mapped the same data and a shortcut
  predicate copied out of the Vault tab's rule. All now **derive** from one
  source of truth, `apps/dashboard/lib/routes.ts`, whose active-match rule is a
  disjunction of paths (the Vault tab is active on both `/` and `/activity`,
  which a scalar field could not express). A **provably-inert** refactor with
  zero behaviour change: the nav strip, drawer, dropdown, palette contents,
  shortcut overlay and docs mapping are byte-identical, pinned by the existing
  site-nav test unchanged plus four new pins (the palette snapshot, the Vault
  tab's `/activity` active state, the exact 18-key docs map, and the chrome-free
  route table). Internal to the `private: true` dashboard package — no public
  surface, manifest or version change.

## [1.8.0] — 2026-07-16

### Added

- **Dashboard member identity — a principal on the dashboard hop (spec 065,
  ADR 0011).** The dashboard now **asserts, on every server call, who the call
  is on behalf of** — a signed-in user, or explicitly *nobody* — in one request
  header on the trusted internal listener. The header is a **scoping assertion,
  not a credential** (a privilege drop by the already-trusted dashboard
  process, ADR 0008 P3): the OSS default provider ignores it — byte-identical
  admin-by-isolation — while a member-aware `authProvider` plugin maps it to
  member principals, closing the hole where any signed-in Teams member saw the
  entire vault.
  - **The assertion contract.** One header, `x-librarian-dashboard-user`:
    `base64url(UTF-8 JSON)` of `{anon:true}` or
    `{provider, sub, email?, name?}` (CLOSED shapes — any undeclared key is
    invalid), or the literal poison marker `invalid`. The setter enforces the
    4 KB cap (oversize → poison, never an omitted header). Published on
    `@librarian/mcp-server/extension` (additive): `readDashboardUser` returning
    the four-way `DashboardAssertion`
    (`absent | invalid | anonymous | user`) — absence and badness are
    DIFFERENT outcomes because they route to opposite trust results — plus the
    `DASHBOARD_USER_HEADER` / `DASHBOARD_USER_POISON` constants and the
    `DashboardUser` type.
  - **Both dashboard call paths carry it.** The `/api/trpc` proxy derives the
    assertion from its OWN session on every call (user / anonymous /
    poison-on-unresolvable-session, chunked session cookies detected by name
    prefix) and strips any inbound forgery; RSC pages and server actions get a
    per-request identity callback on `serverTRPC` implementing the five-row
    table, with the scope discriminator pinned against the installed Next
    (only the outside-request-scope error means "machine context"; every other
    probe throw re-throws). The **auth bootstrap traffic** — the auth-config
    fetch, credentials `verifyPassword`, and the break-glass
    `redeemSetupLink` — rides a separate **bare client** (their credentials
    are out-of-band; one client would deadlock on every cold config cache).
  - **A stable session subject.** `session.user` now carries
    `{sub, provider}`; the credentials owner's `sub` is the pinned constant
    `"owner"`.
  - **`memberProcedure`, the second tier.** Admits `member` OR `admin`
    (`admin` is total authority — `["member","admin"]` passes every
    adminProcedure). Moving a procedure to the tier must arrive WITH
    principal-scoping in the same change; everything else stays fail-closed
    admin-gated — proven by an UNAUTHORIZED suite over the destructive surface
    (`activity.restoreVault` with the CORRECT confirmation phrase,
    `vault.write/delete/rename`, `memories.update/archive/purge`,
    `tokens.create/revoke`, `grooming.setConfig`). `health.*` stays public.
  - **The first scoped slice: the memories browse surface.** Exactly four
    procedures moved to the member tier with principal-scoped store surfaces:
    `memories.list` (new `listMemoriesForPrincipal` — per-shelf rows
    enumerated UNCAPPED in core, merged by the requested sort key with a
    deterministic tie-break, offset/limit after the merge, Σ totals, 062's
    shelf-attribution rule; default router delegates byte-identically),
    `memories.distinctValues` (per-shelf union), `memories.recall`
    (→ `recallForPrincipal`), and `vault.searchReferences`
    (→ `searchReferencesForPrincipal`, with a principal-scoped `searched`
    denominator). New core primitives: `getMemoryForPrincipal` (off-shelf id →
    `null`, no existence oracle) and `countReferencesForPrincipal`. The empty
    shelf set yields the empty envelope / union / `null`, never a throw.
  - **Teams-shape e2e + docs.** A fixture plugin implements the assertion
    table + matching vault router and drives the seven SC 10 assertion groups
    over real HTTP against the internal listener (member scoping, provenance
    labels, restore refusal, admin equivalence, refusal rows, BOTH sessionless
    bootstrap shapes, and the vaultRouter-without-authProvider coupling case).
    The extension docs gain the full contract, the trust-model table with its
    honest fail-open-absent-row consequences, the memberProcedure and
    admin-superset rules, the slice semantics, and the out-of-scope list.

## [1.7.0] — 2026-07-13

### Added

- **Pluggable vault-set routing — a `VaultRouter` over ordered shelves (spec 062,
  ADR 0011).** Recall, reference search, writes, grooming, and the capture pipelines
  now resolve through a replaceable **`VaultRouter`** over ordered **shelves** — rooted
  prefixes inside the *one* vault git repo (`Shelf { id, prefix, writable, label? }`).
  A member-aware build-time plugin can give each principal a **merged view** (a personal
  shelf plus a read-only, provenance-labelled team shelf), while the OSS product keeps
  its single-shelf behaviour **byte-for-byte** under the inert `defaultVaultRouter` (one
  writable shelf at the vault root). Landed across spec 062 T1–T7:
  - **The seam + prefix rules (T1).** `Shelf` / `ShelfOp` / `VaultRouter`, the inert OSS
    default router, and the enforced prefix discipline — relative, forward-slash,
    trailing slash, NFC-normalised, disjoint (no nesting, checked **case-insensitively**),
    **capped at two segments** (`members/x/` is the deepest shape), no canonical-name
    shadowing, and a printable `]`/newline-free `id`; a violation throws the first time the
    router is used for a principal.
  - **Store parameterisation + determinism plumbing (T2).** Path resolution and
    file-kind detection go shelf-relative (visibility rules applied beneath each prefix;
    `primer.md` and the `.index`/embedding caches stay vault-singular);
    `LibrarianStoreOptions` gains optional `now` / `generateId` injection, and a golden
    layout test proves a write/groom cycle is byte-identical to a pre-change fixture
    under the default router.
  - **Shelf-scoped read/write + typed write errors (T3).** A `forShelf(shelf)` store
    handle confines reads and writes beneath a prefix; principal-attributed writes land
    on `writeTarget(principal)`, enforced by two published error classes —
    **`ShelfNotWritableError`** (a read-only target) and **`ShelfNotInWriteSetError`**
    (a target outside `shelves(principal, "write")`).
  - **Per-shelf indexes (T4).** The corpus index is built and cached per shelf; a write
    to shelf A invalidates only A's cache. Measured memory cost: **126 MB @ 1 shelf →
    159 MB @ 6 shelves (500 memories each) — ~6.6 MB per added shelf, ~7.8% of the 2 GB
    envelope.**
  - **Merged, labelled recall (T5).** Recall consults the principal's shelves in router
    order and merges by a **per-shelf rank interleave** (strict alternation, router-order
    priority on equal rank, dedupe by memory id, `limit` after the merge — scores are
    never compared across independently built indexes). Every merged hit is tagged with
    its shelf; the MCP text leads each line with `[<label> (<id>)]` (or `[<id>]`) — but
    only when the materialised set has more than one shelf, so single-shelf output stays
    byte-identical.
  - **Per-shelf pipelines (T6).** Grooming iterates `shelves(system, "groom")` against
    shelf-scoped handles, the intake sweep drains every groom shelf's inbox, and
    `/transcript` + `/ingest` capture onto the capturing principal's `writeTarget`
    shelf; reference search merges across the principal's `search` shelves. Grooming and
    intake are **system** pipelines scoped to the shelf they process and are **not** gated
    by `writable` — a read-only team shelf still grooms and drains its inbox.
  - **Restore generalisation (T7).** The restore-staging vault check
    (`isLibrarianVault`) recognises shelf-prefixed layouts — the canonical layout at the
    vault root **or** beneath a shelf prefix — so a backup + restore round-trip of a
    Teams-shape vault succeeds (the pre-062 root-only check rejected exactly that tree).
    Existing root-anchored vaults are still accepted.
- **The vault-router seam types join the extension entrypoint.**
  `@librarian/mcp-server/extension` now publishes **`Shelf`**, **`ShelfOp`**,
  **`VaultRouter`**, and the two typed write-error classes
  (**`ShelfNotWritableError`**, **`ShelfNotInWriteSetError`**) alongside the 060/061
  shapes — documented on the docs site under *Extend the Librarian → Extension API* with
  the full router contract, the prefix rules, the shelf layout rule, `writeTarget` +
  write-set semantics, the merge/label behaviour, the groom-set-drives-pipelines rule,
  and a worked member-router example. (`RecalledMemory` / `GroomingStore` stay
  core-internal — a router author's signatures never name them.)

### Fixed

- **Spec 062 adversarial-review fixes (pre-release).** A fresh-eyes review of the shelf
  work above surfaced several semantic bugs, all corrected before release:
  - **System pipelines are no longer writability-gated.** Grooming composed the
    *principal*-gated store, so a `writable: false` team shelf threw on every proposal
    apply — the whole pass silently errored. Grooming (like intake) now writes through the
    shelf's raw store, so a read-only shelf grooms and lands its writes under the shelf;
    `writable` gates principal-attributed writes only.
  - **The write gate is now per call, not baked per prefix.** The scoped handle memoized
    `writable` at first materialisation, so whichever caller reached a prefix first fixed
    its gate process-wide (a member's read-only recall could neuter a later legitimate
    groom, and vice versa). The store now memoizes the expensive per-prefix core and derives
    the write gate **freshly per call** from the `Shelf` argument.
  - **`writeTarget` write-set agreement now also matches on `writable`**, so a target that
    disagrees with its write-set member on writability is rejected.
  - **Restore vault-detection tightened.** The shelf-aware scan accepted any git repo with
    one canonical-named dir up to two levels deep (a foreign repo with a nested
    `references/` passed) and had silently changed the root check from `existsSync` to
    `isDir`. The root arm restores the exact pre-062 semantics; the nested arm requires a
    `memories/` dir or a canonical **cluster** beneath a shelf-legal prefix, and the
    prefix-depth cap keeps the scan aligned with the validator by construction.
  - **Reference-search de-dupe no longer drops distinct documents** that share a
    shelf-relative path across shelves — it now keys on the full vault-relative path.
  - **Handoff/flag routing** — `list_handoffs` / `claim_handoff` / `flag_memory` route
    across the principal's recall shelves (not just the vault root), respecting each shelf's
    `writable` for the claim/flag mutation.
  - **Transcript `.shelf` marker fail-soft** — a malformed/non-writable marker now falls
    back to the **first groom-set shelf's** (guaranteed-swept) inbox — the vault-root inbox
    only when the groom set is empty — so captured facts are never dropped into an un-swept
    inbox. A marker must carry `writable: true` (an integrity check: a marker records what
    `resolveWriteTarget` returned, which is always writable — a marker that doesn't is
    corrupt, not a permission verdict).
  - **The transcript intake submits through the system-pipeline path, not the write gate.**
    Both marker paths now land facts via the store's shelf-scoped, **un-gated**
    `systemSubmitToInbox` — captured facts are `system-consolidator`-bound material, and
    (per the first fix above) `writable` gates principal-attributed writes only. Through the
    gated view, a groom set whose first shelf is read-only — a legal shape, since router order
    is plugin-chosen — threw `ShelfNotWritableError` on every fact; the sweep's per-fact
    fail-soft swallowed each throw and then deleted the buffer: **permanent capture loss**.
    Now zero facts are lost for any legal groom set.
  - **Defense-in-depth** — a shelf-scoped path can no longer escape into a sibling shelf (the
    guard now covers directory *listings* too, not just reads/writes), and recall provenance
    labels are stripped of `]`/newlines at render.

### Changed

- **The extension surface (`@librarian/mcp-server/extension`) is now STABLE.** With spec
  062 shipped, the ADR 0011 semver promise for this entrypoint **starts here**: a
  breaking change to any type or value published on it is a **major version bump
  documented in this changelog**. The experimental marker on the entrypoint and its docs
  page is **dropped**. Everything *not* exported through the entrypoint remains private
  and refactorable at will.

## [1.6.0] — 2026-07-13

### Added

- **A pluggable identity seam — one `Principal`, resolved by a replaceable
  `AuthProvider` (spec 061, ADR 0011).** The four identity shapes the request path
  used to carry (`AuthResult`, the MCP `ToolContext` role/agentId pair, the tRPC
  role, and core's `ResolvedCaller`) collapse into a single **`Principal`
  `{ kind, actorId, boundActorId?, roles, scope?, tokenId?, attrs? }`**, threaded
  from listener to store write and produced by an **`AuthProvider`** — the "who is
  this request?" seam a build-time plugin can now **replace** to answer for its own
  members on both listeners. The `actorId`/`boundActorId` split is load-bearing:
  `actorId` is always the attributed actor, while `boundActorId` is set only when a
  credential *cryptographically binds* an identity and is the id the impersonation
  guard checks — so a self-identifying single-token agent's body `agent_id` still
  wins. The OSS **default provider reproduces today's per-surface auth matrix
  exactly** (internal → admin, public → the agent-token ladder with identical
  401/403 semantics), so existing behaviour is unchanged; a supplied provider that
  resolves **admin on the public surface** is refused `403` by the factory unless the
  supplying plugin sets `allowPublicAdmin` (the ADR 0008 no-admin-on-public
  invariant, now factory-enforced). The factory guard also **backstops token scope**
  for a substitute provider: a **non-admin** principal whose `scope` does not match a
  scoped public route (`agent` for `/mcp` · `/transcript`, `capture` for `/ingest`) is
  refused `403`, so the D21 wall holds even if a provider ignores `requiredScope` (the
  OSS default enforces it itself, so the default path is unchanged).
- **The auth-provider seam is consulted on *every* authenticated request path,
  including internal plugin routes.** A plugin route on the trusted internal listener now
  resolves its identity through the same provider seam every other path uses, rather than a
  direct admin-by-isolation call — so a substitute member-aware provider is consulted there
  too. On the default provider this is byte-identical (the internal branch still returns the
  trusted `dashboard-admin` principal); a substitute may now also refuse an internal request
  (`401`/`403`), failing closed.
- **The auth provider types join the extension entrypoint.**
  `@librarian/mcp-server/extension` now publishes **`Principal`** (re-exported from
  `@librarian/core`), **`AuthProvider`**, **`AuthProviderResult`**, and
  **`SyncAuthProvider`** alongside the 060 registration shapes — documented on the
  docs site under *Extend the Librarian → Extension API* with the full `Principal`
  contract for provider authors and an async member-provider example. The entrypoint
  stays **experimental**: the ADR 0011 semver promise for the extension surface still
  starts at the 062 release (`vaultRouter`'s type lands then).

### Changed

- **Callers with no resolvable identity are now attributed a named sentinel, not
  `unknown-agent`.** Memories written by a caller the server can authenticate but not
  bind to a name are attributed **`env-token-agent`** (the shared
  `LIBRARIAN_AGENT_TOKEN` single-token path) or **`local-agent`** (the localhost
  no-auth bypass, and the stdio bin invoked with no id) — where an identity-less
  write previously fell back to the ambiguous `unknown-agent`. This is the one
  deliberate, self-hoster-visible attribution change in spec 061 (the "unknown-agent
  ambiguity replaced" consequence ADR 0011 promised). **Existing vault files are
  untouched** — only new writes on those paths carry the sentinel — and a request that
  supplies its own `agent_id` is unaffected: it still wins.

### Deprecated

- **`AuthResult` is a deprecated alias for one release.** The mcp-server's flat
  `AuthResult` shape is superseded by `Principal` + `AuthProvider`; derive the role
  from `principal.roles`, the attributed actor from `principal.actorId`, and the
  credential binding from `principal.boundActorId`. It is retained **unchanged** so
  existing code and `PluginRouteContext.auth` keep compiling, and is scheduled for
  removal after the 062 release.

## [1.5.0] — 2026-07-13

### Added

- **A build-time plugin API behind a single composition root (spec 060, ADR
  0011).** The HTTP server now assembles from one factory,
  `createLibrarianServer(options)`, which owns store construction, both
  listeners, the schedulers, and shutdown; the `bin/http.ts` boot reduces to env
  parsing plus one factory call. The factory accepts build-time **plugins** — an
  imported object `{ name, tools?, trpcRouters?, routes?, authProvider?,
  vaultRouter?, allowPublicAdmin? }`, no dynamic loading — with three
  registration seams that **add** to a registry: MCP `tools` (list + dispatch
  with the same role-filtering core tools get), `trpcRouters` (merged under the
  plugin name as a namespace on the internal admin surface), and HTTP `routes`
  (each declaring its `surface` and `auth` contract, which the factory enforces
  before the handler runs). Name/path/tool collisions — and a public `/trpc`
  mount — are loud construction-time boot errors naming the offending plugin;
  registrations never silently override.
- **Provider seams + the extension entrypoint.** Plugins may also fill two
  provider seams that **replace** a default rather than add — `authProvider`
  ("who is this request?") and `vaultRouter` ("which shelf?"); two plugins
  supplying the same seam is a boot error naming both. As the ADR 0008 amendment
  in ADR 0011, the factory now enforces the no-admin-on-public invariant as a
  default: a supplied auth provider that resolves an admin-role principal on the
  public surface is refused `403` unless the supplying plugin sets the explicit
  `allowPublicAdmin` opt-out. The plugin-facing types are published from a new,
  **experimental** subpath entrypoint, `@librarian/mcp-server/extension`
  (`LibrarianPlugin`, the tool/route/tRPC registration shapes), documented on
  the docs site under *Extend the Librarian*. The provider interfaces themselves
  are owned by specs 061/062 and join the entrypoint when those land; the ADR
  0011 semver promise for the extension surface starts at the 062 release.

## [1.4.2] — 2026-07-17

### Fixed

- **Codex automatic capture now reads native rollout transcripts.** The adapter
  previously assumed Claude-style top-level message records, so real Codex
  conversations produced zero turns while their byte cursors advanced. It now
  captures canonical user display events and assistant output items exactly
  once, excluding adjacent duplicates, injected developer context, reasoning,
  and tool traffic. Unknown payload variants, malformed complete records, and
  records beyond the safe request ceiling hold the cursor instead of being
  discarded; ordinary records over the 256 KiB batch size are captured normally.
  Upgrading a legacy cursor locally replays only its consumed prefix to reconstruct
  private-mode state, then resumes without uploading that prefix. Cursor files are
  retained rather than age-pruned so an old conversation cannot restart from byte
  zero unexpectedly.

## [1.4.1] — 2026-07-07

### Changed

- **Curator prompt v5.6 — sharper judgement.** The shared curator core now
  leads with an explicit value hierarchy (intent, learning, history, direction)
  and a durable-vs-brittle rule that strips rediscoverable-from-code detail
  (file paths, line numbers, snippets) while keeping the intent it served.
  Intake and grooming modes gain per-mode judgement guidance — kernel
  extraction and augment-vs-supersede in intake, entity-narrative
  consolidation and de-brittling in grooming — plus confidence-scale anchoring
  and a reminder that the stored `confidence` field is the `tentative` /
  `working` / `strong` enum, not the operation's numeric score. No wire-shape,
  MCP-surface, or memory-state changes.

## [1.4.0] — 2026-07-02

### Added

- **The curator chat can search the corpus.** The chat's output contract gains
  an internal `{ kind: "search", query }` shape: the model asks, the server
  runs the same hybrid recall the agents' `recall` verb uses (top 8 hits,
  redacted, body-truncated, untrusted-framed) and feeds the results back —
  bounded at 3 searches per reply, degrading to prose when the budget is spent
  or the index is unavailable. Ids from search results are usable in proposed
  actions, so "find other memories about X and merge them" now ends in a merge
  proposal with real ids for the admin to confirm. The dashboard wire and UI
  are unchanged — the search happens inside the turn.

### Fixed

- **The discuss dialogs use the screen.** `DialogContent` merged caller classes
  naively, so every "wide" dialog silently rendered at the base 32rem —
  overrides now merge via tailwind-merge and genuinely apply. The proposal- and
  memory-discuss chat dialogs get a roomy canvas: near-viewport width (capped
  at 80rem) and height, with the chat panel absorbing the extra space.

## [1.3.1] — 2026-07-02

### Fixed

- **"Distill example" no longer fails with HTTP 400 on real providers.** The
  shared curator LLM client defaults every request to OpenAI JSON mode
  (`response_format: json_object`) — right for every other curator call, wrong
  for the distill call, which asks for plain markdown; OpenAI-compatible
  providers reject JSON mode when the prompt never mentions JSON. Both distill
  completions now opt out explicitly, pinned by a regression test.

## [1.3.0] — 2026-07-02

### Added

- **Proposal review rework — informed, expressive, instructive**
  (spec 2026-07-01). Reviewing an intake proposal no longer means guessing from
  "curator guessed: augment":
  - **The judge's plan is persisted.** An intake judgment routed to propose now
    stamps its full plan onto the proposal's `curator_note` (guessed target,
    planned addition / curated title / body / tags, judgment confidence) —
    additive keys, redacted like the rationale, never touching `supersedes`, so
    the honest "New — needs filing" badge and plain-approve semantics are
    unchanged. Legacy proposals need no migration.
  - **The card shows the plan.** A "Curator's plan" panel renders the intent
    ("Wanted to augment ‹Elaine› with: …"), the planned content, a
    server-rendered preview diff of applying it, and the confidence. An
    archived/vanished guessed target gets a teaching note instead of a preview.
  - **The plan can be executed.** "Approve as augment of ‹X›" / "Approve —
    replaces ‹X›" runs the persisted plan through the existing guards (target
    alive, no-clobber) via the new `memories.applyProposalPlan` mutation — never
    re-running the curator — then consumes the proposal (archived,
    `resolution: "applied_plan"`). Guard failures teach and mutate nothing.
    A planned create offers "Approve curated version" (the judge's cleaned-up
    title/body/tags via the approve mutation's `patch`) alongside "Approve raw
    submission".
  - **Rejections can teach.** "Reject & make an example" distills the rejected
    submission into a new single examples document
    (`.curator/intake-examples.md`, capped by the new
    `curator.intake.examples_max_bytes` setting, default 4096 bytes) that rides
    every intake prompt — note → curator distill → diff preview → explicit
    confirm commits the doc, then rejects. Plain Reject stays silent. New admin
    tRPC router `examples` (get / set / rollback / distill); the intake eval
    threads the document through the same prompt path.
  - **Every proposal can be discussed.** "Discuss this proposal" opens the
    curator chat grounded in the proposal, its plan, and the resolved guessed
    target; confirming a chat-proposed action also clears the proposal
    (`resolution: "resolved_via_chat"`). Chat still proposes, never executes.
  - Curator prompt version bumps to v5.5 (the intake examples block).

## [1.2.3] — 2026-06-30

### Changed

- **Dashboard "Docs" link defaults to the public docs site.** The contextual
  "Docs" nav link previously stayed hidden until `NEXT_PUBLIC_DOCS_URL` was set at
  build time, so a self-hoster on the prebuilt image never saw it. It now defaults
  to `https://librarian-docs.codeministry.net` for every deployment, with
  `NEXT_PUBLIC_DOCS_URL` kept as an optional override (e.g. a private docs fork).

## [1.2.2] — 2026-06-30

### Changed

- **Docs-update rule now names the live docs site.** With
  `https://librarian-docs.codeministry.net` live, `AGENTS.md` and
  `CONTRIBUTING.md` drop the "once it ships" conditional and point the
  user-facing-docs rule at the docs site as its canonical home (spec T1.6).
- **Docs site brought on-brand with the dashboard and marketing surfaces.** An
  impeccable design critique found the Starlight docs read as a recoloured
  default theme. Fixes (`apps/docs`): default to light **Manuscript** for new
  visitors instead of following the OS — matching the other two surfaces — via a
  `ThemeProvider` override; collapse Starlight's five rainbow hue families (cards
  **and** asides) onto the verdigris-rubric + copper-structure two-metal system;
  flat and sharp throughout (no drop shadows, squared cards / buttons / search /
  code-frames); add the missing copper structural accent (header rule, code
  frames, home); retire the callout side-stripe for a full framed aside; drop the
  faux terminal window-dots; and replace the stock card-grid home with a bespoke
  editorial index. Verified in light and dark, with the existing axe-core a11y
  gate still green over both palettes.

### Added

- **Click-to-enlarge screenshots.** Content images (the dashboard-tour
  screenshots) open enlarged in a dependency-free native `<dialog>` lightbox —
  activated by click or keyboard (Enter/Space), dismissed by Esc / backdrop /
  close button, with focus returned to the image. A copper-mounted frame and a
  theme-aware scrim mirror the marketing site's lightbox idiom; the open
  animation respects `prefers-reduced-motion`.

## [1.2.1] — 2026-06-30

### Changed

- **Docs site canonical URL.** Set the Astro `site` to
  `https://librarian-docs.codeministry.net` (the chosen docs subdomain, spec
  OQ1), so the built site emits absolute canonical / Open Graph URLs and a
  sitemap rather than skipping them. Repo-side preparation for the Cloudflare
  Pages go-live; no user-visible change until the site is published.

### Fixed

- **Cloudflare Pages (and any submodule-aware clone) no longer aborts on
  checkout.** Removed a stray gitlink at
  `.claude/worktrees/agent-a6282d3c0bf0d483c` — a Claude Code agent worktree
  accidentally committed as a submodule pointer (the repo has no `.gitmodules`),
  which made `git submodule` init fail with `No url found for submodule path`.
  Added `/.claude/worktrees/` to `.gitignore` so agent worktrees can't be
  committed again.

## [1.2.0] — 2026-06-30

### Added

- **`server up --dashboard-port <port>`** — choose the host port the dashboard is
  published on. The choice is recorded in the deploy state, so `server update` and
  auto-update reuse it automatically (re-run `up --dashboard-port` to change it).
  Validated with teaching errors: a whole number from 1 to 65535, and not `3838`
  (the agent/MCP port). Only the *published* host port changes — the container
  still listens on 3000 internally, so the Dockerfile and healthcheck are untouched.

### Changed

- **`server up` now publishes the dashboard on `3042` by default (was `3000`).**
  3000 collides with almost every other Node/Next app on a dev box; 3042 is far
  less contended. **Existing servers are unaffected:** a deploy brought up before
  this release has its port pinned to `3000` in the deploy state, and `update` /
  auto-update keep it there — only a fresh `up` (or an explicit
  `up --dashboard-port`) uses the new default, so no running server's dashboard
  moves out from under its operator.

### Fixed

- **Manual-install docs: the Compose dashboard healthcheck now curls `:3839`**
  (was `:3000`). The Compose stack publishes the dashboard on `3839`, so the
  documented verification command failed against `:3000`.

## [1.1.4] — 2026-06-29

### Added

- **Generated reference appendix in the docs site** — five drift-guarded pages
  under `apps/docs` Reference, produced from canonical source by `pnpm docs:gen`:
  the seven MCP verbs (each parameter's name, type, required-ness, and human
  description), both CLIs (`librarian` and `the-librarian`, every command with
  flags), the shipped primer verbatim, the slash-command contract, and the
  harness capture matrix.
- **`pnpm check:docs` drift-guard** — regenerates the reference and diffs it
  against the committed pages, failing CI (after the build step) with the stale
  page and the fix command if a canonical source changed without regenerating.
- **Per-parameter descriptions on all seven MCP tools** — authored inline on each
  tool's input schema as the single source of truth for the reference, guarded so
  no parameter can ship undocumented.
- **Screenshot pipeline for the dashboard tour** — `pnpm docs:screenshots` drives
  the live, seeded dashboard with Playwright and captures one deterministic,
  secret-masked image per documented route; the dashboard-tour pages now show the
  real UI instead of placeholders. Images are committed (`.gitattributes`, not
  LFS) and a CI job re-captures them as an artifact.
- **In-dashboard "Docs" deep-link** — a contextual nav link that opens the docs
  page for the current screen. Dark until `NEXT_PUBLIC_DOCS_URL` is set at
  go-live, and guarded so a docs rename can't 404 a deep-link.

### Changed

- **`tools/list` strips per-parameter descriptions before sending** — the inline
  descriptions are docs-only; the agent-facing wire payload stays lean (this also
  removes the one inline description, on `search_references.query`, that was
  previously sent). The transmitted parameter names, types, and required-ness are
  unchanged.

## [1.1.3] — 2026-06-29

### Added

- **In-repo documentation site** (`apps/docs`, Astro + Starlight) — a prose-first,
  Reading Room–themed guide covering installation, first run, per-harness setup
  (Claude Code, Codex, OpenCode, Hermes, Pi), a dashboard tour, operating guides,
  and self-hosting. It builds in CI behind internal-link validation and a WCAG 2.1
  AA accessibility gate. (Public deployment — Cloudflare Pages + subdomain — to
  follow.)
- **"Docs are part of the change" definition of done** — a new rule in `AGENTS.md`,
  the PR template, and `CONTRIBUTING.md`: a user-facing change updates its docs in
  the same PR.

### Changed

- **`README.md` and `DEPLOYMENT.md` thinned** — their detailed operational prose now
  lives canonically in the docs site (single source). `README.md` keeps the pitch,
  the one-line install, and the harness table; `DEPLOYMENT.md` signposts the docs.

## [1.1.2] — 2026-06-29

### Fixed

- **Ingest-log + rate-limit retention (issue #423).** The capture log and the
  per-token rate buckets share the settings sidecar (read + rewritten wholesale
  per op) and grew without bound, making every capture — and the dashboard's
  Captures view — progressively more expensive (O(n²) over time). The ingest log
  now keeps only the **100 most-recent** attempts (pruned on write), and stale
  prior-day rate buckets are garbage-collected on each accepted capture (incl.
  revoked tokens'). Trade-off: URL dedup now spans only the last 100 captures —
  re-capturing an older URL files a fresh reference instead of overwriting it.

## [1.1.1] — 2026-06-29

### Added

- **Android capture recipe** on the dashboard "Connect a device" page — a working
  HTTP Shortcuts setup (POST `/ingest` with the capture token + a
  `{ "url": "…", "via": "android" }` body) so Android users can share pages into
  their vault, completing the mobile-capture story alongside the iOS Shortcut.

### Changed

- **New brand mark across all icons.** Regenerated the dashboard favicons + mobile
  / PWA icons (`favicon.svg`/`.ico`, `favicon-16/32/48`, `apple-touch-icon`,
  `android-chrome-192/512`, `maskable-192/512`, `mstile-150`) and the browser
  extension's icons from the concentric-rings Librarian mark (copper + verdigris).
  App-icon variants (apple-touch, maskable) render on the warm paper background,
  with maskable safe-zone padding.
- **The browser extension is now always the light "Manuscript" theme**, rather than
  following the OS dark mode.

### Fixed

- **Two flaky tests.** `git-ops.test.ts` — raised the file's test timeout
  (5s → 30s) so real `git` subprocess operations no longer spuriously time out
  under parallel-suite load. `ingest.test.ts` — the ingest-log "newest-first"
  assertion could tie when three rows shared a millisecond `created_at`; the
  seeded rows are now stamped apart so ordering is deterministic.
- **Connect page showed an unreachable server URL.** The Server URL field
  displayed the dashboard's *internal* view of the mcp-server (e.g.
  `http://127.0.0.1:3838`) — the right port but a loopback host no external
  capture client can reach. It now substitutes the host the admin actually
  reached the dashboard at (`window.location.hostname`) while keeping the
  mcp-server's port (the dashboard and server are separate ports, ADR 0001), and
  respects an explicitly-configured external `LIBRARIAN_PUBLIC_URL`. The field is
  now a read-only, copyable display (it's a deployment fact, not a dashboard
  setting) — set `LIBRARIAN_PUBLIC_URL` to override.
- **Stale iOS Shortcut caption** on the Connect page, left over from the SPIKE-B
  placeholder now that the Shortcut is published.

## [1.1.0] — 2026-06-28

### Added

- **Send references into your vault from the browser and your phone — no agent
  session required.** A new capture pipeline clips the page you're reading
  straight into your Librarian:
  - **`POST /ingest`** — a new public, capture-token-gated endpoint that accepts a
    pre-extracted article (`content`), a bare `url` the server fetches, or raw
    `text`, and writes a markdown reference to
    `vault/references/web/<date>-<slug>.md` with
    `title`/`source`/`captured_at`/`via`/`site`/`byline` frontmatter. Captures are
    async (202 + background write) and idempotent — re-capturing a URL overwrites
    its reference in place.
  - **Capture-scope tokens** — a new least-privilege token scope, minted from the
    dashboard, that reaches *only* `/ingest`. The auth seam enforces the wall both
    ways: a capture token can't reach the 7-verb `/mcp` surface, and an agent token
    can't reach `/ingest` (403). Each token gets a daily quota + burst limit (429).
  - **SSRF-guarded server fetch** — the `url` path resolves and validates every
    resolved IP (IPv4 + IPv6, including NAT64/6to4 and IPv4-mapped forms) against a
    deny-list, pins the socket to the validated address (no DNS-rebinding), with
    per-redirect-hop re-validation, a body-size cap, a `text/html` gate, and no
    credential forwarding. Extraction uses Defuddle.
  - **Ingest log** — every capture attempt is recorded; the dashboard surfaces
    failures with their (redacted) source for manual retry, and the log doubles as
    the normalized-URL → path dedup index.
  - **Chromium browser extension** (`clients/chromium-extension`, Chrome + Edge) —
    one-click clip of the current article, extracted client-side with Defuddle and
    posted to your server. "Reading Room" UI with the bundled brand typefaces.
  - **iOS Shortcut + dashboard "Connect a device" page** — mint a capture token,
    confirm your server URL, and install the share-sheet Shortcut from an iCloud
    link + QR code (the link carries no secret; setup is local to the device).
  - **Dashboard "Captures" panel** — review recent capture attempts and outcomes.

  Reference-ingest spec, decisions D1–D29 (in git history).

## [1.0.1] — 2026-06-28

### Changed

- **Build: TypeScript project references.** Added `composite` + `references`
  across the workspace tsconfigs and a root solution `tsconfig.json`, so
  cross-package `@librarian/*` imports resolve to source instead of each
  package's built `dist`. Editor and tooling navigation — go-to-definition,
  find-all-references, and rename — now traverses package boundaries; before,
  it stopped at `dist/*.d.ts` and silently omitted cross-package consumers
  (e.g. a `find-references` on a `@librarian/core` symbol missed its
  `mcp-server` usages). No source or runtime changes — `pnpm -r build`,
  `pnpm -r run typecheck`, `tsc -b`, and the package test suites stay green.

## [1.0.0] — 2026-06-21

First stable release. 🎉

The Librarian is a portable, agent-agnostic memory + handoff layer for AI coding
agents: durable cross-session memory with an LLM curator (intake + grooming),
cross-harness handoffs, a self-hosted MCP server, a Next.js admin dashboard, a
CLI, and integrations for Claude Code, Codex, Hermes, OpenCode, and Pi.

A no-change promotion of `1.0.0-rc.52` to a stable 1.0.0. The full path to 1.0 —
every feature, fix, and decision across the `rc.1`–`rc.52` series — is catalogued
in the entries below.

## [1.0.0-rc.52] — 2026-06-21

### Changed

- Replaced personal example data (names and a project name) and hardcoded
  personal home paths with neutral placeholders — across test fixtures, the
  curator prompt's example titles, design docs, and the write-guard test paths.
  No behavioural change or public-API change. The final candidate before 1.0.0.

## [1.0.0-rc.51] — 2026-06-20

### Added

- **Proposal review queue.** The dashboard `/proposals` page now tells you what
  each curator proposal actually does. Every proposal shows an **action badge**
  (New / Update / Replace / Merge / Split), the **source** it came from (intake or
  grooming) and the curator's **rationale** — and for a single-target replacement
  it shows the **old memory and the proposed new one with an old→new diff**
  (reusing the vault's diff view). Merge proposals list the memories they fold
  together; split replacements are grouped under their shared source. A low-confidence
  intake draft with no target is badged **"New — needs filing"** rather than
  implying a replacement it won't make.
- **`memories.proposalsForReview` admin query** backing the queue: it resolves each
  proposal's superseded targets and renders the server-side old→new diff. Admin-only
  (not exposed on the public listener); additive alongside the existing
  `list` / `approve` / `reject`.
- **`unifiedMemoryDiff` helper** in `@librarian/core` — renders an old→new unified
  diff (title + body) for a memory; `diff` (jsdiff) is now a direct dependency of
  `@librarian/core`.

### Changed

- **Grooming proposals now describe themselves.** A proposed grooming operation
  stamps `source`, `proposed_action`, and a redacted `rationale` into its
  `curator_note` (matching what intake already did), so the review surface can label
  and explain it without a separate lookup.

### Fixed

- **Approving a replacement no longer leaves a duplicate.** Approving a proposed
  `update` / `supersede` / `merge` now archives the memories it supersedes in the
  same step (idempotent; `split` excluded, since its source is retired only once all
  replacements are accepted). Previously the old and new memory were both left active.

## [1.0.0-rc.50] — 2026-06-20

### Added

- **`librarian server up --data-dir <path>`.** Self-host the vault in a host
  directory you choose, instead of the default Docker named volume — to back it
  up, put it on a specific disk, or move it between hosts. The directory is
  bind-mounted at `/data` and the container runs **as the directory's owner**
  (`--user uid:gid`), so the data stays owned by, and writable by, the operator
  rather than the image user. `server update` reuses it (persisted in the
  non-secret deploy-state), and `--data-dir` / `--data-volume` are mutually
  exclusive.

### Documentation

- The `@the-librarian/cli` npm README now documents the **server** command group
  (`server up` / `update` / …), not just the client-side `install`; the main
  README and DEPLOYMENT.md gain the `--data-dir` option.

## [1.0.0-rc.49] — 2026-06-20

### Added

- **Read-only view of the curator prompts.** The Curator cockpit now shows the
  base intake/grooming prompt — the static CORE + mode section the addendum
  augments — in a collapsed, read-only disclosure above the addendum editor, with
  the prompt version. Backed by a new admin-gated `addendum.getBasePrompt` tRPC
  query and an exported `buildBaseCuratorPrompt` core helper; a test asserts the
  view matches the system message the curator actually sends.

## [1.0.0-rc.48] — 2026-06-20

### Changed

- **`@the-librarian/cli` npm description** refreshed — it now states the CLI
  self-hosts the server and installs The Librarian into your agents (Claude Code,
  Codex, OpenCode, Hermes, Pi), rather than just a "cross-harness installer". The
  publish job stamps the root version into the package, so this ships on release.
- Main README: shorten the project-website link text to "Project site".

## [1.0.0-rc.47] — 2026-06-20

### Documentation

- **READMEs lead with the `librarian` CLI.** Each of the five integration
  READMEs (`integrations/{claude,codex,opencode,hermes,pi}`) now documents
  `npx @the-librarian/cli install` / `update` as the recommended path, with the
  manual configuration kept below it.
- **Accuracy fixes.** Claude: the `UserPromptSubmit` capture wiring is described
  as primary-plus-redundancy and Claude bug #29767 is noted as fixed in Claude
  Code 2.1.179. OpenCode: the manual setup now exports `LIBRARIAN_MCP_URL` (the
  auto-capture plugin reads it). Hermes and Pi note that the CLI covers them.
- **Main README:** add the project banner (`assets/The Librarian.png`), npm
  version + weekly-downloads badges, and a prominent link to the project website
  (<https://codeministry.net/the-librarian/>), surface `librarian update`, and
  trim duplicated configuration prose.

## [1.0.0-rc.46] — 2026-06-19

### Changed

- **Better retrieval ranking — `recall` and `search_references` now reward
  matching *all* your words, not just repeating one.** Two fixes to the shared
  hybrid ranker:
  - **BM25 keyword scoring** (was raw summed term-frequency). The old scorer had
    no IDF, no length normalisation, and no coverage, so a document that spammed
    one common query word outranked one that matched every query word. IDF now
    down-weights common terms, term-frequency saturates, and length is
    normalised.
  - **An exact-phrase signal** fused into the ranking (RRF): a document
    containing your query as a contiguous phrase gets a boost, ranked by how
    many times it occurs.

  Together these fix the observed case where `search_references "gentle coding"`
  ranked a doc that says *"coding"* thirteen times (and never *"gentle"*) above
  the doc that actually says *"gentle coding"*. Because the ranker is shared,
  `recall` gets the same improvement. No new dependency; the intake-eval quality
  gates are unchanged.

## [1.0.0-rc.45] — 2026-06-19

### Added

- **Vault page: pick where a file lands instead of typing the path.** The
  New-file dialog now has a folder picker — a combobox over the vault's existing
  directories (type to filter, click or keyboard-pick, or type a brand-new
  folder) — plus a filename field, so you choose a location without typing the
  whole vault-relative path or scanning the tree.

### Changed

- **The file view's "Rename" is now "Move".** The same dialog gains the folder
  picker and an editable filename, with a live preview of the resulting path: a
  folder change moves the file, a filename change renames it. Both still go
  through the wikilink-rewriting `git mv` (`vault.rename`), so behaviour is
  unchanged — only the affordance is clearer and no longer needs a hand-typed
  path.

## [1.0.0-rc.44] — 2026-06-19

### Added

- **Dashboard "References" tab — test the `search_references` verb from the
  admin UI.** A third tab on the Memories page (Browse · Recall · References)
  runs the agents' `search_references` retrieval verb against the live server
  vault and shows exactly what an agent receives: ranked hits with vault path
  (linking into the vault explorer), score, heading anchor, character range, and
  the matched section, plus a raw-JSON disclosure of the agent payload. The
  empty state tells **"no reference documents filed"** apart from **"filed, but
  none matched your query"** — so a query that returns nothing (e.g. a doc filed
  under a misspelt title, or missing from this server's vault) is diagnosable
  rather than a mystery. Backed by a new admin `vault.searchReferences` tRPC
  procedure that is a thin pass-through to the same `store.searchReferences` the
  MCP tool calls — parity pinned by test, so what the dashboard shows is what
  the agent sees.

### Fixed

- **The Memories → Recall tab now uses the same hybrid recall engine agents
  use.** It previously ran keyword-only `searchMemories`, while agents' `recall`
  MCP tool runs `store.recall` (keyword + vector + backlink graph, RRF-fused) —
  so the tab could surface a different set of memories, in a different order,
  than agents actually get, and the semantic signal never appeared. The tab now
  calls `store.recall` and exposes the agent's other knobs: an any-match `tags`
  filter and a result `limit`.

## [1.0.0-rc.43] — 2026-06-19

### Changed

- **Internal simplification follow-ups to the memory-field removals** — no
  behavior change beyond dead-code removal:
  - Dropped the always-empty `projects` aggregate from `getAggregates()` (the
    memory `project_key` it tallied is gone, and nothing consumed it).
  - Removed the dead `recordRecall` no-op seam (retired in D16): the
    `MemoryStore` method, its implementation, and its three call sites (the
    `recall` MCP tool, the tRPC recall handler, and `startContext`).
  - Dropped `project_key` from `startContext`'s input + the recall plumbing it fed.
  - Cleaned retired optional keys from the intake-eval fixture schema.
  - **Closed the store `Memory` type** — removed the `Record<string, unknown>`
    escape hatch (adding the genuinely-used `created_at`), so dead-field access
    and stale fixtures are now caught at build time. `getAggregates` /
    `distinctValues` / the list sort use narrow field unions instead of dynamic
    casts.

## [1.0.0-rc.42] — 2026-06-19

### Removed

- **Dropped three dead fields from the MEMORY model: `project_key`,
  `recall_count`, and `usefulness_score`.** None were ever meaningfully
  populated — `recall_count`/`usefulness_score` were always `0` (recall tracking
  was retired in D16; `recordRecall` is a no-op), and memory `project_key` was
  never auto-populated. Removed end-to-end: core schema/types/frontmatter, the
  markdown store (incl. the inert `usefulness_score` search-ranking term — the
  `FLAG_PENALTY` ranking is unchanged), the MCP `recall`/`remember` input schemas
  and the Pi adapter (in lockstep — the schema-parity drift-guard stays green),
  the curator prompt (bumped v5.2 → v5.3), and the dashboard (the memories
  project filter, the "rehome to project" path, and the project/score columns —
  rehome is now agent-only). Retired keys are swept from existing `memories/`
  vault docs by the data-dir migration.
- **Removed the memory `priority` field** (`low`/`normal`/`high`/`core`). Unlike
  the three above it was a *live* field, but it was rarely set and added noise to
  the agent + curator surfaces, so it's dropped for simplicity. Gone from the
  schema/types/frontmatter, the `remember` input (server `memoryInputSchema` + the
  Pi adapter, in lockstep), the curator prompt (bumped v5.3 → v5.4), the analytics
  "By priority" breakdown, and the dashboard "sort by priority" option; swept from
  existing `memories/` docs by the migration.

### Changed

- **Grooming now runs over a single global slice.** Memory `project_key`
  previously partitioned grooming into per-project slices; with the field gone,
  grooming consolidates the whole corpus as one `common_global` slice (it already
  did in practice, since no memory carried a project_key). The visibility-boundary
  guard is retained.
- **Recall ranking + sort simplified by the `priority` removal.** Recall no
  longer applies the `core`/`high` relevance bonus — it ranks by keyword
  relevance + the flag soft-demotion only — and "sort by priority" is gone (the
  memories list defaults to `updated_at`).

### Note

- **Handoff `project_key` is unchanged and fully retained** — it's a live filter
  for handoffs. Only the *memory* field was removed. (`CurationRun.project_key`
  is also kept; it's just always null now.)

## [1.0.0-rc.41] — 2026-06-18

### Changed

- **Analytics page rebuilt around data that actually exists.** It showed three
  current-snapshot tallies, one of which ("By project") is always empty because
  memory `project_key` is never populated. Now: top-line stat tiles (total
  memories, curator runs, input/output tokens), a new **Curator LLM usage**
  section (total tokens + completed-run count, broken down by model, from the
  grooming runs' recorded usage), and "By agent" / "By status" / "By priority"
  breakdowns. The dead "By project" dimension is gone. No "recalls over time" —
  recall tracking was retired in D16, so that data doesn't exist
  (`apps/dashboard/app/(memories)/analytics/page.tsx`).

## [1.0.0-rc.40] — 2026-06-18

### Changed

- **Docs now recommend `npx @the-librarian/cli` over a global install.** The CLI
  ships a `librarian` bin, so `npx @the-librarian/cli <cmd>` runs with no global
  install or sudo. README, DEPLOYMENT.md, and the installer-cli README now lead
  with npx and keep `npm i -g` as the optional "you'll run it often" path.

## [1.0.0-rc.39] — 2026-06-18

### Changed

- **Server auto-update settings moved to a new `/settings/dashboard` page.** They
  lived on `/settings/curator` (a curation-job page) but are an instance-level
  concern; the new "Dashboard" entry sits at the top of the settings nav.

### Fixed

- **The version status no longer reports "up to date" when a newer prerelease
  exists.** The dashboard's own semver comparator dropped the prerelease segment,
  so `rc.29` and `rc.33` both parsed to `[1,0,0]` and compared equal — the
  auto-update panel AND the menu-bar version badge (both route through
  `autoUpdateStatus`) falsely said "up to date". The comparator is now
  prerelease-aware (mirrors `installer-cli/src/semver.ts`), staying conservative:
  an unparseable version reads as "unknown", never a false "update available"
  (`apps/dashboard/components/curator/autoupdate-status.ts`).

## [1.0.0-rc.38] — 2026-06-18

### Fixed

- **CI: the Dashboard e2e (Playwright) job no longer flakes out on a timeout
  cancellation.** Its 15-minute budget had to cover install + workspace build +
  Playwright browser install *before* the suite even started, so a cold run
  routinely hit the cap and was cancelled mid-suite — surfacing as a flaky
  "cancelled" required check that blocked otherwise-green PRs and stalled
  auto-merge. Raised the job `timeout-minutes` to 30 (`.github/workflows/ci.yml`).

## [1.0.0-rc.37] — 2026-06-18

### Changed

- **Curator chat "Try asking" suggestions now match what the chat can actually
  do.** The prompts offered things the chat has no way to answer — it has no
  tools and no live data access (no inbox query, no run logs, no corpus search) —
  e.g. "What's in the inbox right now?" and "Why was the last grooming run
  skipped?". They're replaced with capability-aligned prompts chosen by context:
  questions about the grounded memory (and the merge/split/update proposals the
  chat can raise) when opened from a memory, and job-understanding / addendum
  drafting in the general chat (`apps/dashboard/components/curator/chat-panel.tsx`).

## [1.0.0-rc.36] — 2026-06-18

### Fixed

- **Vault history: the "Restore this version" button no longer appears on the
  latest version.** The current version is the head of the file's history, so
  there is nothing to restore it to — the action now shows only on older
  versions (`apps/dashboard/components/vault/file-history.tsx`).
- **Vault file tree now opens collapsed.** Directories rendered expanded by
  default; they now start collapsed and the user expands what they want. An
  active filter still force-opens directories so matches stay visible
  (`apps/dashboard/components/vault/file-tree.tsx`).
- **`/memories`: the mobile detail bottom-sheet no longer duplicates the
  desktop right rail.** The sheet is a Radix dialog that portals to `<body>`,
  so the `lg:hidden` wrapper never reached it and an open dialog kept trapping
  focus on desktop. Its `open` state is now gated on the `lg` breakpoint in JS
  via a new `useMediaQuery` hook, so on desktop only the Inspector rail shows
  (`apps/dashboard/components/memories/view.tsx`, `apps/dashboard/hooks/use-media-query.ts`).

## [1.0.0-rc.35] — 2026-06-18

### Fixed

- **`librarian install` now wires the Codex/OpenCode/Hermes capture adapters on
  non-GNU tar (macOS), not just on Linux.** The installer fetches each adapter from
  the pinned release tarball and extracted one subtree with
  `tar --strip-components=N --wildcards '*/integrations/<harness>/*'`. `--wildcards`
  is a GNU-tar-only flag: BSD/libarchive tar (the `/usr/bin/tar` on macOS) rejects it
  outright (`tar: Option --wildcards is not supported`) and busybox tar lacks it too,
  so those three harnesses failed to install on every non-GNU box
  (`Failed to extract <Harness> capture adapter: …`). Extraction now uses only the
  universally-supported `-xzf`/`-C` flags and locates the wanted subtree on the
  filesystem (new `packages/installer-cli/src/archive.ts`), with no tar-flavour
  detection. Regression test round-trips a real codeload-shaped tarball through the
  host `tar` and pins that the invocation carries none of the GNU-only flags.

## [1.0.0-rc.34] — 2026-06-18

### Fixed

- **Harness version labels now track the CLI version, so `librarian status`/`update`
  tell the truth.** OpenCode's managed marker and the Hermes adapter's `plugin.yaml`
  were hardcoded to a static `1.0.0`, and Pi's `package.json` was pinned at a stale
  `1.0.0-rc.2` — so `librarian update` reported "already at 1.0.0" after a real update,
  and `librarian status` showed `UPDATE? no` against a newer pre-release (semver ranks
  `1.0.0` above `1.0.0-rc.N`, so the static label looked newer than latest). Now:
  - **OpenCode** stamps `cliVersion()` into its managed `_librarianVersion` marker
    (instead of the `"1.0.0"` constant).
  - **Hermes** stamps the installed `plugin.yaml` from `cliVersion()` at install time
    (the git-tag-fetched source value is a placeholder); detect reads it back.
  - **Pi** — `stamp-version.mjs` now also syncs the public `integrations/pi/package.json`
    (`@the-librarian/pi-extension`) to the root version, and it's bumped from the stale
    `rc.2` to `rc.34`.

  The plugin *content* always updated on `librarian update`; only the version labels were
  frozen — they now move with each release.

## [1.0.0-rc.33] — 2026-06-17

### Changed

- **The Claude `SessionStart` banner now reflects whether THIS client is actually
  shipping**, not just the server's intake gate. `buildBanner` takes an optional
  `shipping` probe (new `probeShipping`): when the server gate is on but the resolved
  `$CLAUDE_PLUGIN_DATA` shows the client has never shipped (no capture cursors), the
  banner cautions and points at the cursors dir instead of claiming "Automatic capture
  is active" — the false-positive that masked a non-firing per-turn hook for hours on
  2026-06-17. Backward compatible: omitting `shipping` keeps the prior line (existing
  callers/tests unchanged).

### Fixed

- **Corrected the stale `on-stop.mjs` rationale.** Its header claimed plugin-scoped
  `Stop` hooks never fire (Claude Code bug #29767), which drove the `Stop` →
  `UserPromptSubmit` switch. As of Claude Code 2.1.179 (verified 2026-06-17 with an
  isolated single-purpose probe plugin) plugin-scoped `UserPromptSubmit` **and** `Stop`
  both fire reliably — wiring all three is sound redundancy, not a #29767 workaround.
  The capture failure that looked like a non-firing hook was a data-dir mismatch (live
  hooks write under `$CLAUDE_PLUGIN_DATA`, not the manual-run fallback).

## [1.0.0-rc.32] — 2026-06-17

### Fixed

- **Grooming no longer times out on the global (unscoped) slice.** A curation run
  now splits its evidence into bounded sub-batches — one `complete()` call each,
  `chunkSize` memories per call (default 30) — instead of sending the whole slice
  in a single call. Past ~80 unscoped memories the single call exceeded the 60s LLM
  timeout (`llm_timeout`, observed in production) and the entire unscoped
  consolidation failed and never made progress as the set grew; it now drains
  across bounded calls. Each chunk is fail-soft: one chunk's timeout no longer
  fails the whole run. A slice at/under the bound is a single chunk == the prior
  behavior. Spec: `docs/specs/2026-06-17-global-slice-consolidation-chunking.md`.
  Follow-ups (deferred): an operator-configurable `curator.grooming.chunk_size`
  setting + per-chunk run records in the dashboard.

## [1.0.0-rc.31] — 2026-06-17

### Added

- **Automatic capture for Pi and Hermes** (Phase 2B, spec
  `docs/specs/2026-06-17-harness-capture-phase-2b-spike-gated.md`). Completes per-turn
  `POST /transcript` capture across all five harnesses — each a thin acquisition adapter over
  the **unchanged** server pipeline, zero agent memory calls:
  - **Hermes** (Python) — **spike runtime-confirmed**: the installed Hermes agent still fires
    `sync_turn(user, assistant, *, session_id, messages)` per completed turn
    (`turn_finalizer` → `MemoryManager.sync_all`). The adapter un-retires `sync_turn`, posts the
    delta via the existing authenticated client, keys `conv_id` by `session_id`, and uses an
    **exchange-granular** private skip (a marker anywhere in the user+assistant pair drops the
    whole exchange). Best-verified of Phase 2 alongside Claude.
  - **Pi** (TS extension) — captures on the `agent_end` event (completed `AgentMessage[]`
    in-payload, prose blocks only), `conv_id = ctx.sessionManager.getSessionId()`. Confirmed
    against `@earendil-works/pi-coding-agent@0.75.5` types; the `agent_end`-vs-`turn_end` choice
    is the one optimistic assumption (fail-safe to a no-op on an unexpected shape).
  - Both honor the shared contract: forward-only private skip, the `LIBRARIAN_AUTO_SAVE=false`
    kill-switch, the server-authoritative intake gate, fail-soft, advance-on-ack idempotency.
  - **Honest status:** Hermes's per-turn hook is confirmed on the live agent; Pi's is confirmed
    from SDK types but not against a running Pi (no `pi` CLI at build time). A live server
    round-trip is deferred for both. See the
    [capability matrix](docs/harness-capture-capability.md).

### Changed

- **Capability matrix:** Pi and Hermes move from *feasible* to *ported* (Hermes
  spike-runtime-confirmed; Pi e2e-pending), completing the Phase 2 sweep of the matrix.

## [1.0.0-rc.30] — 2026-06-17

### Added

- **Automatic capture for Codex and OpenCode** (Phase 2A, spec
  `docs/specs/2026-06-17-harness-capture-phase-2a-proven-ports.md`). Extends the per-turn
  `POST /transcript` capture from Claude to two more harnesses — each a thin acquisition
  adapter over the **unchanged** server pipeline, so memories flow without the agent making
  any memory calls:
  - **Codex** reuses the Claude adapter (`on-stop.mjs` + `lib/*`) on the same
    `UserPromptSubmit` (primary) / `Stop` / `SessionEnd` hook events, installed by merging
    into `~/.codex/hooks.json` (owner-marker idempotent; surfaces the `codex_hooks = true`
    requirement). `conv_id` is keyed `session_id` → transcript-filename → no-op, **never
    `cwd` / `$USER`**.
  - **OpenCode** ships a `chat.message` TS plugin (`@opencode-ai/plugin`) that builds each
    turn's delta from the full message list, keyed by `sessionID`, wired through
    `librarian install`.
  - Both honor the shared contract: forward-only private-mode skip, the
    `LIBRARIAN_AUTO_SAVE=false` kill-switch, the server-authoritative intake gate, fail-soft,
    and advance-on-ack idempotency.
  - **Honest status:** built optimistically against mem0's shipping plugin; end-to-end
    verification against a live Codex / OpenCode runtime is **pending** (neither CLI was
    available at build time). See the
    [capability matrix](docs/harness-capture-capability.md).

### Changed

- **Harness-capture capability matrix re-grounded** against mem0's shipping plugin: Codex
  moves from *blocked* to *ported (e2e-pending)*, OpenCode from *feasible-with-caveats
  (idle-bracketing)* to *ported via `chat.message` (e2e-pending)*, and **Claude Cowork** is
  added as *blocked-on-verification* (shares the Claude plugin host; desktop hook-firing not
  yet confirmed). The Claude README gains a Cowork desktop GUI-install section and the
  desktop env-var gotcha.

## [1.0.0-rc.29] — 2026-06-17

### Added

- **Server auto-update** (spec `docs/specs/2026-06-16-server-autoupdate.md`). Keep a
  self-hosted Librarian current automatically, configurable from the **CLI** and the
  **dashboard**. `librarian server autoupdate <enable|disable|uninstall|status>`
  installs a host systemd timer (cron fallback) that runs a gated `--run` wrapper —
  it updates only when enabled, the cadence (`daily`/`weekly`) is due, **and** the
  server is reachable, reusing `server update`'s health-check + rollback and
  serialized by a host lock so fires can never overlap and leave the server down. The
  dashboard (Settings → Curator → **Server auto-update**) toggles the same
  `server.autoupdate.*` settings via a new admin `autoupdate` tRPC router — so it
  configures auto-update **without ever holding host/docker access** (the container
  can't manage its own host).

## [1.0.0-rc.28] — 2026-06-16

### Fixed

- **Quieter intake sweeps.** The inbox sweep no longer records a run entry (the source
  of dashboard/log noise) when it processed **0 memories** — an empty-inbox no-op is
  silent. A run is recorded only when ≥1 inbox item was actually handled
  (applied/proposed/skipped/rejected, a judge error, or a thrown error). The sweep
  cadence is unchanged — the last-sweep timestamp still advances on an empty pass, and
  genuine errors are still logged.

## [1.0.0-rc.27] — 2026-06-16

### Fixed

- **Auto-capture now actually fires (Claude `Stop`-hook bug workaround).** Claude Code
  doesn't fire plugin-scoped `Stop` hooks
  ([#29767](https://github.com/anthropics/claude-code/issues/29767)) — they register
  but never execute — so the capture adapter never ran on real turns. Capture is now
  driven by **`UserPromptSubmit`** (which fires from plugins); `Stop`/`SessionEnd` are
  kept as supplementary triggers so capture self-heals when the upstream bug is fixed
  (the cursor's advance-on-ack makes firing on multiple events idempotent).

## [1.0.0-rc.26] — 2026-06-16

### Fixed

- **Claude plugin updates now actually propagate.** Dropped the explicit `version`
  field from the Claude plugin manifest (`integrations/claude/.claude-plugin/plugin.json`)
  and the marketplace entry (`.claude-plugin/marketplace.json`), so Claude Code
  versions the plugin by **git commit SHA** — every merge auto-updates instead of
  being pinned to a stale `version` string (the rc.25 capture hooks were unreachable
  because the manifest still declared `rc.1`). Refreshed the manifest descriptions to
  reflect the automatic-capture + awareness hooks. Users update with
  `claude plugin marketplace update the-librarian` → `claude plugin install` →
  `/reload-plugins`.

## [1.0.0-rc.25] — 2026-06-16

### Added

- **Harness auto-capture — Claude Code adapter + awareness** (spec
  `2026-06-16-harness-auto-capture`, T3–T6). The Claude plugin now ships hooks: a
  `Stop`/`SessionEnd` **adapter** that tails the session transcript from a per-session
  byte cursor, skips `[librarian:private=on]` turns, and POSTs deltas to
  `POST /transcript` (advance-only-on-ack, bounded window, fully fail-soft — never
  blocks the turn); a `PreToolUse` **write-block** redirecting native
  `.claude/**/memory/**` writes to `remember`; and a `SessionStart` **banner**
  surfacing capture status (warns when the intake gate or `LIBRARIAN_AUTO_SAVE` is
  off). Sharpened the server-sourced primer's recall awareness and added a `capture`
  field to `GET /healthz`. Docs: a per-harness capability matrix + the default-on /
  kill-switch / private-skip contract.

### Fixed

- **HTTP server hardening:** `createHttpServer` now guards `req`/`res`/`clientError`
  and connection socket errors, so a client disconnecting mid-response can no longer
  surface an unhandled `EPIPE` that crashes the server process.

## [1.0.0-rc.24] — 2026-06-16

### Added

- **Harness auto-capture — server pipeline** (spec `2026-06-16-harness-auto-capture`,
  T1–T2). A new agent-token-authed **`POST /transcript`** endpoint accepts per-turn
  conversation deltas, **redacts secrets on intake**, drops `[librarian:private=on]`
  turns, and appends to a per-conversation sidecar buffer **outside the git vault**. A
  background **settle-sweep** worker (idle / explicit-end / size-cap) atomically claims
  each settled buffer, makes one extractor LLM pass into discrete candidate facts,
  re-redacts each, and feeds them through the **existing** inbox→curator pipeline
  (confidence bands), then deletes the buffer. Self-gates on `curator.intake.enabled`.
  This is the server half of automatic Librarian capture; the Claude Code adapter
  (the `Stop` hook that feeds it), awareness banner, and narrow write-block follow.
- New env vars: `LIBRARIAN_TRANSCRIPT_SWEEP_TICK_MS` (default 5 min),
  `LIBRARIAN_TRANSCRIPT_IDLE_MS` (30 min), `LIBRARIAN_TRANSCRIPT_MAX_BYTES` (5 MB).

## [1.0.0-rc.23] — 2026-06-16

Docs only — no shipped code, so the published `@the-librarian/cli` is unchanged.

### Added

- **ADR 0009 — make Librarian use automatic at the harness boundary**
  (`docs/adr/0009-integration-enforced-librarian-use.md`): the primary lever for
  agent adoption is automatic harness-driven capture + awareness injection, with a
  narrow native-`MEMORY.md` write-block as a supplement — not a broad file-write veto.
- **Spec `docs/specs/2026-06-16-harness-auto-capture.md`** — Claude-Code-first design
  for automatic per-turn transcript capture into the existing inbox→curator engine,
  awareness injection, and the narrow write-block, behind a uniform per-harness
  server contract. Reuses the curator as the extraction engine; default-on,
  private-mode gated, `LIBRARIAN_AUTO_SAVE=false` kill-switch. Grounded vs rc.22.

## [1.0.0-rc.22] — 2026-06-16

A cluster of `librarian server` / admin-CLI fixes surfaced by a real LXC +
snap-docker → native-docker host migration. See
`docs/specs/2026-06-15-server-cli-hardening.md`.

### Fixed

- **The admin CLI can now read encrypted settings.** `the-librarian` built its
  store with no master key, so it could not decrypt secret settings — `restore`
  reported a false `No backup remote configured` on a dashboard-configured deploy
  (the encrypted `backup.github.token` read was swallowed). It now resolves the key
  (env → `<dataDir>/secret.key`, never generating one); a malformed key degrades to
  keyless instead of crashing every command.
- **`server up` no longer re-mints the master key.** It minted a fresh key on every
  run, orphaning every secret encrypted under the previous one (curator token,
  backup PAT). `up` now reuses an existing `deploy.env` key and only mints on a
  first deploy.
- **`server admin` no longer fails with "the input device is not a TTY".** Its
  runner ignores stdin, so the old `-it` could never deliver a working prompt.
  Interactive verbs now use an inherited-stdio exec (a real TTY); non-interactive —
  including when `--secret-key` is supplied — runs without `-t`.
- **The dashboard can restore into a fresh deployment.** The Restore button was
  gated on local successful-run history, so a new deployment restoring from an
  existing remote (a host migration) could never enable it. It now gates on a
  resolvable remote (`backup.config.canRestore`).
- **`server up` detects the snap-docker health-read failure.** Snap docker does not
  emit stdout to a non-TTY pipe, so health/log capture came back empty → a false
  health timeout that rolled back a running container. `up` now raises a teaching
  error naming the cause instead of the cryptic "(no log output captured)".
- **`server up` now shows progress.** A multi-minute `up` was a blank line with no
  sense of what was happening. It now prints numbered phase messages
  (`[1/5]…[5/5]`) and **streams the slow image build live** (base-image pull, deps
  install, embeddings-model download), so you can see where it is and what remains.

### Changed

- README + DEPLOYMENT document that `librarian server` requires **native Docker**
  (snap docker is unsupported — hidden-dir build context + non-TTY-pipe stdout), and
  reconcile the master-key externalization recipe with the actual reuse/rotation
  behavior.

## [1.0.0-rc.21] — 2026-06-15

Two release-plumbing fixes for `librarian server`.

### Fixed

- **`librarian server up` / `update` no longer fail at the git checkout step.**
  The deploy-dir checkout passed the ref after `--end-of-options`, but
  `git checkout` does **not** honor that marker — it reads it as a pathspec
  (`error: pathspec '--end-of-options' did not match`, reproduced on git 2.43) —
  so `up`/`update` aborted before building the image. The ref is now resolved to
  a commit SHA via `git rev-parse --end-of-options` (which *does* honor it, so
  the S-1 anti-injection guard is preserved) and that SHA is checked out. Covered
  by a real-git regression test — the existing suites mock the git runner, so by
  construction they could not catch this.
- **npm auto-publish unstuck.** `@the-librarian/cli` is published from
  `packages/installer-cli`, whose version had drifted (frozen at `1.0.0-rc.5`)
  while the root advanced — so the publish step kept seeing a version already on
  npm and silently no-op'd, freezing npm at rc.5 while GitHub releases reached
  rc.20. The Release workflow now stamps the root version into every public
  workspace package before publishing.
- **Hermes adapter pin no longer drifts.** `PINNED_REF` (the tag the Hermes
  adapter is fetched from) was a hardcoded `v1.0.0-rc.5`; it now derives from the
  CLI's own version so it tracks the published tag automatically. It had only
  stayed green because `installer-cli` was frozen at that same rc.5.

### Added

- **`scripts/stamp-version.mjs`** (also `pnpm sync:versions`) — stamps the root
  version into every public workspace package, keeping the published
  `@the-librarian/cli` version in lockstep with the root (and an honest
  `librarian --version` for source builds). Private packages stay pinned at
  `0.0.0`.

## [1.0.0-rc.20] — 2026-06-15

The vault activity feed becomes an accordion: each commit row
expands in place to show the per-file diffs that commit introduced,
instead of just naming the files it touched. Same shape as the
per-file history accordion on the vault file view, but commit-scoped
— one fetch returns the whole commit's diff, lazy-loaded on expand.

### Added

- **`GitHistory.commitDiff(hash)`** in `packages/core` returns the
  per-file diffs for a single vault commit as a structured
  `CommitDiff` (`{ hash, files: [{ path, status, fromPath?, diff }] }`).
  One `git show -M --pretty=format:` under the hood; sections split
  on the `diff --git` header; status (added / modified / deleted /
  renamed) is derived from the section's metadata.
- **`store.vaultCommitDiff(hash)`** on `LibrarianStore` thin-wraps
  it for the dashboard.
- **`vault.commitDiff` tRPC procedure** (admin) on the activity
  router — `{ hash } → CommitDiff`.
- **`commitDiffAction({ hash })`** server action in the dashboard
  for the accordion's lazy-load on expand.
- **`<DiffView>` extracted** to `components/vault/diff-view.tsx` so
  the activity feed and the per-file history accordion render diffs
  through the same primitive. Editorial palette: verdigris wash for
  additions, red-ochre wash for deletions, foreground/55 for hunk
  markers and headers (swapped from the emerald/red/sky Tailwind
  defaults). `file-history.tsx` re-exports `DiffView` under the
  original name for backwards-compat with existing tests.

### Changed

- **`/activity` ActivityFeed** rebuilt as an accordion. Each commit
  row gains a chevron toggle; expand lazy-loads the commit's diff
  via `commitDiffAction` and renders each file as a SectionLabel +
  path header followed by the editorial `<DiffView>`. The inline
  file-list stays under the subject line so the at-a-glance "which
  files" answer is preserved.
- **`/settings/primer`** drops the page-level "Settings" heading +
  byline. The Settings dropdown in the top nav carries the
  cross-page context; the form's own Primer heading + subtitle says
  the rest. Removes the duplicate-context noise.

## [1.0.0-rc.19] — 2026-06-15

### Fixed

- **Flaky teardown** in `packages/core` `intake-grooming-trigger`
  tests. The markdown backend's git operations occasionally left a
  transient handle inside `.git/`, which caused
  `fs.rmSync(dataDir, { recursive: true, force: true })` in the
  `afterEach` to fail with `ENOTEMPTY: rmdir … vault/.git`.
  `force` only swallows `ENOENT`, not `ENOTEMPTY`, so add the
  node-builtin retry loop (`maxRetries: 5, retryDelay: 50`) to
  ride out the race.

## [1.0.0-rc.18] — 2026-06-15

Dashboard redesign Phase 4 — every remaining shadcn-era surface
moves onto the rc.16 editorial system. After this PR the dashboard
reads editorial end-to-end: no `rounded-md bg-card` cards, no
`text-muted-foreground` labels, no `bg-primary` buttons, no
off-palette status colours. The visual debt the earlier phases
scoped down to "the one-offs" is closed.

### Added

- **`<Select>` primitive** (`components/ui-v2/select.tsx`). Wraps a
  real `<select>` so screen reader, keyboard, and mobile pickers
  all behave; renders a visible chevron + hairline divider as a
  `pointer-events-none` overlay so clicks still hit the native
  control. Variants: `default` (h-9) and `compact` (h-8). Every
  native `<select>` on the dashboard now goes through it.
- **`<CuratorTabs>` shell** (`components/curator/tabs-shell.tsx`).
  Client wrapper around the editorial `Tabs` primitive so the
  server-rendered /settings/curator page can split Intake / Grooming
  into tabbed panels without going client-component itself.
- **`humaniseAction` helper** (`components/curator/humanise-action.ts`).
  Translates a `ProposedAction` (merge / split / update / unmerge)
  into a plain-English intent gloss + a destructive verdict — used
  by the rebuilt ProposedActionCard.

### Changed

- **`/curator` rebuilt onto the editorial system.** Bubble chat
  swaps for a typographic transcript (role marker as SectionLabel,
  body in Newsreader prose, hairline dividers). ProposedActionCard
  leads with the human intent line and hides the JSON behind a
  `<details>` disclosure; Confirm wears the destructive variant for
  irreversible actions, primary otherwise; a Skip greys the
  proposal out. Empty conversation renders three job-aware example
  prompts. Live 2 KB byte counter under the addendum textarea
  disables Commit when over the cap. Session strip with the job
  picker + "Conversations aren't saved" notice; the Roll-back
  addendum control moves into the workspace footer with its own
  inline confirm.
- **`/settings/curator` rebuilt with Tabs IA.** Three-deep card
  nesting flattens to one bordered providers list + a Tabs surface
  (Intake / Grooming) holding each job's Enablement & schedule,
  Model, and Recent runs. **P0 safety fix: Delete provider** now
  opens an inline confirm row with a "Used by Intake/Grooming —
  they will lose their model" warning when the provider is
  referenced; the unguarded one-click delete is gone. Verdigris
  "Token set" Pill replaces text-green-600; foreground/55 "No
  token" replaces text-amber-600. Run-now button auto-clears
  results after 5s and routes errors to the red-ochre alert
  callout. Both runs tables migrate to ui-v2 Table; Intake table
  swaps ASCII chevrons for SVG and uses the brand palette for
  outcome cells.
- **`/settings/backups` rebuilt + hardened.** Three-deep nested
  cards flatten; the redundant BackupConfigSummary is dropped (the
  form's live field state IS the summary). Health strip uses the
  StatusStrip pattern. Backup-now mirrors the curator Run-now.
  RestartPrompt becomes a copper hairline + tint callout (the
  "important but not destructive" tier) with a destructive
  Restart-now. Restore opens an inline confirm with a destructive
  Confirm. Harden pass closes three flow gaps: Enable-scheduled-
  backups toggle disables until a GitHub repo is entered (and
  flips back to off if the repo is un-configured while enabled,
  so the saved state can't re-enable an un-configured destination);
  Restore is disabled until at least one successful backup exists
  with a tooltip; first-run Health strip branches on
  `config.github.repo` ("Configure a GitHub remote below" vs
  "Click Backup now below"). Plus run-interval + webhook hints
  and a tightened subtitle.
- **`/handoffs/[id]` rebuilt.** Page header gets a back-arrow link
  to /handoffs above a truncating Fraunces h1 with the claim-status
  Pill on the right. Esc navigates back. Document body swaps the
  `<pre>` dump for `<MarkdownContent>` from the vault — the 5
  schema-required headings (Start & intent / Journey / Current
  state / What's left / Open questions) typeset as proper h2s on
  the Reading-Room ramp instead of literal `## ...` markers.
  Sidebar moves to a hairline + ink-surface frame with humanised
  SectionLabel labels and a copy-to-clipboard button next to the
  Handoff ID. Loading uses the MemoryOrb pulse; errors land in the
  red-ochre alert; not-found has an inline link back to /handoffs.
- **`/analytics` rebuilt.** Three identical
  `rounded-md border bg-card` DimensionCards in `lg:grid-cols-2`
  (the project's absolute-banned "identical card grids" pattern)
  collapse into one bordered surface with three hairline-separated
  dimension sections. Bars become 2px sharp-corner tracks with
  ink-accent fill — data-ink hairlines, not chart chrome.
  Singleton dimensions drop the trivial `100%` tail; truncated
  slice values get a `title` attribute; counts use
  `toLocaleString`. Subtitle added.
- **`/activity` rebuilt.** Back-arrow header. Per-row cards collapse
  into one bordered container with hairline-separated commit rows.
  Provenance Pills swap the off-palette sky/violet/emerald defaults
  for the brand palette (verdigris accent for curator, sage muted
  for admin, neutral mono for the rest). RestoreVaultDialog's
  Restore wears the destructive variant; Cancel is outline;
  Confirmation input uses SectionLabel + label-htmlFor.
- **`SiteNav` polished.** Desktop active tab gets a verdigris
  bottom-underline matching the Tabs primitive vocabulary used
  inside pages; drops the rounded-pill + shadow chrome. Mobile
  drawer rows wear the verdigris wash matching the dropdown's
  child-active treatment. Nav root: `bg-ink-surface` +
  `border-ink-hairline` (was `bg-muted/20` + uncoloured border).
  Mobile Settings heading uses SectionLabel with a hairline
  divider above. Settings dropdown panel drops the shadow-blur for
  hairline-only depth — depth via line, not blur.
- **`VersionBadge` polished.** Status dots map onto the brand
  palette: verdigris (up_to_date), copper (behind), outlined
  (loading / unknown). Drops rounded-md + hover-border chrome.
- **`Dialog` primitive polished.** Overlay tint swaps `bg-black/50`
  for `bg-foreground/40` so the scrim takes the ink-hue. Both
  overlay and content panel respect `prefers-reduced-motion`.

### Removed

- `components/curator/config-summary.tsx` (redundant — the live
  config form fields ARE the current state).
- The rendering side of `components/backups/config-summary.tsx`
  (reduced to a type-only export — the live summary it rendered
  was redundant with the form's own state and the new Health
  strip).

## [1.0.0-rc.17] — 2026-06-15

Dashboard redesign Phase 3 — the three form-shaped surfaces
(`/settings/auth`, `/settings/primer`, `/login`) move onto the
rc.16 editorial system, and the configuration routes regroup
under a new **Settings** dropdown in the top nav (no more
sibling top-level tabs for Backups / Tokens / Auth). The
homepage flips from Memories to Vault, the hamburger
breakpoint bumps to 930px, and `/curator` splits chat from
configuration.

### Added

- **`/settings/auth` rebuild.** Five stacked rounded cards
  collapse into one page with two numbered sections:
  Status strip → Step 1 Sign-in methods (Password ↔
  tabbed OAuth providers) → Step 2 Enforcement (admin-token
  gate with destructive Pause break-glass). New
  `<StatusStrip>`, `<SignInMethods>`, `<EnforcementSection>`
  primitives; `EnableCard` + `MethodsPanel` absorbed and
  deleted. The form layout previously read like a
  generic shadcn dashboard — it now sits inside the
  editorial system with the same chrome as every other
  surface.
- **`<LibrarianMark>` on `/login` + `/settings/auth/reset`.**
  The brand mark (rail size) above the heading on the two
  chrome-free unauthenticated landings. These pages are the
  first thing a new operator sees and used to be text-only.
- **OR divider on `/login`** between the password form and
  OAuth buttons when both are configured — the alternatives
  read visually as alternatives, not a stacked sequence.
- **Settings dropdown in `SiteNav`.** A single
  `Settings ▾` trigger replaces four top-level tabs (Backups,
  Tokens, Settings, Auth); the dropdown lists the 5 children
  in setup-flow order (Auth → Primer → Curator → Tokens →
  Backups). Closes on outside-click, Escape, or route change.
- **Mobile hamburger drawer**: same children grouped under a
  `Settings` section heading.
- **`/settings/curator`**: the LLM provider manager + Intake
  and Grooming config/runs sections lift out of `/curator`,
  which now hosts the chat workspace + a "Configure curator
  →" link.
- **`G V` keyboard shortcut** for Vault, alongside the
  existing `G M` (now → /memories) and `G H` shortcuts.

### Changed

- **P0 a11y fix across every form on every Phase 3 surface.**
  Real `<label htmlFor>` (via `SectionLabel as="label"`) on
  Password, OAuth GitHub, OAuth Google, Reset Password,
  Admin Token, Login Username, Login Password, Awareness
  Primer textarea. The previous placeholder-as-only-label
  pattern failed WCAG 1.3.1 / 3.3.2.
- **Error treatment standardised** to the red-ochre alert
  callout (`border-destructive/40 bg-destructive/[0.06]
  text-destructive`) on every Phase 3 surface; success
  states wear the verdigris callout. The earlier
  `text-ink-accent` (verdigris rubric) errors collided with
  the positive-action vocabulary established in rc.15.
- **`/settings/auth` admin-token field clears + refocuses on
  Enable failure.** A wrong/typo'd token shouldn't sit
  visible on screen.
- **`/settings/auth` Disable → Pause copy.** "Pause
  authentication" is more accurate — methods stay configured
  and can be re-enabled any time.
- **`/settings/auth` page chrome.** Left-aligned full-width
  layout matching the table-route canon (was a centered
  `max-w-2xl` form-shaped page).
- **`/settings` rebuild.** AwarenessPrimerForm drops the
  rounded-md card chrome (no nested cards when the page IS
  the form's container), switches to the editorial
  bottom-hairline textarea frame with `bg-ink-mono-fill`
  matching the new-memory form. Save status auto-clears on
  edit + dismisses after 5 seconds.
- **`/login` and `/settings/auth/reset` page chrome.** Editorial
  error and success callouts; verbose `text-ink-accent`
  errors gone.

### Moved

- **Route shape regrouped under `/settings/*`:**
  - `/tokens` → `/settings/tokens`
  - `/backups` → `/settings/backups`
  - `/settings` (primer) → `/settings/primer`
  - new `/settings/curator` (lifted from `/curator`)
  - There is no `/settings` route — Settings is a menu trigger,
    not a destination. Hard break; no redirects from old paths.
- **Vault is the dashboard homepage.**
  - `/vault` → `/`
  - `/vault/activity` → `/activity`
  - `/` (Memories) → `/memories`
  - Vault wikilinks, file-tree links, file-view router pushes,
    and `revalidatePath` calls in vault server actions all
    migrate from `/vault?path=` to `/?path=`. The Memories
    command-palette entry now points at `/memories?selected=`
    and the `G M` shortcut navigates to `/memories`.
- **Top nav reorder.** Vault and Curator move to the start
  (highest-frequency operator surfaces). Memories sits with
  the other list-shaped "corpus state" tabs to their right.
- **Hamburger breakpoint** bumped from `md` (768 px) to
  `min-[930px]:` so the full nine-tab bar + the Settings
  dropdown + the right-rail controls all fit at desktop
  widths before collapsing.

### Removed

- `components/settings/auth/enable-card.tsx` (absorbed into
  `<EnforcementSection>`).
- `components/settings/auth/methods-panel.tsx` (absorbed
  into the Status strip + `<EnforcementSection>` disable
  flow).
- Their test files (replaced by `enforcement-section.test.tsx`
  and `status-strip.test.tsx`).

## [1.0.0-rc.16] — 2026-06-15

Dashboard redesign Phase 2 — the six table-shaped routes (Memories,
Proposals, Flagged, Archive, Handoffs, Tokens) migrate onto the
rc.15 editorial system. Memories is the pattern setter (Tabs, chip-
row filter, right-rail Inspector, mobile bottom sheet, keyboard
shortcuts, skeleton loading, empty-state branches); the five
siblings inherit `<MemoryCard>` (extracted in the same PR) and
the standalone-table chrome patterns. The dashboard now reads as
one continuous product across every list surface.

### Added

- **`<MemoryCard>` primitive** (`components/memories/memory-card.tsx`).
  Canonical row used by Memories list / Proposals queue / Flagged
  queue / Archive list. Four near-identical inline implementations
  collapse to one source of truth; polish updates the chrome here
  and all four surfaces inherit. Hairline border + sharp + paper-
  surface + verdigris-wash + copper structural marker on selected,
  matching the vault tree row vocabulary.

- **`<FilterChips>` orchestrator** (`components/memories/filter-chips.tsx`).
  Replaces the legacy 280 px filter sidebar with a single chip row.
  Active chips show value + remove handle; outlined "add chip"
  triggers open inline popover pickers (select with search +
  optional groups, native date input). `maxVisible` is optional —
  no collapse by default so surfaces with a fixed handful of
  dimensions render all of them; opt in for surfaces with many.
  No Radix Popover dep, just `useClickOutside` + absolute
  positioning. Generic enough for Handoffs / Tokens to reuse.

- **`<MemoryDetailContent>` + `<MemoryInspector>` + `<MemoryBottomSheet>`**
  (`components/memories/`). The detail-view body lifts into a
  shared component; the rail (md+) and the bottom sheet (<lg)
  wrap the same content with their own chrome. Bottom sheet built
  on Radix Dialog primitives for focus trap + Escape + backdrop-
  tap, anchored at viewport bottom, 80 vh tall, swipe-handle pill
  on the top edge. Reduced-motion honoured via Tailwind's
  `animate-in` / `animate-out` utilities.

- **/memories Tabs (Browse / Recall)** carry the IA split. Browse
  owns search + chips + paginated list; Recall owns the recall
  query + ranked-result banner + dedicated empty-state copy.
  Switching tabs swaps the input affordance and result semantics
  without losing list scroll.

- **/memories keyboard shortcuts** via `useSurfaceShortcuts`:
  `/` focuses the active tab's input; `n` toggles New memory;
  `r` switches to Recall + focuses its input; `j`/`k` cycle the
  displayed list; `Esc` peels off context (selection → recall
  results → no-op). Each input also handles its own Escape to
  clear + blur. KeyHint badges next to New memory `[N]`, Recall
  tab `[R]`, and the search input `[/]`. SHORTCUTS list in
  keyboard-host gains five contextual entries for the `?`
  overlay on `/`.

- **Skeleton loading state** for /memories. Replaces the plain
  "Loading memories…" text with a verdigris MemoryOrb pulse +
  "CONSULTING MEMORY" mono small-caps + four hairline-bordered
  card skeletons that mirror the MemoryCard shape (title strip
  - body strips + meta strip). The breathe-animation is the
  memory-orb-pulse keyframes; scale delta tuned down to ±1.5 %
  so the opacity carries the motion.

- **Per-surface page subtitles**. Every Phase-2 page header now
  follows the Handoffs pattern (Fraunces h1 + foreground/60
  subtitle explaining the queue semantics). Standardises page
  context across the dashboard.

- **EmptyState composite usage** on /memories. The hero
  LibrarianMark + constellation + "The library is empty." copy
  - primary action — the system primitive built in rc.15 finally
  gets a real consumer.

### Changed

- **/memories full IA rebuild**. Left filter sidebar removed; chip
  row + search input above the list now. Detail-panel modal becomes
  the right-rail `<MemoryInspector>` at md+ (mobile gets the
  bottom sheet). `filters.tsx` deleted; its agent-grouping logic
  moves into `buildFilterDefs` in view.tsx; matching tests in
  `tests/components/memories/filter-chips.test.tsx`.

- **/proposals, /flagged, /archive chrome onto editorial**.
  Fraunces h1 + subtitle; error → editorial red-ochre alert;
  loading/empty → foreground/60; bespoke styled buttons → ui-v2
  Button variants. **One Pen Rule split** on row actions: only
  the affirmative action per row wears the verdigris rubric;
  destructive paths (Reject / Archive / Permanently delete) move
  to `variant="destructive"` (red ochre). Toast on /archive
  adopts the verdigris ink-accent callout. Native checkboxes pick
  up `accent-ink-accent` + coarse-pointer min-tap bumps.

- **/handoffs and /tokens** migrate from bespoke `<table>` markup
  to the `ui-v2/Table` primitives (hairline rows, mono cells,
  11 px tracked column heads at foreground/60). `/handoffs`
  filter inputs become editorial (SectionLabel + hairline +
  ink-accent focus ring); status column renders ui-v2 Pill
  (`accent` for unclaimed, `muted` for claimed). `/tokens`
  GenerateTokenForm: native inputs → ui-v2 Input + SectionLabel;
  Generate → ui-v2 Button primary; the reveal-once token callout
  adopts the verdigris ink-accent treatment; the token plaintext
  renders in the editorial mono-fill code chip. TokenList:
  Revoke → ui-v2 Button destructive.

- **MemoriesList accepts an optional `emptyState` ReactNode** so
  the parent owns the wording. Pagination buttons + bulk-select
  checkbox label migrate to editorial (ui-v2 Button + accent-ink-
  accent native checkboxes + coarse-pointer bumps).

- **`memory-orb-pulse` keyframe scale tuned twice**. Started at
  ±8 % (read as a heartbeat); dropped first to ±3.2 % then to
  ±1.5 %. Opacity now carries ~all of the motion — scale is a
  whisper at the edge of perception.

### Removed

- `components/memories/filters.tsx` + `tests/components/filters.test.tsx`
  (replaced by FilterChips orchestrator + buildFilterDefs +
  filter-chips test).
- `components/memories/detail-panel.tsx` (replaced by
  MemoryDetailContent + the two chrome wrappers).

## [1.0.0-rc.15] — 2026-06-15

Dashboard design-system amplification — "library materials, digital behaviour."
The Reading Room now reads like a reading room **and** a memory vault: tangible
craft in the foreground (paper, ink, copper hardware, the librarian figure),
networked substrate behind (constellation, glow, the memory orb). Two reference
banners Guybrush provided (Manuscript light + Scriptorium teal) committed to a real
visual language; the vault surface picks up the system on the first application.
No behaviour or contract changes; the rest of the dashboard still wears its
pre-redesign chrome and is queued for Phase 2.

### Added

- **Two-accent contract: verdigris + copper.** The rubric accent moves from
  vermilion to **verdigris** (`#3f9c8e` light, `#7dd3c0` dark — the existing
  cyan is already in the verdigris family, which is the whole reason the
  rename "links the themes"). The structural accent moves from brass to
  **copper** (`#b87333` light, `#d49872` dark — polished copper for the cool
  dark field). Verdigris is the patina of oxidized copper, so the pairing
  tells a single chemical story — bright copper hardware on the catalog
  drawers, patina where time has touched it. Both accents earn their place by
  being rare; the **Copper-Never-State Rule** keeps the structural copper from
  carrying hover / focus / selection — those stay with the rubric.
- **Scriptorium-at-midnight dark theme.** Repalette end to end: `--background`
  flips from warm dark brown (`#1c1814`) to deep teal (`#0e2a36`); `--foreground`
  becomes warm parchment (`#e8d9b8`); the rubric accent flips saffron → cyan
  (`#7dd3c0`). Cards and the librarian figure stay paper-warm so they read as
  "warm objects glowing in a cool room" — the candlelit-scriptorium composition
  the reference commits to, not a generic dimmed dark theme.
- **One-Illuminated-Element-Per-Surface rule + glow tokens.** Replaces the old
  "no shadows ever" absolute. `--glow-accent` (full bloom: 12–14 px of rubric
  accent at ~35–45% alpha, tuned per theme) and `--glow-accent-subtle` (half
  bloom for ambient lit elements). Applied via `glow-accent` / `glow-accent-subtle`
  utility classes — and via component CSS on the Button focus-visible ring
  (rubric ring + bloom), Tabs focus (subtle bloom), the active tab (downward
  halo from the underline), and the MemoryOrb (drop-shadow bloom scaled with
  size). Library materials stay flat; only the *one illuminated element* glows.
  No glass, no backdrop-filter — soft glow is a box-shadow, never a layered
  surface.
- **Brand graphic primitives** (`components/brand/`). The librarian figure has
  three real places to stand rather than the failed top-left logo + watermark
  approach:
  - `<LibrarianMark>` — theme-switching SVG at three legible sizes (sidebar
    38 × 56, hero 220 × 320, loading 22 × 32). Light + teal source files in
    `public/brand/`. Uses `next/image` + `next-themes` with hydration-flicker
    suppression.
  - `<ConstellationBackdrop>` — hand-tuned 280 × 280 SVG pattern (9 nodes
    composed rather than uniform-grid, copper-soft edges, 2 rubric nodes that
    pulse on a staggered 6 s cycle when `live`). Tiles seamlessly across hero
    surfaces only. The AI substrate made visible.
  - `<MemoryOrb>` — the librarian's illuminated dot extracted as a primitive
    (solid rubric circle + scale-matched drop-shadow bloom + optional 1.8 s
    breathing pulse). Replaces generic spinner dots; "consulting memory" reads
    truer than "please wait."
  - `<EmptyState>` — composes constellation + librarian + serif heading +
    editorial copy + copper gilt inner-rule margin. The shape every empty /
    landing surface should take going forward.
  All motion honours `prefers-reduced-motion` (static glow, no breathing).
- **Vault surface picks up the system.** The `/vault` sidebar renders the
  LibrarianMark beside the Fraunces "Vault" heading; the empty pane becomes the
  EmptyState composite ("The vault, at rest." + the librarian + a live
  constellation + a mono shortcuts hint). The Read-mode article picks up a 1 px
  copper-soft inner border alongside its hairline frame — the manuscript-margin
  reading on every file view. The active tree row grows a 2 px copper gilt
  marker on its left edge, paired with the existing rubric wash. The tree's
  per-row pending dot is now a MemoryOrb.

### Changed

- **DESIGN.md rewritten** to document the new vocabulary. Frontmatter carries
  both palettes plus copper. Section 1 (Overview) leads with the library / AI
  synthesis and the two-accent contract. Section 2 (Colors) splits into rubric
  (verdigris / cyan) / state (sage / muted-teal) / structural (copper), with the
  Scriptorium-at-midnight neutrals replacing the old warm-dark ones. Section 4
  renamed to "Elevation & Illumination" and documents the new
  One-Illuminated-Element / Flat-Materials / No-Glass rules. New Section 5
  ("Brand Graphics") documents LibrarianMark / ConstellationBackdrop /
  MemoryOrb / EmptyState with their Earned-Scale and Substrate-on-Hero-Only
  rules. Sections 6 (Components) and 7 (Do's and Don'ts) renumbered.

## [1.0.0-rc.14] — 2026-06-14

### Fixed

- **Compose deploys couldn't reach the server.** Since rc.10 (ADR 0008), the
  two-service `docker/docker-compose.yml` attached both services **only** to a
  `internal: true` network. Docker does not publish host ports for a container
  whose only network is internal, so the agent surface (`/mcp`, `/healthz`,
  `/primer.md` on `:3838`) — and the dashboard on `:3839` — silently stopped
  being reachable from the host on every compose deploy from rc.10 onward (it
  also cut the mcp-server's outbound curator/backup calls). The server itself
  ran fine; it just wasn't published. The network is now a normal bridge; the
  admin tRPC port (3840) stays off the host because it is simply never published
  (ADR 0008 intact). Adds `test/docker-compose.test.ts` pinning the invariants —
  `docker compose config` validates syntax only and the smoke test runs
  in-network, so neither caught this.

## [1.0.0-rc.13] — 2026-06-14

Dashboard vault redesign, Phase 1 (the `/vault` surface of the `impeccable-redesign`
work). The reading room finally reads like a reading room — editorial typography for
the markdown reader, shadcn cards swapped for flat hairline editorial, keyboard-first
stewardship wired (focus rings, destructive variant, `N`/`E`/`D`/`J`/`K`/`/` shortcuts),
touch adaptation via `(pointer: coarse)`, and a substring filter for vaults too large
to scroll. No behaviour or contract changes outside the `/vault` route; the rest of the
dashboard is untouched and still wears its legacy chrome (queued for Phase 2).

### Fixed

- **Long lines in the vault diff view now wrap inside the column.** `DiffView` used
  `whitespace-pre` per-line, so a prose-heavy diff (the vault is overwhelmingly notes,
  not code) forced per-line horizontal scrolling on a 13" screen. Swapped to
  `whitespace-pre-wrap` — indentation preserved, lines wrap on word boundaries,
  `overflow-x-auto` stays as defensive backstop. Closes [#372](https://github.com/code-ministry-ltd/the-librarian/issues/372).

### Added

- **Editorial typography for the markdown reader.** New `.vault-prose` block in
  `globals.css`: Newsreader 16px @ 1.75 leading capped at 68ch, Fraunces headings
  (~1.25 ratio, balanced wrap, sharp), IBM Plex Mono inline code on the warm mono-fill
  tint, pre blocks with hairline border + `pre-wrap`, real bullets with muted markers,
  vermilion links with underline-offset, 1-px hairline blockquote rule, tabular-num
  tables. The dashboard's dense 14px UI body stays untouched — only the reader opts
  into the editorial measure. Replaces the dead `prose prose-sm` Tailwind classes
  (typography plugin wasn't installed; the scoped CSS avoids the dep).
- **`destructive` Button variant + focus-visible ring on every variant.** The ring is
  the rubric accent (vermilion/saffron) with offset, applied to outline/primary/
  destructive/ghost equally — keyboard users see the same one-mark-of-colour the rest
  of the system reserves for current state. The destructive variant lands on the Delete
  trigger and its confirm so an irreversible write looks like one; Restore stays primary
  (a write, but a new commit, reversible).
- **Per-action keyboard shortcuts on the vault surface.** `N` opens the new-file
  dialog; `E` switches the file Tabs to Edit; `D` opens the Delete confirm; `J` / `K`
  cycle the selected file through the (filtered) tree, wrap at both ends; `/` focuses
  the tree filter (Esc clears + blurs). The handlers skip when focus is in an
  input/textarea/contenteditable so typing into a search box never gets hijacked.
  `KeyHint` badges render the mnemonic next to each action and hide on coarse
  pointers (no keyboard, no need for the hint). The `<kbd>` is `aria-hidden` so the
  accessible button name stays clean ("Delete", not "Delete D"). Shortcuts also
  joined the global `?` cheatsheet so it's the single source of truth.
- **Per-row pending state on tree links** via Next 15's `useLinkStatus` — only the
  clicked row pulses a vermilion dot, not the whole tree. Honours `prefers-reduced-motion`.
- **`(pointer: coarse)` adaptation.** Buttons, Tabs triggers, file-tree rows, dir
  summaries, and backlinks all bump to ≥44 × 44 px on touch devices without changing
  desktop density (verified at 28–36px desktop / 44–48px touch via Playwright
  device-emulation). The KeyHint hides on coarse, the filter input bumps to 44px,
  and the vault tree caps at `max-h-60 overflow-y-auto` on mobile once a file is
  selected so a 30-file tree doesn't push content off the fold.
- **Vault tree filter.** Substring match on the full path, case-insensitive, instant
  (no debounce — 500 files is trivial). Pruned tree keeps directories whose subtree
  has at least one match (path context preserved, not a flat result list); empty
  filter passes the tree through unchanged. While a filter is active every `<details>`
  re-mounts in the open state so matches inside collapsed dirs become visible — filter
  clears, user's collapse state returns. `j`/`k` cycles the *filtered* list so the
  user never lands on a hidden file. Empty match renders an inline "No files match …"
  with one-tap clear. `filterTree` is exported and unit-tested directly (6 cases).

### Changed

- **Vault layout fix → accordion file history.** Contained the explorer overflow
  (the unwrapped `<pre>` in a CSS grid track with `min-width: auto` was pushing the
  Restore button off-screen): added `min-w-0` on the explorer content section, the
  file-view article + aside, and the file-history list; restructured the file history
  from a `lg:grid-cols-[1fr_2fr]` two-column layout into a single-column accordion
  where each commit row expands in place to load its diff inline, one open at a time.
- **Vault chrome migrated from shadcn cards to flat hairline editorial.** Header pill
  is the `ui-v2` `Pill` component; Edit/History are now the `ui-v2` `Tabs` (with View
  renamed to **Read**) so mode switching gets its canonical affordance, with Rename
  and Delete sitting as file-level actions in the header; the article surface lost its
  rounded card for hairline + paper-surface + sharp + generous padding; FrontmatterTable
  and BacklinksPane lost their cards entirely, flowing as hairline-divided rows under
  the DESIGN.md mono-label treatment (font-mono · 11px · uppercase · tracking 0.08em
  · `foreground/60`). New-file + raw-markdown textareas: hairline + mono-fill + sharp +
  ink-accent focus ring. Tree rows: sharp corners, `foreground/60` for inactive items.
- **Design system context captured in-repo.** `PRODUCT.md` and `DESIGN.md` document
  the "Reading Room" editorial system (warm-paper/ink palette, single
  vermilion/saffron rubric, flat-by-default, Fraunces/Newsreader/IBM Plex Mono), with
  `.impeccable/` carrying the live config + critique snapshots and `CLAUDE.md`
  pointing future agents at both.

### Tests

- 13 new tests (256 dashboard tests total): 6 `filterTree` cases (passthrough,
  case-insensitive, dir-prune, segment match, no-match, mixed root + dirs), 1
  accordion-expand test for the new file-history shape, plus minor coverage updates.

## [1.0.0-rc.12] — 2026-06-14

### Fixed

- **Dashboard no longer 500s in the edge runtime when the tRPC URL env is unset.**
  `apps/dashboard/lib/trpc-server.ts` is `import "server-only"`, but Next's
  middleware bundler still pulls it into the **edge runtime** (middleware →
  `auth-config-client` → `trpc-server`), where `process.stderr` is undefined. Its
  cold-start misconfiguration warning used `process.stderr.write`, which threw at
  module init and 500'd **every request** whenever neither `LIBRARIAN_TRPC_URL`
  nor `LIBRARIAN_SERVER_URL` was set. Switched the warning to `console.warn`
  (edge-safe). Regression test added.

## [1.0.0-rc.11] — 2026-06-14

Internal/tooling only — no shipped code; the published `@the-librarian/cli` and
the Claude plugin are unchanged.

### Removed

- **The repo-local `.claude/commands/` dogfood copy of the slash surface.** The
  four slash commands (`/handoff`, `/learn`, `/takeover`, `/toggle-private`) were
  duplicated as repo-local `.claude/commands/*.md` **and** shipped via the Claude
  plugin (`integrations/claude/commands/`, installed from the marketplace). With
  the plugin installed, the duplicate only obscured which surface was firing.
  The plugin is now the single source — no change to the commands themselves or
  to the cross-harness slash-command contract.

### Changed

- **Inverted the `test/repo-structure.test.ts` guard** so it asserts the slash
  commands exist in the canonical plugin copy and are **absent** from
  `.claude/commands/`, preventing the duplicate from being reintroduced.

## [1.0.0-rc.10] — 2026-06-14

Auth & secrets hardening, Phase 1 (implements [ADR 0008](docs/adr/0008-auth-secrets-model.md)
and the rc.9 spec). Shrinks the network surface and externalizes the master key.
**Behaviour change for self-hosters:** the admin token is no longer a network gate —
existing deploys can drop `LIBRARIAN_ADMIN_TOKEN` from their env (the dashboard reaches
the admin API over a loopback/internal-network listener with no bearer). See the
[deployment guide](DEPLOYMENT.md#the-auth-model-adr-0008).

### Added

- **Two-listener HTTP split.** The mcp-server now serves the agent surface
  (`/mcp`, `/healthz`, `/primer.md`) on the published listener (`LIBRARIAN_HOST:PORT`)
  and the admin tRPC API (`/trpc/*`) on a **separate internal listener**
  (`LIBRARIAN_TRPC_HOST`, default loopback `127.0.0.1` : `LIBRARIAN_TRPC_PORT`, default
  `3840`). A `/trpc` request to the published port now `404`s — the admin surface
  (which can return *decrypted* secrets) is off the network entirely.
- **`LIBRARIAN_TRPC_URL`** for the dashboard, so the agent `/mcp` URL and the admin
  `/trpc` URL can differ (defaults to the internal listener: `127.0.0.1:3840`
  all-in-one, `mcp-server:3840` compose).
- **Master-key externalization ladder** documented in `DEPLOYMENT.md` (default `0600`
  deploy env-file → `systemd-creds` → external secrets manager), with an honest threat
  model (it defends the at-rest/offline case, **not** a live-host root compromise).

### Changed

- **Admin token dropped as a network gate.** The internal tRPC listener is trusted by
  isolation (loopback in the all-in-one; an `internal: true`, unpublished docker network
  in compose) and grants the admin role with **no bearer**. `server up` no longer mints
  or surfaces an admin token; compose no longer requires `LIBRARIAN_ADMIN_TOKEN`; the
  public listener can **never** resolve the admin role. (The dashboard "enable owner
  login" land-grab guard still accepts an operator-set `LIBRARIAN_ADMIN_TOKEN` — a
  turn-key no-token flow is a documented follow-up.)
- **Secrets delivered via a `0600` env-file, not inline `-e`.** `server up`/`update`
  write the agent token + master key to `<deployDir>/deploy.env` (mode `0600`) and run
  the container with `docker run --env-file` — keeping secrets off the process argv.
- **Master key minted off the data volume.** The CLI now mints `LIBRARIAN_SECRET_KEY`
  (as it already does the agent token) and supplies it via env, so the server resolves
  it from the environment and **never writes `/data/secret.key`** — the key is no longer
  co-located with (or backed up alongside) the ciphertext it protects. `update`
  preserves the existing key across a container recreate, so encrypted `settings.json`
  secrets are never orphaned.
- **Dashboard repointed** at the internal tRPC listener (server-side client + browser
  proxy); it no longer injects an admin bearer.
- **Docs synced to the model:** README / CONTRIBUTING / DEPLOYMENT no longer describe
  the removed admin token; the generated `the-librarian.service` points at the deploy
  env-file (comment) without embedding a secret.

### Fixed

- **A configured agent token is now enforced on loopback.** A `127.0.0.1` bind no
  longer grants the agent role without a token when an agent token (or
  `LIBRARIAN_AGENT_TOKENS` map) is configured; the no-auth bypass fires only on an
  explicit `LIBRARIAN_ALLOW_NO_AUTH=true` or a loopback bind with no agent auth
  configured at all. The bypass keys off the server's **bind** host, never a
  request-supplied `Host`/`X-Forwarded-*` header (no spoofing).

## [1.0.0-rc.9] — 2026-06-14

Docs only — no shipped code, so the published `@the-librarian/cli` is unchanged.

### Added

- **ADR 0008 — auth & secrets model** (`docs/adr/0008-auth-secrets-model.md`) and a
  buildable spec (`docs/specs/2026-06-14-auth-secrets-hardening.md`). Records the
  decision to shrink the network surface and make the secrets model match its real
  value: move the admin tRPC API to an **internal-only listener** and **drop the
  admin token** as a network gate (amends ADR 0002 — the tRPC shape stands, its
  exposure changes); **externalize the master key** (CLI-minted into a `0600` deploy
  env-file, off the data volume) with a documented ladder
  (env-file → `systemd-creds` → external secrets manager); and make **per-client
  agent tokens + rotation** the real hardening. The spec phases it: Phase 1
  (listener split + admin-token removal + key externalization), Phase 2 (per-client
  tokens). Captures the reasoning — the vault is plaintext by design, the master key
  protected only the server's own creds (and weakly, co-located), and the admin
  tRPC was network-exposed only incidentally.

### Changed

- **ADR 0002 re-pointed** to note its network-exposure aspect is amended by ADR 0008.

## [1.0.0-rc.8] — 2026-06-14

Docs only — no shipped code, so the published `@the-librarian/cli` is unchanged.

### Added

- **Spec: README review & improvement sweep**
  (`docs/specs/2026-06-14-readme-review.md`). A lightweight, buildable plan to make
  every README clear, correct, and useful to consumers — its core discipline is
  *verifying every claim against the code* (the AGENTS.md "README is the contract"
  rule), not just polishing prose. Scopes the root README + the five harness
  integration READMEs + the installer-CLI README as consumer-facing (full pass), with
  the two internal READMEs (`intake-eval`, `seed`) on a correctness-only pass; phased
  one-README-per-slice, root first.

## [1.0.0-rc.7] — 2026-06-14

Implement the `librarian server` self-host CLI from the rc.6 spec — the loop
closer: **server on the host → token → clients.** `@the-librarian/cli` (the
`librarian` bin) gains a host-only, Docker-driven `server` command group; no new
tool, no rename.

### Added

- **`librarian server up`** — one command stands up the all-in-one container on a
  fresh Docker host: clones the monorepo at the latest release tag (`--ref` pins a
  tag or `main`), builds + runs the image (named `librarian_data` volume), waits
  for both services healthy (rolling the container back on failure — never a
  half-up deploy), surfaces the server-generated master key **once** with the
  `SAVE THIS KEY` warning, and prints the MCP URL + a freshly minted agent token
  ready to paste into `librarian install`. Offers to write this machine's own
  `~/.librarian/env` when it's also a client.
- **Bind-aware auth.** A `127.0.0.1` bind (default) runs with
  `LIBRARIAN_ALLOW_NO_AUTH=true` (no admin token); `--host <tailnet-ip|0.0.0.0>`
  omits it so the server generates + enforces the admin token (surfaced once).
  `0.0.0.0` is ask-first; a detected Tailscale IP is offered, never auto-selected.
- **`server update`** — re-pins forward to the latest release (idempotent no-op
  when already current + healthy), rebuilds, recreates the container **preserving
  the data volume**, reuses the existing agent token, and applies pending data-dir
  migrations via `docker exec … migrate-data-dir`.
- **`server down` / `status` / `logs`** — `down` stops the container and never
  touches the data volume; `status` reports running/health/deployed-vs-latest with
  an update badge; `logs [-f] [--service mcp|dashboard|all]` streams live.
- **`server enable-boot` / `disable-boot`** (and `up --enable-boot`) — generate a
  Linux systemd unit whose `ExecStart` is `docker start --attach the-librarian`
  (references the existing named container, so **no secret lands in the unit
  file**). macOS launchd is deferred (clean notice).
- **`server admin <backup|restore|auth|rebuild>`** — runs the admin CLI inside the
  container (`docker exec`), so auth-lockout recovery works even when the dashboard
  is locked. The all-in-one image now bundles `@librarian/cli` (`the-librarian`)
  on `PATH`. `seed`/`migrate-data-dir`/`export`/`handoffs` are intentionally not
  exposed here.
- **`the-librarian restore`** (new admin command) — clones the configured backup
  remote into the data dir and re-supplies the master key (`--secret-key`, which is
  excluded from backups). Crash-safe (clones to a temp dir, swaps atomically, so a
  failed clone never destroys an existing vault) and key-verified (rejects a
  well-formed-but-wrong key that would otherwise leave an undecryptable server);
  `--force` guards the populated-vault and differing-key cases.

### Security

- No agent token, admin token, or master key is ever written to a host file, a
  log, or an error message: failed-step output from `up`/`update`/`server admin`
  is run through a shared redactor before it is surfaced, and the boot unit carries
  no secret.

### Fixed

- **Vault backup over HTTPS failed with `server certificate verification failed.
  CAfile: none`.** The git-using images installed `git` with
  `--no-install-recommends` on a slim base that ships no CA bundle, so the backup
  `git push https://…github.com…` couldn't verify GitHub's certificate (reads were
  unaffected — only git does outbound HTTPS; Node bundles its own CAs). Both
  `docker/all-in-one.Dockerfile` and `docker/mcp-server.Dockerfile` now install
  `ca-certificates` alongside `git`, with a static regression guard
  (`dockerfile-tls.test.ts`).
- **Vault backup then failed to exec the `GIT_ASKPASS` helper**
  (`fatal: cannot exec '…/askpass.sh': Permission denied`) on hardened
  (`read_only`) deployments, where `/tmp` is a `noexec` tmpfs. The transient
  askpass helper is now written to the data dir — a writable, exec-capable volume
  outside the vault working tree — instead of `os.tmpdir()` (the token is still
  supplied only via the helper's env, never embedded). `createSyncGitOps` /
  `cloneVaultBackup` gain an optional `scratchDir`; the store + `restore` pass the
  data dir.

## [1.0.0-rc.6] — 2026-06-13

Spec only — no shipped code, so the published `@the-librarian/cli` is unchanged
(the publish job idempotently skips the already-published version).

### Added

- **Spec: `librarian server` — self-host the Librarian from the CLI**
  (`docs/specs/2026-06-13-server-cli.md`). Turns the pre-spec feature doc into a
  buildable plan for a `server` command group (`up`/`update`/`down`/`status`/
  `logs`/`enable-boot` + a folded-in `server admin` subset). Locks the key
  decisions: deploy the **all-in-one container only**; deploy from the **latest
  released tag** (`--ref` escape hatch) with `update` re-pinning forward; the
  server self-generates the master key + admin token on first boot (the CLI
  surfaces them once, never persists them) while the CLI mints the agent token
  as the loop-closer; fold `backup`/`restore`/`auth`/`rebuild` under `server
  admin` (bundling `@librarian/cli` into the image and reaching it via `docker
  exec`), **build a new `restore`** command, drop `seed`, and run
  `migrate-data-dir` automatically inside `update`. Rewritten with the
  `sdlc-spec` method — testable success criteria up front and a vertically-sliced
  task plan (S1–S9, each with its own acceptance check + dependencies) — and
  grounded against the actual deploy code, which surfaced three corrections: the
  admin-token "only beyond localhost" rule is realized via `LIBRARIAN_ALLOW_NO_AUTH`
  (the container always binds `0.0.0.0`, so it can't see the host publish
  address); `update` must apply migrations via `docker exec … migrate-data-dir`
  (server boot only warns); and the image genuinely lacks `@librarian/cli` at
  runtime today (only its `package.json` is copied into the builder), so bundling
  it is real work.

## [1.0.0-rc.5] — 2026-06-13

Wire up automatic npm publishing so a merge to `main` ships the public CLI —
no more hand-running `npm publish`. This republishes `@the-librarian/cli` with
the rc.4 installer fixes (interactive token prompt + `LIBRARIAN_*` reuse).

### Added

- **Auto-publish `@the-librarian/cli` to npm on release.** `release.yml` gains a
  `publish-npm` job that runs after the tag/GitHub release is cut and publishes
  the public package with `pnpm publish --access public`. It is idempotent — it
  skips any version already on npm, so a no-bump merge and a workflow re-run are
  clean no-ops (a re-run also recovers a half-failed publish by shipping only
  what's still missing). It is gated on an `NPM_TOKEN` repo secret: until that
  secret exists the job logs and exits 0, so this change is safe to land first
  and auto-publish switches on the moment the owner adds the secret — no further
  code change. Private `@librarian/*` workspace packages are never published
  (`private: true`).

### Changed

- **Pin the Hermes adapter ref to `v1.0.0-rc.5`.** The CLI fetches the Hermes
  adapter from the matching release tag at install time; the version-tracking
  test keeps `PINNED_REF` in lockstep with the package version, so the bump
  moves it too.

## [1.0.0-rc.4] — 2026-06-13

Installer-CLI fixes for the interactive setup (`@the-librarian/cli`). Needs a
republish to npm to reach users.

### Fixed

- **Interactive token prompt no longer drops the second answer.** `librarian
  install` built a fresh `readline` interface per question and closed it after
  each one; closing the first interface discarded any input buffered past its
  line, so when both answers arrived together (a paste, or a fast/piped run) the
  token read saw no input and hung — `resolveConfig` then failed with
  "MCP URL and token are required". The prompter now uses ONE shared readline
  interface for its whole lifetime, created lazily on the first real prompt and
  reused for every question, with a persistent line queue so no input is lost
  regardless of chunking. The secret (token) echo is muted only for that one
  question and restored afterwards. A new `Prompter.close()` (called from the
  install/uninstall lifecycle) tears the interface down so an open readline no
  longer keeps the event loop alive and the process exits cleanly.

### Added

- **Reuse existing `LIBRARIAN_*` environment variables.** When
  `~/.librarian/env` isn't already complete, `librarian install` now consults
  `LIBRARIAN_MCP_URL` / `LIBRARIAN_AGENT_TOKEN` from the environment instead of
  blindly prompting. With BOTH present it shows them (URL in full, token
  redacted to `LIBRARIAN_AGENT_TOKEN=set` — never the value) and asks
  `Use the LIBRARIAN_MCP_URL and LIBRARIAN_AGENT_TOKEN from your environment?
  [Y/n]`; accept reuses and persists them, decline prompts for fresh values.
  With only ONE present it prefills that prompt's default so a bare enter
  accepts it. The environment is injectable for tests, and the token value is
  never logged.

## [1.0.0-rc.3] — 2026-06-13

The cross-harness installer CLI (`docs/specs/2026-06-13-installer-cli.md`,
Phase 1). One bootstrap line installs a small `librarian` CLI that drives each
harness's native install path — the package-manager-style tool you keep, instead
of hand-editing five config formats.

### Added

- **`librarian` installer CLI** (`@the-librarian/cli`, bin `librarian`) — a thin
  cross-harness orchestrator for Claude Code, Codex, OpenCode, Hermes, and Pi.
  `librarian install` (interactive multi-select; prompts once for MCP URL +
  token), `uninstall`, `update`, plus a live `status` table, `doctor`
  diagnostics, and `config`. Each harness is detected and skipped (`not-detected`)
  rather than erroring when its CLI is absent. Operations are idempotent and
  roll back per-step on error. Phase 1 is local-only; server reporting
  (`report`) and CLI `self-update` land in a later release.
- **Install with `npm i -g @the-librarian/cli` then `librarian install`** — any
  harness you'd install into already has Node, so there's no bootstrap script;
  the two commands install the CLI globally and hand off to the interactive
  setup (`librarian install` prompts once for MCP URL + token and multi-selects
  harnesses).
- **Env + machine identity** — the CLI writes `~/.librarian/env` (`chmod 600`)
  with `LIBRARIAN_MCP_URL` + `LIBRARIAN_AGENT_TOKEN`, adds one idempotent managed
  block to the shell rc (bash/zsh source it; fish gets a native
  `conf.d/librarian.fish`), and stamps a per-machine `~/.librarian/machine-id`.
  The token is never printed and never leaves `~/.librarian/env`.

### Changed

- **Pi npm package renamed** from the unpublishable `@librarian/pi-extension`
  (an npm scope nobody owns) to `@the-librarian/pi-extension` — scoped under
  the new `@the-librarian` npm org the owner controls, with
  `publishConfig.access: public` so the scoped package publishes publicly.
  The old unscoped `the-librarian-pi-extension` (v0.4.0), published from the
  pre-1.0 repo, will be `npm deprecate`d post-publish to point at the new
  `@the-librarian/pi-extension` name. The Pi package and the Claude
  marketplace manifest are now version-aligned to the root.

- **Installer CLI package name** — published as the scoped **`@the-librarian/cli`**
  (with `"publishConfig": { "access": "public" }`), owner decision. The bootstrap
  one-liner and spec §2/§7 use `npm i -g @the-librarian/cli`.

### Fixed

- **Hermes adapter extraction** — the codeload tarball nests the adapter four
  path components deep (`the-librarian-<ref>/integrations/hermes/librarian/**`),
  so `tar --strip-components` is now `4` (was `3`). Files land at the plugin-dir
  root, so a fresh-machine install + `detect()` round-trips. Regression test
  drives the real `tar` path against a codeload-shaped fixture.
- **Hermes pinned ref** — `PINNED_REF` now tracks the published package version
  (`v1.0.0-rc.3`), so the adapter fetch no longer 404s on a fresh machine; a test
  pins `PINNED_REF === "v" + <package version>` so it can't drift again.
- **OpenCode uninstall no longer removes a foreign `…/primer.md`** — install
  stamps the exact primer URL it added into the managed `mcp.librarian` block,
  and uninstall removes only that exact `instructions` entry, leaving unrelated
  primer entries intact.
- **Non-interactive install with no saved config fails cleanly** — a missing MCP
  URL/token in a non-interactive run now prints one friendly line and exits 1
  instead of leaking a `MissingValueError` stack trace.
- **Install defers global side effects until a harness succeeds** —
  `~/.librarian/env` + the managed shell rc block are written only after at least
  one harness install succeeds, so a run where every harness fails leaves no
  global state behind.

## [1.0.0-rc.1] — 2026-06-12

Phases 1–5 of the v1.0 rethink (`docs/specs/2026-06-12-rethink.md`): carve the
system down to ONE curator with ONE apply rule and ONE prompt, close the
Phase 1 review findings, land the primer + the pinned 7-verb agent surface +
the five in-tree harness integrations, give the dashboard its Obsidian-lite
vault explorer/editor with per-file history/diff/restore plus the
activity-feed audit trail and the guarded whole-vault restore (T18–T21),
make `search_references` fast + end-to-end searchable (persistent embedding
cache + chunked retrieval, T23/T24), and ship the one-shot `migrate-data-dir`
CLI for legacy data dirs (T26). Promotes to `1.0.0` once the owner's
live instance migrates cleanly.

### Added — Phase 5 (data-dir migration)

- **`migrate-data-dir` CLI command** (rethink T26, spec §10) —
  `pnpm --filter @librarian/cli migrate-data-dir [--data-dir <path>]` migrates
  a pre-1.0 data dir in one idempotent pass and prints a three-section report
  (changes made / archivable artifacts / needs the operator). It verifies the
  vault is a git repo (initializing + making the initial commit through the
  same GitOps path the server boot uses when not), renames the intake decision
  log `consolidation-runs.json` → `intake-runs.json` (the store reads the
  legacy name as a one-time fallback until the rename), strips the retired
  frontmatter fields (`domain`, `category`, `visibility`, `scope`,
  `actor_kind`, `last_recalled_at`, and CuratorNote's
  `addendum_version`/`dry_run`/`dry_run_candidate`) from every memory doc in
  ONE sweep commit (`migrate: strip retired frontmatter fields`), and removes
  the retired settings keys (the classifier-era `classifier.*` surface, the
  pre-D13 `curator.grooming.default_auto_apply` +
  `curator.grooming.auto_apply_confidence`/`curator.auto_apply_confidence` —
  each removal reports the old value next to the new 0.8 default under
  `curator.apply.confidence_threshold`, spec §15.3 — the under-evaluation
  `addendum_status`/`addendum_eval_version` pair, the `LIBRARIAN_CONSOLIDATOR`
  -era seed sources `curator.enabled`/`curator.interval_minutes`/
  `curator.schedule.*`, and the post-primer-seed `awareness.primer`/
  `working_style`), running the boot seed migrations FIRST so no value is
  removed before it migrated. **It never deletes data:** `librarian.sqlite`,
  `events.jsonl`, the root `memories.md`, `conv-state.json`,
  `*.predeprecation.bak` files, dry-run-tagged proposals, stuck
  `agent_private` curation lock rows, and an over-2KB migrated primer are
  reported (with sizes) for the operator; an unreadable secret legacy value
  (master key absent) is left in place with a note instead of being destroyed
  unread. A second run reports "nothing to do" and creates no commits.
- **Boot warn-only migration checks** — the HTTP server boot now runs the same
  detections read-only and logs one `data-dir migration: …` warning line per
  finding (fail-soft; never blocks boot, never mutates). The mutations belong
  to the CLI command.

### Added — Phase 4 (references completion)

- **Persistent embedding cache** (rethink T23, spec §9 / D5) — a sidecar at
  `<data-dir>/embeddings-cache/` (outside the vault, never git-committed)
  stores per-file chunk vectors keyed by relative path + content hash + a
  stable embedder model id (`Embedder.modelId`; hash and llama key separately,
  so switching embedders can never serve a wrong-model vector). A process
  restart re-embeds nothing that hasn't changed — references AND memory index
  builds ride the same cache. Records invalidate per file on content-hash (or
  chunking) mismatch; orphan entries for deleted files are pruned
  opportunistically during index builds/searches; every disk op is fail-soft
  (a corrupt/torn record is a miss, never a throw — the cache can be deleted
  wholesale at any time).
- **Chunked reference indexing + retrieval** (rethink T24, spec §9 / D5) —
  `search_references` no longer embeds a reference as one (truncated) blob.
  References are split by heading structure first, then into size-bounded
  windows inside oversized sections (max 6000 chars ≈ 1500–2000 tokens, with
  600 chars of overlap so a fact straddling a cut embeds whole somewhere);
  each chunk is indexed keyword+vector (same RRF hybrid index) and the
  best-ranked chunk per file returns with the file path id + a
  heading-breadcrumb `anchor` + a bounded excerpt + `startChar`/`endChar`
  range. Wire-compatible: `id`/`score`/`section` unchanged, the new fields are
  additive. A >100KB document is now searchable in its tail sections (pinned
  by test).

### Added — Phase 3 (history / diff / rollback)

- **Per-file history, diff, and restore** (rethink T20, spec §8 / D16) — the
  vault file view gains a **History** tab: the file's commit list (newest
  first, following renames — pre-rename versions stay addressable and
  diffable under the path they had then), a unified-diff view per version
  ("what this commit changed", rendered as a dependency-free `<pre>` with
  +/- line colouring), and **"Restore this version"** behind a confirm
  dialog. A restore writes the chosen version's content back as a **new
  commit** through the same validated store write path as every other
  mutation (per-kind validation, commit-per-write, recall-index
  invalidation) — history is never rewritten, and a version that no longer
  passes the file type's CURRENT validation is refused with the errors and
  a pointer to the manual-edit path. Backed by a new core git-history
  reader (`git log --follow` / `show` / `diff` over the existing sync
  shell-out plumbing, every revision argument validated as plain hex before
  reaching argv) and new admin-gated tRPC procedures
  (`vault.history`/`atCommit`/`diff`/`restoreVersion`).
- **Vault activity feed — the audit trail** (rethink T21, spec §8 / D16) — a
  new **Activity** page under the Vault section (`/vault/activity`) lists the
  vault's recent git commits newest-first, each with the files it touched and
  a provenance badge (**agent** / **curator** / **admin** / **system**)
  derived server-side from the commit-subject conventions (`inbox: submit` /
  `memory: flag` / `handoff: store|claim` → agent; `inbox: consolidate
  sweep`, `curator: …`, and the `memory: store|propose|update|archive`
  lifecycle writes → curator; `vault: …`, `primer: update`, and the
  admin-only memory/handoff verbs → admin). Served by a new admin-gated tRPC
  `activity` router (`feed` with `limit`/`before` paging). **This view
  replaces the event ledger's old logs view** (D7/D16): the git history IS
  the audit trail — no separate ledger exists.
- **Guarded whole-vault restore** (rethink T21, spec §8 / D16) —
  `activity.restoreVault` rolls every vault file back to a chosen commit's
  tree state, guarded exactly as D16 orders: the dashboard modal makes the
  admin **type `RESTORE`** and the **server validates the phrase** (the UI
  ceremony can't be bypassed); the **curator/intake pause** for the duration
  via a dedicated in-process + TTL-bounded settings signal both tick
  entrypoints check before anything else (run-now included — and distinct
  from the operator's `enabled` settings, which come back untouched); a
  **`pre-restore-<timestamp>` tag** anchors the old HEAD (shown in the
  success state); the tree revert lands as **ONE new commit** (`vault:
  restore to <hash>` — never a history rewrite); the recall index is
  invalidated and rebuilds from markdown by construction; the curator resumes
  in a `finally`, so a mid-sequence failure still resumes it and the error
  reports honestly how far the sequence got. Restores are refused while a
  curation/intake run is in flight and while another restore is running
  (simple process-wide lock).

### Added — Phase 3 (dashboard vault explorer/editor)

- **Vault explorer** (rethink T18, spec §8 / D15) — a new top-level dashboard
  surface (`/vault`) over the WHOLE vault: a file tree (memories/, handoffs/,
  references/, `.curator/`, `primer.md` — `.git`, the disposable `.index/`,
  and the intake's transient `inbox/` queue are deliberately invisible) plus a
  file view with rendered markdown (react-markdown — the dashboard's first
  markdown renderer, chosen as the lightest standard element-tree option, no
  raw HTML), the frontmatter as a property table, **clickable wikilinks**
  (resolved server-side by filename stem / frontmatter id / title / alias —
  the same naming the wikilink machinery uses) and a **backlinks pane**
  ("what links here", from a vault-wide link index). Backed by a new
  admin-gated tRPC `vault` router (`tree`/`read`/`resolve`) over a new
  `store.vaultFiles` surface; every path from the browser is re-validated —
  traversal (`..`), absolute paths, and symlink tricks are rejected before
  touching disk.
- **Vault editor** (rethink T19, spec §8 / D15) — raw markdown editing with
  create/rename/delete (confirm dialogs), all through the store layer: one
  git commit per write, recall-index invalidation on the existing onWrite
  path, never a raw fs write. Saves validate for the file's type BEFORE
  writing — memories against the memory frontmatter schema, handoffs against
  the frontmatter + five-section contract (missing headings are named),
  `primer.md`/`.curator/*` against the 2 KB cap (with a live byte budget in
  the editor), references and plain files lenient — and an invalid document
  is refused with the teaching errors inline, never written. Saves are
  **compare-and-swap** on the content hash captured at load: a file changed
  underneath comes back as a conflict (reload + reapply), never a silent
  last-write-wins. Renames rewrite wikilinks targeting the old filename stem
  across the vault (the existing link-integrity machinery), so nothing
  dangles.

### Added — Phase 2 (primer + 7-verb surface)

- **The primer is now a vault file: `vault/primer.md`** (rethink T11, spec
  §5.2 / D9–D11) — one ≤2KB operator-editable document, seeded on first boot
  with a shipped default that teaches the recall/remember loop, the handoff
  protocol (`store_handoff` with the five sections; `list_handoffs` →
  `claim_handoff` to take over), the learn protocol, private mode (writes
  blocked, reads stay and hit server logs — D11), and the fail-soft posture.
  Served from that one source as the MCP `initialize` result's `instructions`
  field (stdio + HTTP, read fresh per connection) and as the new
  **unauthenticated `GET /primer.md`** endpoint (text/markdown — the ONLY
  unauthenticated content route, for OpenCode's remote-URL instructions
  config). Saves enforce the 2 KB cap like curator addendums. The legacy
  settings-key primer (`awareness.primer`, spec 041) and the `working_style`
  preamble are migrated into the file once at boot, then retired; the
  dashboard Settings form now edits the vault file.
- **Protocol-bearing tool descriptions for all 7 verbs** (rethink T12, D9/D12)
  — each description now carries its protocol (≤1KB each), since descriptions
  are the only teaching surface guaranteed to render in every harness:
  `recall` says "call before answering" and points long-form lookups at
  `search_references`; `remember` says fire-and-forget; `store_handoff`
  embeds the five required section headings; `list_handoffs`/`claim_handoff`
  carry the takeover chain (claims race → 409); `search_references` states
  references are deliberately NOT auto-recalled. The registry test pins the
  markers. Cleanups folded in: `remember`'s unreachable "saved as a proposal"
  branch and its stale "review queue" description claim are gone (S2), and
  the zombie `category`/`scope` wire fields left the curator's grooming
  contract (S1; `CURATOR_PROMPT_VERSION` v5.1 → v5.2 — the input-hash
  invalidation is deliberate).
- **The 7-verb registry is pinned end-to-end** (rethink T13, spec §5.1):
  `scripts/healthcheck.js` now asserts the exact agent surface — `recall`/
  `remember`/`flag_memory` + `store_handoff`/`list_handoffs`/`claim_handoff`
  - `search_references`, nothing missing, nothing extra (the retired
  `conv_state_*`/`list_skills`/`get_skill` verbs stay pinned absent) — and
  the tool-registry test pins exactly 7 with no internal/admin-only tools.
- **All five harness integrations live in-tree under `integrations/`**
  (rethink T14–T16, D9/D10/D14): `claude/` (marketplace manifest +
  env-var-templated `.mcp.json` + four command markdown files — no hooks, no
  code), `codex/` (README-only: `url` + `bearer_token_env_var` MCP config),
  `opencode/` (README-only: remote MCP block + the one-line
  `instructions: ["<server>/primer.md"]`; command files byte-identical to the
  Claude set), `hermes/` (Python `MemoryProvider` — the 7 verbs proxied over
  HTTP, primer via `system_prompt_block()`, stdlib-only at runtime, pytest
  wired into CI via `.github/workflows/hermes-tests.yml`), and `pi/`
  (`@librarian/pi-extension` in the pnpm workspace — 7 native tool proxies +
  a `before_agent_start` primer hook, with a schema-parity drift guard
  against `@librarian/mcp-server`). Per-turn injection hooks and conv-state
  machinery are gone everywhere; private mode is the in-conversation
  `[librarian:private=on|off]` marker (D11). The five standalone plugin
  repos are being archived — **AGENTS.md's rule is inverted: harness work
  happens here, never in the standalone repos.**

### Fixed — Phase 2 review

- **Hermes + Pi had mirrored a pre-T12 tool surface** (both were built in
  parallel worktrees): they advertised the retired required `category` field
  on `remember` (Pi also the zombie `visibility`/`scope` fields) plus the
  stale "protected memories route to a review queue" claim, and Pi's tool
  descriptions had drifted from the T12 protocol-bearing rewrites. Re-synced
  both (Pi descriptions are again verbatim copies of the server's; both
  `/learn` templates now tell the fire-and-forget intake story), and the
  Hermes CI workflow now also triggers on
  `packages/mcp-server/src/mcp/tools/**` so a server-side surface change
  re-runs the parity suite.
- **Hermes client error hygiene raised to the Pi client's level:** endpoints
  embedding basic-auth credentials are refused up front, and network-failure
  messages render a credential-free, query-free endpoint.
- **`docs/slash-commands.md` rewritten to the rethink contract** — in-tree
  integrations, marker-based private mode (the per-turn hook story is gone),
  `remember` as fire-and-forget intake (no protected-category proposal
  routing), no `domain` scoping. AGENTS.md §1–§2 updated to match.

### Removed — the Phase 1 carve-down

- **Whole subsystems deleted:** the skills subsystem (skill store, vault
  handling, `list_skills`/`get_skill`), the server-side `conv_state_*` tools +
  sidecar store, the namespaced recall index (recall now runs on the plain
  hybrid index built from `memories/` only), the classifier plumbing
  (`pendingClassification`/`outsideSession`/`forceActive` routing), the
  SQLite-shaped store contracts (dead `backend` discriminator, the
  category/visibility/scope columns on the tRPC memories surface), the
  event-ledger throwers (`appendEvent`/`listEvents`), the curator addendum
  under-evaluation lifecycle and grooming dry-run, and the risk-level apply
  policy (`off`/`safe_only`/`high_confidence` + `risk_level`).
- **The dual intake/grooming prompt pair** — replaced by ONE unified curator
  prompt core with mode sections (`CURATOR_PROMPT_VERSION` v5 → v5.1) and ONE
  apply rule (rethink D13): `noop` skips; `archive`/`split` ALWAYS propose; a
  `requires_approval` target or a force-proposal submission always proposes;
  `create`/`update`/`merge` auto-apply at confidence ≥ the single
  `curator.apply.confidence_threshold` knob.
- **Deleted parked proposals** `safe-fallback-capture.md`,
  `memory-healthchecks-and-benchmarks.md` and `hybrid-recall.md` — the
  still-relevant ideas were folded into `docs/TODO.md`.

### Changed

- **Deliberate behaviour reset: the curator auto-apply confidence threshold is
  0.8 for EVERY instance** (spec §15.3, owner-confirmed). The legacy
  `curator.grooming.auto_apply_confidence` / `curator.auto_apply_confidence`
  settings are no longer read (the migrate-on-read fallback is gone);
  `migrate-data-dir` reports the stale keys. If you ran a custom threshold,
  re-set the one knob — `curator.apply.confidence_threshold` — from the
  dashboard.
- **Archive proposals ride the flag-review queue, in both curator lanes.**
  Grooming and intake now FLAG the judged target memory
  (`curator proposes archive: <redacted rationale>`) instead of intake filing
  the raw submission as an unactionable proposed doc. Flagging is idempotent:
  an open curator flag is never stacked (a re-groom of an unchanged slice
  records `skipped: already flagged by curator`), and an admin-dismissed flag
  is honoured — dismissal removes the flag, so a later run may legitimately
  flag afresh, but an open dismissal decision is never silently overridden.

## [0.11.0] — 2026-06-12

### Removed

- **6 admin/redundant MCP verbs — the agent-facing surface is now 9 verbs.**
  Removed `start_context` (the injected primer covers it), `propose_memory`
  (subsumed by `remember`), and `archive_memory` / `approve_proposal` /
  `list_proposals` / `update_memory` (admin/curatorial — they remain on the
  dashboard tRPC and in the curator, just no longer exposed to agents). The
  agent MCP is now exactly **9 verbs** (`recall`, `remember`, `flag_memory`,
  `store_handoff`, `list_handoffs`, `claim_handoff`, `list_skills`, `get_skill`,
  `search_references`) plus the 3 internal `conv_state_*` injection tools.
  Underlying store methods + tRPC procedures are unchanged. **Breaking** for any
  agent/plugin calling a removed verb (the plugin hooks move off them in the
  coordinated plugin releases). Finalizes ADR 0006 / plan 048 PR-4.

### Changed

- **Removed the bundled "how to use The Librarian" skill** (`skills/use-the-librarian/`)
  and aligned the in-repo docs (`docs/slash-commands.md`, `.claude/commands/*`,
  `README.md`, `SOUL.md`, `DEPLOYMENT.md`) to the 9-verb surface. Per ADR 0006,
  the injected primer + the tools' own descriptions are the teaching surface — no
  auto-loaded skill. Surviving verb descriptions sharpened to behavioural docs.

## [0.10.0] — 2026-06-12

### Added

- **`list_skills` MCP verb.** A simple `list_skills()` returns the server-hosted
  skill catalog (`{ slug, name, description }[]`); pair it with `get_skill` to
  fetch a skill's full document. Replaces the skills half of the removed
  `session_manifest`.
- **Working-style preamble now rides the injected primer.** The `working_style`
  setting (previously surfaced by `session_manifest`) is appended to the
  awareness primer that `conv_state_get` injects every turn — fail-soft, so a
  missing/secret-stored value degrades to just the awareness note. (plan 048 PR-3)

### Removed

- **`find_skills` and `session_manifest` MCP verbs.** `find_skills` (ranked skill
  search) is replaced by `list_skills` for the now-small catalog — the ranking
  helper stays in core, re-introducible later. `session_manifest` is split:
  skills → `list_skills`, working-style → the injected primer (above). Both are
  added to the healthcheck's retired-tools guard.

## [0.9.0] — 2026-06-12

### Added

- **Dashboard: a "Flagged" review queue for `flag_memory`.** A new **Flagged**
  nav tab + page lists every memory with an open flag, showing each flag's
  reason, the flagging agent, and when — with per-row **Dismiss** (clear the
  flags, keep the memory active) and **Archive** (archive + clear) actions.
  Backed by two admin-only tRPC procedures, `memories.listFlagged` and
  `memories.resolveFlag`. This is the human/curator adjudication surface for the
  route-to-review flags introduced in 0.8.0 (plan 048 PR-2).

## [0.8.0] — 2026-06-12

### Added

- **`flag_memory(memory_id, reason)` MCP verb.** An agent can flag a recalled
  memory it believes is incorrect, misleading, or outdated, with a short
  free-text `reason`. The flag is **route-to-review**: it appends to a `flags`
  list in the memory's frontmatter (the same storage method `proposed` uses — no
  separate ledger), leaves the memory `active`, and **soft-demotes** it in recall
  (ranked below unflagged matches, never excluded) until a human/curator
  adjudicates. The flagger is the authenticated caller (a contradicting
  client-supplied `agent_id` is rejected); an empty or oversized `reason` is
  refused. Implements the first slice of the agent-facing MCP surface redesign
  (ADR 0006).

### Removed

- **`verify_memory` MCP verb (replaced by `flag_memory`).** The gameable
  `useful`/`not_useful`/`outdated` signal — and its agent-driven *immediate
  archive* (`outdated`) — are gone. There is no "this memory was correct" signal;
  recall leans on passive usage + the new flag demotion. A tool-registry contract
  test now pins the agent-facing surface against accidental drift.

## [0.7.4] — 2026-06-11

### Changed

- **ADR 0006 — agent-facing MCP surface (accepted).** A decision record only (no
  code change): slims the MCP from 19 tools to **9 agent verbs** (`recall`,
  `remember`, `flag_memory`, the handoff trio, `list_skills`, `get_skill`,
  `search_references`), replacing `verify_memory` with a route-to-review
  `flag_memory(memory_id, reason)`, relocating `conv_state_*` off the agent tool
  surface (deferred follow-on), and keeping all admin/curatorial operations on
  tRPC/in-process. **Accepted** — Spec 047 + Plan 048 approved; implementation
  underway as a coordinated cross-repo change. See
  `docs/adr/0006-agent-facing-mcp-surface.md`.

## [0.7.3] — 2026-06-11

### Added

- **Brand watermark behind the dashboard.** A large, faint Librarian mark is
  fixed and centred behind every page's content (decorative — `aria-hidden`,
  `pointer-events-none`, `-z-10`, so it never intercepts clicks). The small nav
  logo stays. It's the light (dark-ink) variant, subtle on the default light
  theme and near-invisible on dark.

## [0.7.2] — 2026-06-11

### Added

- **Logo in the top nav.** The Librarian mark
  (`assets/logo/the-librarian-mark-vector-light.svg`) now sits at the start of
  the persistent top navigation, linking home. The web copy lives in
  `apps/dashboard/public/`. It's the light (dark-ink) variant, suited to the
  default light theme; a dark-theme variant can be swapped in via a `dark:` rule
  once one exists.

## [0.7.1] — 2026-06-11

### Added

- **Dashboard favicons + PWA manifest.** Wired the full icon set
  (`assets/icons/`) into the dashboard: SVG + sized PNG favicons, the
  `apple-touch-icon`, the Windows tile, and `site.webmanifest` (installable PWA
  with the brand theme colour `#061B22`). The web set lives in
  `apps/dashboard/public/`; the masters stay in `assets/icons/`. Previously the
  dashboard shipped no favicon at all.

## [0.7.0] — 2026-06-08

### Added

- **Memories page: select-all / deselect-all.** A select-all control sits above
  the row checkboxes and toggles every memory on the current page in one click
  (showing an indeterminate state for a partial selection), so a whole page can
  be fed to the bulk re-home flow without ticking each row.
- **Archive page: checkboxes + permanently delete archived memories.** The
  Archive page now has per-row checkboxes, a select-all control, and a
  **Permanently delete (N)** action. Deletion is gated behind a confirmation
  modal that lists the selected memories and warns it can't be undone from the
  app. Backed by a new admin-only `memories.purge` tRPC mutation and a
  `purgeMemory` store primitive that **hard-deletes the vault document** (the
  narrow exception to "archive = move, never destroy"); the disposable index
  drops the row on rebuild. Guarded to **archived-only** — an active or proposed
  memory must be archived first, so a one-click delete can never hit a live
  memory. Each purge is a git commit, so a deletion remains recoverable from
  history by an admin even though it's gone from the app, recall, and the index.

## [0.6.2] — 2026-06-08

### Changed

- **Release runbook slimmed to the automated model.** Now that all five plugin
  repos (Claude, Codex, Hermes, OpenCode, Pi) have the same release-on-merge
  workflow + `release-guard` as the monorepo, `docs/release-runbook.md` drops the
  per-plugin manual `git tag` / `gh release` / `npm publish` command blocks and
  the "⏳ migrating" labels. It now documents one unified flow — bump the version
  file(s) + a dated CHANGELOG entry in your PR; the merge tags, releases, and (for
  the npm packages) publishes automatically — plus a per-repo version-file +
  user-update table. Docs only.

## [0.6.1] — 2026-06-08

### Changed

- **Release process: merging to `main` is now the release — no more
  `[Unreleased]`.** Every PR bumps the root `package.json` and files its notes
  under a dated `## [X.Y.Z]` heading in the same PR; the CHANGELOG no longer
  carries an `[Unreleased]` section. A new **Release** workflow
  (`.github/workflows/release.yml`) auto-creates the `vX.Y.Z` git tag + GitHub
  release on the version-bumping merge to `main`, and a `check:release` CI guard
  fails any PR that leaves an `[Unreleased]` section, forgets the version bump,
  or desyncs `package.json` from the top CHANGELOG entry. `AGENTS.md`,
  `docs/release.md`, and `docs/release-runbook.md` are updated to the new model;
  the old separate-release-branch flow is retired. No runtime behaviour change.

## [0.6.0] — 2026-06-08

### Added

- **Curator dashboard: editable cadences + clear run-now reasons.** The Curator
  page now exposes both job schedules as editable controls — Intake shows *Run
  every [N] minutes* and Grooming shows *Run every [N] days at [HH:MM]* (with a
  *1 = nightly · 7 = weekly · 30 ≈ monthly* hint) — saved over the existing
  admin tRPC config surface and taking effect on the next poll (no restart).
  Both controls validate client-side (whole number ≥ 1) and surface the server's
  teaching error inline when a value is rejected. **Run now** no longer fails
  silently: when a run does nothing it reports a clear reason — *automatic runs
  are disabled (Run now still works)*, *no model configured*, *no LLM token
  configured*, or *nothing to do* — instead of a bare no-op. The enable toggles
  are unchanged.

- **Configurable intake sweep interval — `curator.intake.interval_minutes`.**
  The intake (consolidator) job's inbox-sweep cadence is now a setting — *run
  every N minutes* (positive integer, **default 5**) — replacing the hard-coded
  poll interval. Validated (`interval_minutes must be an integer >= 1`) and read
  without the master key (the cockpit render path). The scheduler wiring +
  dashboard control land in follow-up tasks.

- **Configurable grooming schedule — `curator.grooming.interval_days` +
  `curator.grooming.schedule_time`.** The grooming curator now reads a
  wall-clock cadence — *run every N days at HH:MM* (server-local time), default
  *every 1 day at 03:00* (nightly at 3 AM; 7 = weekly, ~30 = monthly). The
  auto-apply policy keys move under the job namespace too
  (`curator.default_auto_apply` → `curator.grooming.default_auto_apply`,
  `curator.auto_apply_confidence` → `curator.grooming.auto_apply_confidence`).
  A seed-once, no-clobber migration carries an existing install's settings into
  the new keys (the legacy `curator.schedule.{time,interval_days}` and the
  un-prefixed policy keys map 1:1), so behaviour is preserved across the
  upgrade. Both new settings are validated (`interval_days` integer ≥ 1;
  `schedule_time` 24h `HH:MM`) and settable via the `curator.setConfig` admin
  API. (Scheduler wiring + dashboard controls land in follow-up tasks.)

- **Configurable grooming run size — `curator.grooming.max_memories`.** The
  grooming curator now reads a per-run cap on how many active+proposed memories
  a single run feeds the model, wired through the tick into every run's evidence
  gather and settable via the `curator.setConfig` admin API. This bounds a run
  so one oversized slice can't exceed the LLM timeout — the cause of a
  production incident where a ~60-memory global slice failed every scheduled run
  with `llm_timeout` (a slow model couldn't process the whole slice in 60s, and
  the failed slice re-ran forever). **Default 200** (the prior implicit cap), so
  existing installs are unchanged; lower it for slow models / large slices.
  Truncation is newest-first, so a cap below the slice size leaves the oldest
  memories ungroomed until they next change — an informed trade-off documented
  in [ADR 0005](docs/adr/0005-bounded-grooming-runs.md), with automatic
  full-coverage bounding (chunking / rotation) proposed as the follow-up.

### Changed

- **Internal naming aligned to the Intake / Grooming / Curator vocabulary
  (code-symbol rename only — no behaviour change).** Job-named code symbols,
  files, and the eval package were renamed so the codebase reads the way the
  product talks: `consolidator` → `intake` everywhere it named a code identifier
  (including the `@librarian/consolidator-eval` package → `@librarian/intake-eval`
  and its `consolidator-eval` bin → `intake-eval`), and the **grooming-sense** of
  `curator` → `grooming` (e.g. `runCuratorTick` → `runGroomingTick`,
  `CuratorConfig` → `GroomingConfig`, the dashboard `CuratorConfigForm` /
  `CuratorRunsTable` / `CuratorChatWorkspace` and their actions → `Grooming*`).
  **"Curator" is retained as the umbrella** for the two jobs — the dashboard
  "Memory Curator" page + `/curator` route, the `curator.<job>.*` settings
  namespace, the `curator_note` field, and the `Curation*` projection are
  deliberately unchanged. Persisted provenance kept stable for compatibility:
  the `system-consolidator` actor-id values and the `LIBRARIAN_CONSOLIDATOR*`
  env-var names are untouched; only the opaque `curator_note.source` writer
  flips from `"consolidator"` to `"intake"` on newly-filed memories. A CI
  `check:naming-canon` guard now fails the build if a job is renamed back to
  `consolidator`/`curator`. No runtime behaviour changes.

- **Enabling/disabling a curator job — and changing its cadence — now takes
  effect on the next poll, with no server restart.** The Intake and Grooming
  schedulers are now created **unconditionally** at boot (whenever their poll
  interval is > 0), mirroring the backup scheduler; each tick **self-gates** on
  its dashboard toggle (`curator.intake.enabled` / `curator.grooming.enabled`),
  so a disabled job is a cheap no-op and flipping the toggle starts (or stops)
  the work on the next tick. Previously the schedulers were only created when the
  job was enabled at boot, so a toggle required a restart to take effect.
  - The **Intake sweep cadence is now runtime-effective**: the scheduler polls on
    a fixed short floor (`LIBRARIAN_CONSOLIDATOR_TICK_MS`, default **60s**) and
    sweeps only once `curator.intake.interval_minutes` have elapsed since the last
    sweep, so editing the interval changes the effective sweep gap on the next
    poll — no restart. The effective gap is `max(interval_minutes, poll-floor)`.
  - The **Grooming schedule** runs on its own poll (`LIBRARIAN_GROOMING_TICK_MS`
    — *not* the retired `LIBRARIAN_CURATOR_TICK_MS`; default **15 min**) calling
    the scheduled-grooming entry, which checks the wall-clock schedule
    (`curator.grooming.{interval_days,schedule_time}`) and runs a pass when due —
    so editing the schedule also takes effect without a restart. This
    **re-introduces a wall-clock grooming schedule that 0.5.0 had removed** (0.5.0
    retired the wall-clock cron and made grooming intake-triggered only); the
    schedule now runs alongside that trigger.
  - The boot banner now reports each job's **live** enable state as two distinct
    jobs (`intake: on|off`, `grooming: on|off`) read at log time.
  - Legacy `curator.schedule.*` keys are **migrated** into the
    `curator.grooming.*` schedule at boot before the legacy-key notice; that
    notice no longer says the keys are "ignored" — it confirms they were migrated
    and can be deleted.

- **Grooming no longer skips recently-groomed slices on a pass — the per-slice
  time-interval gate is retired.** A scheduled or run-now grooming pass now
  attempts **every** slice; the existing content **input-hash idempotency**
  (a slice whose evidence is unchanged since its last completed apply-run makes
  **no LLM call**) is the sole gate deciding which slices actually do work.
  Previously a per-slice "every N minutes" interval gate (`curator.interval_minutes`,
  default 60) could skip a slice that had groomed within the last hour even on a
  forced pass. Net effect: a pass re-grooms only the slices whose content has
  changed (a `bypassSkip` run-now still re-runs everything), and the schedule
  (every N days at HH:MM) — not a per-slice timer — decides *when* a pass runs.
  This fully retires the vestigial `curator.interval_minutes` cadence setting and
  removes the per-slice interval control from the Curator config form. (The legacy
  key is still read once by the enablement migration to seed the auto-groom
  debounce floor, `curator.grooming.debounce_minutes` — that is unchanged.)

- **Admin "Run now" works on a disabled job (behaviour change).** Clicking *Run
  now* on the Intake or Grooming job in the cockpit now runs a one-off pass even
  when that job is **disabled** — an explicit admin override. Previously both
  run-now controls refused a disabled job (intake returned
  `{ran:false,reason:"disabled"}`; grooming self-gated on `curator.enabled`
  before running), so an operator had to enable a job just to test it. The
  enable gate is now bypassed only on the run-now path (the scheduled tick still
  does nothing when a job is disabled). The LLM-config/token gates still apply —
  a disabled-but-unconfigured job returns a clear `incomplete_config` / `no_token`
  reason (never `disabled`) for the cockpit to display.

### Fixed

- **The grooming/intake boot scan now respects the timer-off switch
  (`*_TICK_MS=0`) — disabling a job's poll timer disables its automatic curation
  entirely.** Each job kicks one pass at boot (before the first poll fires), but
  that boot scan is now **gated on the job's scheduler being live**: setting
  `LIBRARIAN_GROOMING_TICK_MS=0` (or `LIBRARIAN_CONSOLIDATOR_TICK_MS=0`) now means
  *no automatic grooming/intake at all* — not "no timer, but still one pass on
  every restart". Previously the boot scan ran unconditionally, so a server with
  the grooming timer off still groomed the whole corpus at each startup. Run-now
  and the dry-run / re-evaluate admin paths bypass the schedulers and are
  unaffected. (Surfaced as a test-determinism regression: a boot-time grooming
  pass was auto-applying/proposing into a freshly-seeded corpus before a dry-run
  or re-evaluate could act on it.)

- **`propose_memory` now goes through the curator instead of writing around it.**
  Previously `propose_memory` wrote a standalone proposal directly — bypassing the
  inbox, so it got **no dedup or merge** (an obvious restatement of an existing
  memory became a duplicate proposal, and on approval a duplicate active memory),
  and it slipped past the under-evaluation gate that holds an unproven curator
  prompt's output for review. It now **submits to the consolidator inbox with a
  force-proposal directive** (when intake is enabled): the curator dedups and
  merges it like any submission, but it **always terminates as a proposal**, never
  an auto-apply. The proposal therefore lands after the next consolidator tick
  (the tool now replies "queued for review") rather than synchronously. When
  intake is off, the legacy direct write remains — but now **surfaces detected
  duplicates** in its response, matching `remember`. See
  [ADR 0004](docs/adr/0004-propose-memory-routes-through-inbox.md).

## [0.5.0] — 2026-06-07

### Added

- **Awareness primer — a dashboard-editable note that tells every agent it has
  durable memory.** A new admin setting (**Settings → Awareness primer**) holds a
  short, server-sourced note (shipped with a sensible default, pre-filled) that
  will be injected **every turn on every harness** — reminding the model that The
  Librarian exists and which verbs to reach for (`recall` before asking,
  `remember` / `/learn` to save). Editing it changes what the next turn sees with
  no plugin redeploy; **clearing it to empty disables the primer**. The server now
  returns the primer as an **additive `primer` field on every `conv_state_get`
  response** — both when a conversation-state row exists (alongside the existing
  row fields, so un-updated plugins are unaffected) and when none does — so it is
  available on the very first turn and on harnesses without a stable conversation
  id; reads are fail-soft (`""` on an unreadable settings store, never blocking a
  turn). Per-turn injection of the `<librarian>` block reaches each harness as its
  plugin adopts the new field (rolling out incrementally, backward-compatibly).

- **The curator now self-improves under your supervision.** You can teach each
  curator job — **Intake** and **Grooming** — by editing its **prompt addendum**,
  a per-job vault file (`<vault>/.curator/grooming-addendum.md` and
  `intake-addendum.md`) that is **git-versioned**, so every edit gets diff,
  revert, and backup for free; an existing install's old single
  `curator.prompt_addendum` is migrated into the grooming file byte-for-byte and
  retired automatically. **Both jobs now consume their addendum on the live
  path** (intake previously didn't). Editing an addendum puts that job **under
  evaluation**: every operation it would have auto-applied is instead **proposed**
  for your review (auto-archives are skipped), tagged with the addendum version,
  until you **Accept** (resume auto-apply), **Roll back** (`git checkout` the
  prior version), or — for grooming — **Re-evaluate** that version's proposals.
  Grooming can also **dry-run** a candidate addendum over the whole corpus or a
  single slice in propose-mode **without committing it live**. A new **curator
  chat** (a "discuss this memory" button on each memory row plus a general entry)
  grounds in a memory and its decision history and can **propose** a fix-now
  mutation — **merge / split / update / unmerge** (unmerge reverses a bad groom)
  — or an addendum edit, which **you confirm** with an explicit button: the
  curator proposes, never executes on its own. There is **no automated evaluation
  gate** — the addendum is **advisory** (the curator's hard, safety, and
  structural rules stay code-re-checked regardless of it), and the guards are a
  human judging real results, a 2 KB addendum cap (soft in-chat condense + hard
  write backstop), the under-evaluation lifecycle, and dry-run. Everything is
  **admin-only** — there is no agent-facing surface and recall/navigate are
  untouched.

- **Unified Memory Curator dashboard — one page, two jobs.** The Memory Curator
  page now presents both curator jobs side by side in clear **Intake** and
  **Grooming** sections, each with its own enablement toggle, model
  configuration, recent-run history, and a run-now button. Shared LLM provider
  management lives once, above both sections (it serves both jobs). The Intake
  section makes consolidation **observable for the first time**: each run expands
  to reveal its decisions — the action taken, whether it was applied, proposed,
  skipped, or failed, the confidence, and the rationale — so you can see exactly
  what intake did with each new submission. Run-now clearly reports when nothing
  ran and why (disabled / incomplete config / no token). Everything stays
  admin-only.

- **Intake can now propose splitting an overloaded memory at ingestion.** When a
  new submission turns out to be primarily about a different, already
  well-supported entity whose existing doc has become an overloaded grab-bag, the
  intake judge can now propose a **split** — spinning that conflated doc into
  focused per-entity docs. An intake split is **always a proposal for you to
  approve, never applied automatically** (even at high confidence): intake lacks
  grooming's whole-corpus context, so a human decides every split. The scope is
  deliberately narrow to avoid over-fragmentation — a single-entity or
  non-overloaded submission never splits, and the split target must be one of the
  memories intake already retrieved as a candidate. (Grooming's existing split is
  unchanged; both now share one underlying mechanism.)

- **Dashboard-managed LLM providers with independent per-consumer model
  selection.** The curator's LLM connection is no longer a single hard-coded
  block — you now manage named LLM providers (name + endpoint + write-only API
  token) on the Memory Curator page, and the two curator consumers, **intake**
  (inbox consolidation) and **grooming** (memory curation), each pick their own
  provider *and* model independently, so they can run on different models (and
  providers) while reusing one stored connection. The model field offers a probed
  dropdown of the provider's available models with a free-text fallback, and a
  "Test connection" check (tokens are sent only as a `Bearer` header, never echoed
  back). Existing installs are migrated automatically on the first curator/
  consolidator run: the old single `curator.llm.*` config is converted one-time
  into a `default` provider that both consumers point at, then the legacy config
  is retired. The migration is fail-soft — if the master key is temporarily
  unavailable it defers and retries on a later run, never losing your token.

### Changed

- **The curator's prompt addendum is now a git-versioned vault file.** Each
  curator job's advisory prompt addendum moves out of a single overwritten
  setting into a committed vault file (`<vault>/.curator/grooming-addendum.md`,
  and `intake-addendum.md` for intake), so edits get git history, diff, and
  revert for free. An existing install's `curator.prompt_addendum` is migrated
  into the grooming file **byte-for-byte automatically on first start** and the
  old setting is retired — no operator action needed. (Editing these files, the
  under-evaluation lifecycle, dry-run, and the curator chat are described under
  the self-improving-curator entry in **Added** above.)

- **Consistent "one curator, two jobs" naming across the product.** User-facing
  surfaces now describe a single curator doing two jobs — **Intake** (consolidates
  new submissions) and **Grooming** (tends the existing corpus) — rather than
  exposing the older internal "consolidator" name. The dashboard model labels,
  the `remember` queued-for-consolidation reply, the agent skill doc, and the
  README curator section are updated to match. No behaviour change.

- **Both curator jobs' enablement is now a dashboard setting; the
  `LIBRARIAN_CONSOLIDATOR` env var is deprecated.** Grooming and intake are now
  enabled/disabled from settings under the unified `curator.*` namespace
  (`curator.grooming.enabled` / `curator.intake.enabled`) instead of the old
  `curator.enabled` setting (grooming) and the `LIBRARIAN_CONSOLIDATOR`
  environment variable (intake). Existing installs are migrated automatically on
  the first boot — your exact enablement is preserved (grooming-on stays on,
  `LIBRARIAN_CONSOLIDATOR=on` becomes intake-on) — and the migration is
  idempotent and never overwrites a value you have since set. The setting is now
  authoritative: `LIBRARIAN_CONSOLIDATOR` no longer controls intake (it only
  seeds the setting once), so toggling intake from the dashboard takes effect.
  **Action:** remove `LIBRARIAN_CONSOLIDATOR` from your environment — it logs a
  deprecation warning on boot while still set, and will be removed in a future
  release. (`LIBRARIAN_CONSOLIDATOR_TICK_MS`, the tick cadence, is unaffected.)

- **Grooming no longer runs on a wall-clock cron — it is triggered.** Memory
  grooming (curation) previously ran on a timer; it now runs only when you click
  **Run now** or when intake has changed enough memories to warrant it. After an
  intake sweep, if intake has created/augmented/superseded at least
  `curator.grooming.trigger_threshold` memories (default 20) since the last groom,
  one grooming run is enqueued — rate-limited so it never auto-runs within
  `curator.grooming.debounce_minutes` (default 60, seeded once from your old
  `curator.interval_minutes`) of the previous one. Due-slice idempotency is
  unchanged, so a triggered groom still only reprocesses slices whose input
  actually changed. The wall-clock cron (`LIBRARIAN_CURATOR_TICK_MS`) is retired.

### Removed

- **Dashboard `/logs` and `/recall` pages removed.** Both rendered the
  append-only event ledger, which is retired on the markdown backend, so both
  were permanently empty. Live recall already lives on the Memories page; the
  audit trail lives in git history. The backing `memories.events` /
  `memories.byIds` tRPC procedures and the always-empty "By category" / "By
  scope" analytics dimensions are dropped with them.

- **The SQLite storage backend is gone — markdown is the only backend.** The
  `node:sqlite` event-ledger store, its projection/replay layer, and the
  `LIBRARIAN_BACKEND` / `resolveBackend` / `StorageBackend` selector are removed;
  `createLibrarianStore` now always returns the git-vault markdown store. Memory,
  curation, settings, conversation-state, and handoff data live in the vault (+
  sidecar JSON for non-memory state), exactly as the shipped product already
  defaulted to. The append-only event ledger is retired (git history is the audit
  trail), so the now-empty `BACKUP_REQUIRES_MARKDOWN` error export and the
  SQLite-era `memory.classified` / `classifier.evaluation_completed` event schemas
  are dropped. The `check:no-store-bypass` CI guard (which sealed the
  SQLite-handle seam) is retired with the seam it guarded.

- **The retired event-ledger schema layer is gone.** With the event ledger
  retired on the markdown backend (git history is the audit trail), the
  `MemoryLedgerEntry` discriminated union and its 14 member schemas
  (`MemoryCreated`/`Proposed`/`Updated`/`Approved`/`Rejected`/`Deleted`/
  `Archived`/`Recalled`/`RecallEmpty`/`Verified`/`UsefulnessAdjusted`/
  `BulkUpdated`/`ConflictDetected`/`ConflictResolved`), plus the `MemoryEventType`
  enum and `MemoryEventTypeSchema`, had no remaining producer or consumer and are
  removed from `@librarian/core`. The runtime `MemoryEvent` store type (a plain
  `event_type: string`) is unaffected.

### Changed

- **Proposals screen shows full memory text.** The Proposals review list no longer
  clamps a proposed memory's body to two lines — it renders the full body with
  preserved line breaks, so a proposal can be read and judged without opening it
  elsewhere. The Archive list keeps its two-line preview (the new `expandBody` prop
  on `SimpleMemoryList` defaults to the clamped behaviour).

- **`backup.github.repo` is validated as an `owner/repo` slug at the config
  boundary.** A malformed value (a bare repo name, a full URL, junk) used to fail
  deep in the `git push` with a confusing message; the dashboard `backup.setConfig`
  procedure now rejects it up front with a teaching error that shows the expected
  shape and echoes the bad value (e.g. `Expected "owner/repo" (e.g.
  "octocat/hello-world"), got "hello-world"`), never any token. An empty/unset repo
  stays allowed.

- **Agent guidance: the curator owns consolidation.** The `use-the-librarian`
  skill no longer tells agents to recall/search for duplicates before
  `remember`, or to hand-consolidate via `update` + `verify(outdated)` — the
  consolidator/curator de-duplicates, merges, and supersedes asynchronously
  (with the consolidator on, `remember` is fire-and-forget and returns no
  `duplicates` list). The `/learn` command drops its stale `conv_id`→`domain`
  resolution and "classifier worker" references. Docs accuracy: README drops the
  retired `domain` handoff scope, the removed `/logs` + `/recall` dashboard tabs,
  and the stale "JSONL ledgers + SQLite/FTS5 index" storage line (it's a
  git-backed markdown vault now); the skill's storage example is updated to match.
  (The harness plugin repos carry the same agent-guidance fix.)

- **The per-turn `<conversation-state>` block is trimmed to `conv_id` +
  `off_record`.** D16 had already removed the `domain` line from the canonical
  renderer; the `session_id` line is now dropped too — the session lifecycle that
  populated it is retired, so it was always `none`. `off_record` (the privacy
  signal) and `conv_id` (the key) remain. The five harness plugins, which mirror
  this block byte-for-byte, are updated in lockstep.

- **Backup is now `git push` of the memory vault.** On the markdown backend the
  old backup bundled an empty `librarian.sqlite` (memories live in the git vault,
  not SQLite) — so it backed up almost nothing. Backup now pushes the vault repo
  to a GitHub remote built from the `backup.github.{repo,token}` settings, and a
  restore is a `git clone`. The token is supplied to git via a `GIT_ASKPASS`
  helper, so it never appears in the remote URL, `.git/config`, the process
  command line, or git's error output. The v0.4.0 `VACUUM INTO` / gzip-bundle /
  checksummed-manifest / staged-restart-restore machinery, the **S3 target**, and
  bundle retention are retired (git history is the retention). Backup run history
  moved to a sidecar `backup-runs.json`. The dashboard `/backups` page now
  configures the GitHub remote + schedule; the CLI `the-librarian backup` pushes
  the vault. A new `check:no-secrets-in-vault` CI guard asserts secrets never land
  in the pushed vault. **Secrets are not auto-backed-up** — save your
  `LIBRARIAN_SECRET_KEY` (shown once on first boot); other settings are
  re-enterable via the dashboard. **Restore** clones the backup repo into a staging
  dir, then swaps it in on the next restart (never under the live store), keeping
  your current vault as `vault.pre-restore.bak` — available from the dashboard
  `/backups` page (validate-before-swap, restart-gated, reversible) and applied at
  boot before the store opens.

- **Consolidator curation prompt → v3.** Two additions to the judge's "ways of
  working": (1) **title-craft** — write a concise, entity-first noun phrase (the
  title is also the memory's filename now), avoiding category prefixes, colons, and
  sentence/status-style titles; (2) a **gatekeeping bias** — `noop` (discard)
  submissions that are obviously transient or low-value (one-off task notes,
  resolved bugs/typos, ephemeral status) rather than cluttering the library, while
  still filing anything of genuinely unclear value. `CONSOLIDATOR_PROMPT_VERSION`
  bumped v2 → v3.

- **Memory files now have human-readable names.** A memory is written to
  `memories/<title-slug>-<shortid>.md` (e.g. `role-and-responsibilities-2dd76e5c.md`)
  instead of `memories/<id>.md` — far easier to browse, diff, and maintain by hand.
  The id suffix keeps names unique; the filename is set once at creation and never
  renamed (the frontmatter id + title stay authoritative). The store now resolves a
  memory's file by its frontmatter id, so existing `<id>.md` files keep working
  unchanged — no migration needed.

### Fixed

- **Recall no longer embeds references it never queries.** The recall index built
  both the corpus (memories) and the references tier eagerly, but `recall` only
  ever queries the corpus — references are searched through the separate
  `search_references` path. Embedding every reference on each index build was pure
  waste, and brutal when references are large (a single 553 KB reference is a ~10s
  embed under the real model, so a groom over a reference-heavy vault stalled for
  minutes before processing a single memory). References are now embedded lazily —
  only when `search_references` is actually called. (`search_references`'s own
  per-call cost is tracked separately in docs/TODO.md.)

- **The vault always gets its own git repo, even when nested in another checkout.**
  The store inits the vault as a git repo (a commit per write), but the init guard
  treated "inside *any* repo" as done — so a data dir placed under an existing git
  checkout skipped init and committed every memory write into that *parent* repo
  (running `git add -A` over its whole working tree). The guard now checks whether
  the vault is its own repo *root*, creating a dedicated repo when nested. A
  standalone/Docker `./data` was unaffected; this only bit vaults under a checkout.

- **Recall no longer re-embeds the whole corpus on every write.** The disposable
  recall index is rebuilt (and every active memory re-embedded) whenever a memory
  is written; a bulk groom — consolidating many inbox items one at a time — did
  that once per item over a growing corpus, i.e. O(N²) embeddings. Under the real
  CPU model (EmbeddingGemma) that made a large groom (e.g. a seed import of a few
  hundred memories) glacial. The store now memoizes document embeddings by content
  across rebuilds, so each distinct memory embeds once per sweep (O(N)); queries
  are never cached.

- **Recall no longer crashes on long documents.** EmbeddingGemma threw "Input is
  longer than the context size" on any doc over its ~2048-token window, failing
  the consolidator's navigate step for that item. Long inputs are now truncated to
  the model's context window before embedding (a truncated embedding still
  captures the gist for recall).

### Changed

- **Consolidator curation prompt → v2.** The judge prompt now states the
  *judgement* behind a filing choice, not just the output contract: preserve over
  rewrite (augment rather than supersede unless genuinely contradicted), calibrate
  confidence honestly so an ambiguous-entity merge scores low (and files fresh
  rather than clobbering the wrong target), resolve entities cautiously, and file
  for retrieval (`[[wikilink]]` both sides of a multi-entity fact). Affects only
  the opt-in consolidator; `CONSOLIDATOR_PROMPT_VERSION` bumped v1 → v2.

- **The shipped server + CLI now default to the markdown backend** (the plan-036
  cutover): the git-backed vault for memories/handoffs, sidecar JSON for
  conv-state/settings, the disposable hybrid index for recall. `LIBRARIAN_BACKEND=sqlite`
  is the explicit opt-out. The Docker images now include `git` (the markdown
  backend commits every write). A residual SQLite db still backs the dormant
  curator until Phase 4. **Upgrading:** existing data in `librarian.sqlite` is
  NOT auto-migrated to the vault yet (the migration tool is a follow-up) — an
  upgraded install defaults to an empty markdown vault; set `LIBRARIAN_BACKEND=sqlite`
  to keep using your existing data until migration lands.

### Added

- **`@librarian/consolidator-eval` — the consolidator evaluation harness.** An
  operator-driven package (mirroring `@librarian/classifier-eval`) that scores the
  consolidator's `navigate → judge → route` pipeline against S1/S2/S4/S12/S18
  fixtures: filing accuracy, decision-band routing, no-clobber of hand-authored
  prose (S18), contradiction-recall (S4), and entity-resolution under ambiguity
  (S12). Ships a `consolidator-eval` CLI with a frozen-baseline regression gate
  (`--update-baseline` / `--baseline … --gate`). Not part of CI (it calls a real
  model); its own tests drive the pipeline with a deterministic scripted model.

- **The consolidator — opt-in async memory filing (plan-036 Phase 4).** With
  `LIBRARIAN_CONSOLIDATOR=on` on the markdown backend, `remember` becomes a
  fire-and-forget submission: the note is queued to a vault inbox and an LLM
  consolidator files it asynchronously (navigate the existing memories → judge
  whether to augment/supersede an existing one or create a new memory →
  minimal-edit in place, preferring `[[wikilinks]]` over duplication), carrying
  the submitter's `agent_id`/`project_key`/`tags`/`applies_to`. A serial scheduler drains the
  inbox on a cadence (`LIBRARIAN_CONSOLIDATOR_TICK_MS`, default 5 min) plus a
  boot scan; it shares the curator's LLM brain config. **Default off** — when
  disabled (or on the sqlite backend, which has no vault inbox), `remember` keeps
  its existing direct-write behaviour unchanged.

- **EmbeddingGemma wired as the production embedder** for index recall +
  `search_references` (`resolveEmbedder`). Selection is env-driven:
  `LIBRARIAN_EMBEDDER=hash|llama` (default: hash under tests, the EmbeddingGemma
  model otherwise). The GGUF (`EmbeddingGemma-300M-Q8_0`, ~333 MB) is downloaded
  - cached lazily on first embed under `<dataDir>/models`, or supply your own via
  `LIBRARIAN_MODEL_PATH`. The model loads only on first use, so nothing downloads
  during boot/healthcheck.

- **`search_references` MCP tool (F3/F4).** Tier-0 lookup over the vault's
  `references/` — background reference docs that are deliberately kept out of
  normal recall. Returns each match's path + the query-relevant section (so the
  agent pulls just the matched section, not the whole file). Backed by the
  disposable hybrid index; backend-independent (references live in the vault).

- **Real embedding model via `node-llama-cpp` (F2).** `createLlamaEmbedder` runs a
  GGUF embedding model on CPU (default **EmbeddingGemma-300M**, 768-dim, multilingual)
  behind the pluggable `Embedder` interface, with asymmetric query/document prompts
  (`embedQuery`). It's lazy-loaded, so the bundled deterministic hash embedder stays
  the zero-dependency default for tests/CI and nothing loads the native binary until
  the model is actually used. The GPU (CUDA/Vulkan) prebuilt binaries are stripped at
  install via `.pnpmfile.cjs`, keeping the dependency footprint ~60 MB.

- **Skills (read surface) — `find_skills`, `get_skill` MCP tools (F7).** Skills live
  as `skills/<slug>/SKILL.md` (+ optional `resources/`) in the vault; `find_skills`
  ranks the manifest (name + description) against a query, and `get_skill` returns a
  skill's full document plus its resource file list. Backend-independent (vault-based),
  fail-soft on bad input. Semantic ranking currently uses the bundled deterministic
  embedder; the production model is a drop-in via the same interface.
- **`session_manifest` MCP tool (F6, server side).** Returns the session-start
  manifest the client hook consumes: the working-style preamble (from the
  `working_style` setting) plus a bounded skills manifest.

### Changed

- **`recall` is no longer domain-scoped (D16, memory side).** Results rank by
  relevance across all memories instead of being filtered to the caller's
  conversation domain; the `conv_id` and `include_other_domains` arguments are
  removed from `recall`, and `remember` no longer derives or routes writes by
  domain. This is the first step of removing memory-domain-isolation entirely
  ("relevance from retrieval, not walls"); the `domains` management surface,
  handoff/conv-state scoping, and the SQLite domain columns are removed in
  follow-up D16 PRs.
- **Handoffs are no longer domain-scoped (D16).** `store_handoff` / `list_handoffs` /
  `claim_handoff` and the dashboard + CLI handoff views drop the per-domain isolation
  and the `conv_id` / `domain` arguments; the shared `domain-resolution` helper is
  removed. (The vestigial `handoffs.domain` column is dropped with the rest of the
  schema in the final D16 PR.)
- **The domain model is fully removed (D16, final step).** The owner-managed
  `/domains` dashboard page (and its tRPC `domains` router) is gone; conversation
  state no longer carries a `domain` (the `conv_state_upsert` tool and the per-turn
  `<conversation-state>` block drop the field, and first-create now requires only
  `harness`). The SQLite schema drops the `domains` / `signal_rules` /
  `token_domain_bindings` tables and the `domain` column from `memories`,
  `conversation_state`, and `handoffs` (projection schema version 21); existing
  databases migrate automatically on next open. Relevance now comes from retrieval,
  not domain walls.
- **`handoffs show --json` now emits the normalized handoff shape.** The CLI
  `the-librarian handoffs show --json` output uses `handoff_id` / `tags` (array) /
  `claimed_by` (object) instead of the raw database columns (`id` / `tags_json` /
  `claimed_by_json`). This falls out of routing the dashboard `handoffs.byId` view
  and the CLI through a new `HandoffStore.getById` rather than raw SQL — the first
  step of sealing the storage seam (F0) for the markdown rearchitecture.
- **`the-librarian rebuild` output is backend-neutral.** The command now reports
  "Rebuilt the memory index in &lt;data-dir&gt;" (was "Rebuilt projection from
  &lt;events.jsonl path&gt;"), and its help line reads "Rebuild the memory index from
  stored data". Same behaviour; the wording no longer names the SQLite/events-ledger
  internals, via a new backend-neutral `reindex()` store verb (F0).

## [0.4.0] — 2026-05-30

### Added

- **Backups cockpit on the dashboard.** The `/backups` page now manages the whole
  backup lifecycle: a config form (cloud target — S3 or GitHub — with write-only
  credentials, schedule, retention, and an optional failure webhook), a health
  banner (last successful backup / last failure), the recent bundles with one-click
  **restore** (restart-staged, with the supervisor warning), and a run-history
  table. No redeploy needed to change any of it.

- **Restore a backup from the dashboard (restart-staged).** Staging a restore
  validates the chosen bundle (pulling it from the cloud target if it isn't
  local) and queues it; it's applied on the next server boot — before the SQLite
  file is opened, never under a live connection. A failed restore leaves the live
  data untouched and keeps the marker for the operator. The admin API gains
  `backup.stageRestore` and a `backup.restart` control.

- **GitHub Releases as a backup target.** Alongside S3-compatible storage, a
  backup can now sync to a (private) GitHub repo: each bundle becomes a Release
  (tag = bundle name) with the bundle's files attached as release assets. No new
  dependency — it uses Node's built-in `fetch`; the fine-grained token is stored
  encrypted and never appears in URLs, logs, or errors. Configure via
  `backup.github.repo` / `backup.github.token` (dashboard or the
  `LIBRARIAN_BACKUP_GITHUB_REPO` / `LIBRARIAN_BACKUP_GITHUB_TOKEN` env vars).
- **Dashboard-managed backup schedule + run health.** The backup cadence,
  target, retention count, and an optional failure-alert webhook now live in
  admin settings (no redeploy to change). Each scheduled or manual backup
  records a `backup_runs` row (status, target, bytes, error, timestamps); the
  server runs a backup once the configured interval has elapsed, recovers a run
  left in-flight by a crash, and POSTs a generic-JSON alert to the webhook on
  failure. The schedule ships disabled by default; the legacy
  `LIBRARIAN_BACKUP_INTERVAL_MS` still enables backups for headless installs.

### Changed

- **Backup bundles are now gzipped (`format_version` 2).** Each file in a
  backup bundle (`librarian.sqlite`, `events.jsonl`, `memories.md`) is stored
  gzipped as `<name>.gz`, cutting bundle size by roughly 70% (the SQLite copy is
  mostly empty pages). The manifest records both the stored (compressed) and the
  uncompressed sha256/bytes per file. `restore` is backward-compatible — existing
  `format_version` 1 (uncompressed) bundles still restore — and now bounds
  decompression to each file's declared uncompressed size, refusing a malformed
  or zip-bomb `.gz` before it can exhaust memory.

## [0.3.0] — 2026-05-29

### Added

- **Classifier admin cockpit at `/classifier`.** Operators configure
  the classifier worker (remote LLM connection, prompt version, enable
  flag) from the dashboard the same way they configure the curator. The
  page shows a configuration summary with a "Config has changed since
  the worker started" drift banner; a form with the LLM-connection
  fields and a masked token input that preserves the stored value on
  empty submit; a restart button that calls the new
  `classifierConfig.restartWorker` mutation (coalesces concurrent
  callers via the single-flight mutex documented in the spec); and a
  self-test button that runs the classifier package's
  `runSelfTest(SELF_TEST_INPUT)` against a transient classifier
  instance, returning verdict + latency + fallback reason. Worker
  drift detection uses a sha256 of the encrypted token blob so token
  rotation flips the hash without ever touching plaintext.
- **`@librarian/core` shared `llm-connection` helper.** The
  per-LLM-connection block (provider/endpoint/model/timeoutMs +
  encrypted token) used by both the curator and the new classifier
  config is now a single tested module. Curator-config delegates to
  it; classifier-config layers an enable flag + prompt version on top.
  Public surface:
  `LlmConnection`, `LlmConnectionPatch`, `LlmConnectionPatchSchema`,
  `llmConnectionKeys`, `readLlmConnection`, `writeLlmConnection`,
  `resolveLlmToken`.
- **`@librarian/core/classifier-config`.** Settings-store-backed
  config for the classifier worker.
  `readClassifierConfig` / `writeClassifierConfig` /
  `resolveClassifierToken` / `classifierConfigHash` /
  `findLegacyClassifierEnvKeys` / `ClassifierConfigPatchSchema`. The
  hash includes a sha256 fingerprint of the encrypted token blob, so
  rotation triggers drift without exposing plaintext.
- **`@librarian/mcp-server` store-driven classifier boot + restart +
  self-test.** `bootClassifierWorker({ store, … })` reads the stored
  config; `restartClassifierWorker(input)` implements the nine-step
  shutdown procedure with a single-flight mutex
  (outcomes: `started | stopped | restarted | already_in_progress |
  failed`); `runClassifierSelfTest(input)` builds a transient
  classifier, runs the fixture, and returns the result.
- **`classifierConfig` tRPC router** mounted on `appRouter`:
  `config` / `setConfig` / `workerState` / `restartWorker` /
  `selfTest`. All admin-gated; token never on the wire.

### Removed

- **Embedded local classifier provider (`node-llama-cpp`).** The
  in-process GGUF provider shipped in v0.2.0 — the `node-llama-cpp`
  optional native dependency, the Node-Worker inference host, the
  curated model `CATALOG`, the HuggingFace download plumbing, and the
  `providerMode` config discriminator — is removed. The classifier is
  **remote-only**: point the LLM connection at any OpenAI-compatible
  endpoint, including a self-hosted **ollama / vllm / llama.cpp** server
  URL, for local inference. This drops a ~300MB native dependency that
  never installed in the read-only Docker image anyway. No migration
  needed — a stored `provider_mode = "local"` reads back as remote and
  reports "not operational" until an endpoint is configured; orphaned
  `classifier.local.*` settings are ignored. `ClassifierConfig` loses
  its `providerMode` and `local` fields (`isOperational === enabled &&
  isLlmComplete`), so the config hash changes once, showing a one-time
  drift banner cleared by a worker restart. `classifier-eval`'s
  `--provider` now accepts only `remote`.
- **`LIBRARIAN_CLASSIFIER_*` env vars retired** in favour of admin-
  settings persistence (see the cockpit above). Boot logs a one-line
  `classifier_env_retired` notice if any of the seven retired keys
  (`_ENABLED`, `_PROVIDER`, `_REMOTE_ENDPOINT`, `_REMOTE_TOKEN`,
  `_REMOTE_MODEL`, `_LOCAL_MODEL`, `_LOCAL_QUANT`) are still set, with
  a hint to migrate to the cockpit. A new CI guard
  (`scripts/check-classifier-env-retirement.mjs`, wired into the
  guards job) `git grep`s the repo for new references and fails the
  build on any occurrence outside the explicit allowlist (the
  retirement-related source / tests / docs + classifier-eval's
  separate CLI env contract + the `_LOCAL_E2E` integration-test
  flag).

## [0.2.0] — 2026-05-28

### Fixed

- **v18 → v19 sessions-rethink migration crash on boot.** The PR 7
  drop-and-rebuild path tried to pre-drop the FTS5 shadow tables
  (`session_events_fts_data` etc.) before the parent virtual table,
  which SQLite refuses (`table … may not be dropped`). The first
  statement threw and `ensureSchema` aborted, leaving the server
  unable to start against any v18 database. Fix drops only the
  virtual table — SQLite cleans up its shadows atomically — wrapped
  in try/catch in case an exotic half-migrated DB has an orphan
  `session_events_fts` row in `sqlite_master` without shadows.
  Reported by the Hermes deploy at startup. Regression test pins the
  v18 → v19 path.

### Added

- **Responsive memories page + hamburger nav on small screens.** The
  memories page outer grid now stacks below `lg` (1024px) — the
  filter sidebar collapses above the list with a
  `<details>`-driven "Filters & recall" toggle, so a phone-sized
  viewport gets a usable list column instead of a 30px sliver. The
  site nav swaps `flex flex-wrap` for a hamburger pattern below `md`
  (768px) — inline SVG icon with `aria-expanded` / `aria-controls`,
  drawer below the bar when open, auto-closes on route change. The
  right-hand controls (version badge, theme toggle, sign-out) stay
  visible at every width.
- **Release runbook + per-repo release docs.** Canonical cross-family
  release procedure lives at
  [`docs/release-runbook.md`](docs/release-runbook.md); the per-repo
  steps and decision rules at [`docs/release.md`](docs/release.md).
  AGENTS.md thinned to point at both — the bump-size rule and
  per-procedure steps no longer duplicate inline. Sibling plugin repos
  pick up matching `docs/release.md` files that cross-link to the
  monorepo runbook.

### Removed

- **Session subsystem retired (sessions-rethink PR 7).** The thirteen
  session MCP tools (`start_session`, `get_session`, `list_sessions`,
  `list_session_events`, `search_sessions`, `record_session_event`,
  `checkpoint_session`, `pause_session`, `end_session`, `attach_session`,
  `continue_session`, `promote_session_fact`, plus the older retired
  `archive_session` / `restore_session` / `delete_session`) are gone.
  The CLI's `the-librarian sessions <verb>` family, the dashboard's
  `/sessions` and `/sessions/[id]` surfaces, the `lib-session-*` and
  `lib-toggle-private` slash commands, the `sessionsRouter` tRPC
  surface, the session formatters (`renderHandover*`), the
  `scripts/check-session-state-divergence.mjs` /
  `scripts/migrate-sessions-to-authoritative-sqlite.mjs` scripts, and
  the corresponding healthcheck probe are all retired. Plugin repos
  have already been trimmed in parallel PRs (claude-plugin #12,
  codex-plugin #6, opencode-plugin #6, hermes-plugin #21,
  pi-extension #10) — they now register only the conv-state injection
  hook and rely on the `/handoff`, `/takeover`, `/learn`,
  `/toggle-private` slash surface for cross-harness continuity.
  **Schema break:** projection bumps 18 → 19 and drops the
  `sessions`, `session_state_changes`, `session_events`, and
  `session_events_fts*` tables. Existing memory data is unaffected
  (events.jsonl is the source of truth); leftover
  `session_events.jsonl` / `sessions.legacy.jsonl` files are renamed
  to `.predeprecation.bak` on next open so operators can see they've
  been retired but no data is silently deleted. Older backup bundles
  carrying the old ledger files restore cleanly — the post-PR-7 store
  ignores them on open.

### Added

- **Dashboard version badge with "behind latest" indicator.** A small
  `v<version>` chip in the nav bar shows the running build's version
  (read from the root `package.json` at boot, surfaced via a new public
  `health.info` tRPC procedure). A coloured dot + native browser
  tooltip indicates whether the local build is up to date, behind the
  latest GitHub release, or in a "couldn't check" state (no releases
  yet, rate-limited, or the host is offline). Clicking the badge opens
  the matching release notes in a new tab. The GitHub lookup is cached
  for an hour, lifts to 5000 req/h when `LIBRARIAN_GITHUB_TOKEN` is
  set, and can be disabled entirely with
  `LIBRARIAN_DISABLE_VERSION_CHECK=true` for air-gapped instances.
  Downstream forks can point the check at a different repo via
  `LIBRARIAN_GITHUB_REPO=org/repo`.
- **Handoffs surface (sessions-rethink PR 1, additive).** Three new MCP
  tools — `store_handoff`, `list_handoffs`, `claim_handoff` — back a new
  `handoffs` SQLite table that records self-contained narrative handoffs
  for cross-harness pickup. The atomic `claim_handoff` wraps an UPDATE +
  SELECT in `BEGIN IMMEDIATE` so two concurrent claimants always pick a
  single winner (404 vs 409 distinguish unknown rows from already-claimed
  ones). Server-side domain isolation matches the memory tools.
  Companion surfaces: a `the-librarian handoffs <list|show|purge>` CLI
  family (purge is admin-only), a read-only dashboard at `/handoffs`
  with a list view + detail view (no claim button — that's an agent
  operation), and four new Claude Code slash commands
  (`/handoff`, `/takeover`, `/learn`, `/toggle-private`) shipping the
  agent-side contract from spec §6.5. Healthcheck allow-list updated.
  **The old session surface (13 MCP tools, `lib-session-*` commands) is
  untouched** — both surfaces live side-by-side until PR 7 removes the
  old one. Schema bumps 17 → 18; the new table is authoritative and
  preserved across future projection rebuilds.

### Changed

- **Memory curator decouples from sessions (sessions-rethink PR 0).** The
  curator is now memory-only. The session-evidence path
  (`gatherSessionEvidence`, `SessionEvidenceBundle`, `source_session_ids`,
  `input_session_ids`) is gone from `curator-evidence.ts`,
  `curator-worker.ts`, `curator-prompt.ts`, `curator-output.ts`,
  `curator-validate.ts`, `curator-apply.ts`, and the curation-store
  schemas. The session-derived `safe` discriminator (and the implicit
  "strong session-backed evidence" shortcut for `create`) is retired;
  exact-duplicate `safe` survives. Curation runs no longer hash session
  ids into their input fingerprint. **Schema break:** projection bumps
  16 → 17 and drops `memory_curation_runs.input_session_ids` and
  `memory_curation_operations.source_session_ids` via
  `ALTER TABLE … DROP COLUMN`. Existing curation rows are preserved;
  the columns just disappear.
- **Curator cadence is disabled by default with an explicit operator
  opt-in (§12.4).** The legacy `curator.schedule.interval_days` /
  `curator.schedule.time` / `min_sessions_since_run` keys are retired
  and replaced by `curator.interval_minutes` (default 60, capped at one
  week). When `curator.enabled` is `false` (the default), the scheduler
  ticks but does nothing — no LLM calls, no runs created. When enabled,
  the scheduler runs every `curator.interval_minutes` from the slice's
  last completion; the previous self-gate on new-session counts is
  retired (sessions no longer drive the curator). Boot logs a one-line
  notice if legacy schedule keys are still in settings so operators
  know to migrate. Dashboard cockpit config form replaces the
  "every N days at HH:MM" inputs with a single "every N minutes" field.

### Added

- **`classifier-eval generate-fixture` CLI (Task 4.10).** Implements
  the spec §4.7 public-consensus fixture generation pipeline:
  generate ~1500 candidate memories via one strong LLM, run each
  through 3 frontier graders from different model families (Claude /
  GPT / Gemini) via the classifier's own v1 prompt, keep only
  unanimous candidates, trim to ~900 maintaining the 60/40 ratio,
  iterate if a bucket falls short. Configurable via a JSON file
  (`fixtures/graders.example.json` ships as a template) with tokens
  resolved from env-var references so the config is safe to commit.
  Hard `--max-calls` budget guard prevents runaway API spend; verbose
  per-iteration progress logging via `--verbose`; dry-run mode
  validates config + env without making any calls. The fixture
  itself is NOT generated in this PR — that's an operator one-shot
  with three API keys in hand (~$5 spend). 28 new unit tests cover
  consensus, ratio-preserving trim, generator prompt construction,
  CLI flag parsing, and an end-to-end pipeline test with in-memory
  fake clients. Documented in `packages/classifier-eval/README.md`.

### Removed

- **Legacy `category` / `visibility` / `scope` columns + dashboard
  dropdowns + `PROTECTED_CATEGORY_STRINGS` gate inside the store
  (Section 4d.3 final cleanup).** The schema bumps to v16 — the
  `memories` table loses three columns; the FTS table loses its
  `category` column. New writes don't carry those fields; legacy
  ledger events still parse (the projection ignores those fields on
  rebuild). Memory-side `visibility` is gone end to end; sessions
  still carry it for cross-agent handover.

  The curator's protected-routing rebased onto the
  classifier-decided `requires_approval` flag: the apply layer emits
  `options.requires_approval: true` for protected creates, the
  validate layer reads `requires_approval` on each evidence item
  (`category` is no longer carried on `MemoryEvidenceItem`).

  `createMemory` exposes an `options.requires_approval: boolean` (and
  `options.is_global`) channel for trusted internal callers (curator,
  dashboard, tests). Agent-supplied values via `input.requires_approval`
  are still ignored per spec §4.1/§4.4. The legacy
  `legacyProtected` short-circuit inside the store is retired.

  Dashboard UI: `NewMemoryForm`, `MemoryDetailPanel`, `MemoriesFilters`,
  `PromoteForm`, and the `(memories)/actions.ts` server actions all
  drop their category/visibility/scope inputs. The detail panel now
  surfaces `is_global` / `requires_approval` / `domain` pills built
  from the classifier verdict instead.

  Migration `scripts/migrate-add-domain-and-conv-state.mjs` is now a
  no-op on post-4d.3 schemas (legacy backfill target columns gone);
  it prints a clear message and exits cleanly.

- **Legacy `Category` / `Scope` enums + `deriveLegacyMemoryFlags` /
  `isProtectedCategory` (Section 4d.2 cleanup).** The classifier
  worker is now the source of truth for `is_global` and
  `requires_approval`; the legacy category-derived bridge is retired.
  `category` / `visibility` / `scope` remain as opaque free-text
  columns on the `memories` table for backward compatibility with
  pre-cutover ledger events; the projection no longer treats them as
  routing signals.

  Curator output schemas (`CuratorMemoryInputSchema`,
  `CuratorMemoryPatchSchema`) widen `category` / `scope` to
  `z.string()`. The `PROTECTED_CATEGORY_STRINGS` set survives as a
  legacy gate inside `createMemory` so identity / relationship
  strings still route to `requires_approval=true`+`status=proposed`
  until callers (curator apply, dashboard new-form) switch to
  emitting `requires_approval=true` directly.

  `startContext` is rewritten to bucket by `is_global=true` +
  agent-private rather than by category enum members.

  **No production behaviour change** beyond what Section 4d.1
  already shipped — the worker still decides the booleans on the
  write path; this PR retires the dead bridge code.

### Added

- **Classifier cutover (Section 4d.1 of the rollout-completion plan, halt-gated).**
  The classifier worker is now wired into `mcp-server`'s HTTP boot
  behind `LIBRARIAN_CLASSIFIER_ENABLED=true`. When the flag is set
  along with the provider-specific env (remote: endpoint + token +
  model; local: model id + optional quant), the worker starts at
  listen time and `remember` lands every new memory at conservative
  defaults (`is_global=false, requires_approval=true,
  status=proposed, classified=0`) — the worker then decides the
  two booleans asynchronously and emits `memory.classified`. When
  its verdict says `requires_approval=false`, the worker promotes
  the row from `proposed` to `active` so the recall filter sees it.
  When the env flag is unset (default), nothing changes — the legacy
  bridge in `normalizeMemoryInput` continues to derive the booleans
  from `category`, and the worker stays dormant.

  Projection rebuild now applies `memory.classified` events to the
  snapshot so a verdict survives a `pnpm rebuild` of the projection.
  Legacy-bridge writes carry `classified=1` on the snapshot (the
  worker has nothing to do); pendingClassification writes carry
  `classified=0`.

  New `scripts/migrate-enqueue-existing-memories.mjs` flips every
  existing row in `memories` to `classified=0, classification_attempts=0`
  so the worker drains the canonical instance's backfill queue
  post-cutover. Dry-run by default; `--apply` writes. Idempotent.

  **Halt gates on the canonical instance:** if the first 100
  classifications show `fallback_used: "max_retries"` rate > 20%
  (the spec §4.3 soft-alert threshold; dashboard banner surfaces
  it), HALT and investigate model configuration before continuing.
  The plan's §7.3 column drop + enum removal + dashboard-UI cleanup
  is deferred to 4d.2 (low-risk follow-up; runs after backfill is
  confirmed healthy).

- **Classifier evaluation surface (Section 4c of the rollout-completion plan).**
  New workspace package `@librarian/classifier-eval` ships the eval
  runner + a CLI bin (`classifier-eval run --provider remote --model
  <id> --sample 10 --category boundary`) and a soft-alert helper that
  computes the §4.3 max-retries rate over a window. The dashboard
  gains a `/classifier-eval` admin page that runs evals against a
  remote OpenAI-compatible endpoint (configured per-run via a form;
  persistent admin config arrives in 4d) and renders agreement
  metrics, per-category disagreement, latency distribution, and
  fallback counts. A banner appears at the top of the page when the
  recent classification window crosses the 20% max-retries threshold
  (spec §4.3). Each successful eval appends a
  `classifier.evaluation_completed` event (new `MemoryEventType`
  variant) so the timeline survives reloads. A 12-entry seed fixture
  at `packages/classifier-eval/fixtures/seed-v1.json` covers every
  verdict quadrant and includes boundary cases; the consensus-graded
  public fixture from spec §4.7 (~900 entries) lands in a follow-up.

  **No production behavior change.** Soft-alert returns zeros until
  Section 4d wires the worker into mcp-server startup so
  `memory.classified` events start flowing.

- **Classifier local provider (Section 4b of the rollout-completion plan).**
  `@librarian/classifier` now ships a `local` provider that runs GGUF
  models via [`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp)
  on a Node worker thread, keeping the mcp-server's event loop
  responsive while inference blocks. `node-llama-cpp` is declared as an
  `optionalDependency` so installs without local mode complete cleanly
  on platforms where the native build fails. A six-model catalog (spec
  §4.3 — Qwen 3.5 0.8B / LFM 2.5 1.2B Instruct + Thinking / Qwen 3.5
  2B / Phi-4-mini / Gemma 4 E2B; LFM 2.5 1.2B Instruct is the default)
  is committed at `packages/classifier/src/catalog.ts`. A new
  `runSelfTest()` helper exercises the classifier against a known
  identity-shaped memory and surfaces the raw model output on parse
  failure — the dashboard's custom-model save path uses it to reject
  configs that can't produce parseable JSON. The provider router now
  requires `deps.inferenceFor` for `provider: "local"` and `deps.llm`
  for `provider: "remote"` — misconfiguration throws at construction
  rather than silently returning conservative defaults. The 4a-era
  `LIBRARIAN_CLASSIFIER_LOCAL_STUB` env-flag escape hatch is retired —
  the local provider is now the production wiring.

  **Still no behavior change in production.** The worker
  (`createClassifierWorker`) is not wired into mcp-server startup;
  that lands in Section 4d.

- **Classifier foundation (Section 4a of the rollout-completion plan).**
  New workspace package `@librarian/classifier` with a remote (OpenAI-
  compatible) provider, the v1 prompt template, and the parser that
  folds every model output failure to a conservative-defaults verdict
  with a `fallback_used` tag (`parse` / `timeout` / `provider_unavailable`).
  Two new `memories` columns — `classified` and
  `classification_attempts` — both `INTEGER NOT NULL DEFAULT 0` (schema
  bump v14 → v15). A new `memory.classified` event variant on the
  ledger schema (spec §4.8). A new async worker scaffold at
  `packages/mcp-server/src/classifier-worker.ts` that drains the
  `classified = 0` queue, retries on parse / provider failures up to 3
  attempts, then gives up with conservative defaults + an event marked
  `fallback_used: "max_retries"`.

  **No behavior change.** The worker module exists but is NOT wired
  into mcp-server startup; no code path writes `classified = 0` yet,
  so the worker has nothing to do in production. New memories continue
  through the legacy `deriveLegacyMemoryFlags` path until Section 4d
  performs the cutover (with the migration backfill).

- **CLI `--conv-id` flag on `sessions start` (PR 5 of 8, T5.3 only).**
  Mirrors the new harness hook contract — when the operator pipes a
  series of CLI invocations together (e.g. `LIBRARIAN_CONV_ID=cli:work`
  in their shell), `sessions start` now inherits the domain from the
  matching `conversation_state` row. Single-domain installs continue
  to default to `general` through the §4.10 fast path. The Claude
  Code and Hermes plugin work (T5.1 + T5.2) lives in sibling repos
  and is out of scope for this PR.

- **Dashboard `/domains` page (PR 4 of 8, T4.1 only).** Owner-curated
  list of domains via a new admin tRPC router (`domains.list`,
  `domains.add`, `domains.remove`) on top of a `createDomainsStore`
  surface in `@librarian/core`. Removing a non-floor domain reassigns
  its memories to `general` rather than deleting them — agents can't
  lose content because the owner tidied up. The `general` floor cannot
  be removed (the §4.10 fast path depends on it). T4.2 (signal-rules),
  T4.3 (proposal modal), T4.4 (memory detail panel toggles), and T4.5
  (filter UI rewrite) deferred to follow-up sub-PRs per the plan's
  "split if any one task balloons" guidance.

- **Domain enforcement on memory + session writes (PR 3 of 8).** The
  `remember`, `recall`, `start_session`, and `continue_session` MCP
  tools now consume the conv-state registry from PR 2:
  - `remember` reads `conv_state.domain` for the supplied `conv_id` and
    server-sets the memory's `domain` accordingly. Calls without a
    matching conv_state row on a multi-domain install route to the
    proposal queue with `domain=NULL` and `requires_approval=true` per
    spec §4.14, so the dashboard owner picks the domain at approval
    time. The §4.10 single-domain fast path keeps zero-config installs
    zero-friction — when only `general` exists, the sole domain is
    auto-assigned without the proposal hop.
  - `recall` applies the §4.11 hard filter
    `(domain = current_domain OR is_global = 1) AND status = active`,
    drops the legacy `categories` and `include_private` inputs, and
    adds `tags` plus `include_other_domains`. Admin callers bypass the
    filter via the existing role flag.
  - `start_session` inherits its `domain` from the calling conv_state;
    `continue_session` seeds the resuming conv_state's domain from
    `session.domain` when a `conv_id` is supplied (skipping the
    signal-precedence chain on resume per §4.12).
  - `listMemories` (the dashboard read path) gains
    `domain` / `is_global` / `requires_approval` / `tags` filter axes
    alongside the existing surface.

- **Conversation-state registry and hook helpers (PR 2 of 8).**
  Per-conversation runtime state from spec §4.8 lands as a new SQLite-
  authoritative store on top of the `conversation_state` table from
  PR 1. The agent surface gains three MCP tools — `conv_state_get`,
  `conv_state_upsert`, `conv_state_clear` — that hook code in PR 5 will
  call every turn to defeat compaction-driven state loss. The pure
  helper `renderConvStateBlock(state)` returns the canonical
  `<conversation-state>` block from spec §4.9 byte-for-byte, so every
  harness integration reads one source of truth. No agent-visible
  behaviour change yet — PR 3 wires `remember` and `recall` to consume
  the registry.

- **Memory domain-isolation foundation (PR 1 of 8).** Additive schema for
  the new owner-controlled isolation model (`domain`, `is_global`,
  `requires_approval` columns on memories, `domain` on sessions, plus the
  four authoritative tables `conversation_state`, `domains`,
  `signal_rules`, `token_domain_bindings`). The two policy booleans are
  derived from the legacy `category` column as a temporary bridge until
  the write-path classifier ships in PR 6. The `general` domain is
  auto-seeded on first boot, and the `legacy-private` domain is
  synthesised on the fly by `scripts/migrate-add-domain-and-conv-state.mjs`
  for any historical `agent_private` memories. No behaviour change on
  reads or writes — existing tools see the new columns as defaulted
  metadata.

### Fixed

- **`rowToMemory` JSON-parse crash on corrupt `_json` columns.** A single
  corrupt `tags_json`, `applies_to_json`, `supersedes_json`,
  `conflicts_with_json`, or `curator_note` column in the SQLite `memories`
  table would crash every query that reads memory rows (`listMemories`,
  `listAll`, `getMemory`) with an uncaught `SyntaxError`, manifesting as a
  500 / JSON-RPC -32603 on the dashboard and MCP calls. The read path now
  wraps each `JSON.parse` in defensive helpers that log the corruption to
  stderr and fall back to safe defaults (`[]` or `null`) — one bad row no
  longer blocks the user's turn (fail-soft principle).

### Added

- `AGENTS.md` with the family-wide house rules (privacy, fail-soft,
  cross-repo contracts, etc.) and the main-repo build / test / gotcha
  notes. Sibling AGENTS.md files in the four standalone plugin repos
  share the same baseline so an agent dropped into any repo of the
  family behaves consistently.

### Changed

- **README front-loaded with the harness integrations section.** Moved
  the section to sit immediately before `## Features` so the install
  commands are the first concrete thing readers see (was previously
  buried below CLI / Curator). Each of the five harnesses gets a
  brand-coloured shields.io badge (Claude Code terracotta with the
  Anthropic mark, Codex purple with the OpenAI mark, Hermes gold with
  the dark LobeHub Hermes icon embedded via base64, OpenCode npm
  orange with the npm mark, Pi blue) plus a collapsible `<details>`
  block with the exact install one-liner — no need to navigate to the
  plugin repo for a basic install. The "Harness integrations" bullet
  in the Features list dropped (now redundant with the section right
  above).

### Removed

- `integrations/codex/` and `integrations/pi/` — both harnesses now
  ship as standalone, installable plugins
  ([`the-librarian-codex-plugin`](https://github.com/JimJafar/the-librarian-codex-plugin),
  [`the-librarian-pi-extension`](https://github.com/JimJafar/the-librarian-pi-extension)),
  so the in-tree copyable packages were retired to keep one source of
  truth per harness.
- `@librarian/lifecycle`'s Codex adapter (`src/harness/codex.ts`,
  `src/bin/codex-hook.ts`, the `librarian-codex-hook` bin entry, and
  the `harness-codex.test.ts` suite) — orphaned by the
  `integrations/codex/` removal. The standalone Codex plugin bundles
  its own hook from the Claude plugin's pattern and doesn't depend on
  this package.
- `integrations/opencode/` — opencode has graduated to a standalone
  plugin too ([`the-librarian-opencode-plugin`](https://github.com/JimJafar/the-librarian-opencode-plugin)).
  All five harnesses now ship as standalone repos; no in-tree harness
  packages remain.
- The `integration-wrappers` CI matrix job in
  `.github/workflows/ci.yml` (was opencode-only after the codex+pi
  graduation; now empty → deleted entirely).
- **`integrations/` directory deleted entirely.** With opencode shipping
  as a standalone plugin, every in-tree harness package has graduated;
  the `@librarian/lifecycle` workspace package was orphaned (zero
  consumers outside its own package.json) and removed alongside the
  per-harness packages. The privacy detector source that lived in
  `integrations/shared/librarian-lifecycle/src/privacy.ts` was already
  byte-identically ported into all four plugin repos; the opencode
  plugin's `src/privacy-detector.ts` becomes the de facto canonical TS
  going forward (the four ports are now peers — coordinate any change
  across all four).
- `integrations/shared/*` entry removed from `pnpm-workspace.yaml`.
- `test/integrations.test.ts` renamed to `test/repo-structure.test.ts`
  with reduced scope: dropped the integrations/README.md link check;
  retained the `.claude/commands` per-verb check; added a regression
  test asserting `integrations/` doesn't exist.

## [0.1.0] — 2026-05-26

Public baseline. The Librarian is a portable memory + session layer for AI
agents: one disciplined funnel for recalling, proposing, saving, updating,
and reviewing durable context, plus a neutral cross-harness
session-continuity layer so work started in one harness (Claude Code,
Codex, Hermes, OpenCode, Pi) can be handed off and resumed cleanly in
another.

### Shipped in this baseline

- **Durable memory** — `recall` / `remember` / `verify` over a three-state
  (`active` / `proposed` / `archived`) model, with categories, `common` vs
  `agent_private` scoping, and a proposal flow for protected categories
  (`identity`, `relationship`).
- **Cross-harness sessions** — `start` / `checkpoint` / `pause` / `end` /
  `continue` over a three-state (`active` / `paused` / `ended`) model, with
  a handover package any harness can resume. Session history is evidence;
  durable facts are promoted explicitly.
- **MCP server** — HTTP transport, bearer-token auth, the full tool surface
  including the admin-only verbs surfaced when authenticated with an admin
  token.
- **Memory curator** — an optional scheduled LLM pass that grooms memory
  (dedupe, archive stale, refine), configured and observed from the
  dashboard.
- **Dashboard** — a Next.js admin cockpit (Memories, Sessions, Recall,
  Proposals, Archive, Logs, Analytics, and the Curator cockpit) with a
  persistent nav and ⌘K command palette.
- **Storage** — event-sourced and dependency-light: append-only JSONL
  ledgers + a generated SQLite/FTS5 index on `node:sqlite`. No external
  database required.
- **Harness integrations** — two standalone, installable plugins (Claude
  Code, Hermes) plus copyable setup packages under `integrations/` for the
  rest. See [Harness integrations](./README.md#harness-integrations).

[1.21.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.20.1...v1.21.0
[1.21.1]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.21.0...v1.21.1
[1.20.1]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.20.0...v1.20.1
[1.20.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.17.5...v1.20.0
[1.17.5]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.17.4...v1.17.5
[1.17.4]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.17.3...v1.17.4
[1.17.3]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.17.2...v1.17.3
[1.17.2]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.17.1...v1.17.2
[1.17.1]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.17.0...v1.17.1
[1.17.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.16.1...v1.17.0
[1.16.1]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.16.0...v1.16.1
[1.16.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.15.0...v1.16.0
[1.15.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.14.0...v1.15.0
[1.14.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.13.0...v1.14.0
[1.13.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.12.0...v1.13.0
[1.12.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.11.0...v1.12.0
[1.11.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.10.0...v1.11.0
[1.10.2]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.10.1...v1.10.2
[1.10.1]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.10.0...v1.10.1
[1.10.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.9.0...v1.10.0
[1.9.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.4.2...v1.5.0
[1.4.2]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.4.1...v1.4.2
[1.4.1]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.2.3...v1.3.0
[1.2.3]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.1.4...v1.2.0
[1.1.4]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.52...v1.0.0
[1.0.0-rc.52]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.51...v1.0.0-rc.52
[1.0.0-rc.51]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.50...v1.0.0-rc.51
[1.0.0-rc.50]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.49...v1.0.0-rc.50
[1.0.0-rc.49]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.48...v1.0.0-rc.49
[1.0.0-rc.48]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.47...v1.0.0-rc.48
[1.0.0-rc.47]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.46...v1.0.0-rc.47
[1.0.0-rc.46]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.45...v1.0.0-rc.46
[1.0.0-rc.45]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.44...v1.0.0-rc.45
[1.0.0-rc.44]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.43...v1.0.0-rc.44
[1.0.0-rc.43]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.42...v1.0.0-rc.43
[1.0.0-rc.42]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.41...v1.0.0-rc.42
[1.0.0-rc.41]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.40...v1.0.0-rc.41
[1.0.0-rc.40]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.39...v1.0.0-rc.40
[1.0.0-rc.39]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.38...v1.0.0-rc.39
[1.0.0-rc.38]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.37...v1.0.0-rc.38
[1.0.0-rc.37]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.36...v1.0.0-rc.37
[1.0.0-rc.36]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.35...v1.0.0-rc.36
[1.0.0-rc.35]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.34...v1.0.0-rc.35
[1.0.0-rc.34]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.33...v1.0.0-rc.34
[1.0.0-rc.33]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.32...v1.0.0-rc.33
[1.0.0-rc.32]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.31...v1.0.0-rc.32
[1.0.0-rc.31]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.30...v1.0.0-rc.31
[1.0.0-rc.30]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.29...v1.0.0-rc.30
[1.0.0-rc.29]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.28...v1.0.0-rc.29
[1.0.0-rc.28]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.27...v1.0.0-rc.28
[1.0.0-rc.27]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.26...v1.0.0-rc.27
[1.0.0-rc.26]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.25...v1.0.0-rc.26
[1.0.0-rc.25]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.24...v1.0.0-rc.25
[1.0.0-rc.24]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.23...v1.0.0-rc.24
[1.0.0-rc.23]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.22...v1.0.0-rc.23
[1.0.0-rc.22]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.21...v1.0.0-rc.22
[1.0.0-rc.21]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.20...v1.0.0-rc.21
[1.0.0-rc.20]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.19...v1.0.0-rc.20
[1.0.0-rc.19]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.18...v1.0.0-rc.19
[1.0.0-rc.18]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.17...v1.0.0-rc.18
[1.0.0-rc.17]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.16...v1.0.0-rc.17
[1.0.0-rc.16]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.15...v1.0.0-rc.16
[1.0.0-rc.15]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.14...v1.0.0-rc.15
[1.0.0-rc.14]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.13...v1.0.0-rc.14
[1.0.0-rc.13]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.12...v1.0.0-rc.13
[1.0.0-rc.12]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.11...v1.0.0-rc.12
[1.0.0-rc.11]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.10...v1.0.0-rc.11
[1.0.0-rc.10]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.9...v1.0.0-rc.10
[1.0.0-rc.9]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.8...v1.0.0-rc.9
[1.0.0-rc.8]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.7...v1.0.0-rc.8
[1.0.0-rc.7]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.6...v1.0.0-rc.7
[1.0.0-rc.6]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.5...v1.0.0-rc.6
[1.0.0-rc.5]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.4...v1.0.0-rc.5
[1.0.0-rc.4]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.3...v1.0.0-rc.4
[1.0.0-rc.3]: https://github.com/code-ministry-ltd/the-librarian/compare/v1.0.0-rc.2...v1.0.0-rc.3
[1.0.0-rc.1]: https://github.com/code-ministry-ltd/the-librarian/compare/v0.11.0...v1.0.0-rc.1
[0.11.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v0.7.4...v0.8.0
[0.7.4]: https://github.com/code-ministry-ltd/the-librarian/compare/v0.7.3...v0.7.4
[0.7.3]: https://github.com/code-ministry-ltd/the-librarian/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/code-ministry-ltd/the-librarian/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/code-ministry-ltd/the-librarian/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/code-ministry-ltd/the-librarian/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/code-ministry-ltd/the-librarian/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/code-ministry-ltd/the-librarian/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/code-ministry-ltd/the-librarian/releases/tag/v0.1.0
