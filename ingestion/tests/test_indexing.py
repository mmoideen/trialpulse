"""In-memory search index: idempotent upsert, per-document lookup, and the
tombstone lifecycle (mark, stay searchable, then purge after retention)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from trialpulse_ingest.indexing import InMemorySearchIndex
from trialpulse_ingest.models import Chunk


def _make_chunk(chunk_id: str, document_id: str, content: str, content_hash: str = "hash1") -> Chunk:
    return Chunk(
        chunk_id=chunk_id,
        document_id=document_id,
        document_title="Some Document",
        document_classification="protocol",
        document_version="1.0",
        content=content,
        content_hash=content_hash,
        heading_path="Some Document > 1. Heading",
        page_number=1,
        source_url="https://example.com/doc.md",
        ingested_at=datetime.now(UTC).isoformat(),
        site_code=None,
        previous_version_hash=None,
        embedding=None,
    )


def test_upsert_new_chunks_all_counted_as_upserted() -> None:
    index = InMemorySearchIndex()
    chunks = [_make_chunk("c1", "doc-1", "content one"), _make_chunk("c2", "doc-1", "content two", "hash2")]
    result = index.upsert_chunks(chunks)
    assert result.upserted == 2
    assert result.skipped == 0
    assert len(index.get_chunks_for_document("doc-1")) == 2


def test_reupsert_identical_chunks_skips_everything() -> None:
    index = InMemorySearchIndex()
    chunks = [_make_chunk("c1", "doc-1", "content one"), _make_chunk("c2", "doc-1", "content two", "hash2")]
    first = index.upsert_chunks(chunks)
    second = index.upsert_chunks(chunks)
    assert first.upserted == 2
    assert second.upserted == 0
    assert second.skipped == 2


def test_same_chunk_id_different_hash_is_treated_as_update() -> None:
    index = InMemorySearchIndex()
    original = _make_chunk("c1", "doc-1", "content one", "hash1")
    updated = _make_chunk("c1", "doc-1", "content one edited", "hash-changed")
    index.upsert_chunks([original])
    result = index.upsert_chunks([updated])
    assert result.upserted == 1
    assert result.skipped == 0
    stored = index.get_chunks_for_document("doc-1")
    assert stored[0].content == "content one edited"


def test_get_chunks_for_document_filters_by_document_id() -> None:
    index = InMemorySearchIndex()
    index.upsert_chunks([_make_chunk("c1", "doc-1", "a"), _make_chunk("c2", "doc-2", "b", "hash2")])
    assert [c.chunk_id for c in index.get_chunks_for_document("doc-1")] == ["c1"]
    assert [c.chunk_id for c in index.get_chunks_for_document("doc-2")] == ["c2"]
    assert index.get_chunks_for_document("doc-missing") == []


def test_tombstoned_chunks_remain_searchable_until_purged() -> None:
    index = InMemorySearchIndex()
    index.upsert_chunks([_make_chunk("c1", "doc-1", "a")])

    now = datetime(2026, 1, 1, tzinfo=UTC)
    purge_after = now + timedelta(days=30)
    tombstoned_count = index.tombstone_document("doc-1", tombstoned_at=now, purge_after=purge_after)
    assert tombstoned_count == 1

    # Still searchable/retrievable -- tombstoning does not remove it.
    assert len(index.get_chunks_for_document("doc-1")) == 1
    records = index.all_records()
    assert records[0].is_tombstoned is True
    assert records[0].tombstone_purge_after == purge_after.isoformat()

    # Purging before the retention window elapses removes nothing.
    purged_early = index.purge_tombstones(as_of=now + timedelta(days=29))
    assert purged_early == 0
    assert len(index.get_chunks_for_document("doc-1")) == 1

    # Purging after the retention window elapses removes it.
    purged_late = index.purge_tombstones(as_of=purge_after + timedelta(seconds=1))
    assert purged_late == 1
    assert index.get_chunks_for_document("doc-1") == []


def test_purge_ignores_non_tombstoned_chunks() -> None:
    index = InMemorySearchIndex()
    index.upsert_chunks([_make_chunk("c1", "doc-1", "a")])
    purged = index.purge_tombstones(as_of=datetime.now(UTC) + timedelta(days=365))
    assert purged == 0
    assert len(index.get_chunks_for_document("doc-1")) == 1
