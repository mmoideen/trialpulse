"""Azure AI Search indexing: idempotent upsert, version tombstoning, and an
in-memory fake used by every test and local run.

PRD decision 2: "Every document chunk carries a content_hash... If the hash
exists, the chunk is skipped." Because `chunk_id` is derived deterministically
from (document_id, heading_path, ordinal, content_hash) (see
`hashing.make_chunk_id`), re-ingesting unchanged content always produces the
same chunk_id *and* the same content_hash, so "skip if already indexed with
the same hash" and "skip if this exact chunk_id already exists" are
equivalent here -- we implement the latter, which is a single point lookup
against Azure AI Search's key field instead of a broader hash query.

Tombstoning: tombstone state (`is_tombstoned`, `tombstone_purge_after`) is
deliberately NOT part of the shared `Chunk` type in
`packages/shared/src/types.ts` -- it is an ingestion/indexing-internal
concern, not something the orchestrator's retrieval or citation logic needs
to know about beyond "this chunk is still searchable" (PRD: "Tombstoned
chunks stay searchable until purged"). It is still a real field on the
Azure AI Search index itself (see `schema/search-index.json`), because a
real index has no side channel to store bookkeeping outside its documents.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import Protocol

from trialpulse_ingest.constants import TOMBSTONE_RETENTION_DAYS
from trialpulse_ingest.models import Chunk


@dataclass(frozen=True, slots=True)
class IndexResult:
    upserted: int
    skipped: int


@dataclass(frozen=True, slots=True)
class IndexedChunkRecord:
    """A chunk plus the index-internal tombstone bookkeeping around it."""

    chunk: Chunk
    is_tombstoned: bool = False
    tombstoned_at: str | None = None
    tombstone_purge_after: str | None = None


class SearchIndex(Protocol):
    """Common interface implemented by the real Azure AI Search client and
    the in-memory fake used throughout the test suite."""

    def upsert_chunks(self, chunks: Sequence[Chunk]) -> IndexResult: ...

    def get_chunks_for_document(self, document_id: str) -> list[Chunk]:
        """All chunks for a document, tombstoned or not (tombstoned chunks
        stay searchable/retrievable until purged)."""
        ...

    def tombstone_document(
        self, document_id: str, *, tombstoned_at: datetime, purge_after: datetime
    ) -> int:
        """Mark every chunk of `document_id` as tombstoned. Returns the count
        of chunks tombstoned. Tombstoned chunks are NOT removed here."""
        ...

    def purge_tombstones(self, *, as_of: datetime) -> int:
        """Permanently remove tombstoned chunks whose purge date has passed.
        Returns the count purged."""
        ...

    def all_records(self) -> list[IndexedChunkRecord]: ...


class InMemorySearchIndex:
    """In-memory fake of `SearchIndex`. Used by every offline test and by
    local development runs that don't need a real Azure AI Search resource.
    """

    def __init__(self) -> None:
        self._records: dict[str, IndexedChunkRecord] = {}

    def upsert_chunks(self, chunks: Sequence[Chunk]) -> IndexResult:
        upserted = 0
        skipped = 0
        for chunk in chunks:
            existing = self._records.get(chunk.chunk_id)
            if existing is not None and existing.chunk.content_hash == chunk.content_hash:
                skipped += 1
                continue
            # New chunk_id, or same chunk_id with different content (should
            # not happen given how chunk_id is derived, but if it ever did
            # -- e.g. a hash collision -- treat it as an update, not a skip).
            self._records[chunk.chunk_id] = IndexedChunkRecord(chunk=chunk)
            upserted += 1
        return IndexResult(upserted=upserted, skipped=skipped)

    def get_chunks_for_document(self, document_id: str) -> list[Chunk]:
        return [r.chunk for r in self._records.values() if r.chunk.document_id == document_id]

    def tombstone_document(self, document_id: str, *, tombstoned_at: datetime, purge_after: datetime) -> int:
        count = 0
        for chunk_id, record in list(self._records.items()):
            if record.chunk.document_id != document_id:
                continue
            self._records[chunk_id] = replace(
                record,
                is_tombstoned=True,
                tombstoned_at=tombstoned_at.isoformat(),
                tombstone_purge_after=purge_after.isoformat(),
            )
            count += 1
        return count

    def purge_tombstones(self, *, as_of: datetime) -> int:
        purged = 0
        for chunk_id, record in list(self._records.items()):
            if not record.is_tombstoned or record.tombstone_purge_after is None:
                continue
            purge_after = datetime.fromisoformat(record.tombstone_purge_after)
            if purge_after <= as_of:
                del self._records[chunk_id]
                purged += 1
        return purged

    def all_records(self) -> list[IndexedChunkRecord]:
        return list(self._records.values())


class AzureAISearchIndex:
    """Real Azure AI Search client.

    Lazy-imports `azure.search.documents` so importing this module never
    requires the package to be installed unless this class is actually
    instantiated (production only -- never the offline test suite).
    Authenticates via managed identity per PRD 8.1 (no API keys in code).
    """

    def __init__(
        self,
        *,
        endpoint: str,
        index_name: str,
        credential: object | None = None,
        search_client: object | None = None,
    ) -> None:
        self._endpoint = endpoint
        self._index_name = index_name
        self._credential = credential
        # Test-only injection point (mirrors `http_client` on
        # `GraphSharePointClient`): lets `tests/test_indexing_azure.py`
        # exercise this class's real request-building logic -- which
        # fields it writes and which it selects -- against a fake
        # `SearchClient` double, with no real Azure SDK network calls.
        # This is exactly the gap F3 exists because of: before this, every
        # test exercised `InMemorySearchIndex` only, so a document
        # containing a field absent from the index schema (`tombstoned_at`)
        # was never caught.
        self._client = search_client

    def _get_client(self):  # noqa: ANN202 -- lazily-imported SearchClient type
        if self._client is not None:
            return self._client
        from azure.search.documents import SearchClient  # noqa: PLC0415

        credential = self._credential
        if credential is None:
            from azure.identity import DefaultAzureCredential  # noqa: PLC0415

            credential = DefaultAzureCredential()
        self._client = SearchClient(endpoint=self._endpoint, index_name=self._index_name, credential=credential)
        return self._client

    def upsert_chunks(self, chunks: Sequence[Chunk]) -> IndexResult:
        client = self._get_client()
        upserted = 0
        skipped = 0
        to_upload: list[dict] = []
        for chunk in chunks:
            try:
                existing = client.get_document(key=chunk.chunk_id)
            except Exception:  # noqa: BLE001 -- SDK raises ResourceNotFoundError for a missing key
                existing = None
            if existing is not None and existing.get("content_hash") == chunk.content_hash:
                skipped += 1
                continue
            to_upload.append(chunk.to_dict())
            upserted += 1
        if to_upload:
            client.merge_or_upload_documents(documents=to_upload)
        return IndexResult(upserted=upserted, skipped=skipped)

    def get_chunks_for_document(self, document_id: str) -> list[Chunk]:
        client = self._get_client()
        results = client.search(search_text="*", filter=f"document_id eq '{document_id}'")
        return [_chunk_from_search_doc(doc) for doc in results]

    def tombstone_document(self, document_id: str, *, tombstoned_at: datetime, purge_after: datetime) -> int:
        # F3: `tombstoned_at` is deliberately NOT written here. It is not a
        # field in `schema/search-index.json` (16 fields; `tombstoned_at`
        # is not one of them), and Azure AI Search rejects an entire
        # `merge_or_upload_documents` batch containing a document with a
        # property absent from the index. It is also fully redundant with
        # `tombstone_purge_after`, since `pipeline.py` always computes
        # `purge_after` as `tombstoned_at + TOMBSTONE_RETENTION_DAYS`
        # (`tombstones.compute_purge_after`) -- see `all_records` below,
        # which derives it back out on read. `InMemorySearchIndex` still
        # stores the real value directly (see its `tombstone_document`)
        # since it has no index schema to violate.
        client = self._get_client()
        results = list(
            client.search(search_text="*", filter=f"document_id eq '{document_id}'", select=["chunk_id"])
        )
        if not results:
            return 0
        updates = [
            {
                "chunk_id": doc["chunk_id"],
                "is_tombstoned": True,
                "tombstone_purge_after": purge_after.isoformat(),
            }
            for doc in results
        ]
        client.merge_or_upload_documents(documents=updates)
        return len(updates)

    def purge_tombstones(self, *, as_of: datetime) -> int:
        client = self._get_client()
        filter_expr = f"is_tombstoned eq true and tombstone_purge_after le {as_of.isoformat()}"
        results = list(client.search(search_text="*", filter=filter_expr, select=["chunk_id"]))
        if not results:
            return 0
        client.delete_documents(documents=[{"chunk_id": doc["chunk_id"]} for doc in results])
        return len(results)

    def all_records(self) -> list[IndexedChunkRecord]:
        client = self._get_client()
        results = client.search(search_text="*")
        return [
            IndexedChunkRecord(
                chunk=_chunk_from_search_doc(doc),
                is_tombstoned=bool(doc.get("is_tombstoned", False)),
                tombstoned_at=_derive_tombstoned_at(doc),
                tombstone_purge_after=doc.get("tombstone_purge_after"),
            )
            for doc in results
        ]


def _derive_tombstoned_at(doc: dict) -> str | None:
    """Recover `tombstoned_at` from `tombstone_purge_after`, since the real
    Azure AI Search index does not store `tombstoned_at` directly (F3).

    Valid because `pipeline.py` always tombstones with
    `tombstones.compute_purge_after(now)`, i.e. `purge_after ==
    tombstoned_at + TOMBSTONE_RETENTION_DAYS`, with the default retention
    window every time -- nothing in this codebase ever calls
    `tombstone_document` with a custom `retention_days`. If that ever
    changes for a specific record, this derivation would be wrong for that
    record; `InMemorySearchIndex` (local development, and every offline
    test) is unaffected, since it stores the real timestamp directly.
    """
    purge_after = doc.get("tombstone_purge_after")
    if not doc.get("is_tombstoned") or not purge_after:
        return None
    return (datetime.fromisoformat(purge_after) - timedelta(days=TOMBSTONE_RETENTION_DAYS)).isoformat()


def _chunk_from_search_doc(doc: dict) -> Chunk:
    return Chunk(
        chunk_id=doc["chunk_id"],
        document_id=doc["document_id"],
        document_title=doc["document_title"],
        document_classification=doc["document_classification"],
        document_version=doc["document_version"],
        content=doc["content"],
        content_hash=doc["content_hash"],
        heading_path=doc["heading_path"],
        page_number=doc["page_number"],
        source_url=doc["source_url"],
        ingested_at=doc["ingested_at"],
        site_code=doc.get("site_code"),
        previous_version_hash=doc.get("previous_version_hash"),
        embedding=doc.get("embedding"),
    )
