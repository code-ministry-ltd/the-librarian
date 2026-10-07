# ADR 0007 — The v1.0 rethink: 7 verbs, one curator, one primer, in-tree integrations

- **Status:** Accepted (implemented on `rethink/v1`, ships as 1.0.0-rc.1)
- **Date:** 2026-06-12
- **Context:** Six months of iteration (v0.1.0 → v0.11.0) left the system
  carrying feature drift and design-assumption debt; a full-codebase audit
  plus a first-principles brainstorm converged on a deletion-heavy
  consolidation.

## Context

The owner's framing: *"a beautifully simple and effective memory system that
works for and with any agentic harness, enabling true self & group
improvement"* — with markdown-as-source-of-truth, the harness knowledge, and
the curator named as keepers, and "nothing is sacred" otherwise.

Four parallel audits (server core, curator, the five plugins, drift history)
confirmed the foundation was strong — the markdown+git vault, the disposable
hybrid index, the 5-section atomic-claim handoff store, and the intake spine
all keep-quality — but surfaced six findings of debt around them:

1. **Dead and shell features.** Skills had complete infrastructure
   (`skill-store.ts`, `list_skills`/`get_skill`) but an empty production
   catalog since launch; the classifier worker was a stub behind a live
   routing flag; read-only dashboard views outlived the deleted session
   subsystem; the `domain` field lingered inert two releases after its
   feature was removed.
2. **Half-finished migrations.** The SQLite backend survived the markdown
   cutover as a dual-path factory (split-brain risk the owner's own live
   instance exhibited); the retired event ledger left dashboard routes that
   *threw*; `conv_state` tools were flagged as not-agent-surface in ADR 0006
   yet still advertised; references had no persistent embedding cache and
   truncated large documents at ~2K tokens.
3. **Curator duplication.** Two hand-synced ~60%-identical prompts
   (intake-v4 / grooming-v2), force-propose routing implemented twice with
   diverging semantics, six entry points, and an under-evaluation addendum
   lifecycle that was the least-tested machinery in the codebase — sized for
   an enterprise audience the project doesn't have.
4. **Five-repo integration sprawl.** ~1500 lines of byte-identical-by-
   convention MCP clients and injection plumbing hand-maintained across five
   external plugin repos in two languages; every contract change cost five
   coordinated PRs.
5. **Unverified-assumption drift.** Skills assumed harnesses could load
   skills from context (false in general); research showed only 2 of 5
   harnesses honor MCP `instructions`, so per-turn injection plumbing had
   grown where a thinner channel existed.
6. **Cognitive load.** ~15 distinct concepts for an agent or contributor to
   hold (memory states, two curator jobs, under-evaluation, conv_state,
   skills, classifier, 9+3 verbs, policy levels, …) for a product whose value
   is a recall/remember loop plus handoffs.

The brainstorm resolved this into sixteen decisions (D1–D16) and walked 14
end-to-end scenarios against them with no failures. The decision record below
is the compact summary; the full rationale, evidence, and scenario walks live
in the brainstorm doc (see Related).

## Decision

Carve the existing codebase down to its converged shape (D3 — no rewrite):

> A markdown+git vault of three note types (memories, handoffs, references),
> served to any harness over MCP as 7 verbs, kept healthy by one curator with
> one apply rule, taught to agents by one ≤2KB primer riding the thinnest
> native channel per harness — with a dashboard that is the complete admin
> surface (vault editing, history, diffs, rollback) so operators never need
> git or Obsidian.

### Audience and approach (D1, D3)

Single-operator design, open-source runnable. One operator runs their own
fleet; auth and encrypted settings stay (a deployed instance faces the
internet), but multi-tenant governance workflow is out of scope. Simplify by
deletion under the existing test suite, never greenfield.

### The 7-verb agent surface (D2, D8, D10, D12)

Exactly seven MCP tools, zero internal tools:

| Verb | Behavior |
|---|---|
| `recall` | Hybrid search over memories (keyword + vector RRF + 1-hop backlinks) |
| `remember` | Fire-and-forget into the curator's intake inbox |
| `flag_memory` | Reason required; soft-demote + route to review |
| `store_handoff` | 5-section template enforced at the schema |
| `list_handoffs` | List handoffs in scope |
| `claim_handoff` | Atomic claim, conflict on race |
| `search_references` | Separate verb by design (D12) — references are deliberately not auto-recalled |

