"""Minimal HTTP client for The Librarian server (MCP tools + primer).

The Librarian's ``/mcp`` is **stateless** JSON-RPC 2.0: no ``initialize``
handshake and no session id are required — a ``tools/call`` can be POSTed
directly with a Bearer token. So tool calls are single-request: build the
envelope, POST it, map every failure mode onto a typed
:class:`LibrarianClientError`, and return the tool's text content.

The primer rides the same host at ``GET /primer.md`` — an endpoint the server
deliberately serves **unauthenticated** (it must never carry operator-specific
or secret content), so :meth:`LibrarianClient.fetch_primer` sends no
credentials at all.

Dependency-light: stdlib ``urllib`` only. The bearer token is sent in the
``Authorization`` header of tool calls and is NEVER included in any error
message or repr. Redirects are never followed. Response bodies are size-capped.
The transport is injectable so tests never touch the network.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Literal, Protocol

# Cap the body we buffer + parse so a hostile/runaway endpoint can't OOM the host.
_MAX_RESPONSE_BYTES = 8 * 1024 * 1024

ClientErrorKind = Literal["network", "timeout", "http", "rpc", "malformed"]


class LibrarianClientError(Exception):
    """A Librarian call failed. Carries a typed ``kind`` so callers can
    fail-soft (log + degrade) without leaking the token."""

    def __init__(self, kind: ClientErrorKind, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.kind: ClientErrorKind = kind
        self.status: int | None = status


class Transport(Protocol):
    def __call__(
        self, method: str, url: str, body: bytes | None, headers: dict[str, str], timeout_s: float
    ) -> tuple[int, bytes]:
        """Send the request and return ``(status, body)``. Raise ``TimeoutError``
        on timeout and ``OSError`` on a network failure."""
        ...


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse to follow 3xx. urllib's redirect handler carries the Authorization
    header across hosts, which would leak the bearer token to a redirect target.
    The Librarian /mcp is a single stateless POST and /primer.md a single GET —
    neither has a legitimate 3xx — so a redirect surfaces as an HTTPError
    (→ a typed `http` error) instead."""

    def redirect_request(self, *args: object, **kwargs: object) -> None:
        return None


# Opener with redirects disabled. The endpoint scheme is allowlisted in
# LibrarianClient.__init__, so File/Data/FTP handlers can never be reached.
_OPENER = urllib.request.build_opener(_NoRedirect)


def _read_capped(fp: object) -> bytes:
    raw: bytes = fp.read(_MAX_RESPONSE_BYTES + 1)  # type: ignore[attr-defined]
    if len(raw) > _MAX_RESPONSE_BYTES:
        raise OSError("Librarian response exceeded the size cap")
    return raw


def _urllib_transport(
    method: str, url: str, body: bytes | None, headers: dict[str, str], timeout_s: float
) -> tuple[int, bytes]:
    # noqa: S310 — scheme is allowlisted in LibrarianClient.__init__ (http/https
    # only) and redirects are disabled, so file:/custom schemes can't be reached.
    request = urllib.request.Request(url, data=body, headers=headers, method=method)  # noqa: S310
    try:
        with _OPENER.open(request, timeout=timeout_s) as response:
            return response.status, _read_capped(response)
    except urllib.error.HTTPError as err:
        # A 4xx/5xx (or a refused 3xx) is a real response — surface its status.
        return err.code, _read_capped(err)
    except TimeoutError:
        raise
    except urllib.error.URLError as err:
        if isinstance(err.reason, TimeoutError):
            raise TimeoutError(str(err.reason)) from err
        raise OSError(str(err.reason)) from err


