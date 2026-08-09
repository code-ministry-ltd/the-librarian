# The Librarian — release runbook

How releases work for this repo. Pragmatic. Trunk-based. No release branches.

**The model: merging to `main` IS the release.** Every PR bumps the root
`package.json` and files a dated `## [X.Y.Z]` CHANGELOG entry in the **same
PR** — there is no `[Unreleased]` section and no separate "cut a release" PR.
On merge, `.github/workflows/release.yml` tags `vX.Y.Z`, publishes and verifies
the all-in-one image, then publishes the GitHub release from the CHANGELOG
section — automatically. A `release-guard` CI job blocks any PR that forgets
the bump or leaves an `[Unreleased]` section. You never hand-run `git tag` /
`gh release`.

The bump-size rule and full per-PR mechanics are in
[`docs/release.md`](./release.md); this runbook covers what ships where.

## One repo, one version

Since the rethink (D14, [`docs/adr/0007-the-rethink.md`](./adr/0007-the-rethink.md))
everything lives in this monorepo — server, dashboard, CLI, and all five
harness surfaces under `integrations/`. The old five-plugin-repo family and
its coordinated cross-repo release dance are gone; the external repos
(`the-librarian-{claude,codex,opencode,hermes}-plugin`,
`the-librarian-pi-extension`) are archived and never receive new work.

One version — the root `package.json` — covers the whole tree:

| Surface | Lives at | How it ships / how users update |
|---|---|---|
| Server + dashboard | `packages/*`, `apps/dashboard` | Public all-in-one image at `ghcr.io/code-ministry-ltd/the-librarian:vX.Y.Z`; operators pull a pinned release or use `latest` |
| Claude Code | `integrations/claude` + root `.claude-plugin/marketplace.json` | `/plugin update the-librarian` (marketplace points at the subdir; plain MCP config needs no update at all) |
| Codex | `integrations/codex` | README config block — nothing to ship |
| OpenCode | `integrations/opencode` | README config block — nothing to ship |
| Hermes | `integrations/hermes` | Python adapter installed by copy/script into the Hermes `plugins/` dir; users re-copy on upgrade |
| Pi | `integrations/pi` | npm package (`@the-librarian/pi-extension`) published by hand from the workspace |

Keep `.claude-plugin/marketplace.json`'s `plugins[].version` and
`integrations/pi/package.json` in step with the root version when the change
touches those surfaces (the release-guard checks the root version; the
integration version files ride the same PR by convention).

## Branching strategy

Trunk-based on `main`.

- Feature branch off `main` → PR → merge. Never push to `main` directly.
- One change per PR. Conventional commit subject (`feat(scope): …`,
  `fix(scope): …`, `refactor(scope): …`).
- **Bump the version and add the dated CHANGELOG entry in the feature PR
  itself.** No `[Unreleased]` section; no long-lived release branches. The
  merge is the release.
- A change that touches the server's MCP surface and an integration's mirror
  of it (Hermes/Pi schemas + descriptions) lands in the **same PR** — the
  drift-guard tests enforce it.

## Semver

- **MAJOR** — breaking change to the MCP tool surface (a verb removed or
  renamed), the primer/protocol contract, the handoff document shape, or any
  user-visible behaviour that needs a CHANGELOG migration note.
- **MINOR** — new MCP tool capability (additive), new dashboard surface, new
  integration, additive schema change, new env var with a default.
- **PATCH** — bug fix, doc tweak, internal refactor, test-only change, CI
  change.

Pre-1.0, MINOR bumps were allowed to carry small breaking changes with a
`### Removed` / `### Changed` callout. From 1.0.0, breaking changes take a
MAJOR.

## Trigger: every merge bumps

There is no "does this PR need a release?" judgement call. **Every merge to
`main` bumps the version** (PATCH at minimum) and ships a dated CHANGELOG
entry — including internal refactors, test-only changes, CI changes, and doc
nits. When unsure about size, round down to PATCH — a tag and a GitHub
release are free, and users who don't upgrade aren't affected.

## How a release happens

In your feature PR:

1. **Bump the root `package.json`** — PATCH / MINOR / MAJOR per Semver.
2. **Add a dated `## [X.Y.Z] — YYYY-MM-DD` section** at the top of
   `CHANGELOG.md` and its `[X.Y.Z]:` compare-link at the bottom. (No
   `[Unreleased]` — the `release-guard` job enforces this and that the
   version matches the top CHANGELOG entry.)
3. **Open the PR, get CI green** (including the Hermes pytest job when
   `integrations/hermes/**` or the mirrored tool sources change), **merge.**

On merge, `release.yml` reads the version and classifies the commit. A new
release creates the annotated tag, builds the all-in-one image once, pulls and
smokes the versioned image, records its manifest digest, promotes `latest` by
that digest, creates the GitHub release (notes = your CHANGELOG section), then
publishes public npm packages when `NPM_TOKEN` is configured. A rerun of the
same tagged commit verifies and completes any missing later steps without
overwriting the versioned image. A later commit whose version is already tagged
is a clean no-op.

### Surface-specific notes

- **Server / dashboard** — GHCR receives immutable `vX.Y.Z` and mutable `latest`
  tags for the all-in-one image. The GitHub release carries
  `docker-image-digest.txt`; verify it against both tags. The dashboard version
  badge compares the running `package.json` to the latest GitHub release,
  refreshing on its 1-hour cache (restart the server for an immediate update).
  Stable `librarian server up` / `update` resolves the exact release tag, verifies
  the pulled image against that receipt and the tag's source commit, and runs the
  immutable digest. A release is not operationally ready for the managed CLI until
  the versioned image is anonymously pullable on `linux/amd64`.
- **Claude marketplace** — installs pull this repo; the manifest's `source`
  points at `./integrations/claude`. A marketplace-visible change should bump
  `plugins[].version` in `.claude-plugin/marketplace.json` in the same PR.
- **Pi (npm)** — `integrations/pi` (`@the-librarian/pi-extension`) is published
  after the verified image and GitHub release when `NPM_TOKEN` is configured.
  Sanity-check the tarball with `npm pack --dry-run` before a risky change to
  what ships; the `files` field in its `package.json` is the gate. npm won't let
  you republish the same version — never bump just to "force" a republish.
- **Hermes** — nothing publishes; the adapter installs by copy. Make sure
  `integrations/hermes` pytest is green in CI (`.github/workflows/hermes-tests.yml`).
- **Breaking MCP changes** — name the change explicitly in the CHANGELOG
  (`### Removed` / `### Changed`) and state what un-updated clients will see
  (retired verbs return tool-not-found; the adapters fail soft).

## Release-day checklist (copy-paste)

- [ ] In your feature PR, bump the root `package.json` — PATCH / MINOR / MAJOR
- [ ] Add `## [X.Y.Z] — YYYY-MM-DD` at the top of `CHANGELOG.md` + its `[X.Y.Z]:` compare-link (no `[Unreleased]`)
- [ ] Touched `integrations/claude` or `integrations/pi`? Bump their version fields in the same PR
- [ ] `node scripts/check-release.mjs` passes locally (also enforced by the **release-guard** CI job)
- [ ] CI green → merge. `release.yml` tags, verifies the image, then publishes the GitHub release automatically
- [ ] Verify the release digest receipt matches `vX.Y.Z` and `latest`
- [ ] On the first image release, make the GHCR package public if required; verify a logged-out pull
- [ ] With the published CLI, verify a stable `server up` selects the new exact tag, reports its digest, and needs no Git/source checkout
- [ ] Verify the GitHub release appeared (and, for a Pi publish, `npm view <pkg> version` reports the new version)
