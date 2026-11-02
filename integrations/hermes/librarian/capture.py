"""Auto-capture pure transforms (no IO, no network) — Phase 2B / T-Hermes.

The Hermes ``sync_turn`` hook hands the adapter BOTH halves of a completed turn
directly (``user_content`` + ``assistant_content``) plus the stable session id.
That is the §11.2 expectation: the delta is built O(1) from the in-payload turn —
there is NO cursor and NO transcript re-read (unlike the Claude ``Stop`` adapter,
which slices an append-only JSONL file by byte offset).

This module owns the three pure transforms the hook drives, mirroring the Claude
adapter's *guarantees* in Python:

  turn_pair_to_turns   the two halves → ordered [user, assistant] turn dicts
  filter_private_turns forward-only private-span skip (carry-forward across turns)
  build_payload        the uniform /transcript contract body

Everything is fail-soft and trivially unit-testable; the provider (provider.py)
wires the session state, the client ship, and the env gates around these.
"""

from __future__ import annotations

from typing import Any

# The private-mode markers (AGENTS.md: never bypass private mode). Same literals
# the harness toggles in-conversation and the server backstops on intake.
PRIVATE_ON = "[librarian:private=on]"
PRIVATE_OFF = "[librarian:private=off]"

HARNESS = "hermes"


def _coerce_text(value: Any) -> str:
    """A turn half is supposed to be a str; coerce anything else to "" rather
    than crash the hook (fail-soft). A non-string half yields no turn."""
    return value.strip() if isinstance(value, str) else ""


def turn_pair_to_turns(
    user_content: Any,
    assistant_content: Any,
    *,
    ts: str | None = None,
) -> list[dict[str, str]]:
    """Map the two halves of one completed turn to ordered turn dicts.

    Yields ``[user, assistant]`` in that order, dropping an empty half (a
    tool-only assistant step, or an empty user prompt). Each turn is the contract
    shape ``{role, text, ts?}``; the optional ``ts`` (an ISO-8601 stamp) is
    applied to both halves when supplied.
    """
    turns: list[dict[str, str]] = []
    for role, raw in (("user", user_content), ("assistant", assistant_content)):
        text = _coerce_text(raw)
        if not text:
            continue
        turn = {"role": role, "text": text}
        if ts:
            turn["ts"] = ts
        turns.append(turn)
    return turns


def filter_private_turns(
    turns: list[dict[str, str]],
    *,
    start_private: bool,
) -> tuple[list[dict[str, str]], bool]:
    """Forward-only private-span filter (mirrors the Claude adapter).

    Tracks the ``[private=on]/[private=off]`` marker state across the turns in
    this delta AND across turns via ``start_private`` (whether the previous turn
    left an open span). Any turn while the span is open is SKIPPED; the
    marker-toggle turns themselves are skipped too (they carry no durable fact).
    Forward-only: a private turn is NEVER retroactively shipped — once the caller
    advances past it (a skip is still a real, counted delivery), it is gone.

    Within a single turn's text the LAST-occurring marker wins, so a turn that
    re-opens privacy stays private into the next turn.

    Returns ``(kept, end_private)`` — the non-private turns and the span state to
    carry into the next ``sync_turn``.
    """
    priv = bool(start_private)
    kept: list[dict[str, str]] = []
    for turn in turns:
        text = turn.get("text", "")
        has_on = PRIVATE_ON in text
        has_off = PRIVATE_OFF in text
        is_marker_turn = has_on or has_off

        # Resolve the new state from this turn's last-occurring marker.
        if is_marker_turn:
            on_at = text.rfind(PRIVATE_ON) if has_on else -1
            off_at = text.rfind(PRIVATE_OFF) if has_off else -1
            priv = on_at > off_at

        # Skip if we're (or just entered) a private span, OR this is itself a
        # boundary marker turn (it may carry private text alongside the marker).
        if priv or is_marker_turn:
            continue
        kept.append(turn)
    return kept, priv


def filter_private_exchange(
    turns: list[dict[str, str]],
    *,
    start_private: bool,
) -> tuple[list[dict[str, str]], bool]:
    """Exchange-granular private filter for the Hermes ``sync_turn`` unit.

    Hermes hands a completed turn as a user+assistant PAIR (one atomic exchange),
    not two independent messages. So a private toggle anywhere in the exchange
    makes the WHOLE exchange a privacy boundary: if the user opens privacy
    mid-exchange the assistant's reply is responding to now-private content, and
    if the user closes privacy the assistant reply is still part of the boundary
    exchange that carries no durable fact. Either way the safe, privacy-conservative
    choice is to ship NOTHING for an exchange that contains a marker, and let the
    next CLEAN exchange ship — never retroactively shipping the skipped halves.

    Resolves the end-state from the LAST-occurring marker across the exchange
    (so a re-open stays private into the next exchange), and an exchange with no
    marker is filtered per-turn (kept iff the carried span is closed).

    Returns ``(kept, end_private)``.
    """
    has_marker = any(
        PRIVATE_ON in t.get("text", "") or PRIVATE_OFF in t.get("text", "") for t in turns
    )
    if has_marker:
        # Boundary exchange: skip everything, but resolve the carried state from
        # the last marker seen across the exchange's text (concatenated order).
        joined = "\n".join(t.get("text", "") for t in turns)
        on_at = joined.rfind(PRIVATE_ON)
        off_at = joined.rfind(PRIVATE_OFF)
        return [], on_at > off_at
    # No marker in the exchange: a clean per-turn filter (carry the span forward).
    return filter_private_turns(turns, start_private=start_private)


def build_payload(
    *,
    conv_id: str,
    seq: int,
    turns: list[dict[str, str]],
    ended: bool = False,
    project: str | None = None,
) -> dict[str, Any]:
    """Build the uniform, harness-agnostic delta the server contract expects:
    ``{conv_id, harness:"hermes", seq, turns[], ended?, project?}``. ``ended`` is
    omitted unless true (the server treats its mere presence as the explicit-end
    accelerator). ``project`` (spec 078) is set only by a caller that knows the
    server accepts it."""
    payload: dict[str, Any] = {
        "conv_id": conv_id,
        "harness": HARNESS,
        "seq": seq,
        "turns": turns,
    }
    if ended:
        payload["ended"] = True
    if project:
        payload["project"] = project
    return payload
