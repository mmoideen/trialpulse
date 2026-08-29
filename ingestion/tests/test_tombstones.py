"""Pure helpers in tombstones.py: purge-date math and section_path recovery."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from trialpulse_ingest.constants import TOMBSTONE_RETENTION_DAYS
from trialpulse_ingest.models import Chunk
from trialpulse_ingest.tombstones import build_previous_version_hash_map, compute_purge_after, section_path_of


def _chunk(document_title: str, heading_path: str, content_hash: str = "h") -> Chunk:
    return Chunk(
        chunk_id="id",
        document_id="doc-1",
        document_title=document_title,
        document_classification="protocol",
        document_version="1.0",
        content="content",
        content_hash=content_hash,
        heading_path=heading_path,
        page_number=1,
        source_url="https://example.com",
        ingested_at=datetime.now(UTC).isoformat(),
        site_code=None,
        previous_version_hash=None,
    )


def test_compute_purge_after_adds_retention_days() -> None:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    assert compute_purge_after(now) == now + timedelta(days=TOMBSTONE_RETENTION_DAYS)
    assert compute_purge_after(now, retention_days=10) == now + timedelta(days=10)


def test_section_path_of_strips_document_title_prefix() -> None:
    chunk = _chunk("My Doc Title", "My Doc Title > 1. Study Design")
    assert section_path_of(chunk) == "1. Study Design"


def test_section_path_of_handles_nested_headings() -> None:
    chunk = _chunk("My Doc Title", "My Doc Title > A > B > C")
    assert section_path_of(chunk) == "A > B > C"


def test_section_path_of_handles_title_only_preamble_chunk() -> None:
    chunk = _chunk("My Doc Title", "My Doc Title")
    assert section_path_of(chunk) == ""


def test_build_previous_version_hash_map() -> None:
    chunks = [
        _chunk("Doc v3.0", "Doc v3.0 > 1. Study Design", content_hash="hash-1"),
        _chunk("Doc v3.0", "Doc v3.0 > 2. Endpoint", content_hash="hash-2"),
    ]
    mapping = build_previous_version_hash_map(chunks)
    assert mapping == {"1. Study Design": "hash-1", "2. Endpoint": "hash-2"}
