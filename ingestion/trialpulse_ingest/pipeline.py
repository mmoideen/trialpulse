"""Ingestion orchestration: download -> extract -> chunk -> hash -> embed -> index.

This is the single place that wires together every other module in this
package into the pipeline described in PRD workflow 3.3.1. `function_app.py`
calls `IngestionPipeline.ingest_document` from its queue trigger; tests call
it directly against `InMemorySearchIndex` and `LocalFakeEmbedder`.

Design note on `heading_path` vs version matching: `heading_path` is stored
on `Chunk` as "<document_title> > <section path>" per the PRD. Because a new
document version necessarily has a different title (e.g. "...v3.0" vs
"...v4.0"), matching chunks across versions to stamp `previous_version_hash`
must compare on the *section path* alone, not the full heading_path -- see
`tombstones.section_path_of`.
"""

from __future__ import annotations

import json
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from trialpulse_ingest.chunking import chunk_markdown
from trialpulse_ingest.document_status import DocumentStatus, DocumentStatusStore, InMemoryDocumentStatusStore
from trialpulse_ingest.embedding import Embedder
from trialpulse_ingest.extraction import extract_text
from trialpulse_ingest.hashing import content_hash, make_chunk_id
from trialpulse_ingest.indexing import SearchIndex
from trialpulse_ingest.models import Chunk, DocumentMetadata
from trialpulse_ingest.telemetry import get_logger, log_event, traced_span
from trialpulse_ingest.tombstones import (
    build_previous_version_hash_map,
    compute_purge_after,
    validate_supersession,
)

_logger = get_logger(__name__)

#: SharePoint document library names per PRD section 2.2's architecture
#: diagram, used to build a realistic `source_url` for the synthetic corpus.
CLASSIFICATION_LIBRARY_NAMES: dict[str, str] = {
    "protocol": "Protocols",
    "investigator_brochure": "Investigator Brochures",
    "regulatory_submission": "Regulatory Submissions",
    "safety_report": "Safety Reports",
    "site_communication": "Site Communications",
    "competitive_intelligence": "Competitive Intelligence",
}

_SHAREPOINT_SITE_BASE = "https://meridiantx.sharepoint.com/sites/TrialPulse"


def build_source_url(classification: str, filename: str) -> str:
    """A plausible SharePoint document URL for a given classification/filename.

    Real production ingestion receives the true `webUrl` from Microsoft
    Graph; this is only used for the local synthetic corpus, which has no
    real SharePoint site behind it.
    """
    library = CLASSIFICATION_LIBRARY_NAMES.get(classification, "Documents")
    return f"{_SHAREPOINT_SITE_BASE}/{urllib.parse.quote(library)}/{urllib.parse.quote(filename)}"


@dataclass(frozen=True, slots=True)
class IngestResult:
    document_id: str
    chunks_upserted: int
    chunks_skipped: int
    chunks_tombstoned: int
    chunk_ids: list[str] = field(default_factory=list)


