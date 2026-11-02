"""Provider behavior — tool-call proxying, primer block, fail-soft everywhere.

Covers:
- handle_tool_call proxies each of the 8 verbs over tools/call and returns a
  JSON string ({"ok": true, "result": …} / {"ok": false, "error": …});
- config-resolved arg scoping (agent_id / project_key / include_ids /
  harness provenance) with caller-supplied values winning;
- system_prompt_block returns the fetched primer verbatim, caches it for the
  session, and fails soft to "" (without negative-caching a transient outage);
- every public method is fail-soft against a dead server — exercised through
  a REAL LibrarianClient over a connection-refused transport, never a raise.
"""

from __future__ import annotations

import json

from _helpers import ENDPOINT, PRIMER, TOKEN, FakeClient, server_down_transport

from librarian.client import LibrarianClient
from librarian.provider import LibrarianConfig, LibrarianProvider

ALL_TOOLS = [
    "recall",
    "remember",
    "flag_memory",
    "store_handoff",
    "list_handoffs",
    "claim_handoff",
    "search_references",
]


def _provider(client=None, *, agent_id: str | None = "agent-a", project_key: str | None = None):
    config = LibrarianConfig(
        endpoint=ENDPOINT, token=TOKEN, agent_id=agent_id, project_key=project_key
    )
    return LibrarianProvider(client=client if client is not None else FakeClient(), config=config)


def _result(raw: str) -> dict:
    parsed = json.loads(raw)
    assert isinstance(parsed, dict)
    return parsed


# ---- tool-call proxy round-trip ----


def test_handle_tool_call_round_trips_every_verb() -> None:
    client = FakeClient({name: f"{name} response" for name in ALL_TOOLS})
    p = _provider(client)
    for name in ALL_TOOLS:
        out = _result(p.handle_tool_call(name, {}))
        assert out == {"ok": True, "result": f"{name} response"}
    assert [name for name, _ in client.calls] == ALL_TOOLS


def test_result_is_always_a_json_string() -> None:
    # The ABC contract: handle_tool_call must return a JSON string.
    client = FakeClient({"recall": "free text\nwith newlines"})
    p = _provider(client)
    raw = p.handle_tool_call("recall", {"query": "x"})
    assert isinstance(raw, str)
    assert json.loads(raw)["result"] == "free text\nwith newlines"


def test_recall_injects_scope_and_include_ids() -> None:
    client = FakeClient()
    p = _provider(client, agent_id="agent-a", project_key="proj-1")
    p.handle_tool_call("recall", {"query": "auth"})
    _, args = client.calls[0]
    # Memories are project-less now, so recall scopes by agent_id only — the
    # config project_key is NOT injected (the exact-dict match pins its absence).
    assert args == {
        "query": "auth",
        "agent_id": "agent-a",
        "include_ids": True,
    }


def test_remember_injects_agent_scope_but_not_project() -> None:
    client = FakeClient()
    p = _provider(client, agent_id="agent-a", project_key="proj-1")
    p.handle_tool_call("remember", {"title": "t", "body": "b", "tags": ["lessons"]})
    _, args = client.calls[0]
    assert args["agent_id"] == "agent-a"
    # memories are project-less now — the config project_key is NOT injected
    assert "project_key" not in args
    assert "include_ids" not in args


def test_caller_supplied_scope_wins_over_config() -> None:
    client = FakeClient()
    p = _provider(client, agent_id="agent-a", project_key="proj-1")
    p.handle_tool_call("recall", {"query": "q", "agent_id": "other-agent", "include_ids": False})
    _, args = client.calls[0]
    assert args["agent_id"] == "other-agent"
    assert args["include_ids"] is False


def test_flag_memory_passes_args_through_verbatim() -> None:
    # flag_memory is keyed by memory_id (a global primary key); no scoping.
    client = FakeClient()
    p = _provider(client, agent_id="agent-a", project_key="proj-1")
    p.handle_tool_call("flag_memory", {"memory_id": "mem_1", "reason": "outdated"})
    _, args = client.calls[0]
    assert args == {"memory_id": "mem_1", "reason": "outdated"}


def test_search_references_passes_args_through_verbatim() -> None:
    client = FakeClient()
    p = _provider(client, agent_id="agent-a", project_key="proj-1")
    p.handle_tool_call("search_references", {"query": "deploy runbook", "limit": 3})
    _, args = client.calls[0]
    assert args == {"query": "deploy runbook", "limit": 3}


def test_store_handoff_stamps_project_and_harness_provenance() -> None:
    client = FakeClient()
    p = _provider(client, project_key="proj-1")
    p.handle_tool_call("store_handoff", {"title": "Mid-task pause", "document_md": "x" * 120})
    _, args = client.calls[0]
    assert args["project_key"] == "proj-1"
    assert args["harness"] == "hermes"


def test_claim_handoff_stamps_claiming_provenance() -> None:
    client = FakeClient()
    p = _provider(client, agent_id="agent-a")
    p.handle_tool_call("claim_handoff", {"handoff_id": "hof_1"})
    _, args = client.calls[0]
    assert args == {
        "handoff_id": "hof_1",
        "claiming_agent_id": "agent-a",
        "claiming_harness": "hermes",
    }


def test_no_scope_injected_when_config_has_none() -> None:
    client = FakeClient()
    p = _provider(client, agent_id=None, project_key=None)
    p.handle_tool_call("recall", {"query": "q"})
    _, args = client.calls[0]
    assert args == {"query": "q", "include_ids": True}


