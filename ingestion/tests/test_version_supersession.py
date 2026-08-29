"""Version supersession + tombstoning, end to end over the real AXIOM-HN01
protocol v3.0 -> v4.0 pair (PRD decision 2, Feature 3.2.2)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from trialpulse_ingest.constants import TOMBSTONE_RETENTION_DAYS
from trialpulse_ingest.embedding import LocalFakeEmbedder
from trialpulse_ingest.indexing import InMemorySearchIndex
from trialpulse_ingest.models import DocumentMetadata
from trialpulse_ingest.pipeline import IngestionPipeline, build_source_url
from trialpulse_ingest.tombstones import section_path_of


def _protocol_v3() -> DocumentMetadata:
    return DocumentMetadata(
        document_id="sp-prot-0001",
        filename="protocol-axiom-hn01-v3.0.md",
        title="AXIOM-HN01 Protocol v3.0",
        classification="protocol",
        version="3.0",
        effective_date="2025-11-14",
        site_code=None,
        supersedes=None,
        source_url=build_source_url("protocol", "protocol-axiom-hn01-v3.0.md"),
    )


def _protocol_v4() -> DocumentMetadata:
    return DocumentMetadata(
        document_id="sp-prot-0002",
        filename="protocol-axiom-hn01-v4.0.md",
        title="AXIOM-HN01 Protocol v4.0",
        classification="protocol",
        version="4.0",
        effective_date="2026-06-02",
        site_code=None,
        supersedes="sp-prot-0001",
        source_url=build_source_url("protocol", "protocol-axiom-hn01-v4.0.md"),
    )


def test_v4_stamps_previous_version_hash_for_unchanged_sections(corpus_dir: Path) -> None:
    fixed_time = datetime(2026, 6, 2, tzinfo=UTC)
    index = InMemorySearchIndex()
    pipeline = IngestionPipeline(embedder=LocalFakeEmbedder(), index=index, clock=lambda: fixed_time)

    v3_meta = _protocol_v3()
    v4_meta = _protocol_v4()
    v3_result = pipeline.ingest_document(v3_meta, corpus_dir / v3_meta.filename)
    v4_result = pipeline.ingest_document(v4_meta, corpus_dir / v4_meta.filename)

    assert v3_result.chunks_upserted > 0
    assert v4_result.chunks_upserted > 0

    v3_chunks_by_section = {section_path_of(c): c for c in index.get_chunks_for_document(v3_meta.document_id)}
    v4_chunks = index.get_chunks_for_document(v4_meta.document_id)

    # "5. Interim Analysis" content changed materially between versions, but
    # "3. Key Inclusion Criteria" and "2. Primary Endpoint" both exist in
    # both versions -- every v4 chunk whose section existed in v3 must be
    # stamped with that v3 chunk's content_hash as previous_version_hash.
    matched_any = False
    for chunk in v4_chunks:
        section = section_path_of(chunk)
        v3_chunk = v3_chunks_by_section.get(section)
        if v3_chunk is None:
            # New section in v4 (e.g. "6. Summary of Changes from Version 3.0")
            assert chunk.previous_version_hash is None
            continue
        matched_any = True
        assert chunk.previous_version_hash == v3_chunk.content_hash

    assert matched_any, "expected at least one shared section_path between v3 and v4"


def test_v4_tombstones_v3_chunks_with_30_day_purge_date(corpus_dir: Path) -> None:
    fixed_time = datetime(2026, 6, 2, tzinfo=UTC)
    index = InMemorySearchIndex()
    pipeline = IngestionPipeline(embedder=LocalFakeEmbedder(), index=index, clock=lambda: fixed_time)

    v3_meta = _protocol_v3()
    v4_meta = _protocol_v4()
    pipeline.ingest_document(v3_meta, corpus_dir / v3_meta.filename)
    v4_result = pipeline.ingest_document(v4_meta, corpus_dir / v4_meta.filename)

    v3_chunk_count = len(index.get_chunks_for_document(v3_meta.document_id))
    assert v4_result.chunks_tombstoned == v3_chunk_count
    assert v3_chunk_count > 0

    # Tombstoned v3 chunks remain searchable immediately after supersession.
    assert len(index.get_chunks_for_document(v3_meta.document_id)) == v3_chunk_count
    records_by_chunk_id = {r.chunk.chunk_id: r for r in index.all_records()}
    v3_chunk_ids = [c.chunk_id for c in index.get_chunks_for_document(v3_meta.document_id)]
    for chunk_id in v3_chunk_ids:
        record = records_by_chunk_id[chunk_id]
        assert record.is_tombstoned is True
        purge_after = datetime.fromisoformat(record.tombstone_purge_after)
        assert purge_after == fixed_time + timedelta(days=TOMBSTONE_RETENTION_DAYS)

    # v4 chunks are not tombstoned.
    for chunk in index.get_chunks_for_document(v4_meta.document_id):
        record = records_by_chunk_id[chunk.chunk_id]
        assert record.is_tombstoned is False

    # Before the retention window elapses, nothing is purged.
    assert index.purge_tombstones(as_of=fixed_time + timedelta(days=TOMBSTONE_RETENTION_DAYS - 1)) == 0
    assert len(index.get_chunks_for_document(v3_meta.document_id)) == v3_chunk_count

    # After the retention window elapses, the tombstoned v3 chunks are purged.
    purged = index.purge_tombstones(as_of=fixed_time + timedelta(days=TOMBSTONE_RETENTION_DAYS, seconds=1))
    assert purged == v3_chunk_count
    assert index.get_chunks_for_document(v3_meta.document_id) == []
    # v4 chunks survive the purge untouched.
    assert len(index.get_chunks_for_document(v4_meta.document_id)) > 0
