"""F9: `supersedes` must not silently flip which document version is
"current". `pipeline.IngestionPipeline.ingest_document` used to
unconditionally tombstone whatever `doc_meta.supersedes` named, with no
check that the ingesting document was actually newer and no cycle
detection. These tests reproduce both failure modes the finding
describes and assert they are now rejected before anything is tombstoned
or indexed with a misleading `previous_version_hash`.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from trialpulse_ingest.embedding import LocalFakeEmbedder
from trialpulse_ingest.indexing import InMemorySearchIndex
from trialpulse_ingest.models import DocumentMetadata
from trialpulse_ingest.pipeline import IngestionPipeline
from trialpulse_ingest.tombstones import InvalidSupersessionError, parse_dotted_version, validate_supersession


def _doc_meta(**overrides: object) -> DocumentMetadata:
    defaults: dict[str, object] = {
        "document_id": "doc-a",
        "filename": "a.md",
        "title": "Document A",
        "classification": "protocol",
        "version": "1.0",
        "effective_date": "2025-01-01",
        "site_code": None,
        "supersedes": None,
        "source_url": "https://example.com/a.md",
    }
    defaults.update(overrides)
    return DocumentMetadata(**defaults)  # type: ignore[arg-type]


# --- Unit tests for the pure validator -------------------------------------


def test_parse_dotted_version_parses_numeric_dotted_strings() -> None:
    assert parse_dotted_version("3.0") == (3, 0)
    assert parse_dotted_version("10.2") == (10, 2)
    assert parse_dotted_version("1") == (1,)


def test_parse_dotted_version_returns_none_for_non_numeric() -> None:
    assert parse_dotted_version("v3.0") is None
    assert parse_dotted_version("draft") is None
    assert parse_dotted_version("") is None


def test_validate_supersession_allows_a_strictly_newer_version() -> None:
    validate_supersession(
        document_id="doc-b",
        version="4.0",
        supersedes_id="doc-a",
        supersedes_version="3.0",
        supersedes_declared_supersedes=None,
    )  # must not raise


def test_validate_supersession_rejects_an_equal_or_older_version() -> None:
    with pytest.raises(InvalidSupersessionError):
        validate_supersession(
            document_id="doc-a",
            version="1.0",
            supersedes_id="doc-b",
            supersedes_version="2.0",
            supersedes_declared_supersedes=None,
        )


def test_validate_supersession_rejects_an_equal_version() -> None:
    with pytest.raises(InvalidSupersessionError):
        validate_supersession(
            document_id="doc-a",
            version="2.0",
            supersedes_id="doc-b",
            supersedes_version="2.0",
            supersedes_declared_supersedes=None,
        )


def test_validate_supersession_rejects_a_direct_two_document_cycle_even_with_a_newer_version() -> None:
    with pytest.raises(InvalidSupersessionError):
        validate_supersession(
            document_id="doc-a",
            version="99.0",  # would otherwise pass the version check
            supersedes_id="doc-b",
            supersedes_version="2.0",
            supersedes_declared_supersedes="doc-a",  # doc-b already claims to supersede doc-a
        )


def test_validate_supersession_skips_comparison_when_target_has_no_indexed_chunks() -> None:
    validate_supersession(
        document_id="doc-b",
        version="1.0",
        supersedes_id="doc-a",
        supersedes_version=None,
        supersedes_declared_supersedes=None,
    )  # must not raise -- out-of-order ingest, nothing to compare yet


def test_validate_supersession_skips_comparison_for_unparsable_versions() -> None:
    validate_supersession(
        document_id="doc-b",
        version="draft",
        supersedes_id="doc-a",
        supersedes_version="final",
        supersedes_declared_supersedes=None,
    )  # must not raise -- not a numeric versioning scheme, don't block on convention


# --- Integration tests through the real pipeline ---------------------------


def test_ingesting_an_older_document_that_claims_to_supersede_a_newer_one_is_rejected(tmp_path: Path) -> None:
    """The exact F9 probe: B v2.0 is ingested first (current, no
    supersedes). A v1.0 then erroneously claims `supersedes: doc-b`. Before
    the fix this tombstoned B (the newer, correct document) and left A (the
    older, wrong document) live."""
    index = InMemorySearchIndex()
    pipeline = IngestionPipeline(embedder=LocalFakeEmbedder(), index=index)

    b_path = tmp_path / "b.md"
    b_path.write_text("## Section\n\nB content.\n", encoding="utf-8")
    b_meta = _doc_meta(document_id="doc-b", filename="b.md", title="Document B", version="2.0")
    b_result = pipeline.ingest_document(b_meta, b_path)
    assert b_result.chunks_tombstoned == 0
    assert len(index.get_chunks_for_document("doc-b")) > 0

    a_path = tmp_path / "a.md"
    a_path.write_text("## Section\n\nA content.\n", encoding="utf-8")
    a_meta = _doc_meta(document_id="doc-a", filename="a.md", title="Document A", version="1.0", supersedes="doc-b")

    with pytest.raises(InvalidSupersessionError):
        pipeline.ingest_document(a_meta, a_path)

    # B must remain live and un-tombstoned; A must not have been indexed
    # with a misleading previous_version_hash from B either.
    b_records = [r for r in index.all_records() if r.chunk.document_id == "doc-b"]
    assert b_records
    assert all(not r.is_tombstoned for r in b_records)
    assert index.get_chunks_for_document("doc-a") == []


def test_ingesting_a_correctly_ordered_supersession_still_works(tmp_path: Path) -> None:
    index = InMemorySearchIndex()
    pipeline = IngestionPipeline(embedder=LocalFakeEmbedder(), index=index)

    a_path = tmp_path / "a.md"
    a_path.write_text("## Section\n\nA content.\n", encoding="utf-8")
    a_meta = _doc_meta(document_id="doc-a", filename="a.md", title="Document A", version="1.0")
    pipeline.ingest_document(a_meta, a_path)

    b_path = tmp_path / "b.md"
    b_path.write_text("## Section\n\nB content.\n", encoding="utf-8")
    b_meta = _doc_meta(document_id="doc-b", filename="b.md", title="Document B", version="2.0", supersedes="doc-a")
    b_result = pipeline.ingest_document(b_meta, b_path)

    assert b_result.chunks_tombstoned > 0
    a_records = [r for r in index.all_records() if r.chunk.document_id == "doc-a"]
    assert a_records and all(r.is_tombstoned for r in a_records)


def test_ingesting_a_direct_cycle_through_the_pipeline_is_rejected(tmp_path: Path) -> None:
    """B legitimately supersedes A (newer version, accepted). A document
    with the SAME id as A is then re-ingested claiming to supersede B --
    a direct two-document cycle -- and must be rejected even though its
    version (3.0) would otherwise look newer than B's (2.0)."""
    index = InMemorySearchIndex()
    pipeline = IngestionPipeline(embedder=LocalFakeEmbedder(), index=index)

    a_path = tmp_path / "a.md"
    a_path.write_text("## Section\n\nA content.\n", encoding="utf-8")
    pipeline.ingest_document(
        _doc_meta(document_id="doc-a", filename="a.md", title="Document A", version="1.0"), a_path
    )

    b_path = tmp_path / "b.md"
    b_path.write_text("## Section\n\nB content.\n", encoding="utf-8")
    pipeline.ingest_document(
        _doc_meta(
            document_id="doc-b", filename="b.md", title="Document B", version="2.0", supersedes="doc-a"
        ),
        b_path,
    )

    a2_path = tmp_path / "a2.md"
    a2_path.write_text("## Section\n\nA again.\n", encoding="utf-8")
    a2_meta = _doc_meta(
        document_id="doc-a", filename="a2.md", title="Document A Redux", version="3.0", supersedes="doc-b"
    )

    with pytest.raises(InvalidSupersessionError):
        pipeline.ingest_document(a2_meta, a2_path)
