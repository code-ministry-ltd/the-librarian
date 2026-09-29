# The Librarian — codebase review

**Date:** 29/09/2026  
**Commit:** `main` @ `ba080a0` (v1.27.0)  
**Scope:** the whole monorepo (about 80k lines of source): core, mcp-server, dashboard, the five harness integrations, the chromium extension, installer-cli and cli, scripts, CI and Docker.

## How this was done

Seven read-only reviews ran in parallel, one per area:

- security and auth
- storage layer
- curator and LLM pipeline
- MCP server and tRPC
- dashboard
- integrations, CLIs and CI
- whole-repo dead code and dependencies

**What counts as confirmed.** Each reviewer had to verify its findings against the actual call paths. Findings marked **confirmed** were reproduced with a scratch script against the built `dist`, a scratch render test, or a direct read of the complete code path. I re-checked items 1, 3, 4 and 6 by hand, plus the origin-check code behind item 2. **Likely** means the code path is clear but it was not reproduced end to end.

**What changed.** Nothing in the repo was changed. The repro scripts are in the session scratchpad.

**Ordering.** Items are in descending order of importance, which weighs impact against likelihood. Severity tiers:

| Tier | Meaning |
|---|---|
| **P0** | Exploitable security hole, broken privacy promise, or silent data loss that a normal user can hit. Fix before the next release. |
| **P1** | Serious bug or security weakness with a narrower trigger. |
| **P2** | Real bug with modest impact, correctness debt, or an accessibility failure. |
| **P3** | Dead code, duplication, complexity, hygiene. |

---

## Summary

| # | Tier | Area | Finding |
|---|---|---|---|
| 1 | P0 | Security | gray-matter's `---js` front-matter engine runs code from any parsed Markdown (RCE) |
| 2 | P0 | Security | DNS rebinding gets past the origin check, so any website can take over the admin API |
| 3 | P0 | Dashboard | The vault editor saves the previous file's text into the file you switched to |
| 4 | P0 | Privacy | Claude capture ignores `LIBRARIAN_AUTO_SAVE=false` |
| 5 | P0 | Privacy | Pi (and Pi/Hermes after 7 days) can lose private mode and send private turns |
| 6 | P1 | Storage | A body that starts with a `---` block is swallowed into the front matter |
| 7 | P1 | Storage | One malformed memory file breaks listing, create, recall and all curator jobs |
| 8 | P1 | Curator | Grooming auto-applies updates built from truncated or redacted text and overwrites the real memory |
| 9 | P1 | Curator | Intake applies a model-chosen `target_id` that never appeared in the evidence |
| 10 | P1 | Curator | A failed transcript extraction deletes the buffer, so the conversation is lost |
| 11 | P1 | Storage | `settings.json` is written non-atomically, and a torn file wipes every setting |
| 12 | P1 | Security | The secret-redaction regex is quadratic: one request blocks the server for about 20 s |
| 13 | P1 | MCP | `remember` advertises `agent_id` as required, so models invent one and saves are refused |
| 14 | P1 | Storage | A stale id→path cache makes memories unreadable after a rename or restore |
| 15 | P1 | Installer | The installer can wipe the user's OpenCode or Codex config, and a failed re-install uninstalls |
| 16 | P1 | Installer | The Hermes install step never writes the endpoint, so the provider stays inert |
| 17 | P1 | CI | The production audit now reports high-severity undici advisories; the next CI run fails |
| 18 | P1 | MCP | A JSON `null` line crashes the stdio server |
| 19 | P2 | Dashboard | Forms wipe your input on error; several actions swallow failures silently |
| 20 | P2 | Dashboard | Page shortcuts fire inside open dialogs and retarget them |
| 21 | P2 | A11y | Design tokens fail WCAG AA contrast; focus is lost when most dialogs close |
| 22 | P2 | Security | Smaller auth gaps: the chrome-extension origin is accepted on the admin listener; a global lockout; no allowlist on the proxy |
| 23 | P2 | Security | Missing `redirect: "error"` on credentialed fetches (LLM client, GitHub, healthcheck) |
| 24 | P2 | Privacy | The server's private-mode backstop drops only the marker turn |
| 25 | P2 | MCP | The `librarian://memories` resource ignores shelves and exposes proposals |
| 26 | P2 | Storage | Non-atomic vault writes; a failed commit skips index invalidation |
| 27 | P2 | Storage | `renameFile` does not validate the destination kind; handoff ids are unconstrained |
| 28 | P2 | Curator | Retry and failure handling: poison inbox items, partial grooming runs, chronicle reruns |
| 29 | P2 | MCP | Protocol gaps: no `ping`, every error code is -32000, raw errors leak and are never logged |
| 30 | P2 | Server | Shutdown closes the store while jobs and requests are still running; NaN env values disable limits |
| 31 | P2 | tRPC | `approve`/`reject` take the audit actor from the request body; wrong error codes |
| 32 | P2 | Dashboard | Search and the command palette only search the loaded page; dates are in US format and UTC |
| 33 | P2 | Integrations | Capture edge cases: OpenCode has no size cap, one huge Codex record, OpenCode `ended:true` |
| 34 | P2 | Contract | Hermes tool descriptions have drifted; Pi/Hermes slash commands skip the privacy gate |
| 35 | P2 | Perf | Full-vault reads and parses on hot paths; unbounded gray-matter cache; run logs grow forever |
| 36 | P2 | Backup | Restore ignores the noexec-/tmp fix; history breaks on non-ASCII filenames |
| 37 | P3 | Duplication | The private-mode filter and capture stack are copy-pasted across five adapters |
| 38 | P3 | Types | Three `Memory` types cause 28 `as unknown as` casts in one router |
| 39 | P3 | Complexity | Five files or functions over 1,000 lines, each with a proposed split |
| 40 | P3 | Dead code | 335 unused core exports, unused tRPC procedures, dependencies and helpers |
| 41 | P3 | Duplication | `stripCodeFence` ×7, the LLM client bootstrap ×5, `coerceDates` ×4, the adapter fetcher ×3 |
| 42 | P3 | Tests | About 300 test files are never type-checked; critical modules have no tests |
| 43 | P3 | Hygiene | Stale overrides, CI gaps for fork PRs, SHA pinning, doc drift, stray files |

