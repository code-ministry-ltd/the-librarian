"""HTTP client tests (transport injected; no real network)."""

from __future__ import annotations

import json
import traceback

import pytest
from _helpers import ENDPOINT, TOKEN, rpc_text_body

from librarian import client as client_mod
from librarian.client import (
    LibrarianClient,
    LibrarianClientError,
    _NoRedirect,
    _read_capped,
)


def _client_with(transport):
    calls: list[dict[str, object]] = []

    def wrapped(method: str, url: str, body, headers: dict[str, str], timeout_s: float):
        calls.append(
            {"method": method, "url": url, "body": body, "headers": headers, "timeout_s": timeout_s}
        )
        return transport(method, url, body, headers, timeout_s)

    client = LibrarianClient(ENDPOINT, TOKEN, timeout_ms=15000, transport=wrapped)
    return client, calls


# ---- tools/call ----


def test_builds_tools_call_envelope_and_returns_text() -> None:
    client, calls = _client_with(lambda *_: (200, rpc_text_body("recalled context")))
    out = client.call_tool("recall", {"agent_id": "hermes", "query": "auth"})
    assert out == "recalled context"
    sent = json.loads(calls[0]["body"])  # type: ignore[arg-type]
    assert sent["method"] == "tools/call"
    assert sent["jsonrpc"] == "2.0"
    assert sent["params"]["name"] == "recall"
    assert sent["params"]["arguments"] == {"agent_id": "hermes", "query": "auth"}
    assert calls[0]["url"] == ENDPOINT
    assert calls[0]["method"] == "POST"


def test_sends_bearer_auth_and_json_headers() -> None:
    client, calls = _client_with(lambda *_: (200, rpc_text_body("x")))
    client.call_tool("recall", {})
    headers = calls[0]["headers"]
    assert headers["Authorization"] == f"Bearer {TOKEN}"
    assert headers["Content-Type"] == "application/json"


def test_passes_timeout_seconds() -> None:
    client, calls = _client_with(lambda *_: (200, rpc_text_body("x")))
    client.call_tool("recall", {})
    assert calls[0]["timeout_s"] == 15.0


def test_non_200_maps_to_http_error_with_status() -> None:
    client, _ = _client_with(lambda *_: (401, b"unauthorized"))
    with pytest.raises(LibrarianClientError) as exc:
        client.call_tool("recall", {})
    assert exc.value.kind == "http"
    assert exc.value.status == 401


def test_jsonrpc_error_maps_to_rpc_kind() -> None:
    err = json.dumps({"jsonrpc": "2.0", "id": 1, "error": {"code": -32000, "message": "boom"}})
    client, _ = _client_with(lambda *_: (200, err.encode("utf-8")))
    with pytest.raises(LibrarianClientError) as exc:
        client.call_tool("remember", {})
    assert exc.value.kind == "rpc"


def test_timeout_maps_to_timeout_kind() -> None:
    def boom(*_):
        raise TimeoutError("timed out")

    client, _ = _client_with(boom)
    with pytest.raises(LibrarianClientError) as exc:
        client.call_tool("recall", {})
    assert exc.value.kind == "timeout"


def test_network_error_maps_to_network_kind() -> None:
    def boom(*_):
        raise OSError("connection refused")

    client, _ = _client_with(boom)
    with pytest.raises(LibrarianClientError) as exc:
        client.call_tool("recall", {})
    assert exc.value.kind == "network"


def test_non_json_maps_to_malformed() -> None:
    client, _ = _client_with(lambda *_: (200, b"not json"))
    with pytest.raises(LibrarianClientError) as exc:
        client.call_tool("recall", {})
    assert exc.value.kind == "malformed"


def test_missing_content_maps_to_malformed() -> None:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "result": {}}).encode("utf-8")
    client, _ = _client_with(lambda *_: (200, body))
    with pytest.raises(LibrarianClientError) as exc:
        client.call_tool("recall", {})
    assert exc.value.kind == "malformed"


