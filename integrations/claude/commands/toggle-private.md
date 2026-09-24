---
description: Toggle in-conversation private mode (no server state, no hook)
---

# Toggle private mode

Flip the in-conversation private-mode marker. **Pure in-context** — no MCP call, no server flag. The contract:

- `[librarian:private=on]` — the agent must NOT call `remember`, `store_handoff`, or `flag_memory` until told otherwise. `recall` and `search_references` stay allowed — but those read queries reach the Librarian server's logs; say so if the user asks. `/handoff` and `/learn` require explicit user confirmation while private. Private mode is an in-conversation instruction; the server cannot verify its marker. A correction job queued by a flag from public context may still finish after switching private; the toggle does not cancel queued work.
- `[librarian:private=off]` — normal operation.
- **Default when no marker is present:** OFF.

## Behaviour

1. Scan the conversation for the most recent `[librarian:private=on|off]` marker.
2. Announce the inverse state in your reply. Include both the machine token and a human-readable instruction so the LLM can re-emit it on its own if context compaction drops it. Suggested wording:
   - **ON:** "Private mode is ON. `[librarian:private=on]` — no calls to `remember`, `store_handoff`, or `flag_memory` until explicitly toggled off. `recall` and `search_references` are still allowed (those queries reach the server's logs). Private mode is an in-conversation instruction; the server cannot verify its marker. A correction job queued by a flag from public context may still finish after switching private; the toggle does not cancel queued work. Remain in this state until told otherwise."
   - **OFF:** "Private mode is OFF. `[librarian:private=off]` — normal operation resumed."
3. Confirm to the user with a one-liner: `Private mode → ON` or `Private mode → OFF`.

## Known limitation

If the harness compacts the conversation and drops the marker, the agent defaults to OFF and resumes writing durable memory. If a harness exposes a "context restored after compaction" signal, re-scan and re-emit the marker if it was on. Operators who need hard guarantees should avoid compaction during a private stretch (e.g. run with compaction disabled).