Skills die as a server concept (D2). Namespacing is removed — one shared
corpus (D8). `conv_state_get/upsert/clear` are deleted, not hidden (D10).
Tool descriptions are a first-class deliverable: each carries its protocol
(the 5-section template lives in `store_handoff`'s description), because the
tool list is the only teaching surface every harness renders.

### Primer over MCP instructions, per-harness channels (D9, D10, D11)

One ≤2KB operator-editable document at `vault/primer.md`, served three ways
from one source: the MCP `initialize` result's `instructions` field, the
unauthenticated `GET /primer.md` endpoint, and direct reads by the
Hermes/Pi adapters. Delivery rides the thinnest native channel per harness:

| Harness | Channel |
|---|---|
| Claude Code | MCP `instructions` (config only, no code) |
| Codex | MCP `instructions` → tool-namespace description (config only) |
| OpenCode | `opencode.json` remote-URL `instructions` → `GET /primer.md` (config only) |
| Hermes | `MemoryProvider.system_prompt_block()` (Python adapter) |
| Pi | extension `before_agent_start` → `{systemPrompt}` (TS adapter) |

The primer documents the protocols (handoff, takeover, learn, private mode)
in natural language; slash commands become **optional sugar** over those
protocols (D9). Private mode is an in-conversation marker that blocks writes
only — `remember`, `store_handoff`, `flag_memory` — while reads stay allowed
and reach server logs, stated plainly (D11). Per-turn conv-state injection is
gone; system-layer placement survives compaction by construction.

### One curator, one apply rule (D4, D6, D13)

One curator engine, one versioned prompt core with mode sections (replacing
the intake-v4/grooming-v2 pair), one operation vocabulary
(`create | update | merge | split | archive | noop`), three entry points
(on-submission, on-schedule, run-now). The apply rule is enforced by
operation type, not LLM-self-reported risk (D13):

- `create` / `update` / `merge` / `noop` auto-apply at
  `confidence ≥ curator.apply.confidence_threshold` (one knob, default 0.8);
- `archive` / `split` — the only two operations that destroy or restructure
  information — **always** propose;
- any operation targeting a `requires_approval` memory proposes.

> **Amended (2026-10-07):** ADR 0014 removes both exceptions. Every operation,
> `archive` and `split` included, now applies at or above the threshold and
> proposes below it, and `requires_approval` no longer gates curator writes.

The `risk_level` field, the off/safe_only/high_confidence policy levels, the
under-evaluation addendum lifecycle, and the dry-run modes are deleted (D4).
Addendum edits apply immediately as git commits; the dashboard's
history/restore surface is the rollback.

### In-tree integrations (D14)

The surviving harness surfaces move into `integrations/<harness>/` in the
monorepo; the five external plugin repos are archived. Claude Code =
marketplace manifest + four command markdown files (sugar only); Codex and
OpenCode = README config blocks (no code); Hermes = a Python MemoryProvider
(7 tool schemas + primer block, pytest in CI); Pi = a TS extension (primer
hook + 7 tool proxies). Contract changes become one PR with co-located tests.

### Server-owned git + dashboard vault editing (D15, D16)

The server guarantees the vault is a git repo (init on boot if absent,
auto-commit per write, optional remote push as backup). The dashboard gains
an Obsidian-lite vault explorer/editor — tree over the whole vault, rendered
markdown with clickable wikilinks and backlinks, raw editing with
frontmatter validation on save, create/rename/delete with wikilink-integrity
rewrites, 2KB enforcement on primer/addendum saves — plus per-file history
with diffs and restore-as-new-commit, and a whole-vault activity feed with a
guarded restore (confirmation → curator pause → pre-restore tag → revert
commit). That history surface **is** the audit trail, replacing the dead
event ledger. History is never rewritten.

### References completion (D5)

References survive as the third note type, with the two fixes that make them
real: a persistent embedding cache (sidecar at `<data-dir>/embeddings-cache/`,
keyed by path + content hash + embedder model id, so restarts re-embed
nothing unchanged) and chunked indexing (heading/size chunks with overlap;
`search_references` returns the best chunk with a heading anchor instead of
truncating at ~2K tokens).

### Deletions (D2, D7, D8, D10)

Removed outright, each with code + tests + tRPC routes + dashboard UI + doc
references: the skills subsystem; the three conv_state tools and their
sidecar store; the namespaced index wrapper; the classifier stub and its
routing flag; the SQLite backend and dual-path store factory (markdown is
the only backend); session remnants; the inert `domain` field
(tolerate-on-read, strip-on-write); the event-ledger thrower paths; dead
exports; and three parked proposals (hybrid-recall's surviving ideas moved
to `docs/TODO.md`).

## Consequences

**Positive**

- The agent-facing surface shrank from 9 advertised + 3 internal tools to
  exactly 7, contract-tested in the registry test and the healthcheck — while
  agent-facing capability *grew* (Hermes gains handoffs + references; every
  harness gains protocol parity via the primer).
- Claude Code, Codex, and OpenCode need **zero plugin code** — an MCP config
  block (plus one instructions line for OpenCode) is a full integration.
- One curator prompt core and one apply-decision function replace two
  hand-synced prompts and two routing implementations; the apply rule is
  auditable by operation type.
- The dashboard is the complete admin surface; git is an implementation
  detail operators never have to touch.
- Roughly a third of the server codebase and most of the plugin estate
  deleted; the five-peer coordination rule disappears as a category.

**Negative / trade-offs**

- **Breaking MCP contract.** Un-updated clients calling retired verbs
  (`list_skills`, `get_skill`, `conv_state_*`) get tool-not-found; the
  fail-soft posture in the surviving adapters means no harness turn breaks.
- Primer freshness degrades from per-turn to per-session (connect time) —
  accepted; tool descriptions carry the standing reminders.
- A Python package now lives in the TS monorepo (own test runner, CI matrix
  entry).
- Marketplace installs of the Claude integration pull the whole repo (a
  CI-pushed mirror is the escape hatch if it ever matters).

**What operators must do on upgrade**

1. Run `pnpm --filter @librarian/cli migrate-data-dir` against the data dir
   (the server also runs the same checks warn-only on boot). It verifies the
   vault is a git repo, renames `consolidation-runs.json` → `intake-runs.json`,
   strips retired frontmatter fields (`domain`), removes retired settings
   keys (classifier, `addendum_status`, auto-apply policy levels, legacy
   curator keys), and **reports — never deletes** — legacy artifacts it finds
   (`librarian.sqlite`, `events.jsonl`, root `memories.md`, `*.bak`,
   `conv-state.json`).
2. **The auto-apply threshold resets to 0.8.** The single
   `curator.apply.confidence_threshold` knob ships at 0.8 and applies
   regardless of any previous instance setting — a deliberate behavior reset
   (spec §15), called out in the CHANGELOG and the migration report.
3. **Switch harnesses to the in-tree integrations.** The five standalone
   plugin repos (`the-librarian-{claude,codex,opencode,hermes}-plugin`,
   `the-librarian-pi-extension`) are archived; uninstall the old plugins and
   follow `integrations/<harness>/README.md` instead.
4. Expect one re-groom per slice after upgrade: the unified prompt core
   (v5) deliberately invalidates every slice's idempotency hash.

## Related

- **Brainstorm (the *why*, D1–D16 with full rationale + 14 scenario walks):**
  `proposals/2026-06-12-rethink-brainstorm.md` (in git history)
- **Spec (the *what/how*, single implementation run):**
  `docs/specs/2026-06-12-rethink.md` (in git history)
- ADR 0006 — the 9-verb agent surface. **Partly superseded:** this ADR
  removes `list_skills`/`get_skill` (skills die, D2) and deletes the
  `conv_state_*` tools ADR 0006 had only relocated; its core
  agents-vs-admin-surface reasoning and `flag_memory` design carry forward
  unchanged.
- ADR 0004 — `propose_memory` routes through the inbox (the `remember`
  fire-and-forget posture this surface keeps).
