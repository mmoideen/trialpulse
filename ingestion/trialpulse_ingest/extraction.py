"""Text extraction: turns a source document's raw bytes into markdown-like
text that `chunking.py` can chunk.

Every extractor implements the `TextExtractor` protocol and produces the
same intermediate shape: plain text using `##`..`######` markdown headings
and `<!-- page: N -->` page markers, with any format-specific front matter
(YAML front matter for `.md`) stripped. This lets `chunking.py` stay
completely format-agnostic.

`.md` is fully implemented and is the only extractor exercised by the
offline test suite and the local synthetic corpus. `.docx` (python-docx)
and `.pdf` (pypdf) are implemented for real, but their third-party imports
are lazy (deferred until `.extract()` is actually called) so importing this
module -- and running the rest of the test suite -- never requires those
packages to be installed or any network access.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Protocol

_FRONT_MATTER_RE = re.compile(r"\A---\s*\n.*?\n---\s*\n", re.DOTALL)


class UnsupportedDocumentTypeError(ValueError):
    """Raised when no extractor is registered for a file's extension."""


class ExtractionError(RuntimeError):
    """Raised when an extractor fails to read/parse a document it does support."""


class TextExtractor(Protocol):
    """Common interface for all document text extractors."""

    def extract(self, path: Path) -> str:
        """Return markdown-like text (headings + `<!-- page: N -->` markers)."""
        ...


class MarkdownExtractor:
    """Extractor for the local synthetic corpus (`data/synthetic/*.md`).

    Strips the YAML front matter block and returns everything after it
    verbatim, including the synthetic-data banner and every `##` section
    with its `<!-- page: N -->` marker, which `chunking.py` parses.
    """

    def extract(self, path: Path) -> str:
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise ExtractionError(f"Could not read markdown file {path}: {exc}") from exc
        return _FRONT_MATTER_RE.sub("", raw, count=1)


class DocxExtractor:
    """Extractor for Word documents via `python-docx`.

    Heading paragraphs (Word style "Heading 1".."Heading 6") become `##`..
    `#######` markdown headings. Word does not expose reliable page
    boundaries through the object model (pagination is a rendering-time
    concern), so we approximate page numbers by counting explicit page
    breaks (`<w:br w:type="page"/>` runs) encountered in document order,
    starting at page 1. Documents with no explicit page breaks are treated
    as a single page, which matches how most Word exports of short clinical
    letters behave in practice.
    """

    def extract(self, path: Path) -> str:
        try:
            import docx  # noqa: PLC0415 -- deliberately lazy, see module docstring
        except ImportError as exc:
            raise ExtractionError(
                "python-docx is not installed. Install it (see requirements.txt) to extract .docx files."
            ) from exc

        try:
            document = docx.Document(str(path))
        except Exception as exc:  # python-docx raises assorted exceptions for malformed files
            raise ExtractionError(f"Could not open docx file {path}: {exc}") from exc

        lines: list[str] = []
        page = 1
        lines.append(f"<!-- page: {page} -->")
        for paragraph in document.paragraphs:
            style_name = (paragraph.style.name if paragraph.style else "") or ""
            heading_match = re.match(r"^Heading (\d)$", style_name)
            text = paragraph.text.strip()

            has_page_break = any(
                run._element.findall(  # noqa: SLF001 -- python-docx exposes no public page-break API
                    ".//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}br"
                    "[@{http://schemas.openxmlformats.org/wordprocessingml/2006/main}type='page']"
                )
                for run in paragraph.runs
            )

            if heading_match:
                level = min(6, int(heading_match.group(1)) + 1)
                lines.append(f"{'#' * level} {text}")
            elif text:
                lines.append(text)

            if has_page_break:
                page += 1
                lines.append(f"<!-- page: {page} -->")

        return "\n".join(lines)


class PdfExtractor:
    """Extractor for PDFs via `pypdf`.

    PDFs carry no semantic heading markup, so headings are detected with a
    heuristic: a short line (<= 80 chars), not ending in sentence-terminal
    punctuation, is treated as a `##` heading. This is intentionally
    conservative -- false negatives (missing a real heading) just fold that
    text into the previous section rather than corrupting heading_path, and
    every page still gets an accurate `<!-- page: N -->` marker since pypdf
    gives us real page boundaries (unlike .docx).
    """

    _HEADING_HEURISTIC_RE = re.compile(r"^[A-Z0-9][^.!?]{0,79}$")

    def extract(self, path: Path) -> str:
        try:
            from pypdf import PdfReader  # noqa: PLC0415 -- deliberately lazy, see module docstring
        except ImportError as exc:
            raise ExtractionError(
                "pypdf is not installed. Install it (see requirements.txt) to extract .pdf files."
            ) from exc

        try:
            reader = PdfReader(str(path))
        except Exception as exc:  # pypdf raises assorted exceptions for malformed/encrypted PDFs
            raise ExtractionError(f"Could not open PDF file {path}: {exc}") from exc

        lines: list[str] = []
        for page_number, page in enumerate(reader.pages, start=1):
            lines.append(f"<!-- page: {page_number} -->")
            page_text = page.extract_text() or ""
            for raw_line in page_text.split("\n"):
                line = raw_line.strip()
                if not line:
                    continue
                if self._HEADING_HEURISTIC_RE.match(line):
                    lines.append(f"## {line}")
                else:
                    lines.append(line)
        return "\n".join(lines)


EXTRACTOR_REGISTRY: dict[str, TextExtractor] = {
    ".md": MarkdownExtractor(),
    ".docx": DocxExtractor(),
    ".pdf": PdfExtractor(),
}


def get_extractor(path: Path) -> TextExtractor:
    """Look up the extractor registered for `path`'s extension.

    Raises `UnsupportedDocumentTypeError` for any extension not in
    `EXTRACTOR_REGISTRY` (e.g. `.txt`, `.pptx`) with a clear message.
    """
    suffix = path.suffix.lower()
    try:
        return EXTRACTOR_REGISTRY[suffix]
    except KeyError as exc:
        supported = ", ".join(sorted(EXTRACTOR_REGISTRY))
        raise UnsupportedDocumentTypeError(
            f"Unsupported document type {suffix!r} for {path.name}. Supported types: {supported}."
        ) from exc


def extract_text(path: Path) -> str:
    """Convenience wrapper: look up and run the right extractor for `path`."""
    return get_extractor(path).extract(path)
