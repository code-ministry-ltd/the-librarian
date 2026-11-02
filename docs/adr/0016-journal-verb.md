# ADR 0016 — The `journal` verb: an 8th agent-facing MCP tool

- **Status:** Accepted
- **Date:** 2026-11-02
- **Amends:** ADR 0006 (the agent-facing MCP surface) and the rethink's 7-verb pin
  (ADR 0007, rethink spec §5.1). Everything else in them stands.
- **Related:** spec 077 (the conversation journal)

## Context

Spec 077 adds a **journal**: a dated, self-compressing narrative of every captured
conversation, stored in the vault under `journal/`. Recent days keep one entry per
conversation; older weeks and months are summarised. It complements memory —
memories keep *what is true*, the journal keeps *what happened and why*.

The recent part (about six weeks) reaches the agent by injection at session start,
where a harness supports it. That leaves two needs injection can't meet:

1. **Older history.** A year of summaries and the occasional "what did we decide in
   March?" is too much to inject into every session.
2. **Harnesses without injection.** Codex, Hermes, OpenCode and Pi have no
   session-start injection for the journal yet, but every one of them speaks MCP.

The rethink pinned the surface at exactly 7 verbs and treats additions as a
deliberate contract change, because every harness adapter, the healthcheck, the
primer and the docs depend on the exact set.

Options considered:

- **Injection only.** Smallest change; no access to older history; four of five
  harnesses see nothing until they gain injection.
- **Extend `recall`** with a `source: "journal"` mode. Avoids a new verb, but mixes
  two different result types (current facts vs dated narrative) and two rankings
  in one tool, and muddies `recall`'s teaching description.
- **Extend `search_references`.** References are operator-filed documents; the
  journal is derived from conversations, has tiers, and is filtered by project and
  harness. Same muddying problem.
- **A dedicated `journal` verb.** One more contract to keep in sync; clean
  semantics.

## Decision

1. **Add `journal` as the 8th agent-facing verb.** Read-only. Two modes in one tool:
   - **Retrieve** (no `query`): every entry in `[from, to]` oldest first (default:
     the last 30 days), trimmed oldest-first to `max_tokens`, with a line telling
     the agent how to page further back.
   - **Search** (`query`): BM25 over entries and summaries (default range: the last
     365 days), newest first among ties, up to `limit`.
   - Both accept `project` and `harness` filters. Weekly and monthly summaries carry
     no per-entry tags, so filters match them by text and the result is labelled as
     a looser match.
2. **It reads only the caller's own shelf** — the shelf its conversations' entries
   were written to, the same one `GET /journal.md` serves.
3. **It is allowed in private mode**, like `recall` and `search_references`: it
   writes nothing, and its queries reach the server's logs like theirs do. The
   private-mode contract (primer, `docs/slash-commands.md`, every `/toggle-private`
   template) now names it among the reads that stay available.
4. **A journal that is switched off is a normal reply, not an error**: the tool
   says the journal is off and where the owner enables it.
5. **Pinned like the other seven.** The tool-registry test, the healthcheck, the
   Hermes and Pi mirrors (description verbatim, schema parity) and the generated
   verb reference all move to 8 in the same change.

## Consequences

- Every harness can read the journal on the release that ships the verb, whether
  or not it injects the recent window.
- The primer gains one sentence; to stay within its 2 KB budget, one parenthetical
  in the Memory paragraph was shortened (the instruction is unchanged).
- Operators with an edited `vault/primer.md` keep their text: the journal line
  appears only in the default primer. The tool's own description still teaches it.
- Adding a ninth verb remains a deliberate, ADR-level decision.