---

## P0: fix before the next release

### 1. gray-matter runs code from Markdown front matter (RCE)
- **Where:** every `matter(raw)` call.
  - `packages/core/src/ingest/import-file.ts:43`: dashboard "add reference" paste or upload (`trpc/vault.ts:288`), and CLI `refs add`/`refs import`.
  - Plus every vault parse path: `memory-doc.ts:121`, `handoff-doc.ts:60`, `corpus/inbox.ts:129`, `vault-links.ts:40,82`, `vault-files.ts`, `migrate-data-dir.ts`.
- **What happens:** gray-matter 4.0.3 registers a `javascript` engine that runs `eval`, and chooses it when the opening fence is `---js`. No call site disables it. I confirmed that `---js\n{ title: (globalThis.PWNED = 1+1, 'x') }\n---` executes the code. The reviewer's version ran `execSync('id')` and got `uid=0(root)`.
- **Scenario:** an operator imports a shared note or a folder of notes. Or a `.md` file arrives by restore, sync or a manual copy and the link index parses it. Either way, arbitrary code runs as the server user.
- **Fix:** add one `safeMatter()` wrapper that passes `engines: { js: reject, javascript: reject, coffee: reject }` (or YAML only), and use it everywhere. Always passing an options object also bypasses gray-matter's global cache (see item 35). Add a `---js` regression test on every parse path.
- **Confidence:** confirmed.

### 2. DNS rebinding gets past the origin check: any website can drive the admin API
- **Where:** `packages/mcp-server/src/http/auth.ts:436-456` (`isAllowedOrigin`), used by the internal admin tRPC listener (`routes.ts:403`) and the public listener (`routes.ts:327`).
- **What happens:** with `LIBRARIAN_ALLOWED_ORIGINS` unset (the default), a request passes when `Origin` equals `http://${Host}`. The attacker's page controls both headers. After rebinding `evil.example` to 127.0.0.1, `Host: evil.example:3840` and `Origin: http://evil.example:3840` match.
- **Repro against dist:**
  - An ordinary cross-origin `tokens.create` gets 403.
  - The rebinding-shaped request gets 200 and a plaintext agent token.
  - `/mcp` under the default loopback no-auth mode also answers.
- **Dashboard (reasoned, not reproduced):** in the default `open` mode the dashboard is exposed the same way. Server actions compare Origin to Host, and `auth.config` returns `AUTH_SECRET` plus the decrypted OAuth secrets.
- **Scenario:** the operator visits any malicious page while the server runs on localhost. The page reads every memory, mints tokens and takes over admin.
- **Fix:**
  - Validate `Host` against an allowlist on both listeners (loopback names, the configured host, the Docker service name).
  - Reject any browser `Origin` on the internal listener.
  - Set Next `serverActions.allowedOrigins`, and apply the same Host check in middleware and the `/api/trpc` proxy.
- **Confidence:** confirmed for the server listeners.

### 3. The vault editor saves one file's text into another file
- **Where:** `apps/dashboard/components/vault/vault-explorer.tsx:232`, `file-view.tsx:62,119`, `editor.tsx:36`.
- **What happens:** `<FileView>` is not keyed by path, so the Edit mode survives switching files. `VaultEditor` initialises `useState(file.raw)` once and never resets it. A scratch render test saved `{path:"b.md", raw:"AAA content", expectedHash:"hB"}`, which passed compare-and-swap because the hash is B's own.
- **Scenario:** open A, click Edit, select B (click or `j`/`k`), click Save. B is overwritten with A's content.
- **Fix:** `key={file.path}` on `<FileView>` (or on `<VaultEditor>`), and reset `mode` when the path changes. Add a regression test.
- **Confidence:** confirmed.

### 4. Claude capture ignores `LIBRARIAN_AUTO_SAVE=false`
- **Where:** `integrations/claude/scripts/lib/capture.mjs:90` (`runCapture`).
- **What happens:** the only `AUTO_SAVE` check in the Claude integration is in `banner.mjs`. The Codex, OpenCode, Pi and Hermes adapters all gate on it. The reviewer's repro with `LIBRARIAN_AUTO_SAVE=false` returned `{posted:true}` and sent the turn.
- **Scenario:** the user turns capture off. The banner says "Nothing from this session will be saved", but every turn is still sent to the server. This breaks the product's central privacy promise.
- **Fix:** hard-gate with `isAutoSaveOff(env)` before any IO, as Codex does. Add a regression test in `test/claude-stop-adapter.test.ts`.
- **Confidence:** confirmed.

### 5. Pi and Hermes can lose private mode
- **Where:** `integrations/pi/extensions/librarian/capture.ts:160-179`; pruning in `capture.ts:220` and `integrations/hermes/librarian/provider.py:434`.
- **Failed send:** Pi returns before `writeCaptureState` when the send fails, so `private: true` is never persisted. Repro:
  1. Turn 1 says "go private" and the send fails.
  2. Turn 2, "my secret medical detail", is sent as a public turn.
  - The comments at lines 11, 162, 183 and 213 also wrongly claim the delta "re-ships next turn".
- **Pruning:** both adapters delete state files after 7 days, and a missing state reads as `private: false`. A private session resumed after 8 days starts leaking.
- **Fix:**
  - Always persist `private: endPrivate` (hold back only `seq`).
  - Never prune a file whose state is `private: true`, or treat missing state for a session with `seq > 0` as private.
  - Correct the comments.
- **Confidence:** confirmed (failed send); likely (pruning).

---

## P1: serious bugs and weaknesses

### 6. A body that starts with a `---` block is absorbed into front matter
- **Where:** `packages/core/src/store/markdown/memory-doc.ts:116` and `handoff-doc.ts:55` (`matter.stringify(body, frontmatter)`).
- **What happens:** gray-matter parses the *content* for front matter and merges it in. I confirmed that `stringify("---\nlayout: post\n---\nUse this", {id})` writes `layout: post` into the YAML and drops it from the body. The reviewer also showed:
  - a body can forge `updated_by`;
  - a body starting `---\ncorrection_work: [1]\n---` writes an unparseable memory, which then triggers item 7.
