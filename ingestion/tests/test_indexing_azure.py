"""`AzureAISearchIndex` (the real Azure AI Search client) against a fake
`SearchClient` double -- no network access, no real Azure SDK behaviour
relied upon except what we stub out here.

F3: every one of the 100 pre-existing tests in this suite exercised
`InMemorySearchIndex` only, which stores whatever attributes it is given
and never validates them against `schema/search-index.json`. That is
exactly how `tombstone_document` shipped writing a `tombstoned_at` field
that does not exist in the index schema: Azure AI Search rejects an entire
`merge_or_upload_documents` batch containing a document with a property
absent from the index, so every real tombstone call would have failed in
production while every test stayed green.

These tests are the guard the finding asked for: they exercise
`AzureAISearchIndex`'s actual request-building code against a fake
`SearchClient`, and assert that every field it writes exists in
`schema/search-index.json`, and every field it reads via `select=[...]` is
`retrievable`. Run this file's tests without the F3 fix (re-add
`"tombstoned_at": ...` to `tombstone_document`'s `updates` dict) and
`test_azure_search_index_tombstone_only_writes_fields_in_schema` fails --
that is the regression this guard exists to catch.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from trialpulse_ingest.indexing import AzureAISearchIndex
from trialpulse_ingest.models import Chunk

SCHEMA_PATH = Path(__file__).resolve().parents[1] / "schema" / "search-index.json"


def _schema_fields() -> dict[str, dict]:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    return {f["name"]: f for f in schema["fields"]}


def _make_chunk(chunk_id: str, document_id: str, content_hash: str = "hash1") -> Chunk:
    return Chunk(
        chunk_id=chunk_id,
        document_id=document_id,
        document_title="Some Document",
        document_classification="protocol",
        document_version="1.0",
        content="some content",
        content_hash=content_hash,
        heading_path="Some Document > 1. Heading",
        page_number=1,
        source_url="https://example.com/doc.md",
        ingested_at=datetime.now(UTC).isoformat(),
        site_code=None,
        previous_version_hash=None,
        embedding=None,
    )


@dataclass
class _FakeSearchResponse:
    """Minimal double for the `azure.search.documents` `get_document`
    "not found" behaviour: the real SDK raises `ResourceNotFoundError`, so
    any exception works since `upsert_chunks` catches `Exception` broadly.
    """


class _FakeSearchClient:
    """Records every document written and every `select` list requested,
    so tests can assert on exactly what `AzureAISearchIndex` sends without
    any real Azure SDK network access."""

    def __init__(self) -> None:
        self.documents: dict[str, dict] = {}
        self.merged_documents: list[dict] = []
        self.deleted_documents: list[dict] = []
        self.select_calls: list[list[str] | None] = []

    def get_document(self, *, key: str) -> dict:
        if key not in self.documents:
            raise LookupError(f"no such document {key!r}")
        return self.documents[key]

    def merge_or_upload_documents(self, *, documents: list[dict]) -> None:
        for doc in documents:
            self.merged_documents.append(doc)
            existing = self.documents.setdefault(doc["chunk_id"], {})
            existing.update(doc)

    def search(self, *, search_text: str, filter: str | None = None, select: list[str] | None = None):  # noqa: A002
        self.select_calls.append(select)
        results = list(self.documents.values())
        if filter and "document_id eq" in filter:
            wanted = filter.split("'")[1]
            results = [d for d in results if d.get("document_id") == wanted]
        if select:
            results = [{k: v for k, v in doc.items() if k in select} for doc in results]
        return results

    def delete_documents(self, *, documents: list[dict]) -> None:
        for doc in documents:
            self.deleted_documents.append(doc)
            self.documents.pop(doc["chunk_id"], None)


def _index(fake_client: _FakeSearchClient) -> AzureAISearchIndex:
    return AzureAISearchIndex(
        endpoint="https://fake.search.windows.net", index_name="trialpulse-chunks", search_client=fake_client
    )


# --- F3's actual regression guard -----------------------------------------


def test_azure_search_index_upsert_only_writes_fields_in_schema() -> None:
    fields = _schema_fields()
    fake = _FakeSearchClient()
    index = _index(fake)

    index.upsert_chunks([_make_chunk("c1", "doc-1")])

    assert fake.merged_documents, "expected upsert_chunks to call merge_or_upload_documents"
    for doc in fake.merged_documents:
        for key in doc:
            assert key in fields, (
                f"AzureAISearchIndex.upsert_chunks writes {key!r}, which is not a field in "
                f"{SCHEMA_PATH}. Azure AI Search rejects the whole batch for this."
            )


def test_azure_search_index_tombstone_only_writes_fields_in_schema() -> None:
    """This is the exact regression F3 describes: `tombstone_document` used
    to write `tombstoned_at`, which is not a field in
    `schema/search-index.json`."""
    fields = _schema_fields()
    fake = _FakeSearchClient()
    index = _index(fake)
    index.upsert_chunks([_make_chunk("c1", "doc-1")])

    now = datetime(2026, 1, 1, tzinfo=UTC)
    count = index.tombstone_document("doc-1", tombstoned_at=now, purge_after=now + timedelta(days=30))

    assert count == 1
    tombstone_writes = [doc for doc in fake.merged_documents if "is_tombstoned" in doc]
    assert tombstone_writes, "expected tombstone_document to call merge_or_upload_documents"
    for doc in tombstone_writes:
        for key in doc:
            assert key in fields, (
                f"AzureAISearchIndex.tombstone_document writes {key!r}, which is not a field in "
                f"{SCHEMA_PATH}. This is the F3 bug: Azure AI Search rejects the whole batch, "
                "so tombstoning silently fails in production while every InMemorySearchIndex "
                "test stays green."
            )


def test_azure_search_index_purge_does_not_write_any_fields() -> None:
    fake = _FakeSearchClient()
    index = _index(fake)
    index.upsert_chunks([_make_chunk("c1", "doc-1")])
    index.tombstone_document(
        "doc-1", tombstoned_at=datetime(2026, 1, 1, tzinfo=UTC), purge_after=datetime(2026, 1, 1, tzinfo=UTC)
    )

    purged = index.purge_tombstones(as_of=datetime(2026, 2, 1, tzinfo=UTC))

    assert purged == 1
    assert fake.deleted_documents == [{"chunk_id": "c1"}]


def test_azure_search_index_only_selects_retrievable_fields() -> None:
    fields = _schema_fields()
    fake = _FakeSearchClient()
    index = _index(fake)
    index.upsert_chunks([_make_chunk("c1", "doc-1")])

    index.tombstone_document(
        "doc-1", tombstoned_at=datetime(2026, 1, 1, tzinfo=UTC), purge_after=datetime(2026, 1, 1, tzinfo=UTC)
    )
    index.purge_tombstones(as_of=datetime(2026, 2, 1, tzinfo=UTC))

    select_lists = [s for s in fake.select_calls if s]
    assert select_lists, "expected at least one search(..., select=[...]) call"
    for select in select_lists:
        for field_name in select:
            assert fields[field_name]["retrievable"] is True, (
                f"AzureAISearchIndex selects {field_name!r}, which is not retrievable in "
                f"{SCHEMA_PATH}; Azure AI Search would never return it."
            )


# --- Read-side guard: fields read without an explicit `select` -----------

# `_chunk_from_search_doc` reads these via `doc["field"]` (direct
# indexing): if the field were ever marked non-retrievable, a real Azure AI
# Search response would omit it entirely and this would raise `KeyError`
# on every `get_chunks_for_document`/`all_records` call.
_REQUIRED_SEARCH_DOC_FIELDS = (
    "chunk_id",
    "document_id",
    "document_title",
    "document_classification",
    "document_version",
    "content",
    "content_hash",
    "heading_path",
    "page_number",
    "source_url",
    "ingested_at",
)
# Read via `doc.get(...)` (tolerates a missing/non-retrievable field), but
# both are still populated on every real chunk, so they should stay
# retrievable too -- a future change that turns one of these non-retrievable
# would silently start returning None for every chunk.
_OPTIONAL_BUT_EXPECTED_RETRIEVABLE_FIELDS = ("site_code", "previous_version_hash")
# `embedding` is deliberately excluded: `schema/search-index.json` marks it
# `"retrievable": false` on purpose, to avoid returning a 3072-float vector
# on every version-diff / tombstone-purge lookup that never needs it.
# `_chunk_from_search_doc` reads it via `.get(...)` and tolerates `None`.


def test_fields_read_directly_off_a_search_document_are_all_retrievable() -> None:
    fields = _schema_fields()
    for name in _REQUIRED_SEARCH_DOC_FIELDS + _OPTIONAL_BUT_EXPECTED_RETRIEVABLE_FIELDS:
        assert name in fields, f"{name!r} is read by _chunk_from_search_doc but is not in {SCHEMA_PATH}"
        assert fields[name]["retrievable"] is True, (
            f"{name!r} is read directly off search results by _chunk_from_search_doc, "
            "but is not retrievable -- a real Azure AI Search response would omit it."
        )


def test_embedding_is_deliberately_not_retrievable_and_code_tolerates_that() -> None:
    fields = _schema_fields()
    assert fields["embedding"]["retrievable"] is False

    fake = _FakeSearchClient()
    index = _index(fake)
    index.upsert_chunks([_make_chunk("c1", "doc-1")])
    # Simulate what a real, retrievable:false field looks like in a search
    # response: entirely absent, not present-as-None.
    fake.documents["c1"].pop("embedding", None)

    chunks = index.get_chunks_for_document("doc-1")
    assert chunks[0].embedding is None