def test_token_never_appears_in_error_chain_or_traceback() -> None:
    # The token is supplied only via the Authorization header; urllib never echoes
    # request headers into its exceptions, and our messages never reference the
    # token. So across realistic failure modes it must never surface — in the
    # top-level error, the cause chain, or the rendered traceback.
    scenarios = [
        lambda *_: (401, b"unauthorized"),
        lambda *_: (200, b"not json"),
        lambda *_: (_ for _ in ()).throw(TimeoutError("timed out")),
        lambda *_: (_ for _ in ()).throw(OSError("connection refused")),
    ]
    for transport in scenarios:
        client, _ = _client_with(transport)
        try:
            client.call_tool("recall", {})
        except LibrarianClientError as err:
            rendered = []
            cur: BaseException | None = err
            while cur is not None:
                rendered += [str(cur), repr(cur)]
                cur = cur.__cause__ or cur.__context__
            rendered.append("".join(traceback.format_exception(err)))
            assert all(TOKEN not in s for s in rendered)


# ---- transcript intake (POST /transcript) ----


def _transcript_body(accepted: bool = True, buffered: int = 2, **extra: object) -> bytes:
    payload: dict[str, object] = {"accepted": accepted, "buffered": buffered, **extra}
    return json.dumps(payload).encode("utf-8")


def test_transcript_url_is_server_root_not_mcp_path() -> None:
    client = LibrarianClient("https://librarian.example.com/mcp", TOKEN)
    assert client.transcript_url() == "https://librarian.example.com/transcript"
    nested = LibrarianClient("http://127.0.0.1:3838/some/nested/mcp", TOKEN)
    assert nested.transcript_url() == "http://127.0.0.1:3838/transcript"


def test_post_transcript_sends_payload_with_bearer_to_transcript_url() -> None:
    client, calls = _client_with(lambda *_: (200, _transcript_body(buffered=2)))
    payload = {"conv_id": "sess-1", "harness": "hermes", "seq": 1, "turns": []}
    ack = client.post_transcript(payload)
    assert ack["ok"] is True
    assert ack["status"] == 200
    assert ack["accepted"] is True
    assert ack["buffered"] == 2
    assert calls[0]["method"] == "POST"
    assert calls[0]["url"] == "https://librarian.example.com/transcript"
    headers = calls[0]["headers"]
    assert headers["Authorization"] == f"Bearer {TOKEN}"
    assert headers["Content-Type"] == "application/json"
    sent = json.loads(calls[0]["body"])  # type: ignore[arg-type]
    assert sent == payload


def test_post_transcript_non_2xx_is_not_ok_but_never_raises() -> None:
    client, _ = _client_with(lambda *_: (413, b"too big"))
    ack = client.post_transcript({"conv_id": "c", "harness": "hermes", "seq": 1, "turns": []})
    assert ack["ok"] is False
    assert ack["status"] == 413


def test_post_transcript_gate_off_is_ok_but_not_accepted() -> None:
    # The server returns 200 + {accepted:false, disabled:true} when the intake
    # gate is off. That is a clean 2xx (ok) but the delta was NOT buffered.
    client, _ = _client_with(lambda *_: (200, _transcript_body(accepted=False, disabled=True)))
    ack = client.post_transcript({"conv_id": "c", "harness": "hermes", "seq": 1, "turns": []})
    assert ack["ok"] is True
    assert ack["accepted"] is False


def test_post_transcript_network_failure_raises_typed_error() -> None:
    def boom(*_):
        raise OSError("connection refused")

    client, _ = _client_with(boom)
    with pytest.raises(LibrarianClientError) as exc:
        client.post_transcript({"conv_id": "c", "harness": "hermes", "seq": 1, "turns": []})
    assert exc.value.kind == "network"


def test_post_transcript_timeout_raises_typed_error() -> None:
    def boom(*_):
        raise TimeoutError("timed out")

    client, _ = _client_with(boom)
    with pytest.raises(LibrarianClientError) as exc:
        client.post_transcript({"conv_id": "c", "harness": "hermes", "seq": 1, "turns": []})
    assert exc.value.kind == "timeout"


def test_post_transcript_non_json_body_is_ok_on_2xx_without_buffered() -> None:
    # A 2xx with a non-JSON / empty body still acks ok; buffered is just absent.
    client, _ = _client_with(lambda *_: (200, b""))
    ack = client.post_transcript({"conv_id": "c", "harness": "hermes", "seq": 1, "turns": []})
    assert ack["ok"] is True
    assert ack["accepted"] is True  # absent accepted defaults to accepted-on-2xx
    assert "buffered" not in ack


def test_post_transcript_token_never_appears_in_network_error() -> None:
    def boom(*_):
        raise OSError("connection refused")

    client, _ = _client_with(boom)
    with pytest.raises(LibrarianClientError) as exc:
        client.post_transcript({"conv_id": "c", "harness": "hermes", "seq": 1, "turns": []})
    assert TOKEN not in str(exc.value)


