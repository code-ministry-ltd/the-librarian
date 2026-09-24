"""Slash-command sugar + plugin entry-point wiring."""

from __future__ import annotations

from typing import Protocol

import librarian
from librarian.commands import register_commands


class _CommandCtx:
    def __init__(self) -> None:
        self.registered: dict[str, dict] = {}

    def register_command(self, name, handler, *, description="", args_hint=""):
        self.registered[name] = {
            "handler": handler,
            "description": description,
            "args_hint": args_hint,
        }


class _NamedProvider(Protocol):
    name: str


class _MemoryCtx:
    def __init__(self) -> None:
        self.providers: list[_NamedProvider] = []

    def register_memory_provider(self, provider: _NamedProvider) -> None:
        self.providers.append(provider)


class _BareCtx:
    pass


def test_registers_the_four_verbs() -> None:
    ctx = _CommandCtx()
    register_commands(ctx)
    assert set(ctx.registered) == {"handoff", "takeover", "learn", "toggle-private"}


def test_noop_when_ctx_has_no_register_command() -> None:
    register_commands(_BareCtx())  # must not raise


def test_prompts_route_to_the_seven_verb_surface() -> None:
    ctx = _CommandCtx()
    register_commands(ctx)
    handoff = ctx.registered["handoff"]["handler"]()
    assert "store_handoff" in handoff
    for heading in ("Start & intent", "Journey", "Current state", "What's left", "Open questions"):
        assert heading in handoff
    takeover = ctx.registered["takeover"]["handler"]()
    assert "list_handoffs" in takeover and "claim_handoff" in takeover
    learn = ctx.registered["learn"]["handler"]()
    assert "remember" in learn
    # No prompt references the retired verbs.
    for name in ctx.registered:
        text = ctx.registered[name]["handler"]()
        assert "conv_state" not in text


def test_toggle_private_blocks_writes_only() -> None:
    # Rethink D11: the marker blocks remember/store_handoff/flag_memory;
    # reads stay allowed and the prompt says read queries reach server logs.
    ctx = _CommandCtx()
    register_commands(ctx)
    text = ctx.registered["toggle-private"]["handler"]()
    assert "[librarian:private=on]" in text
    assert "[librarian:private=off]" in text
    for blocked in ("`remember`", "`store_handoff`", "`flag_memory`"):
        assert blocked in text
    assert "`recall`" in text
    assert "logs" in text
    assert "server cannot verify its marker" in text
    assert "from public context may still finish after switching private" in text
    assert "does not cancel queued work" in text


def test_register_wires_provider_under_memory_loader() -> None:
    ctx = _MemoryCtx()
    librarian.register(ctx)
    assert len(ctx.providers) == 1
    assert ctx.providers[0].name == "librarian"


def test_register_wires_commands_under_general_loader() -> None:
    ctx = _CommandCtx()
    librarian.register(ctx)  # no register_memory_provider on this ctx
    assert set(ctx.registered) == {"handoff", "takeover", "learn", "toggle-private"}


def test_register_survives_a_bare_context() -> None:
    librarian.register(_BareCtx())  # neither loader surface — still no raise
