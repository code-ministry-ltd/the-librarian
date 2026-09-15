"""The 7 tool schemas — shape, required params, and parity with the server.

Source of truth for the parameter shapes is the server's advertised
``inputSchema`` per tool in ``packages/mcp-server/src/mcp/tools/*.ts`` (plus
``schemas.ts`` for `remember`). The pinned expectations below were derived from
those files; ``test_parity_with_server_ts_sources`` re-derives the load-bearing
parts (tool names + required lists + property names) from the TS sources at
test time, so drift fails loudly when the suite runs inside the monorepo.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from librarian.provider import TOOL_NAMES, tool_schemas

EXPECTED_NAMES = [
    "recall",
    "remember",
    "flag_memory",
    "store_handoff",
    "list_handoffs",
    "claim_handoff",
    "search_references",
]

# Adapter-advertised required params. These mirror the server's `required`
# lists minus `agent_id` (provider-injected from config); `recall` additionally
# tightens `query` to required (the server leaves it optional, but an
# unqueried recall is never what the model wants).
EXPECTED_REQUIRED: dict[str, list[str]] = {
    "recall": ["query"],
    "remember": ["title", "body"],
    "flag_memory": ["memory_id", "reason"],
    "store_handoff": ["title", "document_md"],
    "list_handoffs": [],
    "claim_handoff": ["handoff_id"],
    "search_references": ["query"],
}

# Fields the provider resolves itself (config scoping / provenance) or that
# are retired server-side — they must never be asked of the model.
NEVER_ADVERTISED = {
    "agent_id",
    "conv_id",
    "include_ids",
    "harness_id",
    "claiming_agent_id",
    "claiming_harness",
    "claiming_cwd",
    "claiming_source_ref",
}


def _by_name() -> dict[str, dict]:
    return {schema["name"]: schema for schema in tool_schemas()}


def test_exactly_seven_tools_with_the_canonical_names() -> None:
    schemas = tool_schemas()
    assert [s["name"] for s in schemas] == EXPECTED_NAMES
    assert TOOL_NAMES == frozenset(EXPECTED_NAMES)


def test_every_schema_is_openai_function_format() -> None:
    for schema in tool_schemas():
        assert set(schema.keys()) == {"name", "description", "parameters"}
        assert isinstance(schema["description"], str) and schema["description"]
        params = schema["parameters"]
        assert params["type"] == "object"
        assert isinstance(params["properties"], dict) and params["properties"]
        # Required, when present, must reference advertised properties only.
        for required in params.get("required", []):
            assert required in params["properties"]
        # The whole schema must be JSON-serialisable (it goes on the wire).
        json.dumps(schema)


def test_required_params_match_the_server_contract() -> None:
    by_name = _by_name()
    for name, expected in EXPECTED_REQUIRED.items():
        assert by_name[name]["parameters"].get("required", []) == expected, name


def test_provider_resolved_fields_are_never_advertised() -> None:
    for schema in tool_schemas():
        advertised = set(schema["parameters"]["properties"])
        assert not advertised & NEVER_ADVERTISED, schema["name"]


def test_descriptions_carry_their_protocols_within_budget() -> None:
    by_name = _by_name()
    for schema in tool_schemas():
        assert len(schema["description"].encode("utf-8")) <= 1024  # ≤1KB each (spec §5.1)
    # The descriptions are a teaching surface: pin the protocol markers.
    assert "flag_memory" in by_name["recall"]["description"]
    for heading in ("Start & intent", "Journey", "Current state", "What's left", "Open questions"):
        assert heading in by_name["store_handoff"]["description"]
    # Creation is explicit-request-only (mirrors the server teaching surface).
    assert "explicitly asked" in by_name["store_handoff"]["description"]
    assert "spontaneously" in by_name["store_handoff"]["description"]
    assert "claim_handoff" in by_name["list_handoffs"]["description"]


def test_schemas_are_fresh_copies_per_call() -> None:
    # A harness mutating one call's schemas must not poison the next.
    first = tool_schemas()
    first[0]["parameters"]["properties"]["query"]["type"] = "mutated"
    assert tool_schemas()[0]["parameters"]["properties"]["query"]["type"] == "string"


# ---- parity against the server's TS sources (monorepo-only) ----

_TOOLS_DIR = Path(__file__).resolve().parents[3] / "packages" / "mcp-server" / "src" / "mcp" / "tools"

# tool name → (definition file, file holding its properties block)
_TS_SOURCES = {
    "recall": ("recall.ts", "recall.ts"),
    "remember": ("remember.ts", "schemas.ts"),  # remember uses memoryInputSchema()
    "flag_memory": ("flag-memory.ts", "flag-memory.ts"),
    "store_handoff": ("store-handoff.ts", "store-handoff.ts"),
    "list_handoffs": ("list-handoffs.ts", "list-handoffs.ts"),
    "claim_handoff": ("claim-handoff.ts", "claim-handoff.ts"),
    "search_references": ("search-references.ts", "search-references.ts"),
}


def _server_required(ts_text: str) -> set[str]:
    match = re.search(r"required:\s*\[([^\]]*)\]", ts_text)
    if not match:
        return set()
    return {item.strip().strip('"') for item in match.group(1).split(",") if item.strip()}


@pytest.mark.skipif(
    not _TOOLS_DIR.is_dir(), reason="server TS sources not present (standalone checkout)"
)
def test_parity_with_server_ts_sources() -> None:
    by_name = _by_name()
    for name, (def_file, props_file) in _TS_SOURCES.items():
        def_text = (_TOOLS_DIR / def_file).read_text(encoding="utf-8")
        props_text = (_TOOLS_DIR / props_file).read_text(encoding="utf-8")
        # The tool exists server-side under exactly this name.
        assert f'name: "{name}"' in def_text, name
        # Every advertised property exists in the server's schema source.
        params = by_name[name]["parameters"]
        for prop in params["properties"]:
            assert re.search(rf"\b{prop}:\s*{{", props_text), f"{name}.{prop} not in {props_file}"
        # Adapter required ⊇ server required minus the provider-injected
        # agent_id, and never names anything the adapter doesn't advertise.
        adapter_required = set(params.get("required", []))
        assert adapter_required >= _server_required(props_text) - {"agent_id"}, name
