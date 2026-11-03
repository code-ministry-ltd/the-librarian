# Contributing to The Librarian

Thanks for picking this up. The codebase is small enough that you should be productive in under an hour. This guide is the fastest path to "I know where to add my thing."

## Prerequisites

- **Node 22.5 or newer.**
- **pnpm 9.15.x.** Bootstrapped via Corepack:

  ```sh
  corepack enable
  corepack prepare pnpm@9.15.0 --activate
  ```

- **Docker + Docker Compose** (optional, but required to run the production-shaped stack from `docker/docker-compose.yml`).
- A POSIX shell (zsh, bash). Scripts assume the usual `find`/`grep`/`openssl`.

## Clone + install (under 5 minutes)

```sh
git clone git@github.com:code-ministry-ltd/the-librarian.git
cd the-librarian
corepack enable && corepack prepare pnpm@9.15.0 --activate
pnpm install
pnpm run seed              # writes sample memories into ./data
```

Verify everything is wired up:

```sh
pnpm run healthcheck       # vault durability, index rebuild, stdio MCP, the 8-verb tool surface, HTTP MCP + auth
pnpm test                  # full test suite (Vitest across all packages + root test/)
```

Run the stack locally (two services):

```sh
pnpm run serve                              # mcp-server at http://127.0.0.1:3838
pnpm --filter @librarian/dashboard dev      # dashboard at http://127.0.0.1:3000
```

The dashboard reaches the admin tRPC API on the mcp-server's **internal** listener (ADR 0008) — a separate host:port from the agent `/mcp` surface, trusted by isolation, so it sends **no bearer** (there is no admin token). It reads `LIBRARIAN_TRPC_URL` (default loopback `http://127.0.0.1:3840`; falls back to `LIBRARIAN_SERVER_URL` for a single-server run). Locally, `pnpm run serve` binds both the public listener (`127.0.0.1:3838`) and the internal tRPC listener (`127.0.0.1:3840`), so set `LIBRARIAN_TRPC_URL=http://127.0.0.1:3840` in the env that starts the dashboard — `/trpc` is **not** served on `3838`, so the bare `LIBRARIAN_SERVER_URL` fallback would 404.

## Workspace layout

```text
the-librarian/
├── apps/
│   └── dashboard/         # Next.js 15 admin UI (port 3000)
├── packages/
│   ├── core/              # Vault store, hybrid index, curator, schemas (no I/O outside the data dir)
│   ├── mcp-server/        # public 3838: /mcp (8 verbs) + /healthz + /primer.md + /journal.md; internal 3840: /trpc/* admin API (ADR 0008)
│   ├── cli/               # `the-librarian` binary (rebuild, seed, backup, export, auth, handoffs)
│   └── intake-eval/       # Eval harness for the curator's intake mode
├── integrations/          # All five harness surfaces, in-tree (rethink D14)
│   ├── claude/            # Marketplace plugin: MCP config + 4 optional slash commands
│   ├── codex/             # README-only: MCP config block
│   ├── opencode/          # README-only: MCP config + primer instructions URL
│   ├── hermes/            # Python MemoryProvider (own pytest run, wired into CI)
│   └── pi/                # Pi extension (primer hook + 7 tool proxies)
├── scripts/               # healthcheck, smoke, guards (test-count, no-secrets-in-vault, naming-canon, release)
├── test/                  # cross-cutting Vitest tests (healthcheck script, repo-structure regressions)
├── docker/                # mcp-server.Dockerfile, dashboard.Dockerfile, all-in-one.Dockerfile, docker-compose.yml
└── docs/
    ├── adr/               # Architecture decision records
    ├── specs/             # Active specs (completed specs move out; git history keeps them)
    └── slash-commands.md  # Cross-harness command contract (sugar over the primer protocols)
```

### Data flow at a glance

```
   agent ──────────►  mcp-server PUBLIC listener (3838, published)
   (agent token)         │   /mcp (8 verbs) ┐
                         │   /healthz       │── @librarian/core ──► ./data/vault/   (markdown + git — the source of truth)
                         │   /primer.md     │
                         │   /journal.md    ┘                       ./data/*.json   (settings + run bookkeeping sidecars)
                                            (NO /trpc here — a /trpc request 404s)   in-memory hybrid index (disposable, rebuilt from the vault)
                            ▲
                            │ NO bearer — the internal listener is trusted by
                            │ isolation (loopback / internal docker network)
                            │
   browser ────►  dashboard (3000) ──► mcp-server INTERNAL listener (3840, unpublished): /trpc/*
                      │  Server Actions   ───► mcp-server tRPC (direct, server-side, LIBRARIAN_TRPC_URL)
                      │  Browser tRPC     ───► /api/trpc/[trpc] same-origin proxy ───► mcp-server tRPC
```