class IngestionPipeline:
    """Wires extraction, chunking, hashing, embedding, and indexing together."""

    def __init__(
        self,
        *,
        embedder: Embedder,
        index: SearchIndex,
        document_status_store: DocumentStatusStore | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._embedder = embedder
        self._index = index
        # F4: injectable, defaulting to an in-memory fake -- exactly the
        # pattern `SearchIndex`/`InMemorySearchIndex` already use -- so
        # every existing call site (`IngestionPipeline(embedder=...,
        # index=...)`) keeps working unchanged, and the whole pipeline
        # stays offline-testable without a real Cosmos DB resource.
        self._document_status_store = document_status_store or InMemoryDocumentStatusStore()
        self._clock = clock
        # F9: documents this pipeline instance has itself ingested with a
        # `supersedes` pointer, so a direct two-document cycle (B declares
        # supersedes=A, then A is ingested declaring supersedes=B) can be
        # caught even though neither the shared `Chunk` type nor
        # `DocumentStatus` records a document's own `supersedes` value.
        # Scoped to this pipeline instance / process lifetime (resets on a
        # Function App cold start) -- see `tombstones.validate_supersession`.
        self._declared_supersedes: dict[str, str] = {}

    def ingest_document(self, doc_meta: DocumentMetadata, path: Path) -> IngestResult:
        """Ingest one document end to end. Idempotent: re-running this with
        an unchanged file upserts 0 chunks and skips every chunk that
        already exists with the same content_hash.

        Writes a `DocumentStatus` record to the injected
        `document_status_store` after processing -- `status="indexed"` on
        success, `status="failed"` with `error_message` set (preserving
        the last known `chunk_count`/`last_ingested_at`) on any exception,
        which is then re-raised so retry/dead-letter handling upstream is
        unaffected (F4).
        """
        try:
            result = self._ingest_document_inner(doc_meta, path)
        except BaseException as exc:
            self._record_failure(doc_meta, exc)
            raise
        else:
            self._record_success(doc_meta, result)
            return result

    def _ingest_document_inner(self, doc_meta: DocumentMetadata, path: Path) -> IngestResult:
        with traced_span(
            "ingest_document",
            document_id=doc_meta.document_id,
            document_classification=doc_meta.classification,
        ):
            now = self._clock()
            ingested_at = now.isoformat()

            text = extract_text(path)
            drafts = chunk_markdown(text)

            previous_hash_map: dict[str, str] = {}
            if doc_meta.supersedes:
                previous_chunks = self._index.get_chunks_for_document(doc_meta.supersedes)
                # F9: validate the supersession direction/cycle BEFORE
                # doing anything else -- stamping previous_version_hash
                # from a document that isn't actually superseded, or
                # tombstoning a newer document from an older one, must
                # never happen even partially.
                validate_supersession(
                    document_id=doc_meta.document_id,
                    version=doc_meta.version,
                    supersedes_id=doc_meta.supersedes,
                    supersedes_version=previous_chunks[0].document_version if previous_chunks else None,
                    supersedes_declared_supersedes=self._declared_supersedes.get(doc_meta.supersedes),
                )
                previous_hash_map = build_previous_version_hash_map(previous_chunks)

            contents = [draft.content for draft in drafts]
            embeddings = self._embedder.embed_batch(contents) if contents else []

            chunks: list[Chunk] = []
            for draft, embedding in zip(drafts, embeddings, strict=True):
                chunk_content_hash = content_hash(draft.content)
                heading_path = (
                    f"{doc_meta.title} > {draft.section_path}" if draft.section_path else doc_meta.title
                )
                chunk_id = make_chunk_id(doc_meta.document_id, heading_path, draft.ordinal, chunk_content_hash)
                chunks.append(
                    Chunk(
                        chunk_id=chunk_id,
                        document_id=doc_meta.document_id,
                        document_title=doc_meta.title,
                        document_classification=doc_meta.classification,
                        document_version=doc_meta.version,
                        content=draft.content,
                        content_hash=chunk_content_hash,
                        heading_path=heading_path,
                        page_number=draft.page_number,
                        source_url=doc_meta.source_url,
                        ingested_at=ingested_at,
                        site_code=doc_meta.site_code,
                        previous_version_hash=previous_hash_map.get(draft.section_path),
                        embedding=embedding,
                    )
                )

            index_result = self._index.upsert_chunks(chunks)

            chunks_tombstoned = 0
            if doc_meta.supersedes:
                purge_after = compute_purge_after(now)
                chunks_tombstoned = self._index.tombstone_document(
                    doc_meta.supersedes, tombstoned_at=now, purge_after=purge_after
                )
                self._declared_supersedes[doc_meta.document_id] = doc_meta.supersedes

            log_event(
                _logger,
                "document_ingested",
                document_id=doc_meta.document_id,
                chunks_upserted=index_result.upserted,
                chunks_skipped=index_result.skipped,
                chunks_tombstoned=chunks_tombstoned,
            )

            return IngestResult(
                document_id=doc_meta.document_id,
                chunks_upserted=index_result.upserted,
                chunks_skipped=index_result.skipped,
                chunks_tombstoned=chunks_tombstoned,
                chunk_ids=[chunk.chunk_id for chunk in chunks],
            )

    def _record_success(self, doc_meta: DocumentMetadata, result: IngestResult) -> None:
        self._document_status_store.upsert(
            DocumentStatus(
                document_id=doc_meta.document_id,
                document_title=doc_meta.title,
                document_classification=doc_meta.classification,
                document_version=doc_meta.version,
                status="indexed",
                chunk_count=len(result.chunk_ids),
                last_ingested_at=self._clock().isoformat(),
                error_message=None,
                source_url=doc_meta.source_url,
            )
        )

    def _record_failure(self, doc_meta: DocumentMetadata, exc: BaseException) -> None:
        # Preserve the last known-good chunk_count/last_ingested_at rather
        # than blanking them out: a transient failure on a re-ingestion
        # attempt of an already-indexed document should surface as
        # "failed, here's the error" on top of its last successful state,
        # not erase the fact that a prior version successfully indexed.
        existing = self._document_status_store.get(doc_meta.document_id)
        self._document_status_store.upsert(
            DocumentStatus(
                document_id=doc_meta.document_id,
                document_title=doc_meta.title,
                document_classification=doc_meta.classification,
                document_version=doc_meta.version,
                status="failed",
                chunk_count=existing.chunk_count if existing else 0,
                last_ingested_at=existing.last_ingested_at if existing else None,
                error_message=str(exc),
                source_url=doc_meta.source_url,
            )
        )


def load_manifest(manifest_path: Path) -> list[DocumentMetadata]:
    """Load `corpus-manifest.json` into `DocumentMetadata` records.

    This is the *only* place ingestion reads the manifest's structure
    directly; production ingestion instead builds `DocumentMetadata` from
    SharePoint drive item + list item metadata (see `sharepoint.py`).
    """
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    documents: list[DocumentMetadata] = []
    for doc in data["documents"]:
        documents.append(
            DocumentMetadata(
                document_id=doc["document_id"],
                filename=doc["filename"],
                title=doc["title"],
                classification=doc["classification"],
                version=doc["version"],
                effective_date=doc["effective_date"],
                site_code=doc.get("site_code"),
                supersedes=doc.get("supersedes"),
                source_url=build_source_url(doc["classification"], doc["filename"]),
            )
        )
    return documents


def order_by_supersession(documents: list[DocumentMetadata]) -> list[DocumentMetadata]:
    """Topologically sort documents so a document is always ingested after
    whatever it supersedes -- required for `previous_version_hash` matching,
    which reads the superseded document's chunks out of the index."""
    by_id = {doc.document_id: doc for doc in documents}
    ordered: list[DocumentMetadata] = []
    ordered_ids: set[str] = set()
    remaining = list(documents)

    while remaining:
        progressed = False
        for doc in list(remaining):
            supersedes_is_ready = (
                doc.supersedes is None or doc.supersedes in ordered_ids or doc.supersedes not in by_id
            )
            if supersedes_is_ready:
                ordered.append(doc)
                ordered_ids.add(doc.document_id)
                remaining.remove(doc)
                progressed = True
        if not progressed:
            cycle = ", ".join(doc.document_id for doc in remaining)
            raise ValueError(f"Cycle detected in 'supersedes' graph among: {cycle}")

    return ordered


def ingest_local_corpus(
    manifest_path: Path, corpus_dir: Path, pipeline: IngestionPipeline
) -> list[IngestResult]:
    """Ingest every document in the local synthetic corpus, in an order that
    respects version supersession. Used by the end-to-end test and
    available as a local dev entry point (see ingestion/README.md)."""
    documents = order_by_supersession(load_manifest(manifest_path))
    return [pipeline.ingest_document(doc_meta, corpus_dir / doc_meta.filename) for doc_meta in documents]
