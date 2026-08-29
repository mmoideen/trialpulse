"""Dataclasses mirroring `packages/shared/src/types.ts`.

`Chunk` here must match the TypeScript `Chunk` interface field for field: it
is the contract the orchestrator (TypeScript), the Teams tab, and the eval
harness all rely on. Do not add fields to `Chunk` itself for
ingestion-internal bookkeeping (e.g. tombstone state) -- those live in
`indexing.py` alongside the chunk, not on the shared shape. See
`ingestion/README.md` for the rationale.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Final, Literal, get_args

# Mirrors DOCUMENT_CLASSIFICATIONS in packages/shared/src/types.ts.
DocumentClassification = Literal[
    "protocol",
    "investigator_brochure",
    "regulatory_submission",
    "safety_report",
    "site_communication",
    "competitive_intelligence",
]

DOCUMENT_CLASSIFICATIONS: Final[tuple[str, ...]] = get_args(DocumentClassification)


@dataclass(frozen=True, slots=True)
class Chunk:
    """A single retrievable unit of a document, as stored in Azure AI Search.

    Field-for-field mirror of the `Chunk` interface in
    packages/shared/src/types.ts. `embedding` is Optional because chunks are
    constructed before embedding happens; the pipeline always attaches an
    embedding before indexing.
    """

    chunk_id: str
    document_id: str
    document_title: str
    document_classification: DocumentClassification
    document_version: str
    content: str
    content_hash: str
    heading_path: str
    page_number: int
    source_url: str
    ingested_at: str
    site_code: str | None
    previous_version_hash: str | None
    embedding: list[float] | None = field(default=None)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# The set of field names (and, loosely, expected python types) that define
# the shared Chunk shape, used by tests to validate chunks produced by the
# pipeline without importing the TypeScript compiler.
_CHUNK_STRING_FIELDS: Final[tuple[str, ...]] = (
    "chunk_id",
    "document_id",
    "document_title",
    "document_classification",
    "document_version",
    "content",
    "content_hash",
    "heading_path",
    "source_url",
    "ingested_at",
)
_CHUNK_NULLABLE_STRING_FIELDS: Final[tuple[str, ...]] = ("site_code", "previous_version_hash")


def validate_chunk_shape(chunk: Chunk) -> list[str]:
    """Validate a Chunk against the shared contract.

    Returns a list of human-readable violations (empty list means valid).
    Kept as a pure function returning violations, rather than raising,
    so the end-to-end test can assert zero violations across all 20
    documents in one pass and report every failure at once rather than
    stopping at the first bad chunk.
    """
    violations: list[str] = []

    for field_name in _CHUNK_STRING_FIELDS:
        value = getattr(chunk, field_name)
        if not isinstance(value, str) or value == "":
            violations.append(f"{field_name} must be a non-empty string, got {value!r}")

    for field_name in _CHUNK_NULLABLE_STRING_FIELDS:
        value = getattr(chunk, field_name)
        if value is not None and not isinstance(value, str):
            violations.append(f"{field_name} must be str or None, got {value!r}")

    if chunk.document_classification not in DOCUMENT_CLASSIFICATIONS:
        violations.append(
            f"document_classification {chunk.document_classification!r} not in {DOCUMENT_CLASSIFICATIONS}"
        )

    if not isinstance(chunk.page_number, int) or isinstance(chunk.page_number, bool) or chunk.page_number < 1:
        violations.append(f"page_number must be a positive int, got {chunk.page_number!r}")

    if chunk.embedding is not None and (
        not isinstance(chunk.embedding, list) or not all(isinstance(x, float) for x in chunk.embedding)
    ):
        violations.append("embedding must be a list[float] or None")

    return violations


@dataclass(frozen=True, slots=True)
class DocumentMetadata:
    """Ingestion-time metadata for one source document.

    Populated from `corpus-manifest.json` for the synthetic corpus, or from
    SharePoint drive item + list item metadata in production.
    """

    document_id: str
    filename: str
    title: str
    classification: DocumentClassification
    version: str
    effective_date: str
    site_code: str | None
    supersedes: str | None
    source_url: str