- **Triggers:** an LLM or intake body containing a Jekyll/Hugo/Obsidian snippet, a body that opens with a horizontal rule, a correction that leaves `---` at the top, or a handoff document.
- **Fix:** serialise directly as `"---\n" + yaml.dump(frontmatter) + "---\n" + body`, and add round-trip tests.
- **Confidence:** confirmed.

### 7. One malformed memory file breaks most of the product
- **Where:** `markdown-memory-store.ts:1372` (`readAllMemories`, no try/catch); handoffs have the same problem at `markdown-handoff-store.ts:88`.
- **What breaks:**
  - the store: `listMemories`, `createMemory` (via `detectRelated`), filter-only recall and `getAggregates`;
  - the curator: intake, grooming evidence, the correction poll and chronicle collection.
- **Why this is inconsistent:** the search index and `scanIdToPath` already skip bad files.
- **Triggers:** an Obsidian edit, git conflict markers, a torn write (item 26), item 6, or a bad rename (item 27).
- **Knock-on effects:** intake items throw and are retried every hour for ever (item 28), and chronicle re-runs every 15 minutes.
- **Fix:** skip and log unparseable files in `readAllMemories` and `queryDetails`, and show a warning on the health page and in the dashboard.
- **Confidence:** confirmed.

### 8. Grooming auto-applies updates built from truncated or redacted text
- **Where:** `grooming-evidence.ts:196` truncates bodies to 4,000 chars with an ` …[truncated]` suffix and replaces secrets with `[REDACTED:*]`. `grooming-apply.ts:225` writes the patch with `updateMemory`. `grooming-validate.ts` has no guard against either.
- **What happens:** the scratch run on a 5,620-char memory at confidence 0.95 applied the update. The stored body became 4,009 chars and the tail fact was gone. Merges lose data the same way when their sources are archived.
- **Contrast:** the correction path handles exactly this case (`quote_intersects_redaction` and the source map).
- **Fix:** in `validateOne`, force any update or merge to a proposal (or reject it) when its sources were truncated or redacted, or when the patch contains the markers.
- **Confidence:** confirmed.

### 9. Intake applies a model-chosen `target_id` that was never in the evidence
- **Where:** `packages/core/src/intake/apply.ts:197,274-285`.
- **What happens:** the target is resolved with `store.getMemory(judgment.target_id)`, so any memory id on the shelf is accepted, including archived ones. The only guard is a line in the prompt. Grooming, by contrast, rejects any id "not in the evidence".
- **Scenario:** submitted text, including relayed transcript content, says "supersede mem_X with …". At confidence ≥ threshold, another agent's memory is rewritten or an archived memory is revived. With the threshold at 0 this is especially exposed.
- **Fix:** pass the navigate evidence ids into `ApplyIntakeDeps`, reject targets outside them, and reject non-active targets.
- **Confidence:** confirmed.

### 10. A failed transcript extraction deletes the conversation
- **Where:** `transcript-extract.ts:131-135`, `transcript-sweep.ts:291,323`.
- **What happens:** every LLM error becomes `[]`, and the sweep then removes the `.processing` buffer. This contradicts the file's own comment.
- **Scenario:** during a provider outage, every settling conversation is dropped with 0 facts. Buffers near the 5 MB cap always exceed the model's context and are always dropped.
- **Fix:** return `{ok:false, retryable}`, leave the buffer for the reaper with an attempt cap, and split large buffers into chunks before extraction.
- **Confidence:** confirmed.

### 11. A torn `settings.json` wipes every setting
- **Where:** `packages/core/src/store/sidecar/settings-store.ts:36-55`.
- **What happens:** `writeFileSync` truncates the file in place, `readAll()` turns any parse error into `{}`, and `setSetting` does read-modify-write. The next write after a crash persists only one key. That loses the encrypted LLM tokens, the backup token and the restore-pause flag. The CLI and the server can also overwrite each other's changes.
- **Fix:** write to a temp file, fsync, then rename (as `backup/runs.ts:65-76` already does). On a parse error, fail loudly and keep a `.corrupt` copy. Apply the same to `curation-store`, `intake-store` and `chronicle-store`.
- **Confidence:** confirmed by reading.

### 12. The redaction regex can block the server for about 20 seconds
- **Where:** `packages/core/src/grooming-redaction.ts:61` (`-----BEGIN … PRIVATE KEY-----[\s\S]*?-----END …`).
- **What happens:** repeated BEGIN headers with no END scan to the end of the input for every header. Measured: 232 KB takes 1.1 s and 986 KB takes 20.4 s.
- **Reachable from:** `/transcript` (up to 1 MB, agent token) and `/ingest` (capture token).
- **Scenario:** one crafted request freezes `/mcp`, the dashboard and every job.
- **Fix:** bound the match (`[\s\S]{0,16384}?`) or pair markers with `indexOf`, and cap the input size passed to redaction.
- **Confidence:** confirmed.

### 13. `remember` tells clients `agent_id` is required
- **Where:** `packages/mcp-server/src/mcp/tools/schemas.ts:16`; `dispatch.ts:245-258` strips the field descriptions.
- **What happens:** `tools/list` shows `required: ["agent_id","title","body"]` with no explanation. Models invent a value. With a bound token the server then refuses: "caller id … does not match token-bound id … (possible impersonation)", and the memory is lost.
- **Fix:** drop `agent_id` from `required`, or stop advertising it on remember, recall and flag_memory. Update the generated docs and the Pi/Hermes drift pins in the same PR.
- **Confidence:** confirmed.

