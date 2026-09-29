---
title: Working with references
description: Filing long background documents your agents can search — what belongs here rather than in a memory, and the four ways to get material in.
---

A **reference** is a long document you want your agents to be able to search: a
spec, an RFC, a manual, a design note, a paper. The Librarian keeps references
apart from memories on purpose, and the distinction is the first thing worth
getting right.

## References vs memories

A **memory** is a single durable fact, small enough to be worth recalling on
every relevant turn — *"we never deploy on Fridays"*, *"the API base URL is …"*.
Memories are what `recall` returns, automatically, whenever an agent asks.

A **reference** is the source material behind those facts. It is far too long to
inject into every conversation, so it is **never auto-recalled**. An agent reaches
for it deliberately, by calling `search_references`, when a task needs that depth.

The practical test:

| Ask yourself | File it as |
|---|---|
| Would I want an agent reminded of this on most turns? | a **memory** |
| Is this something an agent should go and *look up* when the task calls for it? | a **reference** |
| Is it longer than a paragraph or two? | a **reference** |
| Is it a fact, a preference, or a decision? | a **memory** |

Don't paste a whole specification in as a memory — it will crowd out everything
else on every recall. File the spec as a reference, and let the *conclusions*
you draw from it become memories.

## How agents reach them

Agents call **`search_references`**, which returns the matching *section* of each
document plus its vault path — not the whole file. The curator never edits
references and never proposes changes to them: they are your material, filed as
you wrote it.

Because references are excluded from recall by construction, an agent that
doesn't know a reference exists will not stumble on it. If a document matters for
a recurring task, it is worth filing a short **memory** that says so — *"the
retry semantics are specified in the payments RFC; search references for it"* —
so the agent knows to look.

References stay searchable in [private mode](/guides/private-mode/), when
memories do not.

## Getting material in

Four ways, all landing in the same place (`references/` in your vault):

**From the dashboard.** The **References** tab on the
[Memories](/dashboard/memories/) page has an **Add reference** control: give it a
URL to fetch, choose a `.md` file, or paste Markdown straight in.

**From the command line**, on the machine running the server:

```bash
the-librarian refs add ./specs/payments-rfc.md   # a local Markdown file
the-librarian refs add https://example.com/spec  # fetched and converted
the-librarian refs import ./my-obsidian-vault    # every .md beneath a folder
```

`refs add` copies the file and leaves your original alone; add `--move` if you
would rather it were taken out of the source folder once filed. `refs import`
mirrors the folder's structure under `references/<folder-name>/`, skips anything
already filed, and tells you what it skipped — so running it again after adding
new notes imports only what is new.

**From the browser or your phone**, using the clippers described under
[Settings](/dashboard/settings/) — best for web articles you meet while reading.

**By hand.** References are just Markdown files in `references/`. Write one
directly if you prefer; nothing needs to be told about it.

### What happens to your frontmatter

Importing a file **keeps whatever frontmatter it already has** and fills in only
what is missing (`captured_at`, `via`, `source`, and a `title` if you had none).
An Obsidian folder full of `tags` and `aliases` imports with all of it intact.
Frontmatter must be YAML. A file whose opening fence names another language
(`---js`, `---coffee`) is refused, because that kind of frontmatter is code.

## Format and size

**Markdown, and only Markdown, for now.** PDFs are not supported yet — convert to
Markdown or plain text first.

There is no enforced size limit, and no fixed number of documents to stay under.
What is worth knowing is *when the work happens*: reference search builds its
index at query time, so the first search after adding new material does the
indexing, and subsequent searches reuse a content-hashed cache until the content
changes. In practice that means adding a large document makes the next search
slower, not every search slower.

A few things that help retrieval, all of which are ordinary good writing:

- **Give the document a real title**, in frontmatter or as a first `# Heading`.
  It names the file and appears in results.
- **Use headings.** Search returns the matching *section*, so a well-sectioned
  document gives back a tight, useful answer instead of a wall of text.
- **Split genuinely separate subjects into separate documents** rather than one
  enormous file — the same instinct as splitting an over-long memory.

## Related

- [Memories page](/dashboard/memories/) — where the References tab lives.
- [Private mode](/guides/private-mode/) — references stay searchable.
- [MCP verbs](/reference/mcp-verbs/) — the `search_references` contract agents see.
- [CLI](/reference/cli/) — the full `refs` command surface.
