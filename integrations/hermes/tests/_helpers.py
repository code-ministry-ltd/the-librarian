"""Shared test doubles: a fake Librarian client + transport builders.

Two layers of fakery, mirroring the two seams the code exposes:

- :class:`FakeClient` stands in for ``LibrarianClient`` at the provider
  boundary (records calls, canned per-tool responses, per-tool failures).
- ``transport``-shaped callables stand in for the HTTP layer inside a *real*
  ``LibrarianClient`` (a fake HTTP server in function form), so client tests
  and the provider fail-soft tests exercise the full client code path without
  any network.
"""

from __future__ import annotations

import json

from librarian.client import LibrarianClientError

ENDPOINT = "https://librarian.example.com/mcp"
TOKEN = "secret-token-value"  # noqa: S105 - test fixture, not a real secret
PRIMER = (
    "# The Librarian\n\nCall `recall` before answering questions that may have "
    "prior context; call `remember` when you learn a durable fact.\n"
)


class FakeClient:
    """Provider-boundary fake: canned responses per tool, optional failures."""

    def __init__(
        self,
        responses: dict[str, str] | None = None,
        fail: set[str] | None = None,
        primer: str = PRIMER,
        primer_fail: bool = False,
        journal: str | None = None,
        journal_fail: bool = False,
    ) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []
        self.primer_fetches = 0
        self.primer_fail = primer_fail
        # Spec 078: the journal window (None = the server has none to show).
        self.journal = journal
        self.journal_fail = journal_fail
        self.journal_fetches: list[int] = []
        self._responses = responses or {}
        self._fail = fail or set()
        self._primer = primer

    def call_tool(self, name: str, arguments: dict[str, object]) -> str:
        self.calls.append((name, dict(arguments)))
        if name in self._fail:
            raise LibrarianClientError("network", f"{name} failed")
        return self._responses.get(name, "")

    def fetch_primer(self) -> str:
        self.primer_fetches += 1
        if self.primer_fail:
            raise LibrarianClientError("network", "primer could not reach the Librarian")
        return self._primer

    def fetch_journal(self, max_chars: int) -> str | None:
        self.journal_fetches.append(max_chars)
        if self.journal_fail:
            raise LibrarianClientError("network", "journal could not reach the Librarian")
        return self.journal


def rpc_text_body(text: str) -> bytes:
    """A successful MCP tools/call response body."""
    return json.dumps(
        {"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": text}]}}
    ).encode("utf-8")


def server_down_transport(*_args: object) -> tuple[int, bytes]:
    """Transport that behaves like a dead server (connection refused)."""
    raise OSError("connection refused")