### 14. A stale id→path cache makes memories unreadable
- **Where:** `markdown-memory-store.ts:253-259` (`pathForId` trusts cached hits and never rescans on a miss).
- **Nothing resets it after:** vault-editor renames, writes or restores; `restoreVaultTo`; or `moveMemoryForPrincipal`.
- **Repro:** after a dashboard rename, `getMemory` returns null, `updateMemory` throws and recall returns 0 hits until a restart. Editing the id in front matter makes the old id resolve to the new document, and the next persist writes the old id back.
- **Fix:** verify that the file exists and its id matches, and rescan on mismatch. Expose `invalidatePaths()` and call it from the vault-file and restore invalidation hooks.
- **Confidence:** confirmed.

### 15. The installer can wipe user config, and a failed re-install uninstalls
- **Where:** `packages/installer-cli/src/harnesses/opencode.ts:88-104,236`; `codex.ts:220-230`; `commands/install.ts:74-86`.
- **Config wipes:**
  - OpenCode: a parse error (for example JSONC comments, which OpenCode allows) reads as `null`, then `?? {}`, then a write. The user's whole `opencode.json` is replaced.
  - Codex: a parse error in `hooks.json` becomes `{hooks:{}}` and is rewritten. Neither path keeps a backup.
- **Failed re-install:** any install error runs `harness.uninstall()`, even when the harness was working before. A GitHub outage during `librarian install` removes a working setup.
- **Fix:**
  - Tell "missing" apart from "unparseable" and refuse the latter with a teaching error (or parse JSONC).
  - Always write a `.bak` first.
  - Only roll back what this run added.
- **Confidence:** confirmed (code path).

### 16. The Hermes install leaves the provider inert
- **Where:** `installer-cli/src/harnesses/hermes.ts:162-180`; `integrations/hermes/librarian/provider.py:154-166`.
- **What happens:** the provider reads `endpoint` only from `$HERMES_HOME/librarian-plugin/config.json`, which the installer never writes, and there is no `LIBRARIAN_MCP_URL` fallback. Install reports success, but there is no primer, no tools and no capture. Suspected: Hermes's main config may be `config.yaml`, not `config.json`.
- **Fix:** write the plugin `config.json` (mode 0600) and/or fall back to the env var. Check against a real Hermes install.
- **Confidence:** confirmed (endpoint); suspected (yaml/json).

### 17. The production audit gate will fail the next CI run
- **Where:** `package.json` and `pnpm-workspace.yaml` override `undici@>=8.0.0 <8.9.0 → 8.9.0`; `.github/workflows/ci.yml:42` runs `pnpm audit --prod --audit-level=high`.
- **What happens:** `pnpm audit` now reports 11 advisories (2 high), 10 of them undici `<8.10.2` via `apps/docs` (astro → unifont), plus devalue. CI passed on v1.27.0 an hour ago, so these advisories are presumably newly published. The next push, and therefore the next release, will go red.
- **Fix:** raise the override to `<8.10.2 → 8.10.2` in both files, bump devalue, and update `test/dependency-security-policy.test.ts` if it pins them.
- **Confidence:** confirmed that the audit fails locally; the CI impact is inferred.

### 18. A JSON `null` line crashes the stdio server
- **Where:** `packages/mcp-server/src/bin/stdio.ts:79-81` (`void handleLine(line)` with no catch).
- **What happens:** piping `null\n` gives `TypeError … reading 'method'` and the process dies without closing the store or draining workers.
- **Fix:** reject anything that isn't an object with -32600, and wrap `handleLine` in try/catch that logs to stderr.
- **Confidence:** confirmed.

---

## P2: real bugs with modest impact, and accessibility failures

### 19. Dashboard forms lose input; actions swallow failures
- **Forms wipe input:**
  - **Where:** `components/memories/new-form.tsx:17` and `memory-detail-content.tsx:154` use `<form action={fn}>`.
  - **What happens:** React 19 resets uncontrolled fields after the action, even on failure. A test confirmed the input is `''` after the error appears.
  - **Fix:** switch to `onSubmit` with `preventDefault`, or use controlled fields.
- **Failures shown nowhere:**
  - `flagged-view.tsx:96`: Dismiss and Archive drop `resolveFlagAction`'s result (Re-assess next to them does check it).
  - `proposals-view.tsx:62-70`: "Archive original".
  - `proposal-card.tsx:95`: the Approve/Reject `run()` has an empty `catch`.
  - **Fix:** check `.ok` and render the error with `role="alert"`.
- **Confidence:** confirmed.

### 20. Page shortcuts fire inside open dialogs
- **Where:** `apps/dashboard/hooks/use-surface-shortcuts.ts:45-52`; `components/handoffs/detail-view.tsx:31-40`.
- **What happens:** the handler skips only inputs and contentEditable. It doesn't check for dialogs, `<select>` or `defaultPrevented`.
- **Scenario:** typing `j` in the Move dialog's shelf select changes the selected memory behind the dialog. In the vault Delete dialog, `j` retargets the dialog at another file. Escape inside a dialog also clears the page selection or navigates away.
- **Fix:** skip when `target.closest('[role="dialog"]')`, when the target is a `<select>`, or when `defaultPrevented`; key detail components by id.
- **Confidence:** confirmed that the shortcuts fire; the retargeting is likely.

### 21. Accessibility: contrast and focus management
- **Contrast** (measured on the light-theme paper):
  - The verdigris accent `#3f9c8e` is about 3:1. It is the primary Button's text colour and appears in 28 `text-ink-accent` uses.
  - Sage pills are about 3.3:1.
  - `text-foreground/55` (54 uses) is about 3.9:1, and `/40` placeholders about 2.5:1.
  - **Fix:** use a darker accent (about `#2b7166`) for text, and keep a floor of `/70` for small muted text.
- **Focus lost on close:** about ten dialogs are opened from plain buttons instead of `DialogTrigger` (file Move/Delete, new file, file history, activity, the discuss buttons, rehome, archive-delete, handoff delete). When they close, focus lands on `<body>` (confirmed by test). **Fix:** use `DialogTrigger asChild`, or focus the opener in `onCloseAutoFocus`.
- **Also:**
  - the `?` overlay is `aria-modal` but doesn't trap focus, and its Escape leaks to the page;
  - the pickers have no `aria-activedescendant`;
  - Escape in the path picker closes the whole host dialog;
  - site-nav `role="menu"` has no arrow keys and no focus-visible styles;
  - the date filter's label isn't linked and Escape doesn't close it;
  - some dialog errors lack `role="alert"`;
  - the version badge shows its state by colour only.
