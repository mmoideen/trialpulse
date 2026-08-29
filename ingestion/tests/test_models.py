"""`Chunk` shape validation against the shared TypeScript contract."""

from __future__ import annotations

from trialpulse_ingest.models import Chunk, validate_chunk_shape


def _valid_chunk(**overrides: object) -> Chunk:
    defaults: dict[str, object] = {
        "chunk_id": "abc123",
        "document_id": "sp-prot-0001",
        "document_title": "AXIOM-HN01 Protocol v3.0",
        "document_classification": "protocol",
        "document_version": "3.0",
        "content": "Some chunk content.",
        "content_hash": "deadbeef",
        "heading_path": "AXIOM-HN01 Protocol v3.0 > 1. Study Design",
        "page_number": 1,
        "source_url": "https://example.com/doc.md",
        "ingested_at": "2026-08-28T00:00:00+00:00",
        "site_code": None,
        "previous_version_hash": None,
        "embedding": [0.1, 0.2, 0.3],
    }
    defaults.update(overrides)
    return Chunk(**defaults)  # type: ignore[arg-type]


def test_valid_chunk_has_no_violations() -> None:
    assert validate_chunk_shape(_valid_chunk()) == []


def test_nullable_fields_accept_none() -> None:
    chunk = _valid_chunk(site_code=None, previous_version_hash=None, embedding=None)
    assert validate_chunk_shape(chunk) == []


def test_nullable_fields_accept_values() -> None:
    chunk = _valid_chunk(site_code="US-014", previous_version_hash="abc")
    assert validate_chunk_shape(chunk) == []


def test_empty_required_string_is_a_violation() -> None:
    violations = validate_chunk_shape(_valid_chunk(document_title=""))
    assert any("document_title" in v for v in violations)


def test_invalid_classification_is_a_violation() -> None:
    violations = validate_chunk_shape(_valid_chunk(document_classification="not_a_real_classification"))
    assert any("document_classification" in v for v in violations)


def test_non_positive_page_number_is_a_violation() -> None:
    violations = validate_chunk_shape(_valid_chunk(page_number=0))
    assert any("page_number" in v for v in violations)


def test_chunk_is_immutable() -> None:
    chunk = _valid_chunk()
    try:
        chunk.content = "mutated"  # type: ignore[misc]
    except (AttributeError, TypeError):
        pass
    else:
        raise AssertionError("Chunk should be a frozen dataclass")
