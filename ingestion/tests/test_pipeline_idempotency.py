"""Idempotency (PRD decision 2): re-running ingestion over an unchanged
document upserts 0 chunks and skips every chunk, with stable chunk_ids."""

from __future__ import annotations

from pathlib import Path

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


def test_reingesting_unchanged_document_upserts_zero_and_skips_all(corpus_dir: Path) -> None:
    pipeline = IngestionPipeline(embedder=LocalFakeEmbedder(), index=InMemorySearchIndex())
    doc_meta = _doc_meta()
    path = corpus_dir / doc_meta.filename

    first = pipeline.ingest_document(doc_meta, path)
    assert first.chunks_upserted > 0
    assert first.chunks_skipped == 0

    second = pipeline.ingest_document(doc_meta, path)
    assert second.chunks_upserted == 0
    assert second.chunks_skipped == first.chunks_upserted
    assert second.chunk_ids == first.chunk_ids


def test_chunk_ids_are_stable_across_independent_pipeline_instances(corpus_dir: Path) -> None:
    doc_meta = _doc_meta()
    path = corpus_dir / doc_meta.filename

    pipeline_a = IngestionPipeline(embedder=LocalFakeEmbedder(), index=InMemorySearchIndex())
    pipeline_b = IngestionPipeline(embedder=LocalFakeEmbedder(), index=InMemorySearchIndex())

    result_a = pipeline_a.ingest_document(doc_meta, path)
    result_b = pipeline_b.ingest_document(doc_meta, path)

    assert result_a.chunk_ids == result_b.chunk_ids
    assert result_a.chunk_ids, "expected at least one chunk"


def test_changed_content_produces_new_hash_and_is_upserted_not_skipped(tmp_path: Path) -> None:
    index = InMemorySearchIndex()
    pipeline = IngestionPipeline(embedder=LocalFakeEmbedder(), index=index)
    doc_meta = _doc_meta(filename="doc.md", source_url="https://example.com/doc.md")

    path = tmp_path / "doc.md"
    path.write_text("## 1. Heading\n<!-- page: 1 -->\n\nOriginal body text.\n", encoding="utf-8")
    first = pipeline.ingest_document(doc_meta, path)
    assert first.chunks_upserted == 1

    path.write_text("## 1. Heading\n<!-- page: 1 -->\n\nEdited body text, now different.\n", encoding="utf-8")
    second = pipeline.ingest_document(doc_meta, path)
    assert second.chunks_upserted == 1
    assert second.chunks_skipped == 0
    assert second.chunk_ids != first.chunk_ids

    # Both the old and new chunk are present (idempotent upsert never
    # deletes on its own -- deletion/tombstoning is a supersession concern).
    stored = index.get_chunks_for_document(doc_meta.document_id)
    assert len(stored) == 2