- **Confidence:** confirmed.

### 22. Smaller auth gaps
- **Chrome-extension origin on the admin listener:** `isAllowedOrigin` accepts any `chrome-extension://` origin, and the internal admin listener uses the same function. Any extension with localhost host permission gets full admin. **Fix:** allow it only on the public `/ingest` route.
- **Password lockout:**
  - **Where:** `core/src/auth/password.ts:185-238`.
  - **What happens:** the lockout is global, so anyone can keep the owner locked out. The login server action also calls `signIn` in-process, which bypasses the per-route limiter on `/api/auth/callback/credentials`.
  - **Fix:** rate-limit per trusted client IP inside `authorizeOwnerCredentials`, and key the lockout by client+username with a global ceiling.
- **No allowlist on the `/api/trpc` proxy:**
  - **What happens:** it forwards the whole admin API to the browser, including `auth.config`, which returns `AUTH_SECRET`. The browser only needs 9 read procedures, and `isSameOrigin` also accepts `same-site`.
  - **Fix:** allowlist the procedures (including batched names), and require `sec-fetch-site: same-origin`.
- **Server actions:** they rely only on the middleware matcher. Add a `requireSessionIfEnforced()` guard as defence in depth.
- **Confidence:** likely (the extension origin), otherwise confirmed.

### 23. Missing `redirect: "error"` on credentialed fetches (house rule)
- **Where:** `core/src/grooming-llm-client.ts:129-139` (used by intake, grooming, correction, chronicle, extraction, chat and distill); `mcp-server/src/github-release.ts:70-73`; `scripts/healthcheck.js:428-431`.
- **What happens:** Node strips `Authorization` on cross-origin redirects, but a 307/308 replays the memory-bearing prompt body to the new host.
- **Fix:** add `redirect: "error"` and map the failure to `LlmClientError("network")`. Also validate `LIBRARIAN_GITHUB_REPO`.
- **Confidence:** confirmed.

### 24. The server's private-mode backstop drops only the marker turn
- **Where:** `packages/mcp-server/src/http/transcript-intake.ts:122-128`.
- **What happens:** only turns that literally contain `[librarian:private=on]` are dropped, so every turn after the toggle is buffered. This matters when an adapter is buggy, as in items 4 and 5.
- **Fix:** track on/off state across the delta, and persist a `.private` marker for each `conv_id`.
- **Confidence:** confirmed.

### 25. The `librarian://memories` resource bypasses scoping
- **Where:** `mcp-server/src/mcp/visibility.ts:52-60`.
- **What happens:** it calls `store.listAll({})` on the root store and keeps everything that isn't archived. Any agent can read unreviewed *proposed* memories. With a plugin router, agents can also read root memories their shelves should hide. Every read also parses the whole vault.
- **Fix:** build it from the principal's active memories (the recall path), or remove the resource.
- **Confidence:** confirmed.

### 26. Non-atomic vault writes; a failed commit leaves the index stale
- **Where:** `core/src/store/corpus/vault.ts:119-123` (in-place `writeFileSync`); `markdown-memory-store.ts:230-233` and `vault-files.ts:593-726` (`onWrite` fires only after a successful commit).
- **What happens:**
  - A crash or ENOSPC leaves a truncated memory, which then triggers item 7.
  - When the commit fails (for example `index.lock` contention with the CLI or an Obsidian git plugin), the change stays on disk but the recall index is never invalidated. The change is later swept into an unrelated commit.
- **Fix:** write to a temp file and rename; fire `onWrite` in `finally`; decide between rollback and "written but uncommitted".
- **Confidence:** likely (atomicity); confirmed by reading (commit ordering).

### 27. `renameFile` doesn't validate the destination kind; handoff ids are unconstrained
- **renameFile:**
  - **Where:** `vault-files.ts:626-659`.
  - **What happens:** moving `references/note.md` to `memories/` plants an invalid memory (which triggers item 7), and moving the other way silently drops a live memory.
  - **Fix:** validate against the destination kind and refuse moves between kinds.
- **Handoff ids:**
  - **Where:** `markdown-handoff-store.ts:41-43`.
  - **What happens:** `handoffPath(id)` interpolates an id that is only checked as a non-empty string. `handoffs.purge("../primer")` deletes `primer.md`. This is contained within the shelf.
  - **Fix:** require `^hdo_[A-Za-z0-9-]+$`.
- **Confidence:** confirmed.

### 28. Curator retries and failure handling
- **Bad inbox items retry for ever:** they return every hour through the reaper, with an LLM call each time and no attempt count (`intake/intake.ts:111-116`, `intake/sweep.ts:141-148`). **Fix:** count attempts, then move the item to `inbox/.failed/`.
- **Partial grooming runs look complete:** when some chunks fail, the run is still recorded as `completed`, and the idempotency hash then hides the failed chunks (`grooming-worker.ts:196-205`). **Fix:** mark such runs `partial` and exclude them.
- **Chronicle re-runs every shelf:** it records success only when *every* shelf succeeds, so it re-narrates all shelves every 15 minutes (`chronicle/job.ts:180`). **Fix:** track success per shelf, with backoff.
- **Correction budget spent on skipped work:** the correction runtime counts skipped `proposal_pending` items against its 10-item budget (`memory-correction-runtime.ts:166-185`).
- **Scheduled intake labelled manual:** runs show as "manual", and item errors are never logged (`intake-tick.ts:108-117`).
- **Duplicate archive proposals:** intake and grooming can both propose archiving the same memory (`intake/apply.ts:251` vs `grooming-apply.ts:315`).
- **CRLF bodies:** the correction worker can't remove list items from bodies with Windows line endings (`memory-correction.ts`, `isWholeListItem`). **Fix:** normalise line endings when parsing.
- **Config not range-checked on read:** grooming and intake config values aren't checked when read. For example, `interval_days: 0` runs grooming on every poll.
- **Confidence:** confirmed (likely for the correction budget).

