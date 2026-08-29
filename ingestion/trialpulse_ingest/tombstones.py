"""Version supersession and tombstone lifecycle.

Pure, index-agnostic helpers used by `pipeline.py`. The actual mutation of
the index (marking chunks tombstoned, purging expired ones) lives in
`indexing.py`; this module computes the *what* and *when* -- which prior
chunks correspond to which new chunks, and when a tombstoned chunk becomes
eligible for permanent deletion.

PRD decision 2: "If a document is updated in SharePoint, the new version
generates new hashes; old hashes are tombstoned after 30 days." Tombstoned
chunks remain searchable until the purge date (workflow 3.3.1's safety net:
a user mid-read of a just-superseded document should not see it vanish).
"""

from __future__ import annotations

from datetime import datetime, timedelta

from trialpulse_ingest.constants import TOMBSTONE_RETENTION_DAYS
from trialpulse_ingest.models import Chunk


def compute_purge_after(tombstoned_at: datetime, retention_days: int = TOMBSTONE_RETENTION_DAYS) -> datetime:
    """The date a tombstoned document's chunks become eligible for purge."""
    return tombstoned_at + timedelta(days=retention_days)


def section_path_of(chunk: Chunk) -> str:
    """Recover the bare heading hierarchy from a stored chunk's heading_path.

    `pipeline.py` builds `heading_path` as "<document_title> > <section
    path>" (or just "<document_title>" for pre-heading content). To match
    chunks across versions -- whose documents necessarily have different
    titles (e.g. "...v3.0" vs "...v4.0") -- we need the section path alone.
    Exact-prefix removal (not fuzzy matching) is safe here because we know
    precisely which title string was concatenated: it is the chunk's own
    `document_title` field, recorded at ingestion time.
    """
    prefix = f"{chunk.document_title} > "
    if chunk.heading_path.startswith(prefix):
        return chunk.heading_path[len(prefix) :]
    if chunk.heading_path == chunk.document_title:
        return ""
    return chunk.heading_path


def build_previous_version_hash_map(previous_chunks: list[Chunk]) -> dict[str, str]:
    """Map section_path -> content_hash for a prior document version's chunks.

    Used to stamp `previous_version_hash` on the corresponding chunk(s) of
    the new version. If a section was split into multiple chunks in the
    prior version, later chunks (by ordinal, i.e. later in `previous_chunks`
    if the caller preserves ingestion order) win in the map -- callers only
    need "did a chunk with this heading exist before", not a full
    reconstruction of the old split boundaries.
    """
    return {section_path_of(chunk): chunk.content_hash for chunk in previous_chunks}


class InvalidSupersessionError(ValueError):
    """A document's `supersedes` pointer failed validation (F9).

    Without this check, `pipeline.IngestionPipeline.ingest_document`
    unconditionally tombstoned whatever `doc_meta.supersedes` named, with
    no check that the ingesting document was actually newer and no cycle
    detection. Ingesting an older document that erroneously (or
    maliciously) claims to supersede a newer, already-current one would
    silently tombstone the newer document and leave the older one live --
    "what is the current protocol version?" then answers wrongly, with no
    error anywhere in the logs.
    """


def parse_dotted_version(version: str) -> tuple[int, ...] | None:
    """Parse a dotted numeric version string ('3.0' -> (3, 0)) into a
    tuple usable for ordering comparisons, or None if it doesn't parse as
    purely dotted-numeric (PRD's version scheme, e.g. "3.0" -> "4.0").

    Returning None rather than raising lets `validate_supersession` treat
    an unparsable version as "not comparable" instead of a hard failure --
    version numbering is a convention this codebase follows, not a
    hard-enforced schema, and ingestion must not crash on a legitimately
    but unusually formatted version string.
    """
    parts = version.split(".")
    if not parts or not all(part.isdigit() for part in parts):
        return None
    return tuple(int(part) for part in parts)


def validate_supersession(
    *,
    document_id: str,
    version: str,
    supersedes_id: str,
    supersedes_version: str | None,
    supersedes_declared_supersedes: str | None,
) -> None:
    """Validate a `supersedes` pointer before it is allowed to tombstone
    the target document's chunks.

    Raises `InvalidSupersessionError` for:

    - A direct two-document cycle: `supersedes_declared_supersedes` (the
      target document's own, previously-declared `supersedes`) points back
      at `document_id` -- i.e. B claims to supersede A while A already
      claims to supersede B. Checked regardless of version ordering,
      because a cycle is nonsensical even if the versions would otherwise
      compare as "newer".
    - A version that is not strictly newer than the target's, when both
      versions parse as dotted-numeric (`parse_dotted_version`). Either
      version failing to parse, or the target having no indexed chunks yet
      (`supersedes_version is None` -- e.g. an out-of-order ingest before
      the target exists), skips this comparison rather than blocking
      ingestion: this check exists to catch a *provably backwards*
      supersession, not to enforce a version-string schema.
    """
    if supersedes_declared_supersedes == document_id:
        raise InvalidSupersessionError(
            f"{document_id!r} claims to supersede {supersedes_id!r}, but {supersedes_id!r} "
            f"already claims to supersede {document_id!r} -- a direct two-document cycle in "
            "the 'supersedes' graph. Refusing to tombstone either document."
        )

    if supersedes_version is None:
        return

    new_parsed = parse_dotted_version(version)
    old_parsed = parse_dotted_version(supersedes_version)
    if new_parsed is None or old_parsed is None:
        return

    if new_parsed <= old_parsed:
        raise InvalidSupersessionError(
            f"{document_id!r} (version {version!r}) cannot supersede {supersedes_id!r} "
            f"(version {supersedes_version!r}): the superseding document's version must be "
            "strictly newer. Refusing to tombstone the target."
        )
