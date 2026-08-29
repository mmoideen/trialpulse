#!/usr/bin/env python3
"""Create or update the `trialpulse-chunks` Azure AI Search index.

Sends `schema/search-index.json` to the Azure AI Search REST API via an
injectable HTTP client, so this script's request-building logic can be unit
tested (see `tests/test_create_index.py`) without ever making a real network
call. Authenticates with `azure.identity` managed identity (PRD 8.1: no API
keys in code or config).

Usage:
    AZURE_SEARCH_ENDPOINT=https://<service>.search.windows.net \\
        python scripts/create_index.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Protocol

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema" / "search-index.json"
API_VERSION = "2024-07-01"


class HttpClient(Protocol):
    """Minimal HTTP interface this script needs -- satisfied by `httpx.Client`
    and by the fake used in tests."""

    def put(self, url: str, *, headers: dict[str, str], json: dict) -> HttpResponse: ...


class HttpResponse(Protocol):
    status_code: int
    text: str


def build_request(endpoint: str, index_schema: dict) -> tuple[str, dict]:
    """Pure function: given an endpoint and the index schema dict, return the
    (url, schema-with-name-overridden) the real client should PUT. Kept
    separate from I/O so it's trivially unit-testable."""
    index_name = index_schema["name"]
    url = f"{endpoint.rstrip('/')}/indexes/{index_name}?api-version={API_VERSION}"
    return url, index_schema


def create_or_update_index(
    endpoint: str,
    index_schema: dict,
    *,
    http_client: HttpClient,
    bearer_token: str,
) -> HttpResponse:
    url, body = build_request(endpoint, index_schema)
    return http_client.put(
        url,
        headers={"Authorization": f"Bearer {bearer_token}", "Content-Type": "application/json"},
        json=body,
    )


def _get_bearer_token() -> str:
    from azure.identity import DefaultAzureCredential  # noqa: PLC0415 -- lazy, script-only

    credential = DefaultAzureCredential()
    return credential.get_token("https://search.azure.com/.default").token


def main() -> int:
    endpoint = os.environ.get("AZURE_SEARCH_ENDPOINT")
    if not endpoint:
        print("AZURE_SEARCH_ENDPOINT environment variable is required.", file=sys.stderr)
        return 1

    index_schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

    import httpx  # noqa: PLC0415 -- lazy, script-only

    token = _get_bearer_token()
    with httpx.Client(timeout=30.0) as client:
        response = create_or_update_index(endpoint, index_schema, http_client=client, bearer_token=token)

    if response.status_code not in (200, 201):
        print(f"Failed to create/update index: {response.status_code} {response.text}", file=sys.stderr)
        return 1

    print(f"Index {index_schema['name']!r} created/updated at {endpoint}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
