"""Full end-to-end ingestion over the real synthetic corpus.

Asserts: all 20 documents ingest, chunk counts per classification are
non-zero, every manifest fact string is findable in exactly one chunk's
content, and every produced chunk validates against the shared `Chunk`
shape.
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

from trialpulse_ingest.embedding import LocalFakeEmbedder
from trialpulse_ingest.indexing import InMemorySearchIndex
from trialpulse_ingest.models import validate_chunk_shape
from trialpulse_ingest.pipeline import ingest_local_corpus, load_manifest


def test_all_twenty_documents_ingest_successfully(manifest_path: Path, corpus_dir: Path) -> None:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert len(manifest["documents"]) == 20

    index = InMemorySearchIndex()
    pipeline_index = index
    from trialpulse_ingest.pipeline import IngestionPipeline

    pipeline = IngestionPipeline(embedder=LocalFakeEmbedder(), index=pipeline_index)
    results = ingest_local_corpus(manifest_path, corpus_dir, pipeline)

    assert len(results) == 20
    for result in results:
        assert result.chunks_upserted > 0, f"{result.document_id} produced no chunks"

    all_records = index.all_records()
    assert len(all_records) > 0


def test_chunk_counts_per_classification_are_non_zero(manifest_path: Path, corpus_dir: Path) -> None:
    from trialpulse_ingest.pipeline import IngestionPipeline

    index = InMemorySearchIndex()
    pipeline = IngestionPipeline(embedder=LocalFakeEmbedder(), index=index)
    ingest_local_corpus(manifest_path, corpus_dir, pipeline)

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    classifications = {doc["classification"] for doc in manifest["documents"]}
    assert classifications == {
        "protocol",
        "investigator_brochure",
        "regulatory_submission",
        "safety_report",
        "site_communication",
        "competitive_intelligence",
    }

    counts = Counter(record.chunk.document_classification for record in index.all_records())
    for classification in classifications:
        assert counts[classification] > 0, f"no chunks produced for classification {classification!r}"


def test_every_manifest_fact_is_findable_in_exactly_one_chunk(manifest_path: Path, corpus_dir: Path) -> None:
    from trialpulse_ingest.pipeline import IngestionPipeline

    index = InMemorySearchIndex()
    pipeline = IngestionPipeline(embedder=LocalFakeEmbedder(), index=index)
    ingest_local_corpus(manifest_path, corpus_dir, pipeline)

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    all_chunks = [record.chunk for record in index.all_records()]

    failures: list[str] = []
    for doc in manifest["documents"]:
        document_chunks = [c for c in all_chunks if c.document_id == doc["document_id"]]
        for section in doc["sections"]:
            for fact in section["facts"]:
                matches = [c for c in document_chunks if fact in c.content]
                if len(matches) != 1:
                    failures.append(
                        f"{doc['document_id']} / {section['heading']}: fact {fact!r} found in "
                        f"{len(matches)} chunks (expected exactly 1)"
                    )

    assert not failures, "Fact verbatim-match failures:\n" + "\n".join(failures)


def test_every_produced_chunk_validates_against_shared_chunk_shape(manifest_path: Path, corpus_dir: Path) -> None:
    from trialpulse_ingest.pipeline import IngestionPipeline

    index = InMemorySearchIndex()
    pipeline = IngestionPipeline(embedder=LocalFakeEmbedder(), index=index)
    ingest_local_corpus(manifest_path, corpus_dir, pipeline)

    all_chunks = [record.chunk for record in index.all_records()]
    assert all_chunks, "expected at least one chunk from the full corpus"

    violations: list[str] = []
    for chunk in all_chunks:
        chunk_violations = validate_chunk_shape(chunk)
        violations.extend(f"{chunk.chunk_id}: {v}" for v in chunk_violations)

    assert not violations, "Chunk shape violations:\n" + "\n".join(violations)


def test_load_manifest_produces_plausible_sharepoint_source_urls(manifest_path: Path) -> None:
    documents = load_manifest(manifest_path)
    assert len(documents) == 20
    for doc in documents:
        assert doc.source_url.startswith("https://meridiantx.sharepoint.com/sites/TrialPulse/")
        assert doc.filename in doc.source_url or doc.filename.replace(" ", "%20") in doc.source_url
