"""Hermes in-session slash commands for The Librarian — optional sugar.

The primer (served via ``system_prompt_block``) is the canonical definition of
these protocols (rethink D9); the commands below are thin prompt templates over
the same 7-verb MCP surface, registered only where Hermes makes that cheap.
``docs/slash-commands.md`` in the monorepo is the wording reference.

Hermes slash commands are registered programmatically via
``ctx.register_command(name, handler, description, args_hint)``. Each handler
has the signature ``fn(raw_args: str) -> str | None``. They are only wired when
the plugin is loaded as a *general* plugin (``hermes plugins enable librarian``);
activating the memory provider alone does not register them — and nothing is
lost if they never register, because the primer teaches the same protocols.

A Hermes ``fn(raw_args)`` handler is non-interactive, so each command surfaces
the prompt that drives the LLM rather than running the multi-step flow itself.
The LLM, having read the primer, then performs the actual MCP calls.
"""

from __future__ import annotations

from typing import Any

_HANDOFF_PROMPT = (
    "Author a five-section handoff document (Start & intent / Journey / "
    "Current state / What's left / Open questions), then call "
    "`store_handoff` with the document. Report the returned handoff_id. "
    "See the Librarian primer in your system prompt for the full protocol."
)

_TAKEOVER_PROMPT = (
    "Call `list_handoffs` with the current project_key + cwd, present the "
    "candidates to the user (never auto-select), then `claim_handoff` on "
    "selection and continue the work the returned document_md describes."
)

_LEARN_PROMPT = (
    "Extract durable lessons from this conversation and store the "
    "user-approved ones with `remember` — one call per durable lesson, each "
    "with a short title and a self-contained body. Fire-and-forget: the user "
    "picking a lesson is the review, so submit and move on; the curator "
    "dedupes, merges, and files each one asynchronously."
)

_TOGGLE_ON = (
    "Private mode is ON. `[librarian:private=on]` — do not call `remember`, "
    "`store_handoff`, or `flag_memory` until told otherwise. `recall` and "
    "`search_references` stay allowed; note that read queries still reach the "
    "Librarian server's logs. Private mode is an in-conversation instruction; "
    "the server cannot verify its marker. A correction job queued by a flag "
    "from public context may still finish after switching private; the toggle "
    "does not cancel queued work. Remain in this state until explicitly "
    "toggled off."
)

_TOGGLE_OFF = "Private mode is OFF. `[librarian:private=off]` — normal operation resumed."


def register_commands(ctx: Any) -> None:
    """Register the four user-facing slash commands.

    No-op if *ctx* has no ``register_command`` (e.g. the memory-provider
    loader's collector, which only keeps the provider).
    """
    register = getattr(ctx, "register_command", None)
    if register is None:
        return

    def handoff(_raw_args: str = "") -> str:
        return _HANDOFF_PROMPT

    def takeover(_raw_args: str = "") -> str:
        return _TAKEOVER_PROMPT

    def learn(_raw_args: str = "") -> str:
        return _LEARN_PROMPT

    def toggle_private(_raw_args: str = "") -> str:
        # The toggle is pure in-conversation — no server state, no hook. We
        # can't observe the prior state from a non-interactive handler, so emit
        # both markers in a single message and rely on the LLM to read its own
        # most-recent state out of the transcript and pick the right one.
        # Private mode blocks writes only (rethink D11).
        return (
            "Toggle in-conversation private mode. Inject the inverse of the "
            "most recent `[librarian:private=on|off]` marker. If ON: emit "
            f"`{_TOGGLE_OFF}`. If OFF or no marker: emit `{_TOGGLE_ON}`."
        )

    commands = (
        (
            "handoff",
            handoff,
            "Author and persist a cross-harness handoff document",
            "",
        ),
        (
            "takeover",
            takeover,
            "Pick up a handoff from another agent / harness",
            "",
        ),
        (
            "learn",
            learn,
            "Extract durable lessons from this conversation into durable memory",
            "",
        ),
        (
            "toggle-private",
            toggle_private,
            "Toggle in-conversation private mode (no server state, no hook)",
            "",
        ),
    )
    for name, handler, description, args_hint in commands:
        register(name, handler, description=description, args_hint=args_hint)