# ---- security posture ----


def test_rejects_non_http_scheme() -> None:
    with pytest.raises(ValueError, match="http"):
        LibrarianClient("file:///etc/passwd", TOKEN)
    with pytest.raises(ValueError, match="http"):
        LibrarianClient("ftp://host/x", TOKEN)


def test_http_and_https_schemes_accepted() -> None:
    LibrarianClient("http://127.0.0.1:3838/mcp", TOKEN)
    LibrarianClient("https://librarian.example.com/mcp", TOKEN)


def test_rejects_endpoint_with_embedded_credentials() -> None:
    # Basic-auth userinfo in the URL is a second secret that would otherwise
    # ride into the network error message below — refuse it up front (the
    # bearer token is the auth mechanism). Mirrors the Pi client's check.
    with pytest.raises(ValueError, match="credentials"):
        LibrarianClient("https://user:hunter2@librarian.example.com/mcp", TOKEN)


def test_network_error_message_excludes_endpoint_query_string() -> None:
    # A mis-pasted endpoint may carry a secret in its query (?token=…). The
    # network error renders only scheme://host/path, never the query.
    def boom(*_):
        raise OSError("connection refused")

    client = LibrarianClient(
        f"{ENDPOINT}?token=super-secret-query", TOKEN, timeout_ms=15000, transport=boom
    )
    with pytest.raises(LibrarianClientError) as exc:
        client.call_tool("recall", {})
    assert "super-secret-query" not in str(exc.value)
    assert ENDPOINT in str(exc.value)


def test_no_redirect_handler_refuses_to_follow() -> None:
    # Redirects are never followed (they would carry the Authorization header
    # to the redirect target).
    handler = _NoRedirect()
    assert handler.redirect_request(None, None, 302, "Found", {}, "https://evil/") is None


def test_redirect_status_maps_to_http_error() -> None:
    client, _ = _client_with(lambda *_: (302, b""))
    with pytest.raises(LibrarianClientError) as exc:
        client.call_tool("recall", {})
    assert exc.value.kind == "http"
    assert exc.value.status == 302


def test_read_capped_rejects_oversize_body(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(client_mod, "_MAX_RESPONSE_BYTES", 8)

    class _FP:
        def read(self, n: int = -1) -> bytes:
            return b"x" * (n if n >= 0 else 32)

    with pytest.raises(OSError, match="size cap"):
        _read_capped(_FP())


# ---- primer fetch (GET /primer.md) ----


def test_primer_url_is_server_root_not_mcp_path() -> None:
    client = LibrarianClient("https://librarian.example.com/mcp", TOKEN)
    assert client.primer_url() == "https://librarian.example.com/primer.md"
    nested = LibrarianClient("http://127.0.0.1:3838/some/nested/mcp", TOKEN)
    assert nested.primer_url() == "http://127.0.0.1:3838/primer.md"


def test_fetch_primer_is_an_unauthenticated_get() -> None:
    client, calls = _client_with(lambda *_: (200, b"# Primer\n"))
    out = client.fetch_primer()
    assert out == "# Primer\n"
    assert calls[0]["method"] == "GET"
    assert calls[0]["url"] == "https://librarian.example.com/primer.md"
    assert calls[0]["body"] is None
    # The endpoint is unauthenticated by design — the token never travels here.
    assert "Authorization" not in calls[0]["headers"]


def test_fetch_primer_non_200_raises_http_error() -> None:
    client, _ = _client_with(lambda *_: (404, b"not found"))
    with pytest.raises(LibrarianClientError) as exc:
        client.fetch_primer()
    assert exc.value.kind == "http"
    assert exc.value.status == 404


def test_fetch_primer_network_failure_raises_typed_error() -> None:
    def boom(*_):
        raise OSError("connection refused")

    client, _ = _client_with(boom)
    with pytest.raises(LibrarianClientError) as exc:
        client.fetch_primer()
    assert exc.value.kind == "network"


def test_fetch_primer_invalid_utf8_maps_to_malformed() -> None:
    client, _ = _client_with(lambda *_: (200, b"\xff\xfe\xfa"))
    with pytest.raises(LibrarianClientError) as exc:
        client.fetch_primer()
    assert exc.value.kind == "malformed"
