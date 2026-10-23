# Threat model

## What this project does

The Librarian is a self-hosted memory and handoff server for AI coding agents. One
operator runs it for themselves and their agents. It stores durable memories,
handoff documents and reference documents as Markdown files in a git repository
(the vault) under `LIBRARIAN_DATA_DIR`. Agents in Claude Code, Codex, OpenCode,
Hermes and Pi reach it over MCP. A Next.js dashboard is the operator's admin
console. A background curator sends memory text to an LLM provider the operator
configures and applies the edits it proposes.

The vault holds the operator's private information: personal facts, work
context, captured agent conversations. The server also holds agent tokens, the
master key and encrypted provider API keys and OAuth secrets. Privacy is the
product, so confidentiality of the vault and of those credentials comes first.

## Trust boundaries and where untrusted input enters

Three processes:

- **Public listener**, `packages/mcp-server`, port 3838. `/mcp` (the 7 MCP
  tools), `/ingest` (capture from harness hooks and the browser extension),
  `/healthz` and `/primer.md`. An agent bearer token authenticates `/mcp` and
  `/ingest`. With no token configured and a loopback bind, `/mcp` runs without
  auth for local development (`resolveAllowNoAuth` in
  `packages/mcp-server/src/http/auth.ts`).
- **Internal admin listener**, tRPC, `127.0.0.1:3840`. Full admin power,
  including reading decrypted secrets. It has no token: it is protected by not
  being exposed, and only the dashboard calls it. A browser must never be able to
  reach it, whether by DNS rebinding, CSRF or a permissive origin check.
- **Dashboard**, `apps/dashboard`, port 3000. Single-owner login with GitHub or
  Google OAuth, or open on a private network. Reaching the dashboard means
  reaching admin power.

Treat these as attacker-controlled:

- Unauthenticated network clients of ports 3838 and 3000, and any web page the
  operator visits while the server runs (DNS rebinding, CSRF, cross-origin
  requests to localhost).
- Holders of an agent token. Agents are semi-trusted: they may write any memory
  text, including prompt injection, but an agent token must never give admin
  access, decrypted secrets, other shelves' memories when shelves are set up, or
  file access outside the vault.
- Content of memories, handoffs, references and captured transcripts. It
  originates from agents, web pages and imported files, and is rendered in the
  dashboard, parsed as Markdown with YAML front matter, and sent to the curator
  LLM.
- Markdown files that arrive in the vault by import, restore, sync or a manual
  copy.
- URLs submitted for capture or reference import. The server fetches them
  (`packages/core/src/ingest/process-url.ts`, behind an SSRF guard).
- Backup archives given to restore.
- LLM responses. The curator's output is untrusted: it may name memory ids or
  operations that the evidence does not support. The guards in
  `packages/core/src/curator-guards.ts` and
  `packages/core/src/grooming-validate.ts` exist to contain this.

Trusted: the operator, anyone with shell access to the host or the data
directory, and the configured LLM provider's availability (not its content).

## Components that matter most

1. Authentication and origin handling: `packages/mcp-server/src/http/`
   (`auth.ts`, `routes.ts`), the dashboard's `middleware.ts`, `auth.ts`, server
   actions and its `app/api/trpc` proxy, and the auth and token code in
   `packages/core`.
2. Vault storage and parsing: `packages/core/src/store/` (front matter parsing,
   file paths, renames, the id-to-path cache, git commits).
3. Private mode and capture: the private-mode marker filter and the capture
   stack in each integration (`integrations/*`), and the server's backstop.
   Content marked off the record must never be stored.
4. Secret redaction before anything is stored, logged or sent to an LLM, and
   bearer tokens never appearing in URLs, logs or error responses.
5. Outbound fetches: the SSRF guard in `process-url.ts`, and `redirect: "error"`
   on every request that carries credentials.
6. Backup, restore and the git history and rollback surface.
7. The installer CLI (`packages/installer-cli`): it edits the user's harness
   config files and pulls container images by digest.

Less important but in scope: the curator's prompt-injection resistance where it
leads to data loss or a write outside the intended memory, and the MCP stdio
server.

Out of scope: `apps/docs` (a static documentation site), `scripts/`, test
fixtures, `fly.toml`, and anything that needs the operator's own credentials or
host access. A dependency advisory without a reachable path in this code is not
a finding.

## How to exercise it

The image has the full workspace built in `/src`, with Chromium for Playwright
and `LIBRARIAN_EMBEDDER=hash` set, so nothing needs the network.

- Unit tests: `pnpm -r run test:vitest && pnpm exec vitest run`. The dashboard
  end-to-end suite: `pnpm --filter @librarian/dashboard test:e2e`. The Hermes
  adapter: `cd integrations/hermes && python3 -m pytest`.
- A server:
  `LIBRARIAN_DATA_DIR=/tmp/lib LIBRARIAN_AGENT_TOKEN=test-token node packages/mcp-server/dist/bin/http.js`.
  This starts the public listener on 3838 and the admin listener on
  127.0.0.1:3840. `scripts/smoke-test.js` shows how to drive it end to end.
- Curator jobs need an LLM provider. Point one at a local stub server if a
  reproducer needs the curator.

## How we rate severity

- **Critical**: code execution on the server; reading or writing the vault, or
  minting tokens, without credentials; admin takeover from a web page against a
  default install; disclosure of the master key, decrypted secrets or agent
  tokens to someone without credentials.
- **High**: an agent token reaching admin power, decrypted secrets or another
  shelf; stored XSS in the dashboard from memory or vault content (an agent can
  plant it, so it escalates agent to admin); a file read or write outside the
  vault; private-mode content being stored; a bearer token in a log, URL or
  error response; SSRF that reaches internal addresses and returns content.
- **Medium**: denial of service, authenticated or not; silent loss or corruption
  of memory content (including by the curator applying an unsupported edit);
  SSRF without returned content; a credentialed fetch that follows redirects.
- **Low**: leaks of non-sensitive metadata, self-XSS, and anything that needs the
  operator's own session or a local account on the host.

## Reports and patches

Please include a reproducer we can run in this image (a vitest test is ideal)
and keep patches small. Fixes need a regression test that fails before the
change.