# ---- fail-soft error shapes (never raise) ----


def test_unknown_tool_returns_error_envelope_without_a_call() -> None:
    client = FakeClient()
    p = _provider(client)
    out = _result(p.handle_tool_call("delete_everything", {}))
    assert out["ok"] is False
    assert out["error"]["kind"] == "unknown_tool"
    assert client.calls == []


def test_non_dict_args_return_error_envelope() -> None:
    p = _provider()
    out = _result(p.handle_tool_call("recall", "not a dict"))  # type: ignore[arg-type]
    assert out["ok"] is False
    assert out["error"]["kind"] == "bad_args"


def test_unconfigured_provider_returns_error_envelope() -> None:
    p = LibrarianProvider(env={})
    out = _result(p.handle_tool_call("recall", {"query": "q"}))
    assert out["ok"] is False
    assert out["error"]["kind"] == "unconfigured"


def test_client_failure_maps_to_error_envelope_per_verb() -> None:
    client = FakeClient(fail=set(ALL_TOOLS))
    p = _provider(client)
    for name in ALL_TOOLS:
        out = _result(p.handle_tool_call(name, {}))
        assert out["ok"] is False
        assert out["error"]["kind"] == "network"


def test_every_public_method_is_fail_soft_when_the_server_is_down() -> None:
    # A REAL client over a connection-refused transport: nothing may raise.
    client = LibrarianClient(ENDPOINT, TOKEN, transport=server_down_transport)
    p = LibrarianProvider(
        client=client, config=LibrarianConfig(endpoint=ENDPOINT, token=TOKEN), env={}
    )
    assert p.name == "librarian"
    assert p.is_available() is True  # config-only; no network involved
    p.initialize("sess-1", hermes_home="/nonexistent")
    assert p.system_prompt_block() == ""
    for name in ALL_TOOLS:
        out = _result(p.handle_tool_call(name, {"query": "q"}))
        assert out["ok"] is False
        assert out["error"]["kind"] == "network"
        assert TOKEN not in out["error"]["message"]
    assert isinstance(p.get_tool_schemas(), list)
    p.shutdown()


# ---- primer (system_prompt_block) ----


def test_system_prompt_block_returns_primer_verbatim() -> None:
    client = FakeClient(primer=PRIMER)
    p = _provider(client)
    # Verbatim: no wording of our own is added around the screened primer.
    assert p.system_prompt_block() == PRIMER


def test_system_prompt_block_caches_for_the_session() -> None:
    client = FakeClient(primer=PRIMER)
    p = _provider(client)
    assert p.system_prompt_block() == PRIMER
    assert p.system_prompt_block() == PRIMER
    assert client.primer_fetches == 1


def test_system_prompt_block_fails_soft_to_empty_string() -> None:
    client = FakeClient(primer_fail=True)
    p = _provider(client)
    assert p.system_prompt_block() == ""


def test_primer_failure_is_not_negative_cached() -> None:
    client = FakeClient(primer=PRIMER, primer_fail=True)
    p = _provider(client)
    assert p.system_prompt_block() == ""
    client.primer_fail = False  # the server comes back
    assert p.system_prompt_block() == PRIMER
    assert client.primer_fetches == 2


def test_system_prompt_block_empty_when_unconfigured() -> None:
    assert LibrarianProvider(env={}).system_prompt_block() == ""


def test_shutdown_drops_client_and_primer_cache() -> None:
    client = FakeClient(primer=PRIMER)
    p = _provider(client)
    assert p.system_prompt_block() == PRIMER
    p.shutdown()
    assert p.system_prompt_block() == ""


# ---- lifecycle wiring ----


def test_initialize_without_hermes_home_leaves_provider_inert_without_raising() -> None:
    logs: list[tuple[str, str]] = []
    p = LibrarianProvider(logger=lambda lvl, msg: logs.append((lvl, msg)), env={})
    p.initialize("sess-1")  # no hermes_home kwarg
    out = _result(p.handle_tool_call("recall", {"query": "q"}))
    assert out["error"]["kind"] == "unconfigured"
    assert any(lvl == "error" for lvl, _ in logs)


def test_initialize_with_bad_endpoint_scheme_is_fail_soft() -> None:
    config = LibrarianConfig(endpoint="ftp://host/mcp", token=TOKEN)
    p = LibrarianProvider(config=config, env={})
    p.initialize("sess-1", hermes_home="/nonexistent")  # must not raise
    out = _result(p.handle_tool_call("recall", {"query": "q"}))
    assert out["error"]["kind"] == "unconfigured"


def test_retired_hooks_are_gone_not_stubbed() -> None:
    # Rethink D10: the per-turn RECALL machinery (prefetch / pre-compress /
    # memory-write mirroring) is deleted, not hidden — the ABC marks these
    # non-abstract, so the class must not define them at all.
    #
    # Phase 2B un-retired sync_turn + on_session_end: they ARE the auto-capture
    # hooks now (ship per-turn deltas to /transcript), so they are intentionally
    # implemented and must NOT appear in this retired list.
    for retired in ("prefetch", "on_pre_compress", "on_memory_write"):
        assert retired not in LibrarianProvider.__dict__, retired


def test_auto_capture_hooks_are_implemented() -> None:
    # Phase 2B: sync_turn + on_session_end are the auto-capture hooks; the class
    # must define them (overriding the ABC no-ops) so Hermes' per-turn dispatch
    # reaches the /transcript ship.
    for wired in ("sync_turn", "on_session_end"):
        assert wired in LibrarianProvider.__dict__, wired
