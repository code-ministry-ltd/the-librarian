# Review follow-up — 29/09/2026

Work list for [`codebase-review.md`](./codebase-review.md). Item numbers match the
review. Tick an item in the same commit that fixes it, and note the PR.

## PR 1 — Security

- [x] **#17** Bump the undici (and devalue) overrides so the production audit passes again
- [x] **#1** Disable gray-matter's JavaScript front-matter engines on every parse path
- [x] **#2** Reject DNS-rebinding requests: validate `Host` on both listeners and in the dashboard
- [x] **#22a** Accept `chrome-extension://` origins only on the public `/ingest` route, never on the admin listener
- [x] **#12** Make secret redaction linear-time (three quadratic rules found and fixed; no input cap needed once linear)
- [ ] **#23** Add `redirect: "error"` to every credentialed outbound fetch

## PR 2 — Privacy

- [ ] **#4** Claude capture honours `LIBRARIAN_AUTO_SAVE=false`
- [ ] **#5** Pi keeps private mode across a failed send; Pi/Hermes never prune a private session's state
- [ ] **#24** Server backstop drops every turn inside a private span, not just the marker turn
- [ ] **#37** Shared private-mode fixture run by every adapter's suite

## PR 3 — Vault editor

- [ ] **#3** Switching files while editing can no longer save one file's text into another

## PR 4 — Storage robustness

- [ ] **#6** Serialise memory/handoff documents without `matter.stringify`
- [ ] **#7** Skip and report unparseable memory/handoff files instead of failing the shelf
- [ ] **#11** Atomic sidecar writes; a corrupt `settings.json` fails loudly instead of resetting
- [ ] **#14** Invalidate and verify the id→path cache
- [ ] **#26** Atomic vault writes; invalidate the index even when the commit fails

## PR 5 — Curator safety

- [ ] **#8** Never auto-apply grooming updates/merges built from truncated or redacted evidence
- [ ] **#9** Intake targets must come from the evidence and be active
- [ ] **#10** A failed transcript extraction keeps the buffer for retry

## Remaining P1

- [ ] **#13** `remember` no longer advertises `agent_id` as required
- [ ] **#15** Installer never wipes unparseable OpenCode/Codex config; failed re-install doesn't uninstall
- [ ] **#16** Hermes install writes the provider endpoint
- [ ] **#18** stdio server survives a non-object JSON line

## P2

- [ ] **#19** Dashboard forms keep input on error; actions surface failures
- [ ] **#20** Page shortcuts ignore events inside dialogs and selects
- [ ] **#21** WCAG AA contrast tokens; focus returns to the opener when dialogs close
- [ ] **#22b** Per-client login throttling; `/api/trpc` procedure allowlist; session guard in server actions
- [ ] **#25** `librarian://memories` resource respects shelves and hides proposals
- [ ] **#27** `renameFile` validates the destination kind; constrain handoff ids
- [ ] **#28** Curator retry and failure handling
- [ ] **#29** MCP protocol gaps and error handling
- [ ] **#30** Graceful shutdown ordering; validate numeric env vars
- [ ] **#31** tRPC audit actor and error codes; shelf-scoped admin writes
- [ ] **#32** Dashboard search, dates, and silent caps
- [ ] **#33** Capture edge cases (OpenCode cap, Codex record, `ended:true`, Codex URL update)
- [ ] **#34** Hermes description drift; Pi/Hermes privacy gate in `/handoff` and `/learn`
- [ ] **#35** Performance hot spots and unbounded caches
- [ ] **#36** Backup restore scratch dir; non-ASCII file history

## P3

- [ ] **#37** De-duplicate the capture stack (see PR 2 for the fixture)
- [ ] **#38** One `Memory` type; remove the tRPC casts
- [ ] **#39** Split the oversized modules
- [ ] **#40** Remove dead code and unused dependencies
- [ ] **#41** Consolidate duplicated helpers
- [ ] **#42** Type-check tests; add missing tests
- [ ] **#43** Hygiene, CI and docs drift