### 29. MCP protocol gaps and error handling
- **Where:** `mcp/dispatch.ts:57-101`, `rpc.ts:35-70`, `routes.ts:344-347,391,1088-1093`.
- **Protocol gaps:**
  - `ping` is unsupported.
  - Every failure uses -32000 instead of -32601, -32600 or -32602.
  - An empty batch returns `[]`.
  - Invalid JSON over HTTP gets a non-JSON-RPC 400.
  - `initialize` echoes any `protocolVersion`.
  - `serverInfo.version` is hard-coded to `"0.1.0"`.
- **Error handling:**
  - Raw `error.message` goes to the client, which leaked an upstream model URL in testing and could leak vault paths.
  - Nothing is logged server-side, and there is no tRPC `onError`.
  - Tool failures come back as protocol errors instead of `isError: true` results, so many clients never show them to the model.
- **Confidence:** confirmed.

### 30. Shutdown order and environment parsing
- **Shutdown:**
  - **Where:** `librarian-server.ts:798-820`, `bin/http.ts`, `bin/stdio.ts`.
  - **What happens:** `SerialScheduler.stop()` only clears the timer, so in-flight intake, grooming, backup and chronicle ticks write to a closed store. The store closes before the listeners, `onSignal` isn't re-entrant, and a rejected `stop()` becomes an unhandled rejection.
  - **Fix:** add a scheduler `drain()`; close the listeners, then the store.
  - **Caution:** the ordering is commented as "load-bearing", so check the intent first.
- **Environment parsing:**
  - `LIBRARIAN_MAX_BODY_BYTES=1mb` becomes NaN, which removes the body limit entirely.
  - `*_TICK_MS=5m` becomes NaN, which silently disables that job.
  - **Fix:** validate with `Number.isFinite` and exit with a teaching message.
- **Confidence:** confirmed.

### 31. tRPC: audit actor spoofing and wrong error codes
- **Audit actor:** `memories.approve` and `memories.reject` take `input.agent_id ?? ctx.principal.actorId` as the commit actor (`trpc/memories.ts:1364,1384`). Everywhere else follows spec 064 F3 ("never body-supplied"). **Fix:** remove the field.
- **Error codes:**
  - User errors come back as 500s: LLM provider add/update/delete, and oversize addendum or examples.
  - Disk and git failures come back as 400s (`reassessFlag`, `setPrimer`, `grooming.setConfig`, `chronicle.setConfig`).
  - **Fix:** use typed validation errors, as `vault.ts` already does.
- **Plugin routers only:** admin `update`, `archive`, `merge`, `split`, `bulkUpdate`, `purge` and `related` find a memory on its shelf but then write only to the root store.
- **Confidence:** confirmed (actor, codes); likely (shelf writes).

### 32. Dashboard data correctness
- **Browse search:** it filters only the 25 loaded rows (`components/memories/view.tsx:93,654`).
- **Command palette:** it searches only the latest 25 memories, and the `?selected=` link it produces is never read (`keyboard-host.tsx:80-97`).
- **Dates:** `toLocaleString()` without a locale renders US format and UTC on the server (backups, curator run tables), with hydration mismatches in client tables. `filter-chips.tsx:429` shows dates a day early west of UTC, and the token list shows raw ISO strings. **Fix:** a shared en-GB `formatDateTime` inside `<time>`.
- **Silent caps:**
  - The Archive page caps at 100 with no paging.
  - `listFlagged`, `proposalsForReview` and `correctionHistory` cap at 200, with `total` capped too.
  - One failed query blanks the whole Curator settings page (`Promise.all`).
- **Confidence:** confirmed.

### 33. Capture edge cases in the integrations
- **OpenCode, no size cap:** it sends all turns since its cursor with no per-POST cap, so a long session hits the 1 MB limit, gets 413, and re-POSTs an ever-larger body for ever (`integrations/opencode/plugin/lib/capture.mjs:95-118`). **Fix:** send in 256 KiB batches, as Claude and Codex do.
- **Codex, one huge record:** a single rollout record over 768 KiB (for example a large tool output) stalls capture for the rest of the conversation (`codex/scripts/lib/capture.mjs:56,331-339`).
- **OpenCode, `ended:true`:** it re-sends `ended:true` on almost every turn, so the server sweep extracts after each one and the LLM cost goes up (`librarian-capture.ts:69,80-82`).
- **Codex, stale URL:** `librarian update codex` keeps the old MCP URL after a URL change (`installer-cli/src/harnesses/codex.ts:378,398`).
- **Temp dirs and hangs:** the installer leaks tarball temp dirs, and its fetch has no timeout (see item 41).
- **Confidence:** likely (OpenCode cap, Codex record, `ended:true`); confirmed (Codex URL).

### 34. Cross-harness contract drift
- **Hermes descriptions:** 6 of Hermes's 7 tool descriptions differ from the server's. The drift test pins only `flag_memory` and checks properties only as a subset (`integrations/hermes/tests/test_schemas.py:167-198`), even though AGENTS.md requires verbatim mirroring. Pi's test does it properly.
- **Privacy gate:** Pi's and Hermes's `/handoff` and `/learn` prompts leave out the confirmation required while private (`docs/slash-commands.md:29,43`), which the Claude and OpenCode templates include.
- **Hermes skip reason:** `test_schemas.py:172` skips with the reason "standalone checkout", which no longer applies after the monorepo move.
- **Confidence:** confirmed.

### 35. Performance hot spots
- **Full-vault reads and parses:**
  - every `createMemory` (`detectRelated`), `listMemories`, filter-only recall;
  - the correction poll every 60 s per shelf;
  - intake, for every item (to build a 200-entry table of contents);
  - grooming `openProposalCovers` for every op;
  - `correctionHistory` and the flagged and proposal lists, per row.
