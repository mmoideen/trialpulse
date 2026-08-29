"""`GraphSharePointClient` (the real Microsoft Graph HTTP client) tested
against an injected fake httpx-like client and a fake credential -- no
network access, no real `azure-identity`/`httpx` behaviour relied upon
except what we stub out here.

This is the class F2's SSRF/path-traversal findings are about, and it was
previously exercised by zero tests (every other test in this suite runs
against `FakeGraphClient`, a hand-written double that never touches HTTP at
all). These tests assert the *actual* request-building code path: that the
bearer token is attached per request rather than cached on the client, that
an absolute URL outside Graph's host is refused before ever building a
request, and that a drive/item id is validated before being interpolated
into a request path.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime

import pytest

from trialpulse_ingest.sharepoint import (
    GraphSharePointClient,
    InvalidGraphIdError,
    SuspiciousGraphUrlError,
)


@dataclass
class _FakeToken:
    token: str


class _FakeCredential:
    """Fake `azure.identity` credential: records every scope requested and
    returns a fixed token, with no network access."""

    def __init__(self, token: str = "fake-graph-token") -> None:
        self._token = token
        self.get_token_calls: list[tuple[str, ...]] = []

    def get_token(self, *scopes: str) -> _FakeToken:
        self.get_token_calls.append(scopes)
        return _FakeToken(token=self._token)


@dataclass
class _FakeResponse:
    status_code: int = 200
    _json_body: dict | None = None
    content: bytes = b""

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self) -> dict:
        return self._json_body if self._json_body is not None else {}


@dataclass
class _RecordedRequest:
    method: str
    url: str
    headers: dict[str, str] = field(default_factory=dict)
    json_body: dict | None = None


class _FakeHttpxClient:
    """Records every request made through it and returns a pre-registered
    response, so tests can assert on the exact URL/headers
    `GraphSharePointClient` sends without any real HTTP client."""

    def __init__(self) -> None:
        self.requests: list[_RecordedRequest] = []
        self.responses: dict[str, _FakeResponse] = {}

    def _respond(self, method: str, url: str, *, headers: dict[str, str] | None, json: dict | None = None):
        self.requests.append(_RecordedRequest(method=method, url=url, headers=headers or {}, json_body=json))
        return self.responses.get(url, _FakeResponse())

    def get(self, url: str, *, headers: dict[str, str] | None = None) -> _FakeResponse:
        return self._respond("GET", url, headers=headers)

    def post(self, url: str, *, json: dict, headers: dict[str, str] | None = None) -> _FakeResponse:
        return self._respond("POST", url, headers=headers, json=json)

    def patch(self, url: str, *, json: dict, headers: dict[str, str] | None = None) -> _FakeResponse:
        return self._respond("PATCH", url, headers=headers, json=json)


def _client(fake_http: _FakeHttpxClient, credential: _FakeCredential) -> GraphSharePointClient:
    return GraphSharePointClient(credential=credential, http_client=fake_http)


# --- F2: per-request Authorization, not a client-level header ------------


def test_get_delta_page_attaches_authorization_per_request() -> None:
    fake_http = _FakeHttpxClient()
    credential = _FakeCredential(token="secret-token-1")
    url = "https://graph.microsoft.com/v1.0/sites/s/drives/d/root/delta"
    fake_http.responses[url] = _FakeResponse(_json_body={"value": []})
    client = _client(fake_http, credential)

    client.get_delta_page(url)

    assert len(fake_http.requests) == 1
    assert fake_http.requests[0].headers.get("Authorization") == "Bearer secret-token-1"
    # The token was fetched fresh for this call, not read off a cached
    # client-level header.
    assert credential.get_token_calls == [("https://graph.microsoft.com/.default",)]


def test_two_requests_each_fetch_their_own_token() -> None:
    """If the Authorization header were still set once at client
    construction, `get_token` would be called at most once total. Calling
    it once per request is what makes token refresh actually work."""
    fake_http = _FakeHttpxClient()
    credential = _FakeCredential()
    url = "https://graph.microsoft.com/v1.0/sites/s/drives/d/root/delta"
    fake_http.responses[url] = _FakeResponse(_json_body={"value": []})
    client = _client(fake_http, credential)

    client.get_delta_page(url)
    client.download_item_content("drive-1", "item-1")

    assert len(credential.get_token_calls) == 2


# --- F2: absolute URLs off the Graph host must be refused -----------------


def test_get_delta_page_refuses_a_non_graph_absolute_url() -> None:
    fake_http = _FakeHttpxClient()
    credential = _FakeCredential()
    client = _client(fake_http, credential)

    with pytest.raises(SuspiciousGraphUrlError):
        client.get_delta_page("https://evil.example.com/steal")

    # Must never have reached the HTTP layer at all -- no token leaked.
    assert fake_http.requests == []
    assert credential.get_token_calls == []


def test_get_delta_page_accepts_a_relative_or_graph_absolute_url() -> None:
    fake_http = _FakeHttpxClient()
    credential = _FakeCredential()
    graph_url = "https://graph.microsoft.com/v1.0/sites/s/drives/d/root/delta"
    fake_http.responses[graph_url] = _FakeResponse(_json_body={"value": []})
    client = _client(fake_http, credential)

    client.get_delta_page(graph_url)  # must not raise

    assert len(fake_http.requests) == 1


# --- F2: drive/item id validation before interpolation --------------------


def test_download_item_content_rejects_a_path_traversal_item_id() -> None:
    fake_http = _FakeHttpxClient()
    credential = _FakeCredential()
    client = _client(fake_http, credential)

    with pytest.raises(InvalidGraphIdError):
        client.download_item_content("drive-1", "../../../subscriptions")

    assert fake_http.requests == []


def test_download_item_content_rejects_a_slash_in_drive_id() -> None:
    fake_http = _FakeHttpxClient()
    credential = _FakeCredential()
    client = _client(fake_http, credential)

    with pytest.raises(InvalidGraphIdError):
        client.download_item_content("drive/../other", "item-1")

    assert fake_http.requests == []


def test_download_item_content_accepts_a_well_formed_id_and_builds_the_expected_path() -> None:
    fake_http = _FakeHttpxClient()
    credential = _FakeCredential(token="tok")
    content_url = "/drives/drive-1/items/item-1/content"
    fake_http.responses[content_url] = _FakeResponse(content=b"file bytes")
    client = _client(fake_http, credential)

    result = client.download_item_content("drive-1", "item-1")

    assert result == b"file bytes"
    assert fake_http.requests[0].url == content_url
    assert fake_http.requests[0].headers.get("Authorization") == "Bearer tok"


def test_get_item_metadata_rejects_invalid_ids_and_builds_expected_path_otherwise() -> None:
    fake_http = _FakeHttpxClient()
    credential = _FakeCredential()
    client = _client(fake_http, credential)

    with pytest.raises(InvalidGraphIdError):
        client.get_item_metadata(drive_id="drive-1", item_id="../etc/passwd")

    metadata_url = "/drives/drive-1/items/item-1?$expand=listItem($expand=fields)"
    fake_http.responses[metadata_url] = _FakeResponse(_json_body={"name": "protocol.md"})
    body = client.get_item_metadata(drive_id="drive-1", item_id="item-1")
    assert body == {"name": "protocol.md"}
    assert fake_http.requests[-1].url == metadata_url


def test_create_and_renew_subscription_also_attach_authorization_per_request() -> None:
    fake_http = _FakeHttpxClient()
    credential = _FakeCredential(token="sub-token")
    client = _client(fake_http, credential)
    expiration = datetime(2026, 1, 1, tzinfo=UTC)
    fake_http.responses["/subscriptions"] = _FakeResponse(_json_body={"id": "sub-1"})
    fake_http.responses["/subscriptions/sub-1"] = _FakeResponse(
        _json_body={"id": "sub-1", "resource": "r", "clientState": "cs"}
    )

    client.create_subscription(
        resource="drives/d/root", notification_url="https://ingest/api/webhooks/sharepoint",
        client_state="cs", expiration=expiration,
    )
    client.renew_subscription("sub-1", expiration=expiration)

    assert all(r.headers.get("Authorization") == "Bearer sub-token" for r in fake_http.requests)
