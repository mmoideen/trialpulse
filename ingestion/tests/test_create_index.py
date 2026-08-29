"""`scripts/create_index.py`: request building against a fake HTTP client, no
network access. Also validates the index schema itself is well-formed and
matches PRD section 4.3's flag requirements plus the documented extra
fields."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

INGESTION_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = INGESTION_ROOT / "schema" / "search-index.json"


def _load_create_index_module():
    spec = importlib.util.spec_from_file_location(
        "trialpulse_create_index", INGESTION_ROOT / "scripts" / "create_index.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def create_index_module():
    return _load_create_index_module()


class _FakeHttpClient:
    def __init__(self, status_code: int = 201) -> None:
        self.status_code = status_code
        self.calls: list[dict] = []

    def put(self, url: str, *, headers: dict, json: dict) -> SimpleNamespace:
        self.calls.append({"url": url, "headers": headers, "json": json})
        return SimpleNamespace(status_code=self.status_code, text="")


def test_build_request_targets_correct_index_url(create_index_module) -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    url, body = create_index_module.build_request("https://my-search.search.windows.net", schema)
    assert url == "https://my-search.search.windows.net/indexes/trialpulse-chunks?api-version=2024-07-01"
    assert body["name"] == "trialpulse-chunks"


def test_build_request_strips_trailing_slash_from_endpoint(create_index_module) -> None:
    schema = {"name": "trialpulse-chunks", "fields": []}
    url, _ = create_index_module.build_request("https://my-search.search.windows.net/", schema)
    assert "//indexes" not in url


def test_create_or_update_index_calls_http_client_with_bearer_token(create_index_module) -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    fake_client = _FakeHttpClient(status_code=201)

    response = create_index_module.create_or_update_index(
        "https://my-search.search.windows.net", schema, http_client=fake_client, bearer_token="fake-token"
    )

    assert response.status_code == 201
    assert len(fake_client.calls) == 1
    call = fake_client.calls[0]
    assert call["headers"]["Authorization"] == "Bearer fake-token"
    assert call["json"]["name"] == "trialpulse-chunks"


def test_search_index_schema_is_valid_json_with_required_top_level_keys() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    assert schema["name"] == "trialpulse-chunks"
    assert "fields" in schema
    assert "vectorSearch" in schema
    assert "semantic" in schema


def test_schema_has_no_dollar_comment_keys_that_would_break_the_real_api() -> None:
    # The task allows documenting extra fields via a `$comment` key OR a
    # sibling README; this project uses schema/README.md instead, so the
    # index JSON sent to the real Azure AI Search API stays 100% valid.
    raw = SCHEMA_PATH.read_text(encoding="utf-8")
    assert "$comment" not in raw


def test_schema_key_field_is_chunk_id() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    key_fields = [f for f in schema["fields"] if f.get("key")]
    assert len(key_fields) == 1
    assert key_fields[0]["name"] == "chunk_id"


@pytest.mark.parametrize(
    "field_name",
    ["document_classification", "document_id", "content_hash"],
)
def test_schema_prd_4_3_required_filterable_fields(field_name: str) -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    fields_by_name = {f["name"]: f for f in schema["fields"]}
    assert fields_by_name[field_name]["filterable"] is True


def test_schema_semantic_config_covers_content_and_title() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    config = schema["semantic"]["configurations"][0]
    assert config["prioritizedFields"]["titleField"]["fieldName"] == "document_title"
    content_fields = [f["fieldName"] for f in config["prioritizedFields"]["prioritizedContentFields"]]
    assert content_fields == ["content"]


def test_schema_hnsw_parameters_match_prd() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    algorithm = schema["vectorSearch"]["algorithms"][0]
    assert algorithm["kind"] == "hnsw"
    assert algorithm["hnswParameters"]["m"] == 16
    assert algorithm["hnswParameters"]["efConstruction"] == 128


def test_schema_includes_extra_chunk_contract_fields_beyond_prd() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    field_names = {f["name"] for f in schema["fields"]}
    # Required by the shared Chunk type but absent from the PRD's illustrative JSON.
    assert {"site_code", "previous_version_hash"}.issubset(field_names)
    # Index-internal tombstone bookkeeping (see schema/README.md).
    assert {"is_tombstoned", "tombstone_purge_after"}.issubset(field_names)


def test_schema_embedding_field_dimensions_match_constants() -> None:
    from trialpulse_ingest.constants import EMBEDDING_DIMENSIONS

    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    fields_by_name = {f["name"]: f for f in schema["fields"]}
    assert fields_by_name["embedding"]["dimensions"] == EMBEDDING_DIMENSIONS