class LibrarianClient:
    def __init__(
        self,
        endpoint: str,
        token: str,
        *,
        timeout_ms: int = 15000,
        transport: Transport | None = None,
    ) -> None:
        # Allowlist the scheme so a mistemplated endpoint can't reach urllib's
        # file://, data://, or ftp:// handlers (config-driven SSRF / file read).
        split = urllib.parse.urlsplit(endpoint)
        if split.scheme not in ("https", "http"):
            raise ValueError(f"Librarian endpoint must be http(s), got {split.scheme!r}")
        # Reject basic-auth userinfo in the URL: the token is the auth
        # mechanism, and an embedded password is a second secret that would
        # otherwise leak into the network error message below.
        if split.username or split.password:
            raise ValueError(
                "Librarian endpoint must not embed credentials; authenticate with the token instead"
            )
        self._endpoint = endpoint
        # A credential-free, query-free rendering used in error messages so
        # nothing secret-bearing in the endpoint can leak into logs.
        self._safe_endpoint = f"{split.scheme}://{split.netloc}{split.path}"
        self._token = token
        self._timeout_s = timeout_ms / 1000
        self._transport: Transport = transport or _urllib_transport

    def call_tool(self, name: str, arguments: dict[str, object]) -> str:
        """Call a Librarian MCP tool and return its text content. Raises
        :class:`LibrarianClientError` (typed) on any failure."""
        body = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            }
        ).encode("utf-8")
        # Token only ever lives in this header — never in args, URL, or errors.
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {self._token}",
        }

        status, raw = self._send(name, "POST", self._endpoint, body, headers)

        if status != 200:
            raise LibrarianClientError("http", f"{name} returned HTTP {status}", status=status)

        try:
            payload = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError) as err:
            raise LibrarianClientError("malformed", f"{name} returned non-JSON") from err

        if isinstance(payload, dict) and "error" in payload:
            rpc = payload["error"]
            code = rpc.get("code") if isinstance(rpc, dict) else None
            raw_msg = rpc.get("message", "") if isinstance(rpc, dict) else ""
            # Truncate the server-controlled message so it can't bloat logs.
            msg = str(raw_msg)[:200]
            raise LibrarianClientError("rpc", f"{name} failed: {msg} (code {code})")

        text = _extract_text(payload)
        if text is None:
            raise LibrarianClientError("malformed", f"{name} response had no text content")
        return text

    def transcript_url(self) -> str:
        """The transcript-intake door lives at the server root
        (``POST /transcript``), on the SAME origin as ``/mcp`` — e.g.
        ``https://host/mcp`` → ``https://host/transcript``. One configured URL
        drives both, and ``redirect: error`` (via ``_NoRedirect``) keeps a
        hostile 3xx from bouncing the bearer cross-origin."""
        return urllib.parse.urljoin(self._endpoint, "/transcript")

    def post_transcript(self, payload: dict[str, object]) -> dict[str, object]:
        """POST a per-turn conversation delta to ``/transcript`` and return a
        small ack the caller folds into its advance decision:
        ``{"ok": <2xx?>, "status": <int>, "accepted": <bool>, "buffered"?: <int>}``.

        - ``ok`` is True only for a 2xx (a non-2xx is a clean ``ok:false`` — the
          caller holds its seq and re-ships next turn; never raises).
        - ``accepted`` reflects the server's body: a 2xx with ``accepted:false``
          (the intake gate is off, or a hard-cap refusal) is OK-but-not-buffered,
          so the caller knows nothing landed. Absent ``accepted`` on a 2xx
          defaults to True (an empty/non-JSON 2xx body still acked).

        The bearer token rides the Authorization HEADER only (never the URL or an
        error). A network/timeout failure raises a typed
        :class:`LibrarianClientError` so the caller's fail-soft try/except logs +
        holds — both a non-2xx and a raise mean "do not advance"."""
        body = json.dumps(payload).encode("utf-8")
        # Token only ever lives in this header — never in args, URL, or errors.
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {self._token}",
        }
        status, raw = self._send("transcript", "POST", self.transcript_url(), body, headers)
        ok = 200 <= status < 300
        ack: dict[str, object] = {"ok": ok, "status": status, "accepted": ok}
        if not ok:
            return ack
        # A 2xx body MAY carry {accepted, buffered}. A non-JSON / empty body is a
        # valid 2xx ack (status alone decides ok); only refine from a dict body.
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return ack
        if isinstance(parsed, dict):
            if isinstance(parsed.get("accepted"), bool):
                ack["accepted"] = parsed["accepted"]
            if isinstance(parsed.get("buffered"), int):
                ack["buffered"] = parsed["buffered"]
        return ack

    def primer_url(self) -> str:
        """The primer lives at the server root (``GET /primer.md``), not under
        the MCP path — e.g. ``https://host/mcp`` → ``https://host/primer.md``."""
        return urllib.parse.urljoin(self._endpoint, "/primer.md")

    def fetch_primer(self) -> str:
        """Fetch the operator-editable primer (``GET /primer.md``). The endpoint
        is unauthenticated by design, so NO Authorization header is sent — the
        token never travels on this request. Raises :class:`LibrarianClientError`
        on any failure (callers fail-soft to an empty primer)."""
        headers = {"Accept": "text/markdown, text/plain"}
        status, raw = self._send("primer", "GET", self.primer_url(), None, headers)
        if status != 200:
            raise LibrarianClientError("http", f"primer returned HTTP {status}", status=status)
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError as err:
            raise LibrarianClientError("malformed", "primer was not valid UTF-8") from err

    def journal_url(self, max_chars: int) -> str:
        """The recent window of the conversation journal, at the server root
        (``GET /journal.md?max_chars=N``) — spec 077 §4.9, spec 078."""
        return urllib.parse.urljoin(self._endpoint, f"/journal.md?max_chars={int(max_chars)}")

    def fetch_journal(self, max_chars: int) -> str | None:
        """Fetch the recent journal window. ``None`` when there is nothing to show:
        a 404 (journal switched off or still empty — and what an older server
        answers), any other non-200, a non-markdown body, or an empty one. The
        bearer token rides the Authorization HEADER only. Raises
        :class:`LibrarianClientError` on a network failure or timeout (callers
        fail-soft)."""
        headers = {"Accept": "text/markdown", "Authorization": f"Bearer {self._token}"}
        status, raw = self._send("journal", "GET", self.journal_url(max_chars), None, headers)
        if status != 200:
            return None
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            return None
        return text if text.strip() else None

    def journal_supported(self) -> bool:
        """Does the server accept ``project`` on /transcript? True only when
        ``GET /healthz`` returns a JSON object carrying a ``journal`` key (its
        presence, enabled or not, is the signal — spec 077 §4.7). /healthz is
        unauthenticated, so no token is sent. Never raises: any failure is False,
        the safe default (an older server rejects the unknown key)."""
        try:
            url = urllib.parse.urljoin(self._endpoint, "/healthz")
            status, raw = self._send("healthz", "GET", url, None, {"Accept": "application/json"})
            if status != 200:
                return False
            parsed = json.loads(raw)
        except (LibrarianClientError, ValueError):
            return False
        return isinstance(parsed, dict) and "journal" in parsed

    def _send(
        self, what: str, method: str, url: str, body: bytes | None, headers: dict[str, str]
    ) -> tuple[int, bytes]:
        """Run the transport, mapping transport failures onto typed errors."""
        try:
            return self._transport(method, url, body, headers, self._timeout_s)
        except TimeoutError as err:
            raise LibrarianClientError(
                "timeout", f"{what} timed out after {self._timeout_s}s"
            ) from err
        except OSError as err:
            # Don't interpolate the wrapped error text into our message — keep the
            # token-bearing request strictly out of anything we render. The cause
            # chain still carries the original for debugging.
            raise LibrarianClientError(
                "network", f"{what} could not reach the Librarian at {self._safe_endpoint}"
            ) from err


def _extract_text(payload: object) -> str | None:
    """Pull ``result.content[0].text`` from an MCP tool response, or None."""
    if not isinstance(payload, dict):
        return None
    result = payload.get("result")
    if not isinstance(result, dict):
        return None
    content = result.get("content")
    if not isinstance(content, list) or not content:
        return None
    first = content[0]
    if not isinstance(first, dict):
        return None
    text = first.get("text")
    return text if isinstance(text, str) else None
