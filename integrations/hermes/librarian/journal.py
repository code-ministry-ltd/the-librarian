"""Journal injection helpers (spec 078) — the Python port of
``integrations/claude/scripts/lib/journal.mjs``.

- :data:`JOURNAL_MAX_CHARS` — the window size every harness asks the server for:
  Claude Code's, under its 10,000-character hook cap, so all five harnesses see
  the same window.
- :func:`fit_journal` — the client-side trim, for a server that ignores
  ``max_chars``: drops the OLDEST ``## `` blocks and ends with a pointer to the
  ``journal`` tool.
- :func:`is_journal_injection_off` — the ``LIBRARIAN_JOURNAL=off`` kill switch.
- :func:`derive_project` — the project label for /transcript. Unlike the other
  harnesses, Hermes labels a conversation only when its working directory is
  inside a git repository: Hermes often runs as a messaging gateway from a
  service directory, where a folder name would be noise. The harness itself is
  always recorded (``harness: "hermes"`` on every payload).

Pure and stdlib-only; nothing here raises.
"""

from __future__ import annotations

import os
from collections.abc import Mapping

JOURNAL_MAX_CHARS = 9_500

TRIMMED_NOTE = "Older entries were left out to fit — call the `journal` tool to read further back."


def is_journal_injection_off(env: Mapping[str, str]) -> bool:
    """True for ``LIBRARIAN_JOURNAL`` = off / false / 0 / no (any case)."""
    return (env.get("LIBRARIAN_JOURNAL") or "").strip().lower() in ("off", "false", "0", "no")


def fit_journal(text: str, limit: int = JOURNAL_MAX_CHARS) -> str:
    """Keep the window under ``limit`` characters by dropping the oldest ``## ``
    blocks (the window is oldest-first), keeping the header and the newest."""
    if len(text) <= limit:
        return text
    parts = text.split("\n## ")
    header = parts[0]
    blocks = [f"## {b}".rstrip() for b in parts[1:] if not f"## {b}".startswith(TRIMMED_NOTE)]

    def render(kept: list[str]) -> str:
        return f"{header.rstrip()}\n\n" + "\n\n".join(kept) + f"\n\n{TRIMMED_NOTE}\n"

    start = 0
    while start < len(blocks) - 1 and len(render(blocks[start:])) > limit:
        start += 1
    out = render(blocks[start:])
    return out if len(out) <= limit else out[:limit]


def derive_project(cwd: str | None) -> str | None:
    """The name of the git repository containing ``cwd`` (the nearest ancestor
    holding a ``.git`` entry), or None — outside a repo Hermes sends no label."""
    if not cwd or not os.path.isabs(cwd):
        return None
    try:
        directory = os.path.abspath(cwd)
        while True:
            if os.path.exists(os.path.join(directory, ".git")):
                label = os.path.basename(directory).strip()[:200]
                return label or None
            parent = os.path.dirname(directory)
            if parent == directory:
                return None
            directory = parent
    except (OSError, ValueError):
        return None
