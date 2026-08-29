"""Text extraction: markdown (fully exercised), the extractor registry, and
the unsupported-type error. Also exercises the real .docx and .pdf
extractors when their optional packages are installed, but never requires
them (imports are lazy in extraction.py)."""

from __future__ import annotations

from pathlib import Path

import pytest

from trialpulse_ingest.extraction import (
    EXTRACTOR_REGISTRY,
    DocxExtractor,
    ExtractionError,
    MarkdownExtractor,
    PdfExtractor,
    UnsupportedDocumentTypeError,
    extract_text,
    get_extractor,
)


def test_registry_has_md_docx_pdf() -> None:
    assert set(EXTRACTOR_REGISTRY) == {".md", ".docx", ".pdf"}
    assert isinstance(EXTRACTOR_REGISTRY[".md"], MarkdownExtractor)
    assert isinstance(EXTRACTOR_REGISTRY[".docx"], DocxExtractor)
    assert isinstance(EXTRACTOR_REGISTRY[".pdf"], PdfExtractor)


def test_unsupported_extension_raises_clear_error(tmp_path: Path) -> None:
    path = tmp_path / "notes.txt"
    path.write_text("hello", encoding="utf-8")
    with pytest.raises(UnsupportedDocumentTypeError, match=r"\.txt"):
        get_extractor(path)


def test_unsupported_extension_lists_supported_types(tmp_path: Path) -> None:
    path = tmp_path / "slides.pptx"
    path.write_text("hello", encoding="utf-8")
    with pytest.raises(UnsupportedDocumentTypeError) as excinfo:
        extract_text(path)
    assert ".md" in str(excinfo.value)
    assert ".docx" in str(excinfo.value)
    assert ".pdf" in str(excinfo.value)


def test_extension_matching_is_case_insensitive(tmp_path: Path) -> None:
    path = tmp_path / "DOC.MD"
    path.write_text("## Heading\n<!-- page: 1 -->\n\nBody.\n", encoding="utf-8")
    assert isinstance(get_extractor(path), MarkdownExtractor)


def test_markdown_extractor_strips_front_matter(tmp_path: Path) -> None:
    path = tmp_path / "doc.md"
    path.write_text(
        "---\n"
        'document_id: "abc"\n'
        'title: "Test Doc"\n'
        "---\n\n"
        "> Banner text.\n\n"
        "## 1. Heading\n"
        "<!-- page: 1 -->\n\n"
        "Body text.\n",
        encoding="utf-8",
    )
    extracted = extract_text(path)
    assert "document_id" not in extracted
    assert "---" not in extracted
    assert "> Banner text." in extracted
    assert "## 1. Heading" in extracted
    assert "<!-- page: 1 -->" in extracted
    assert "Body text." in extracted


def test_markdown_extractor_on_real_corpus_file(corpus_dir: Path) -> None:
    path = corpus_dir / "protocol-axiom-hn01-v3.0.md"
    extracted = extract_text(path)
    assert "SYNTHETIC DATA NOTICE" in extracted
    assert "## 1. Study Design" in extracted
    assert "AXIOM-HN01 is a randomized, double-blind, placebo-controlled Phase 3 study." in extracted
    # Front matter must be gone.
    assert "document_id:" not in extracted


def test_markdown_extractor_missing_file_raises_extraction_error(tmp_path: Path) -> None:
    path = tmp_path / "does-not-exist.md"
    with pytest.raises(ExtractionError):
        extract_text(path)


def test_docx_extractor_real_document(tmp_path: Path) -> None:
    docx = pytest.importorskip("docx")
    document = docx.Document()
    document.add_heading("Study Overview", level=1)
    document.add_paragraph("This is the overview body text.")
    document.add_heading("Dosing", level=2)
    document.add_paragraph("This is the dosing body text.")
    path = tmp_path / "protocol.docx"
    document.save(str(path))

    extracted = DocxExtractor().extract(path)
    assert "## Study Overview" in extracted
    assert "### Dosing" in extracted
    assert "This is the overview body text." in extracted
    assert "This is the dosing body text." in extracted
    assert "<!-- page: 1 -->" in extracted


def test_docx_extractor_missing_dependency_message(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import builtins

    real_import = builtins.__import__

    def fake_import(name: str, *args: object, **kwargs: object) -> object:
        if name == "docx":
            raise ImportError("No module named 'docx'")
        return real_import(name, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(builtins, "__import__", fake_import)
    path = tmp_path / "fake.docx"
    path.write_bytes(b"not a real docx")
    with pytest.raises(ExtractionError, match="python-docx is not installed"):
        DocxExtractor().extract(path)


def test_pdf_extractor_real_document(tmp_path: Path) -> None:
    pypdf = pytest.importorskip("pypdf")
    writer = pypdf.PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.add_blank_page(width=200, height=200)
    path = tmp_path / "doc.pdf"
    with path.open("wb") as handle:
        writer.write(handle)

    extracted = PdfExtractor().extract(path)
    # Blank pages produce no extractable text, but page markers must still
    # appear for both pages.
    assert extracted.count("<!-- page:") == 2
    assert "<!-- page: 1 -->" in extracted
    assert "<!-- page: 2 -->" in extracted


def test_pdf_extractor_missing_dependency_message(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import builtins

    real_import = builtins.__import__

    def fake_import(name: str, *args: object, **kwargs: object) -> object:
        if name == "pypdf":
            raise ImportError("No module named 'pypdf'")
        return real_import(name, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(builtins, "__import__", fake_import)
    path = tmp_path / "fake.pdf"
    path.write_bytes(b"not a real pdf")
    with pytest.raises(ExtractionError, match="pypdf is not installed"):
        PdfExtractor().extract(path)
