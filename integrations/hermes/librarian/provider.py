"""The Librarian-backed Hermes Memory Provider (rethink v1.0 — 7-verb surface).

Maps the Hermes ``MemoryProvider`` hooks onto The Librarian's 7 MCP tools via
:class:`client.LibrarianClient`. Three invariants dominate:

- **The 7-verb agent contract.** ``get_tool_schemas()`` advertises exactly
  ``recall``, ``remember``, ``flag_memory``, ``store_handoff``,
  ``list_handoffs``, ``claim_handoff``, ``search_references``. Each schema's
  parameters mirror the server's advertised ``inputSchema``
  (``packages/mcp-server/src/mcp/tools/*.ts``), minus the fields the provider
  resolves itself (``agent_id`` and the ``claiming_*`` provenance, injected
  from config) and the retired ``conv_id``.
- **The primer is the only prompt injection.** ``system_prompt_block()``
  returns the operator-editable primer fetched once per session from
  ``GET /primer.md`` — verbatim, no wording of our own (Hermes regex-screens
  MCP-adjacent content; the server-side primer is already screened). The old
  per-turn *recall* prefetch / conv-state machinery is gone (rethink D10): the
  ABC marks ``prefetch``/``on_pre_compress``/``on_memory_write`` non-abstract,
  so they are simply not implemented here.
- **Auto-capture (Phase 2B).** ``sync_turn`` and ``on_session_end`` ARE wired:
  Hermes hands the completed turn's two halves + the stable session id to
  ``sync_turn`` after every turn (MemoryManager.sync_all, on a background
  worker), and the adapter ships that as a per-turn delta to ``POST
  /transcript`` — the harness-agnostic capture door. Default-on; suppressed
  under ``LIBRARIAN_AUTO_SAVE=false`` and forward-only private mode; inert when
  the server's intake gate is off; advances its seq only on a 2xx ack. The
  conv_id is the Hermes session id (NEVER ``$USER``/cwd, so concurrent sessions
  never collide). The transforms live in ``capture.py`` and the per-session
  seq/private state in ``capture_state.py``.
- **Fail-soft.** A Librarian / network failure is logged and swallowed — a
  turn is never blocked. ``handle_tool_call`` always returns a JSON string
  (the ABC's contract): ``{"ok": true, "result": …}`` on success, an
  ``{"ok": false, "error": {…}}`` envelope on any failure, never a raise.

The Hermes ``MemoryProvider`` ABC lives in the Hermes codebase (provided at
runtime), not installed here, so we subclass it when importable and ``object``
otherwise. Method names/shapes match ``agent/memory_provider.py`` in
NousResearch/hermes-agent (``handle_tool_call(tool_name, args, **kwargs)``;
``initialize(session_id, **kwargs)`` with ``hermes_home`` in kwargs).
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from . import capture as _capture
from . import capture_state as _capture_state
from .client import LibrarianClient, LibrarianClientError

if TYPE_CHECKING:
    _Base = object
else:
    try:  # pragma: no cover - exercised only inside a real Hermes runtime
        from agent.memory_provider import MemoryProvider as _Base
    except ImportError:
        _Base = object

LogFn = Callable[[str, str], None]

_CONFIG_FILENAME = "config.json"
_PROVIDER_NAME = "librarian"
_HARNESS = "hermes"

# Auto-capture is default-ON; the user opts OUT with LIBRARIAN_AUTO_SAVE=false
# (case-insensitive). Mirrors the Claude/Pi adapters' kill-switch.
_AUTO_SAVE_OFF = "false"

# Age-based pruning of stale per-session capture state (~7 days), opportunistic
# and fail-soft — NEVER clear-all (a fresh sibling is a live concurrent session).
_PRUNE_MAX_AGE_S = 7 * 24 * 60 * 60


# ---------------------------------------------------------------------------
# Config — non-secret values in $HERMES_HOME/librarian-plugin/config.json,
# the bearer token ONLY from the LIBRARIAN_AGENT_TOKEN env var.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LibrarianConfig:
    endpoint: str
    token: str
    agent_id: str | None = None
    project_key: str | None = None
    timeout_ms: int = 15000


def config_schema() -> list[dict[str, Any]]:
    """Field descriptors for ``hermes memory setup`` (the get_config_schema body)."""
    return [
        {
            "key": "endpoint",
            "description": "Librarian HTTP MCP endpoint URL",
            "url": True,
            "required": True,
            "secret": False,
        },
        {
            "key": "token",
            "description": "Librarian agent bearer token",
            "secret": True,
            "required": True,
            "env_var": "LIBRARIAN_AGENT_TOKEN",
        },
        {
            "key": "agent_id",
            "description": "Canonical agent id (optional if the token is agent-bound)",
            "required": False,
            "secret": False,
        },
        {
            "key": "project_key",
            "description": "Default project scope for handoffs (optional)",
            "required": False,
            "secret": False,
        },
        {
            "key": "timeout_ms",
            "description": "Per-call timeout in ms",
            "required": False,
            "secret": False,
            "default": 15000,
        },
    ]


def _config_path(hermes_home: str) -> Path:
    return Path(hermes_home) / "librarian-plugin" / _CONFIG_FILENAME


def save_config(values: dict[str, Any], hermes_home: str) -> None:
    """Persist non-secret config under hermes_home. The token is never written —
    it comes from the LIBRARIAN_AGENT_TOKEN env var at load time."""
    path = _config_path(hermes_home)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.parent.chmod(0o700)
    non_secret = {k: v for k, v in values.items() if k != "token"}
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, json.dumps(non_secret).encode("utf-8"))
    finally:
        os.close(fd)
    path.chmod(0o600)


def load_config(hermes_home: str, env: dict[str, str]) -> LibrarianConfig | None:
    """Load config (non-secret from hermes_home, token from env). Returns None if
    not fully configured."""
    path = _config_path(hermes_home)
    values: dict[str, Any] = {}
    try:
        values = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        values = {}
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(values, dict):
        return None
    endpoint = values.get("endpoint")
    token = env.get("LIBRARIAN_AGENT_TOKEN")
    if not isinstance(endpoint, str) or not endpoint or not token:
        return None
    timeout = values.get("timeout_ms")
    return LibrarianConfig(
        endpoint=endpoint,
        token=token,
        agent_id=values.get("agent_id") or None,
        project_key=values.get("project_key") or None,
        timeout_ms=int(timeout) if isinstance(timeout, int) else 15000,
    )


# ---------------------------------------------------------------------------
# The 7 tool schemas (OpenAI function format, per the ABC).
#
# Source of truth: the server's advertised inputSchemas in
# packages/mcp-server/src/mcp/tools/{recall,remember,flag-memory,store-handoff,
# list-handoffs,claim-handoff,search-references}.ts (+ schemas.ts for
# `remember`). Differences are deliberate and provider-resolved:
#   - `agent_id` (recall/remember/claim) and `project_key` (handoffs only —
#     memories are project-less) scoping and `claiming_*` provenance are
#     injected from config (see _scoped_args), not asked of the model;
#   - `include_ids` is always set to true on recall so flag_memory has a
#     target;
#   - recall tightens `query` to required (the server leaves it optional, but
#     an unqueried recall is never what the model wants);
#   - the retired `conv_id` and curator-side fields (visibility/scope/
#     confidence/applies_to) are not advertised.
# tests/test_schemas.py pins this parity against the TS sources.
# ---------------------------------------------------------------------------


def tool_schemas() -> list[dict[str, Any]]:
    return [
        {
            "name": "recall",
            "description": (
                "Search durable memory before acting — at task start, or whenever "
                "prior context, a stored preference, or a past decision would help. "
                "Query by free text; `tags` narrows to memories carrying any of the "
                "supplied tags. Each result is prefixed with its memory id (e.g. "
                "`[mem_…]`) — if a recalled memory turns out to be wrong, misleading, "
                "or outdated, pass that id to `flag_memory` with a `reason`."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "limit": {"type": "number"},
                },
                "required": ["query"],
            },
        },
        {
            "name": "remember",
            "description": (
                "Save a durable fact, preference, or decision the moment you learn "
                "it — not transient chatter. Fire-and-forget: submit and move on; "
                "the curator files it asynchronously (dedupe, merge, link — no need "
                "to check first). Give it a short `title` and a self-contained "
                "`body`; add `tags` so it surfaces in the right "
                "context."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "body": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["title", "body"],
            },
        },
        {
            "name": "flag_memory",
            "description": (
                "Flag a recalled memory you believe is incorrect, misleading, or "
                "outdated, with a short free-text `reason`. The flag routes the "
                "memory to human review and ranks it below unflagged matches in "
                "recall — it never edits, archives, or deletes the memory, and there "
                "is no 'this was useful' counterpart. Use it sparingly, only when a "
                "memory actively led you astray. The `memory_id` is the id in "
                "brackets from a preceding `recall` result."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "memory_id": {"type": "string"},
                    "reason": {"type": "string", "minLength": 1, "maxLength": 2000},
                },
                "required": ["memory_id", "reason"],
            },
        },
        {
            "name": "store_handoff",
            "description": (
                "Persist a handoff document so another agent (or harness) can resume "
                "your work later. Only call it when the user has explicitly asked "
                "for a handoff — never spontaneously, even when pausing mid-task or "
                "ending a session. The document must follow the "
                "five-section template — Start & intent, Journey, Current state, "
                "What's left, Open questions — or it is rejected."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "minLength": 5, "maxLength": 120},
                    "document_md": {"type": "string", "minLength": 100, "maxLength": 50000},
                    "project_key": {"type": ["string", "null"]},
                    "source_ref": {"type": ["string", "null"]},
                    "cwd": {"type": ["string", "null"]},
                    "tags": {"type": "array", "items": {"type": "string"}, "maxItems": 10},
                },
                "required": ["title", "document_md"],
            },
        },
        {
            "name": "list_handoffs",
            "description": (
                "List unclaimed handoffs you could pick up — call this before "
                "resuming work to see what's waiting. Default scope is the current "
                "project_key + cwd when both are supplied; drop either to broaden "
                "when nothing matches. Then `claim_handoff` the one you want."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "project_key": {"type": ["string", "null"]},
                    "cwd": {"type": ["string", "null"]},
                    "harness": {"type": ["string", "null"]},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                },
            },
        },
        {
            "name": "claim_handoff",
            "description": (
                "Atomically claim a handoff and return its document. Fails with "
                "`not_found` if the id is unknown; `already_claimed` if another "
                "agent got there first (the existing claim is included so you can "
                "report it)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "handoff_id": {"type": "string", "minLength": 1},
                },
                "required": ["handoff_id"],
            },
        },
        {
            "name": "search_references",
            "description": (
                "Search reference docs (references/) by query. Returns each match's "
                "path + the relevant section. References are background material — "
                "they are not in normal recall; use this to look them up on demand."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "What to look up in the references.",
                    },
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                },
                "required": ["query"],
            },
        },
    ]


TOOL_NAMES: frozenset[str] = frozenset(schema["name"] for schema in tool_schemas())


def _error_result(kind: str, message: str) -> str:
    """Fail-soft tool result: a JSON error envelope, never a raised exception.
    The message never carries the token (the client guarantees that)."""
    return json.dumps({"ok": False, "error": {"kind": kind, "message": message}})


class LibrarianProvider(_Base):
    """Hermes Memory Provider backed by The Librarian (7-verb surface)."""

    def __init__(
        self,
        *,
        client: LibrarianClient | None = None,
        config: LibrarianConfig | None = None,
        logger: LogFn | None = None,
        env: dict[str, str] | None = None,
    ) -> None:
        self._client = client
        self._config = config
        self._log: LogFn = logger or (lambda _level, _msg: None)
        self._env = env if env is not None else dict(os.environ)
        # Session-scoped primer cache; only a successful fetch is cached, so a
        # transient failure retries on the next call instead of going dark.
        self._primer: str | None = None
        # Auto-capture session context, captured at initialize(): the stable
        # Hermes session id (the conv_id) and hermes_home (the per-session
        # seq/private state home). Both None until initialize wires them.
        self._session_id: str | None = None
        self._hermes_home: str | None = None

    # ---- identity / availability / config (the ABC surface) ----

    @property
    def name(self) -> str:
        return _PROVIDER_NAME

    def is_available(self) -> bool:
        # Config-only check per the ABC ("should not make network calls").
        if self._config is None:
            hermes_home = self._resolve_hermes_home()
            if hermes_home is not None:
                self._config = load_config(hermes_home, self._env)
        return self._config is not None

    def get_config_schema(self) -> list[dict[str, Any]]:
        return config_schema()

    def save_config(self, values: dict[str, Any], hermes_home: str) -> None:
        save_config(values, hermes_home)

    # ---- lifecycle ----

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        """Agent startup: capture the session context, load config, wire the
        HTTP client. The session id is the auto-capture conv_id (Phase 2B), and
        ``hermes_home`` is the per-session capture-state home. Never raises — an
        unconfigured provider just goes inert (the hooks become clean no-ops)."""
        hermes_home = kwargs.get("hermes_home")
        # Capture the auto-capture session context. The session id is the stable,
        # opaque Hermes session id (timestamp_uuid) — the conv_id, never $USER/cwd.
        self._session_id = session_id or None
        if isinstance(hermes_home, str) and hermes_home:
            self._hermes_home = hermes_home
        if self._config is None:
            if not isinstance(hermes_home, str):
                self._log(
                    "error", "librarian: no hermes_home supplied; provider inert this session"
                )
                return
            self._config = load_config(hermes_home, self._env)
        if self._client is None and self._config is not None:
            try:
                self._client = LibrarianClient(
                    self._config.endpoint, self._config.token, timeout_ms=self._config.timeout_ms
                )
            except ValueError as err:
                # A non-http(s) endpoint in config: log + stay inert (fail-soft).
                self._log("error", f"librarian: invalid endpoint in config: {err}")
        # Opportunistic, fail-soft pruning of stale sibling state (never clear-all).
        if self._hermes_home:
            _capture_state.prune_old_state(self._hermes_home, max_age_s=_PRUNE_MAX_AGE_S)

    def on_session_switch(self, new_session_id: str, **kwargs: Any) -> None:
        """Hermes rotated the session id mid-process (/new, /resume, /branch,
        compression). Re-key auto-capture to the new conversation so subsequent
        deltas land under the right conv_id. Default no-op semantics if empty."""
        del kwargs
        if new_session_id:
            self._session_id = new_session_id

    def shutdown(self) -> None:
        self._client = None
        self._primer = None
        self._session_id = None
        self._hermes_home = None

    # ---- system prompt (the primer — D10's connect-time channel) ----

    def system_prompt_block(self) -> str:
        """The operator-editable primer from ``GET /primer.md``, verbatim.

        Cached for the session after the first successful fetch. Fail-soft:
        any error returns an empty string and the prompt assembles without us
        — the user's work is never blocked on the Librarian being reachable.
        No local wording is added: the server-side primer is already screened
        against injection-shaped phrasing (Hermes regex-screens this content).
        """
        if self._primer is not None:
            return self._primer
        if self._client is None:
            return ""
        try:
            primer = self._client.fetch_primer()
        except LibrarianClientError as err:
            self._log("warn", f"librarian: primer fetch failed: {err}")
            return ""
        self._primer = primer
        return primer

    # ---- auto-capture (Phase 2B — sync_turn / on_session_end) ----

    def _auto_save_enabled(self) -> bool:
        """Default-ON; the user opts OUT with ``LIBRARIAN_AUTO_SAVE=false``
        (case-insensitive). Any other value (unset, "true", "1", "") stays on."""
        return self._env.get("LIBRARIAN_AUTO_SAVE", "").strip().lower() != _AUTO_SAVE_OFF

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        **kwargs: Any,
    ) -> None:
        """Ship the just-completed turn as a per-turn delta to ``POST /transcript``.

        Hermes hands BOTH halves of the turn + the stable session id directly
        (MemoryManager.sync_all, on a background worker), so the delta is built
        O(1) — no cursor, no transcript re-read (§11.2). Forward-only private
        skip; conv_id = the Hermes session id; seq advances only on a 2xx ack.

        Fail-soft above all: this NEVER raises out of the hook (it must never
        block the turn or leak a stack trace), so the whole body is guarded.
        ``messages`` (and any other kwarg) is accepted for forward-compat but
        unused — we ship prose halves, not the raw OpenAI message list."""
        del kwargs
        try:
            self._capture_turn(user_content, assistant_content, session_id, ended=False)
        except Exception as err:  # noqa: BLE001 - fail-soft: never escape the hook
            self._log("warn", f"librarian: sync_turn capture failed (fail-soft): {err}")

    def on_session_end(self, messages: list[dict[str, Any]] | None = None) -> None:
        """Explicit-end accelerator: tell the server's settle-sweep this
        conversation ended so it extracts the buffer on its next tick without
        waiting for the idle window. Ships an ``ended:true`` delta (empty turns
        are fine — its mere presence is the signal). Fail-soft."""
        del messages
        try:
            self._capture_turn("", "", session_id="", ended=True)
        except Exception as err:  # noqa: BLE001 - fail-soft: never escape the hook
            self._log("warn", f"librarian: on_session_end capture failed (fail-soft): {err}")

    def _capture_turn(
        self,
        user_content: str,
        assistant_content: str,
        session_id: str,
        *,
        ended: bool,
    ) -> None:
        """Shared ship path for ``sync_turn`` / ``on_session_end``. Resolves the
        conv_id + state, applies the forward-only private filter, posts the delta,
        and advances seq + persists private state ONLY on a 2xx ack. Inert (clean
        no-op) when auto-save is off, the provider is unconfigured, or there is no
        conv_id. Assumes the caller's try/except provides the outer fail-soft."""
        if not self._auto_save_enabled():
            return
        if self._client is None:
            return
        # conv_id = the hook-supplied session id, else the one from initialize().
        # NEVER $USER/cwd — concurrent same-machine sessions must not collide.
        conv_id = session_id or self._session_id or ""
        if not conv_id:
            return
        # Where to persist seq + the carried private span. Fall back to the user's
        # home if hermes_home was never captured (still per-user, never shared).
        home = self._hermes_home or self._resolve_hermes_home()
        if not home:
            return

        prior = _capture_state.read_capture_state(home, conv_id)

        # Build this exchange's halves and apply the forward-only EXCHANGE-level
        # private filter: a marker anywhere in the user+assistant pair makes the
        # whole exchange a boundary (skip all halves), carrying the resolved span
        # state forward. Privacy-conservative for the atomic sync_turn unit.
        turns = _capture.turn_pair_to_turns(user_content, assistant_content)
        kept, end_private = _capture.filter_private_exchange(
            turns, start_private=bool(prior.get("private"))
        )

        # Nothing public to ship and not an explicit end: still persist the
        # carried private state so the next turn stays private — but don't POST.
        if not kept and not ended:
            if end_private != bool(prior.get("private")):
                _capture_state.write_capture_state(
                    home, conv_id, {"seq": prior["seq"], "private": end_private}
                )
            return

        seq = prior["seq"] + 1
        payload = _capture.build_payload(conv_id=conv_id, seq=seq, turns=kept, ended=ended)

        try:
            ack = self._client.post_transcript(payload)
        except LibrarianClientError as err:
            # Transient/infra: log + hold seq (the delta re-ships next turn;
            # server/curator dedup). Never leak the token (the client guarantees).
            self._log("warn", f"librarian: transcript ship failed (will retry): {err}")
            return

        # Advance + persist ONLY on a 2xx (ack.ok). A non-2xx holds seq so the
        # same delta re-ships next turn (idempotent). A gate-off 2xx still
        # advances (the turn is simply not captured while intake is disabled).
        if ack.get("ok"):
            _capture_state.write_capture_state(home, conv_id, {"seq": seq, "private": end_private})

    # ---- agent-facing tools ----

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        return tool_schemas()

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **kwargs: Any) -> str:
        """Proxy one of the 7 verbs over HTTP MCP (``tools/call``).

        Always returns a JSON string per the ABC contract and never raises:
        ``{"ok": true, "result": <server text>}`` on success,
        ``{"ok": false, "error": {"kind", "message"}}`` on any failure.
        """
        del kwargs
        if tool_name not in TOOL_NAMES:
            return _error_result("unknown_tool", f"Unknown Librarian tool: {tool_name}")
        if not isinstance(args, dict):
            return _error_result("bad_args", f"{tool_name} expects an object of arguments")
        if self._client is None:
            return _error_result(
                "unconfigured", "The Librarian provider is not configured; call skipped"
            )
        try:
            text = self._client.call_tool(tool_name, self._scoped_args(tool_name, args))
        except LibrarianClientError as err:
            self._log("warn", f"librarian: {tool_name} failed: {err}")
            return _error_result(err.kind, str(err))
        return json.dumps({"ok": True, "result": text})

    def _scoped_args(self, tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
        """Inject config-resolved scoping the model shouldn't have to supply.
        Caller-supplied values always win (setdefault only).

        - recall/remember: `agent_id`, and recall always asks for ids so a later
          flag_memory has something to target (memories are project-less now —
          `project_key` was retired from the memory model);
        - store_handoff/list_handoffs: `project_key`; store_handoff also stamps
          `harness: hermes` provenance;
        - claim_handoff: `claiming_agent_id` + `claiming_harness`;
        - flag_memory (keyed by the global memory_id) and search_references
          pass through verbatim.
        """
        out = dict(args)
        agent_id = self._config.agent_id if self._config else None
        project_key = self._config.project_key if self._config else None
        if tool_name in ("recall", "remember") and agent_id:
            out.setdefault("agent_id", agent_id)
        if tool_name in ("store_handoff", "list_handoffs") and project_key:
            out.setdefault("project_key", project_key)
        if tool_name == "recall":
            out.setdefault("include_ids", True)
        if tool_name == "store_handoff":
            out.setdefault("harness", _HARNESS)
        if tool_name == "claim_handoff":
            if agent_id:
                out.setdefault("claiming_agent_id", agent_id)
            out.setdefault("claiming_harness", _HARNESS)
        return out

    # ---- helpers ----

    def _resolve_hermes_home(self) -> str | None:
        home = self._env.get("HERMES_HOME")
        if home:
            return home
        user_home = self._env.get("HOME")
        return str(Path(user_home) / ".hermes") if user_home else None
