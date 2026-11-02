"""Spec 078 — the journal in the Hermes provider.

- The recent window rides ``system_prompt_block`` after the primer, fetched once
  per Hermes session id (byte-stable within a session), Claude-sized, and
  skipped by ``LIBRARIAN_JOURNAL=off``. Every failure leaves the primer alone.
- ``project`` goes on /transcript only when the server accepts it AND the agent
  runs inside a git repository; the harness is always recorded.
- The client fetches the window with the token in the Authorization header only.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from librarian import journal as _journal
from librarian.client import LibrarianClient
from librarian.provider import LibrarianConfig, LibrarianProvider
from tests._helpers import ENDPOINT, PRIMER, TOKEN, FakeClient

WINDOW = "# Journal\n\n## 2026-11-02 10:00 · hermes · x\n- did a thing\n"


def _provider(client: object, env: dict[str, str] | None = None) -> LibrarianProvider:
    config = LibrarianConfig(endpoint=ENDPOINT, token=TOKEN)
    return LibrarianProvider(client=client, config=config, env=env or {})  # type: ignore[arg-type]


# ---- the window in the system prompt ----


def test_window_follows_the_primer_in_the_system_prompt_block() -> None:
    client = FakeClient(journal=WINDOW)
    p = _provider(client)
    assert p.system_prompt_block() == f"{PRIMER}\n\n{WINDOW}"
    assert client.journal_fetches == [_journal.JOURNAL_MAX_CHARS]
    assert _journal.JOURNAL_MAX_CHARS == 9_500


def test_window_is_fetched_once_per_session_and_again_for_a_new_one() -> None:
    client = FakeClient(journal=WINDOW)
    p = _provider(client)
    p.initialize("s1", hermes_home="/nonexistent")
    first = p.system_prompt_block()
    client.journal = "# Journal\n\n## changed\n"
    assert p.system_prompt_block() == first  # byte-stable within a session
    assert len(client.journal_fetches) == 1
    p.on_session_switch("s2")
    assert "## changed" in p.system_prompt_block()
    assert len(client.journal_fetches) == 2


def test_switched_off_or_empty_journal_leaves_just_the_primer() -> None:
    off = FakeClient(journal=WINDOW)
    assert _provider(off, {"LIBRARIAN_JOURNAL": "off"}).system_prompt_block() == PRIMER
    assert off.journal_fetches == []
    assert _provider(FakeClient(journal=None)).system_prompt_block() == PRIMER


def test_a_journal_failure_never_costs_the_primer() -> None:
    assert _provider(FakeClient(journal_fail=True)).system_prompt_block() == PRIMER

    class Broken(FakeClient):
        def fetch_journal(self, max_chars: int) -> str | None:
            raise RuntimeError("unexpected")

    assert _provider(Broken()).system_prompt_block() == PRIMER


def test_the_window_is_trimmed_client_side_if_the_server_ignores_max_chars() -> None:
    blocks = [f"## day {i}\n" + "x" * 2_000 for i in range(10)]
    big = "# Journal\n\n" + "\n\n".join(blocks) + "\n"
    out = _provider(FakeClient(journal=big)).system_prompt_block()
    window = out[len(PRIMER) + 2 :]
    assert len(window) <= _journal.JOURNAL_MAX_CHARS
    assert "## day 9" in window and "## day 0" not in window
    assert window.rstrip().endswith(_journal.TRIMMED_NOTE)


# ---- project on /transcript ----


class CaptureClient(FakeClient):
    def __init__(self, supported: bool) -> None:
        super().__init__()
        self.supported = supported
        self.probes = 0
        self.posts: list[dict] = []

    def journal_supported(self) -> bool:
        self.probes += 1
        return self.supported

    def post_transcript(self, payload: dict) -> dict:
        self.posts.append(payload)
        return {"ok": True, "status": 202, "accepted": True}


def _ship(tmp_path: Path, client: CaptureClient, cwd: Path) -> None:
    p = _provider(client)
    p.initialize("s1", hermes_home=str(tmp_path / "home"))
    old = os.getcwd()
    os.chdir(cwd)
    try:
        p.sync_turn("hello there", "hi, what's up?", session_id="s1")
        p.sync_turn("again", "sure", session_id="s1")
    finally:
        os.chdir(old)


def test_project_is_the_git_repo_name_for_a_server_that_accepts_it(tmp_path: Path) -> None:
    repo = tmp_path / "my-repo"
    (repo / ".git").mkdir(parents=True)
    (repo / "src").mkdir()
    client = CaptureClient(supported=True)
    _ship(tmp_path, client, repo / "src")
    assert [post.get("project") for post in client.posts] == ["my-repo", "my-repo"]
    assert all(post["harness"] == "hermes" for post in client.posts)
    assert client.probes == 1


def test_no_project_outside_a_git_repo_but_the_harness_is_still_recorded(tmp_path: Path) -> None:
    loose = tmp_path / "service-dir"
    loose.mkdir()
    client = CaptureClient(supported=True)
    _ship(tmp_path, client, loose)
    assert client.posts and all("project" not in post for post in client.posts)
    assert all(post["harness"] == "hermes" for post in client.posts)


def test_no_project_for_an_older_server(tmp_path: Path) -> None:
    repo = tmp_path / "my-repo"
    (repo / ".git").mkdir(parents=True)
    client = CaptureClient(supported=False)
    _ship(tmp_path, client, repo)
    assert client.posts and all("project" not in post for post in client.posts)


def test_derive_project_is_git_only() -> None:
    assert _journal.derive_project(None) is None
    assert _journal.derive_project("relative/path") is None


# ---- the client ----


def _transport(routes: dict[str, tuple[int, bytes]], seen: list[tuple[str, dict[str, str]]]):
    def transport(method, url, body, headers, timeout_s):  # noqa: ANN001, ANN202
        seen.append((url, dict(headers)))
        for suffix, response in routes.items():
            if url.split("?")[0].endswith(suffix):
                return response
        return 404, b""

    return transport


def test_client_fetches_the_window_with_the_token_in_the_header_only() -> None:
    seen: list[tuple[str, dict[str, str]]] = []
    client = LibrarianClient(
        ENDPOINT, TOKEN, transport=_transport({"/journal.md": (200, WINDOW.encode())}, seen)
    )
    assert client.fetch_journal(9_500) == WINDOW
    url, headers = seen[0]
    assert url == "https://librarian.example.com/journal.md?max_chars=9500"
    assert TOKEN not in url
    assert headers["Authorization"] == f"Bearer {TOKEN}"


def test_client_returns_none_for_a_404_or_an_empty_window() -> None:
    seen: list[tuple[str, dict[str, str]]] = []
    assert LibrarianClient(ENDPOINT, TOKEN, transport=_transport({}, seen)).fetch_journal(1) is None
    empty = _transport({"/journal.md": (200, b"  \n")}, seen)
    assert LibrarianClient(ENDPOINT, TOKEN, transport=empty).fetch_journal(1) is None


@pytest.mark.parametrize(
    ("status", "body", "expected"),
    [
        (200, json.dumps({"ok": True, "journal": "disabled"}).encode(), True),
        (200, json.dumps({"ok": True}).encode(), False),
        (200, b"not json", False),
        (200, json.dumps(["journal"]).encode(), False),
        (503, b"", False),
    ],
)
def test_client_journal_supported_reads_the_healthz_key(
    status: int, body: bytes, expected: bool
) -> None:
    seen: list[tuple[str, dict[str, str]]] = []
    client = LibrarianClient(
        ENDPOINT, TOKEN, transport=_transport({"/healthz": (status, body)}, seen)
    )
    assert client.journal_supported() is expected
    assert "Authorization" not in seen[0][1]


def test_client_journal_supported_is_false_when_the_server_is_down() -> None:
    def down(*_args: object) -> tuple[int, bytes]:
        raise OSError("connection refused")

    assert LibrarianClient(ENDPOINT, TOKEN, transport=down).journal_supported() is False
