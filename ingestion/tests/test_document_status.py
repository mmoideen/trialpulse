"""F4: `IngestionPipeline` writes a `DocumentStatus` record after every
document it processes -- `status="indexed"` on success, `status="failed"`
(with `error_message` set, preserving the last known-good `chunk_count`/
`last_ingested_at`) on failure -- via an injectable `DocumentStatusStore`,
exactly the pattern already used for `SearchIndex`.

Before this fix, nothing in the ingestion pipeline wrote to Cosmos DB's
`documents` container at all (see `infra/modules/cosmos.bicep`'s comment),
so the orchestrator's Browse tab was permanently empty and version-compare
could never resolve a document pair.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from trialpulse_ingest.document_status import InMemoryDocumentStatusStore
from trialpulse_ingest.embedding import LocalFakeEmbedder
from trialpulse_ingest.indexing import InMemorySearchIndex
from trialpulse_ingest.models import DocumentMetadata
from trialpulse_ingest.pipeline import IngestionPipeline


def _doc_meta(**overrides: object) -> DocumentMetadata:
    defaults: dict[str, object] = {
        "document_id": "sp-prot-0001",
        "filename": "protocol-axiom-hn01-v3.0.md",
        "title": "AXIOM-HN01 Protocol v3.0",
        "classification": "protocol",
        "version": "3.0",
        "effective_date": "2025-11-14",
        "site_code": None,
        "supersedes": None,
        "source_url": "https://example.com/protocol-v3.md",
    }
    defaults.update(overrides)
    return DocumentMetadata(**defaults)  # type: ignore[arg-type]


def test_pipeline_defaults_to_an_in_memory_document_status_store() -> None:
    """Every existing call site constructs IngestionPipeline without a
    document_status_store; it must still work and still record status."""
    pipeline = IngestionPipeline(embedder=LocalFakeEmbedder(), index=InMemorySearchIndex())
    assert isinstance(pipeline._document_status_store, InMemoryDocumentStatusStore)  # noqa: SLF001


def test_successful_ingest_writes_an_indexed_status_record(corpus_dir: Path) -> None:
    fixed_time = datetime(2026, 1, 1, tzinfo=UTC)
    store = InMemoryDocumentStatusStore()
    pipeline = IngestionPipeline(
        embedder=LocalFakeEmbedder(),
        index=InMemorySearchIndex(),
        document_status_store=store,
        clock=lambda: fixed_time,
    )
    doc_meta = _doc_meta()

    result = pipeline.ingest_document(doc_meta, corpus_dir / doc_meta.filename)

    status = store.get(doc_meta.document_id)
    assert status is not None
    assert status.status == "indexed"
    assert status.document_id == doc_meta.document_id
    assert status.document_title == doc_meta.title
    assert status.document_classification == doc_meta.classification
    assert status.document_version == doc_meta.version
    assert status.chunk_count == len(result.chunk_ids)
    assert status.chunk_count > 0
    assert status.last_ingested_at == fixed_time.isoformat()
    assert status.error_message is None
    assert status.source_url == doc_meta.source_url


def test_failed_ingest_writes_a_failed_status_with_error_message(tmp_path: Path) -> None:
    store = InMemoryDocumentStatusStore()
    pipeline = IngestionPipeline(
        embedder=LocalFakeEmbedder(), index=InMemorySearchIndex(), document_status_store=store
    )
    doc_meta = _doc_meta(document_id="sp-missing-0001")
    missing_path = tmp_path / "does-not-exist.md"

    with pytest.raises(Exception):  # noqa: B017, PT011 -- extraction.ExtractionError, re-raised unchanged
        pipeline.ingest_document(doc_meta, missing_path)

    status = store.get(doc_meta.document_id)
    assert status is not None
    assert status.status == "failed"
    assert status.error_message is not None
    assert "does-not-exist.md" in status.error_message
    assert status.chunk_count == 0
    assert status.last_ingested_at is None


def test_failed_reingest_preserves_the_last_successful_chunk_count_and_timestamp(
    corpus_dir: Path, tmp_path: Path
) -> None:
    """A transient failure on a re-ingestion attempt of an
    already-successfully-indexed document must not blank out the last
    known-good chunk_count/last_ingested_at -- only flip status and set
    error_message."""
    fixed_time = datetime(2026, 1, 1, tzinfo=UTC)
    store = InMemoryDocumentStatusStore()
    pipeline = IngestionPipeline(
        embedder=LocalFakeEmbedder(),
        index=InMemorySearchIndex(),
        document_status_store=store,
        clock=lambda: fixed_time,
    )
    doc_meta = _doc_meta()
    result = pipeline.ingest_document(doc_meta, corpus_dir / doc_meta.filename)
    assert result.chunk_ids

    # Force a failure on a second attempt for the *same* document_id by
    # pointing at a missing file.
    with pytest.raises(Exception):  # noqa: B017, PT011
        pipeline.ingest_document(doc_meta, tmp_path / "gone.md")

    status = store.get(doc_meta.document_id)
    assert status is not None
    assert status.status == "failed"
    assert status.error_message is not None
    assert status.chunk_count == len(result.chunk_ids)  # preserved, not zeroed
    assert status.last_ingested_at == fixed_time.isoformat()  # preserved
