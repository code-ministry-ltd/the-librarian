#!/usr/bin/env node
// Claude `SessionStart` journal hook (spec 077 PR C) — prints the recent window of
// the conversation journal so a new session (and a session after compaction, which
// re-fires SessionStart) starts knowing what you and the agent have been doing.
//
// It is a SEPARATE hook from the awareness banner on purpose: Claude Code caps each
// hook's injected output at 10,000 characters, and anything over that is moved to a
// file the model is never told to read. A hook of its own gives the journal the whole
// allowance; the server trims the window to fit and ends it with a pointer to the
// `journal` tool for older history.
//
// FAIL-SOFT (AGENTS.md): no config, `LIBRARIAN_JOURNAL=off`, server down, journal
// switched off or still empty, timeout — every one prints nothing and exits 0. The
// session always starts. The token is sent in the header only, never logged.

import process from "node:process";
import { fetchJournal } from "./lib/journal.mjs";

async function main() {
  const text = await fetchJournal(process.env);
  if (text) process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

main()
  .catch(() => {
    // Absolute backstop: never propagate; the session must start regardless.
  })
  .finally(() => {
    process.exit(0);
  });