- **id→path misses:** a cache miss rescans every non-owning shelf.
- **gray-matter's global cache:** it holds every distinct document ever parsed, and it caches *failures*: a second parse of invalid YAML returns `{data:{}}`, so a corrupt inbox item can be consolidated with its YAML as the body.
- **Root vault listing:** it walks `.git/objects`, and the explorer builds the link index twice per file open.
- **Run logs:** `curation-runs.json`, `intake-runs.json` and `chronicle-runs.json` grow for ever and are rewritten on every operation.
- **Prompt size:** intake and transcript prompts have no size cap (a 5 MB transcript in one prompt).
- **Fix:** one parsed-memory cache per shelf keyed by (path, mtime, size), which also fixes item 14; skip dot-dirs; retention caps; prompt budgets.
- **Confidence:** confirmed.

### 36. Backup restore and file history
- **Restore:** `backup/restore-staging.ts:162-167` doesn't pass `scratchDir`, so under read-only containers (noexec /tmp) backup works but restore fails with "cannot exec askpass".
- **File history:** `git-history.ts:212-220` lacks `-c core.quotePath=false`, so non-ASCII filenames come back C-quoted and diff/restore throws. Repro: `references/café.md`.
- **Other:** the migration's whole-tree `commitAll` sweeps up unrelated edits, and the activity classifier misses `resolve`, `move` and `migrate` commits.
- **Confidence:** confirmed.

---

## P3: dead code, duplication, complexity, hygiene

### 37. The capture stack and private-mode filter are copy-pasted five times
- `filterPrivateSpans`/`PRIVATE_ON`/`PRIVATE_OFF` are copied in Claude, Codex, OpenCode, Pi (TS) and Hermes (Python).
- The three `post.mjs` files differ only in comments, and `isAutoSaveOff`, `buildPayload` and `safeSegment` are copied ×4. The `safeSegment` copies claim to mirror the server's sanitiser but don't.
- Items 4 and 5 are exactly the drift this causes.
- **Action:**
  - Keep a single `integrations/_shared/` source, vendored at build or install time, with a byte-equality drift test.
  - Add a shared JSON fixture of turn sequences (switch off, marker on/off/mixed, failed send, resume) that every adapter's suite (vitest and pytest) must pass.

### 38. Three `Memory` types force casts
- The three types:
  - core `store/memory-types.ts:84` (closed interface);
  - the zod `Memory` in `schemas/memory.ts:60` (different nullability, same name);
  - mcp-server's `MemoryShape` (`status: string` plus an index signature).
- The cost:
  - 28 of the repo's 33 non-test `as unknown as` casts are in `trpc/memories.ts`;
  - the dashboard re-declares `MemoryStatus` by hand;
  - typos are erased.
- The TS2742 reason given for the workaround looks obsolete now that core exports `type Memory`.
- **Action:** return the core type (or a zod DTO derived from it), delete `MemoryShape`, and rename one of the core types.

### 39. Oversized modules, with proposed splits

| Module | Size | Proposed split |
|---|---|---|
| `createMarkdownMemoryStore` (`markdown-memory-store.ts`) | 1,445 lines | Move the correction workflow (lines 487–1212, about 725) to `markdown-memory-corrections.ts`; move proposal resolution and queries out as well |
| `createLibrarianStore` (`librarian-store.ts`) | 1,190 lines | `shelf-core.ts` (build/gate/resolveWriteTarget); `principal-views.ts` (lines 1079–1477); `curator-files.ts` |
| `trpc/memories.ts` | 1,431 lines, 25 procedures | `browse`, `review`, `flags` and `mutations` sub-routers (do together with item 38) |
| `MemoriesView` (`dashboard/components/memories/view.tsx`) | 585 lines, 19 `useState` | One component or hook per tab |
| `installer-cli/src/server/up.ts` | 1,809 lines | Bind-host resolution, deployment files and health checks as separate modules; move `CONTAINER_NAME` to constants |

Also notable: `createLibrarianServer` is 514 lines.

### 40. Dead code

**Core exports**
- `@librarian/core` exports 787 symbols. 335 are referenced nowhere outside core's source and 196 only by core's tests.
- Notable dead values: the handoff output schemas, `toCanonicalId`, `deriveAuthSecret`, `burnBootstrapClaim`, `recallMemories`, `preRestoreTagName`, `parseExtractedFacts` and `normalizeMemoryInput`.
- The `./constants` subpath has no importers, and `./store-internal` has one test importer.

**Whole modules**
- `caller-audit.ts`/`caller-backfill.ts` and the store methods that exist only for them. This is migration tooling; confirm before deleting.
- `startContext`/`memory-context.ts`, `Vault.tryReadDocument`, `SyncGitOps.isRepo`/`log`, `relinkVault`.
- `readLlmConnection`/`writeLlmConnection`, the three `*PatchSchema`s, `failIntakeRun`, `isLegacyIntakeEnvSet`.
- `readSummary` in cli, and the `transcript-sweep.ts:613` re-export block.
- `forceProposal` is still documented as user-reachable in `configuring-the-curator.md` but nothing sets it any more.

**tRPC procedures the dashboard never calls**
- `examples.get` (e2e only), `examples.rollback`, `grooming.runOperations`, `ingest.failures` (whose comment claims the dashboard uses it), `vault.resolve`, `vault.atCommit`, `memories.related`. Confirm before removing.

**Ignored inputs**
- `include_private` and `agent_id` on several tRPC schemas are accepted and ignored, and two `approve` checks can never be false.
- `TrpcContext.role` is never read.
- `__resetLatestReleaseCacheForTests` is exported from the public entry point.

**Dashboard**
- `ui-v2/filter-chip.tsx` and `inspector.tsx` are used only by tests.
- The exported server actions `configureOAuthAction` and `setOwnerAction` are used only by tests. Server actions are reachable endpoints, so remove them.
- The `-v2` suffix, the leftover shadcn `components.json`, and shadcn tokens used 4 times, including a `rounded-md bg-card` that breaks the design system.

**Dependencies**
- Unused: dashboard `@radix-ui/react-slot` and `class-variance-authority`; core `simple-git`; cli → `@librarian/mcp-server` (which the Dockerfile copies a second time).
- Undeclared: dashboard `@librarian/core`; `@next/eslint-plugin-next` is declared in the wrong workspace.