The git-backed markdown vault is the source of truth — every write is a commit
through the store layer. The recall index (keyword + vector + backlinks) is
in-memory and disposable; `pnpm rebuild` or a restart rebuilds it from the
vault. See [`docs/adr/0001-separate-services.md`](./docs/adr/0001-separate-services.md),
[`docs/adr/0002-trpc-admin-api.md`](./docs/adr/0002-trpc-admin-api.md), and
[`docs/adr/0007-the-rethink.md`](./docs/adr/0007-the-rethink.md) for the
architecture decisions behind this shape.

## Where to add what

### A new MCP tool

**Stop first:** the agent-facing surface is **exactly 8 verbs by design**
(rethink D10/D12 — pinned by `tests/mcp/tool-registry.test.ts` and
`scripts/healthcheck.js`). A new agent tool is an architecture decision, not a
recipe — admin capability belongs on tRPC instead. If the decision is made:

1. Add a handler file under `packages/mcp-server/src/mcp/tools/<name>.ts`. Export a `ToolDefinition` whose `handler` takes a `ToolContext` and returns either text or a structured result. Shared input schemas live in `tools/schemas.ts`.
2. Register it in `packages/mcp-server/src/mcp/tools/index.ts`.
3. Update the pinned surface: the tool-registry test, `scripts/healthcheck.js` `EXPECTED_TOOLS`, and the Hermes (`integrations/hermes`) + Pi (`integrations/pi`) mirrors — their drift-guard tests will fail until you do.
4. Give it a protocol-bearing `description` (≤1KB) — the tool list is the only teaching surface every harness renders.
5. Write tests under `packages/mcp-server/tests/mcp/<name>.test.ts` that go through the dispatch layer.

The MCP dispatcher (`dispatch.ts`) is intentionally tiny — every behaviour lives in the per-tool file.

### A new tRPC procedure

1. Pick the namespace under `packages/mcp-server/src/trpc/` (`memories.ts`, `handoffs.ts`, `vault.ts`, `grooming.ts`, …). New namespaces go in their own file and are wired into `router.ts`.
2. Add the procedure under `adminProcedure`. Inputs are Zod schemas; output types are inferred.
3. Map store errors to `TRPCError` codes (`NOT_FOUND`, `BAD_REQUEST`, etc.) — keeps HTTP status codes correct.
4. Write tests under `packages/mcp-server/tests/trpc/<namespace>.test.ts`.

If the dashboard needs it, the type flows automatically: `apps/dashboard/lib/trpc-client.ts` (browser) and `lib/trpc-server.ts` (Server Actions) both import `AppRouter` from `@librarian/mcp-server`.

### A new dashboard page

1. Add a route under `apps/dashboard/app/<segment>/page.tsx` (Next.js App Router).
2. Read via the server-side tRPC client (`createServerTRPC` in `lib/trpc-server.ts`) inside the server component. Pass data to client components as props.
3. Writes: define a Server Action in `app/<segment>/actions.ts` (or a colocated `actions.ts` inside a route group). Call the server-side tRPC client and `revalidatePath` on success.
4. UI primitives live under `apps/dashboard/components/ui/` (shadcn). Feature components go under `components/<feature>/`.
5. Write a Vitest + RTL component test under `apps/dashboard/tests/components/<name>.test.tsx`. Playwright e2e is for end-to-end happy paths only; prefer component tests.

### A new CLI verb

