# ADR 0012 — Shelf-scoped, materialised project briefings

- **Status:** Accepted
- **Date:** 2026-08-06
- **Related:** ADR 0006, ADR 0011

## Context

An agent arriving in a project, returning after compaction, or switching from
another project needs a coherent orientation before narrower memory recall is
useful. Free-text recall cannot reliably reconstruct what the project is, how it
is built, where it stands, what changed recently, what is planned next, and what
remains uncertain. Those facts are spread across memories, handoffs, curator
runs, and vault history, and the most relevant transient work state is
deliberately excluded from ordinary durable memories.

The solution must preserve existing product invariants:

- the agent-facing MCP surface remains exactly seven verbs;
- reading context never waits for an LLM or external provider;
- Markdown and Git remain the durable, inspectable source of truth;
- shelf routing, not project metadata, remains the authorisation boundary;
- private mode produces no capture-derived project evidence;
- an automatic refresh cannot overwrite an administrator's manual correction;
- one shelf's identity or source material cannot leak through another shelf.

## Decision

### Projects are first-class, shelf-scoped Markdown records

Each shelf may contain three canonical document types:

- `projects/<project-id>.md` holds identity, lifecycle, section ownership,
  freshness metadata, and the last valid materialised brief;
- `project-updates/<update-id>.md` holds append-only, source-grounded evidence;
- `project-suggestions/<suggestion-id>.md` holds a reviewable replacement for a
  pinned section.

The immutable id is the filename. A human-facing key is unique within one shelf
and stable after approval. Proposed, active, archived, and rejected history stays
at one path rather than moving between directories. Project reads and writes are
confined to the shelf selected through the existing validated vault router.

### `project_keys` is relevance metadata, never authority

Memories gain an optional `project_keys: string[]`. The field links evidence to
approved projects in the same shelf; it does not change who can read or mutate a
memory. Existing memories without the field retain their existing document
shape. A legacy scalar `project_key` is accepted on read and emitted only in the
plural form after an intentional write.

Project associations may be changed only through attributed, path-scoped store
mutations. Moving a memory to another authorised shelf preserves its keys and may
warn about missing destination projects, but the metadata never blocks the move
or grants access to the destination.

### Briefs are compiled asynchronously and materialised

The curator compiles an active project's same-shelf evidence into six fixed
sections and stores the validated result in the Project document. Reads return
that document in constant local time and make no provider call. A dirty or failed
refresh leaves the last valid brief intact, labels it stale, and schedules work
without delaying the caller.

Automatic sections may be replaced after strict grounding validation. A manual
edit pins its section. Refresh copies pinned text byte-for-byte; materially
different evidence becomes a ProjectSuggestion instead of an overwrite.

### The existing `recall` verb serves briefings

`recall` will gain additive `briefing` and `project` inputs. Ordinary recall is
unchanged when briefing mode is absent or false. No eighth verb, automatic
first-turn call, cwd inference, post-compaction hook, delivery cursor, or dynamic
harness injection is added. Static, versioned guidance teaches an agent to ask
for a briefing once it knows the project.

### V1 never synthesises across shelves

A compiler reads one shelf only. Principal-facing resolution considers only the
caller's validated recall shelves: one visible active match is served, none is
reported as not found, and multiple visible matches are reported as ambiguous
using only those visible identities. V1 never merges records or evidence across
shelves.

## Alternatives considered

### Rank ordinary memories differently at briefing time

This would reuse the existing index and avoid a new domain model. It would still
return fragments, would miss intentionally transient project state, and would
make orientation depend on query wording.

**Rejected:** a briefing is a maintained overview, not a differently ranked
memory search.

### Add a dedicated `brief_me` MCP verb

A separate verb could expose a narrow schema and make discovery obvious. It would
widen the sacred cross-harness contract, duplicate `recall`'s context-retrieval
role, and require every integration to teach an eighth operation.

**Rejected:** additive briefing mode on `recall` keeps one retrieval contract and
the same seven verb names.

### Generate a briefing during each read

Query-time synthesis would always use the newest evidence and avoid storing a
compiled document. It would add provider latency and failure to the user's turn,
make outputs harder to audit, and prevent useful reads when no model is
configured.

**Rejected:** asynchronous materialisation makes reads local, deterministic, and
available during provider failure.

### Infer the project from cwd or inject it automatically

Automatic context could reduce the need for agents to remember the briefing
call. A working directory is not a reliable project identity, especially across
devices, repositories, monorepos, and non-coding work. Dynamic injection would
also add hidden per-turn behaviour and another cross-harness coordination path.

**Rejected:** the agent requests a briefing after the project is known, guided by
static versioned instructions.

### Treat project membership as an access-control boundary

Using project keys as permissions could appear to offer more granular access.
Keys are model- and admin-associated relevance labels, can be stale, and may be
preserved across moves. Elevating them to authority would make classification
errors security errors and conflict with the existing shelf policy.

**Rejected:** shelf routing remains the sole authorisation boundary.

### Compile one brief from multiple shelves

Cross-shelf synthesis could produce a single view when similarly named projects
exist in personal and team material. It would require explicit merge precedence,
provenance, write ownership, and disclosure rules that V1 does not have.

**Rejected:** ambiguity is safer and reversible; cross-shelf merge requires a
separate approved design.

## Consequences

### Positive

- Agents can receive one coherent, source-grounded project orientation without a
  provider call in their turn.
- Markdown, Git history, backups, restore, and manual editing remain the complete
  durability story.
- The seven-verb cross-harness surface stays stable.
- Shelf isolation is enforceable and testable independently of project matching.
- Manual corrections survive automation and conflicts become explicit review
  items.

### Costs and risks accepted

- The product gains three document types, lifecycle/storage APIs, background
  queues, reconciliation, and an admin surface.
- ProjectUpdate evidence is retained indefinitely in V1; compiler reads must be
  bounded until retention has its own reviewed design.
- Briefs can be stale. The response and dashboard must expose freshness and
  failure honestly rather than imply that last-good means current.
- The same key may exist in different authorised shelves, so callers and the UI
  must handle visible ambiguity instead of choosing the first match.
- `project_keys` needs explicit compatibility and preservation through every
  memory mutation; defaulting an absent field to an empty array would create
  unnecessary vault rewrites.
- New Git subjects initially remain the audit export's existing `other` action.
  Widening its permanent action union is a separate breaking API decision.

## Related material

- Approved Project Briefings spec and implementation plan under
  `Work/The Librarian/monetising the librarian/fable-big-ideas/1-morning-briefing/tasks/`.
- ADR 0006 — the agent-facing MCP surface.
- ADR 0011 — extension seams, Principal identity, and shelf routing.