**Stray file**
- `pull-and-restart.sh`: an unreferenced personal ops script with a hard-coded private Tailscale IP and predictable `/tmp` lock paths.

### 41. Duplicated helpers
- `stripCodeFence` ×7 in core. Six are identical; `chronicle/narrate.ts` behaves differently.
- `summarizeIssues` ×2 and `isRecord` ×3.
- The "read consumer config → resolve token → `createGroomingLlmClient`" sequence ×5 (intake, grooming, transcript, chronicle, correction). This is the natural place to add usage metering: transcript extraction, correction, chat and distill token spend is currently never recorded.
- `coerceDates` ×4, `cmpStr` ×3, `DEFAULT_TIMEOUT_MS` ×3, `parseTimeoutMs` ×2 (with different bounds), HH:MM parsing ×3.
- The `"system-consolidator"` literal is repeated instead of being added to `SYSTEM_ACTOR_IDS`.
- The "is a flagged-correction proposal" predicate is inlined 6 times in `librarian-store.ts`.
- MCP input limits (5/120/100/50000) are hand-copied in four places. **Fix:** generate the JSON Schema with `z.toJSONSchema`, or add a parity test.
- Installer adapter fetcher and `copyDir` ×3, which leak temp dirs and have no fetch timeout.
- Dashboard: an identical `message(error)` helper in 9 files, `formatDate` ×4 with three different outputs, and the "saved" flag with a 5 s timer in about 12 forms.

### 42. Test health
- **Type-checking:** about 300 test files are never type-checked. The package tsconfigs exclude `tests`, and vitest strips types. **Fix:** add a `tsconfig.tests.json` per package, chained into `typecheck`.
- **No tests:**
  - CLI `handoffs list/show/purge`. `purge` is destructive, and the comment points at a `handoffs-cli.test.ts` that doesn't exist.
  - `backfillCallerIds`.
  - The `/models` success path.
- **Never run in CI:** the real embedder test (it is gated on `LIBRARIAN_TEST_GGUF`).
- **Lint:** the Vitest ESLint plugin is registered with no rules, and its comment still says the tests use `node:test`.
- **In good shape:** no `.only`, no `.todo`, and every test case asserts something.

### 43. Hygiene, CI and docs
- **Overrides:** `form-data` and `@babel/core` match nothing; `nanoid` is redundant.
- **CI:**
  - It runs on push only, so pull requests from forks get no CI. Add `pull_request` for fork heads.
  - The release job uses third-party actions pinned by tag, not SHA (`release.yml:117-176`).
- **Docs out of step with the code:**
  - `librarian report` and `self-update` are advertised in the usage text and the generated CLI docs but are stubs.
  - The README and the Codex README say "no code" for Codex and OpenCode, but install puts capture hooks in place.
  - `docs/TODO.md:54` and `docs/tech-debt.md:72` are stale.
  - PRODUCT.md, CLAUDE.md and DESIGN.md disagree about the accent colour.
  - The command palette uses `shadow-lg` and `rounded-sm` against the flat, sharp-corner rule.
- **Stray file:** `._.DS_Store` is tracked; add `._*` to `.gitignore`.
- **Tokens on the command line:** `librarian config --token` puts the token in `ps` and shell history. Add `--token-stdin` or an env var.
- **Offline recall:** recall with a query fails outright when the embedding model can't be downloaded, instead of falling back to keyword search. Found in passing; worth a separate look.

---

## Checked and found sound

- **Token and password handling:**
  - DB agent tokens: 192-bit secrets, salted SHA-256, timing-safe comparison.
  - Env tokens compared with `timingSafeEqual`.
  - scrypt parameters.
  - Setup links: single use, TTL, hashed.
  - The bootstrap-claim HMAC flow.
- **Crypto:** AES-256-GCM with a random IV and a 0600 key file.
- **SSRF guard:** DNS pinning, a re-check on every redirect hop, and coverage of IPv4-mapped, 6to4 and decimal/hex literals.
- **Vault paths:** `assertVaultFilePath` and `scopeVault` stop escapes across shelves and out of the root.
- **Backups:** the token goes via `GIT_ASKPASS`, never argv or the URL; `execFileSync` with argv means no shell injection.
- **The D13 apply rule** is applied the same way in intake, grooming and correction. Archive and split always become proposals.
- **Scheduling:** `SerialScheduler` never overlaps runs; chronicle's ISO-week and DST handling is correct.
- **Model output:** all of it is parsed with strict zod schemas and never echoed in errors.
- **The retired MCP verbs** are fully gone; the 7-verb registry matches the healthcheck.
- **Dashboard:**
  - Middleware fails closed.
  - `/api/trpc` strips inbound credentials.
  - No `dangerouslySetInnerHTML`.
  - `react-markdown` blocks `javascript:` links (but see the note below).
  - No server-only module leaks into client code.
- **Integrations:**
  - Hooks exit 0 and time out.
  - Credentialed fetches in the capture clients use `redirect: "error"`.
  - Token files are 0600.
  - The Docker images run as non-root.
  - npm publishing uses OIDC.

**One open privacy note:** `react-markdown` renders remote `<img>` tags from untrusted memories and references, and there is no CSP. Opening a document can fire tracking pixels. Override `components.img` and add `img-src 'self' data:`.

## Suggested order of work

1. **One security PR** for items 1, 2, 12, 22 (chrome-extension origin) and 23. All are small, contained patches.
2. **One privacy PR** for items 4, 5 and 24, with the shared capture fixture from item 37, so every adapter is tested against the same cases.
3. **Item 3** (vault editor), on its own, with a regression test.
4. **A storage robustness PR** for items 6, 7, 11, 14 and 26. They overlap heavily: safe parsing, atomic writes, cache invalidation.
5. **A curator safety PR** for items 8, 9 and 10.
6. **Item 17**, the audit override bump, before anything else is merged, so CI stays green.
7. Then the P1 installer and MCP items, then P2 work by area, and P3 as ongoing cleanup.