1. Add a command file under `packages/cli/src/commands/<verb>.ts`.
2. Register it in `packages/cli/src/runtime.ts` (`topLevelCommands`, or a verb map like `commands/index.ts`'s `handoffVerbs` for sub-verbs).
3. Reuse `parse-flags.ts` for flag handling.
4. Tests: snapshot the help text in `tests/snapshots.test.ts`; behavioural tests in `tests/cli.test.ts` (or a focused `tests/<verb>-commands.test.ts`).

## Test layering

We use Vitest exclusively. The pyramid:

- **Unit + integration tests** (per-package, `tests/`) — most of the suite. Hit the store directly or go through dispatch/router.
- **Component tests** (`apps/dashboard/tests/components/`) — Vitest + RTL + jsdom. Prefer these over Playwright when feasible.
- **Playwright e2e** (`apps/dashboard/e2e/`) — golden-path coverage only. Runs as its own CI job.

The `pnpm test` script chains: build everything → run each package's Vitest config → run the root `test/` config. Workspace-wide totals are floored by `scripts/check-test-count.mjs` (currently ≥ 177).

## Lint / format / typecheck

```sh
pnpm run lint              # ESLint flat config across the workspace
pnpm run format            # Prettier write
pnpm run format:check      # Prettier check (CI)
pnpm run typecheck         # tsc --noEmit per package
pnpm run build             # tsc per package + Next.js build for the dashboard
```

Lefthook runs the lint + prettier on staged files in `pre-commit` (configured in `lefthook.yml`). Don't bypass with `--no-verify` unless you understand what you're skipping.

## Quality gates (PR-level)

- **400 LOC per file (production source).** Tests are exempt. If a file gets close, look for an extraction. This is a PR-template checkbox; CI doesn't enforce it.
- **No `any`, no `@ts-ignore` in production source.** See [`docs/adr/0003-no-any.md`](./docs/adr/0003-no-any.md). One `any` is allowed in test helpers with an inline disable + rationale.
- **Test-count floor.** `scripts/check-test-count.mjs` rejects PRs that drop below the workspace baseline.
- **Docs updated for user-facing changes.** A change to CLI, MCP verbs/schemas, dashboard, install/deploy, harness setup, or slash commands updates its docs in the same PR (`README.md` / `DEPLOYMENT.md` / integration READMEs / `docs/`; the [docs site](https://librarian-docs.codeministry.net) is the canonical home). Internal-only changes are exempt. PR-template checkbox; not CI-enforced.

## Publishing a notice

`notices.json` at the repository root is fetched by every install with notices switched on
(spec 084), straight from the `main` branch, so a merged change reaches operators within about
six hours, including on versions that haven't been upgraded. Each install filters the list
itself. A notice has:

- `id`: unique; never reuse one, because installs remember which ids they've read.
- `created`: `YYYY-MM-DD`.
- `severity`: `info`, `important` or `security`.
- `title` and `body`: plain text. Keep the body to a few sentences.
- `link` (optional): `{ "href": "https://…", "label": "…" }`. Only https links are accepted.
- `audience`: `all` for every install, including ones set up later; `existing` for installs set
  up before `created` only. Use `existing` for anything about a change people have already
  lived through, so new installs a year from now don't inherit it.
- `versions` (optional): a semver range such as `">=1.40.0 <1.47.0"`. Comparators are `>=`,
  `>`, `<=`, `<` and `=`, all of which must hold.
- `expires` (optional): `YYYY-MM-DD`; the notice stops showing for everyone after that day.

An entry that doesn't match this shape is skipped, and `packages/mcp-server/tests/notices.test.ts`
fails if any entry in the file is invalid.

## PR conventions

Follow the user's repo-wide PR conventions in `~/.claude/CLAUDE.md` if you're contributing through a Claude Code agent. In short:

- **Conventional Commits** for messages: `<type>(<scope>): <description>` where `<type>` is one of `fix`, `feat`, `chore`, `test`, `style`, `refactor`, and `<scope>` matches the workspace touched (e.g. `feat(mcp-server): …`, `refactor(core): …`).
- **PR title** under 70 characters. Detail goes in the body.
- **Body sections**: `Summary` (what + why) and `Test plan` (a checklist of what you verified).
- Open as **Draft** if it's not ready for review.
- Use `gh pr merge --rebase --delete-branch`; squash and merge-commit are blocked on this repo.
- Reviewer-bot findings get amended in the same PR before merge.

## Debugging tips

- **MCP dispatch issues.** `packages/mcp-server/src/mcp/dispatch.ts` is intentionally tiny — any tool-specific logic lives in its `tools/<name>.ts` file. Add a console-style log via `logger` from `packages/mcp-server/src/logging.ts` (pino) rather than `console.log`.
- **tRPC connection refused / 404 / "fetch failed".** The dashboard talks to the mcp-server's **internal** tRPC listener (no token — ADR 0008), not the public `/mcp` port. Check `LIBRARIAN_TRPC_URL` points at it (`http://127.0.0.1:3840` for a local `pnpm run serve`); `trpc-server.ts` logs a one-liner on cold start if both `LIBRARIAN_TRPC_URL` and the `LIBRARIAN_SERVER_URL` fallback are unset. A `/trpc` request to the public `3838` port 404s by design, so don't point the dashboard there.
- **`fail to load url node:…`** in a new Vitest config. Vite 5's SSR transformer strips the `node:` prefix from Node built-ins. The fix lives in `vitest.config.ts`: externalise the `@librarian/core` / `@librarian/mcp-server` compiled trees so Node's own loader handles the import chain.
- **Dashboard build failures referencing `@librarian/mcp-server` types.** Run `pnpm --filter @librarian/core --filter @librarian/mcp-server run build` first; the dashboard imports `AppRouter` types from the compiled `dist/`.
- **Healthcheck against a deployed instance.** `pnpm healthcheck -- --remote http://host:3838 --agent-token <t>` skips the in-process checks and only probes the remote URL.

## Where to read next

- [`docs/adr/`](./docs/adr/) — architecture decisions: the two-service split, tRPC, the `any` ban, the agent-facing surface (0006), and the v1.0 rethink (0007).
- [`docs/specs/2026-06-12-rethink.md`](./docs/specs/2026-06-12-rethink.md) — the consolidation spec behind the current shape (completed earlier specs live in git history).
- [`docs/slash-commands.md`](./docs/slash-commands.md) — the cross-harness command contract (optional sugar over the primer protocols).
- [`integrations/`](./integrations/) — the five harness surfaces and their per-harness install/config READMEs.
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — operating the stack on a personal VPS.
