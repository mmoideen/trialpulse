"""Headings-aware chunking.

PRD requirement: chunking must never split across a heading. `heading_path`
is built as "Document Title > Section Heading", with nested `###`
subheadings supported as "A > B > C". A section shorter than
`CHUNK_TARGET_TOKENS` is exactly one chunk; longer sections are split on
sentence boundaries with `CHUNK_OVERLAP_TOKENS` of overlap.

Ambiguity resolved here (documented per the task instructions): the PRD does
not specify a tokenizer, and pulling in a real BPE tokenizer (tiktoken)
would require downloading its encoding files over the network the first
time it runs, which conflicts with "everything must pass with no network
access". We approximate one token as one whitespace-delimited word. This is
an internally-consistent proxy: it is used identically for both sizing
chunks against CHUNK_TARGET_TOKENS and for sizing the CHUNK_OVERLAP_TOKENS
overlap, so relative chunk boundaries behave the same as they would with a
real tokenizer, even though the absolute token count would differ from
Azure OpenAI's actual tokenizer. This keeps the pipeline fully offline.

`heading_path` here is returned WITHOUT the leading "Document Title > "
prefix (that is `section_path`, see `ChunkDraft`). The caller (pipeline.py)
prepends the document title, because chunking should not need to know
document metadata to do its job, and because version-supersession matching
needs the bare section path (see pipeline.py's docstring for why).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from trialpulse_ingest.constants import CHUNK_OVERLAP_TOKENS, CHUNK_TARGET_TOKENS

_HEADING_RE = re.compile(r"^(#{2,6})\s+(.+?)\s*$")
_PAGE_MARKER_RE = re.compile(r"^<!--\s*page:\s*(\d+)\s*-->\s*$")
# Sentence boundary: end punctuation followed by whitespace and another
# character. Deliberately simple (no abbreviation handling) -- clinical
# prose in this corpus does not rely on abbreviation-aware sentence
# splitting, and a simple regex keeps chunk boundaries predictable and
# testable.
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+(?=\S)")

DEFAULT_PAGE_NUMBER = 1


@dataclass(frozen=True, slots=True)
class ChunkDraft:
    """A chunk before document metadata, content_hash, and embedding are attached."""

    section_path: str
    """Heading hierarchy only, e.g. '1. Study Design' or 'A > B > C'. Empty
    string for content that appears before the first heading in the
    document (the synthetic-data banner, in our corpus)."""

    page_number: int
    content: str
    ordinal: int
    """0-based position of this chunk within the whole document, used to
    keep chunk_id deterministic when a section is split into multiple
    chunks."""


def _approx_token_count(text: str) -> int:
    """Whitespace-word approximation of token count. See module docstring."""
    return len(text.split())


def _split_sentences(text: str) -> list[str]:
    return [s for s in _SENTENCE_SPLIT_RE.split(text.strip()) if s]


def _pack_sentences_with_overlap(
    sentences: list[str],
    *,
    target_tokens: int,
    overlap_tokens: int,
) -> list[str]:
    """Greedily pack whole sentences into token-bounded chunks with overlap.

    Overlap is achieved by carrying trailing sentences from the end of one
    chunk into the start of the next, up to `overlap_tokens` worth of
    words, so no chunk boundary splits a sentence and adjacent chunks share
    real context rather than a truncated fragment.
    """
    if not sentences:
        return []

    chunks: list[list[str]] = []
    current: list[str] = []
    current_tokens = 0

    for sentence in sentences:
        sentence_tokens = _approx_token_count(sentence)
        if current and current_tokens + sentence_tokens > target_tokens:
            chunks.append(current)
            # Seed the next chunk with trailing sentences from this one so
            # the two chunks overlap by roughly overlap_tokens.
            carry: list[str] = []
            carry_tokens = 0
            for s in reversed(current):
                s_tokens = _approx_token_count(s)
                if carry_tokens >= overlap_tokens:
                    break
                carry.insert(0, s)
                carry_tokens += s_tokens
            current = list(carry)
            current_tokens = carry_tokens
        current.append(sentence)
        current_tokens += sentence_tokens

    if current:
        chunks.append(current)

    return [" ".join(c) for c in chunks]


def _split_section(content: str) -> list[str]:
    """Split one section's body into one or more chunk texts.

    A section under CHUNK_TARGET_TOKENS is returned as a single chunk
    unchanged (per the PRD: "a section shorter than the target is exactly
    one chunk").
    """
    if _approx_token_count(content) <= CHUNK_TARGET_TOKENS:
        return [content] if content.strip() else []

    sentences = _split_sentences(content)
    return _pack_sentences_with_overlap(
        sentences,
        target_tokens=CHUNK_TARGET_TOKENS,
        overlap_tokens=CHUNK_OVERLAP_TOKENS,
    )


def _line_start_offsets(raw_body: str) -> list[int]:
    """Starting character offset of each line in `raw_body`, aligned with
    `raw_body.split("\\n")` (one "\\n" separator between consecutive
    lines, none trailing)."""
    offsets: list[int] = []
    pos = 0
    for line in raw_body.split("\n"):
        offsets.append(pos)
        pos += len(line) + 1
    return offsets


def _page_at_raw_offset(raw_offset: int, line_start_offsets: list[int], line_pages: list[int]) -> int:
    page = line_pages[0] if line_pages else DEFAULT_PAGE_NUMBER
    for start, line_page in zip(line_start_offsets, line_pages, strict=True):
        if start > raw_offset:
            break
        page = line_page
    return page


def _pages_for_chunks(raw_body: str, body: str, line_pages: list[int], chunk_texts: list[str]) -> list[int]:
    """The page number for each chunk text `_split_section` produced,
    using the page of the first source line/sentence that contributed to
    it (F6).

    Necessary because a section can contain more than one `<!-- page: N
    -->` marker: `_split_section`'s sentence-based repacking discards line
    boundaries entirely, so without this, every chunk from a split section
    was stamped with the section's *first* page, even a chunk built
    entirely from a later page's sentences.
    """
    if len(chunk_texts) <= 1:
        page = line_pages[0] if line_pages else DEFAULT_PAGE_NUMBER
        return [page] * len(chunk_texts)

    left_trim = len(raw_body) - len(raw_body.lstrip())
    line_start_offsets = _line_start_offsets(raw_body)

    sentences = _split_sentences(body)
    sentence_pages: list[int] = []
    sentence_tokens: list[int] = []
    cursor = 0
    for sentence in sentences:
        idx = body.find(sentence, cursor)
        if idx == -1:  # defensive: sentences are exact substrings of body by construction
            idx = cursor
        raw_offset = idx + left_trim
        sentence_pages.append(_page_at_raw_offset(raw_offset, line_start_offsets, line_pages))
        sentence_tokens.append(_approx_token_count(sentence))
        cursor = idx + len(sentence)

    return _pack_sentence_pages_with_overlap(
        sentence_pages, sentence_tokens, target_tokens=CHUNK_TARGET_TOKENS, overlap_tokens=CHUNK_OVERLAP_TOKENS
    )


def _pack_sentence_pages_with_overlap(
    pages: list[int],
    sentence_tokens: list[int],
    *,
    target_tokens: int,
    overlap_tokens: int,
) -> list[int]:
    """Mirrors `_pack_sentences_with_overlap`'s grouping decisions exactly
    (same target/overlap arithmetic over the same per-sentence token
    counts, so it produces the same number of chunks in the same
    boundaries) but tracks page numbers instead of text, returning the
    page of each resulting chunk's first sentence.
    """
    if not pages:
        return []

    chunk_pages: list[int] = []
    current_indices: list[int] = []
    current_tokens = 0

    for i, tokens in enumerate(sentence_tokens):
        if current_indices and current_tokens + tokens > target_tokens:
            chunk_pages.append(pages[current_indices[0]])
            carry: list[int] = []
            carry_tokens = 0
            for j in reversed(current_indices):
                j_tokens = sentence_tokens[j]
                if carry_tokens >= overlap_tokens:
                    break
                carry.insert(0, j)
                carry_tokens += j_tokens
            current_indices = carry
            current_tokens = carry_tokens
        current_indices.append(i)
        current_tokens += tokens

    if current_indices:
        chunk_pages.append(pages[current_indices[0]])

    return chunk_pages


def chunk_markdown(text: str) -> list[ChunkDraft]:
    """Chunk normalized-markdown-with-page-markers text into ChunkDrafts.

    `text` is expected to already have any YAML front matter stripped (see
    `extraction.py`). Recognises `##`..`######` headings and
    `<!-- page: N -->` page markers. Content before the first heading (if
    any) becomes a section with an empty `section_path`.
    """
    heading_stack: list[tuple[int, str]] = []
    current_page = DEFAULT_PAGE_NUMBER
    section_lines: list[str] = []
    section_line_pages: list[int] = []
    ordinal = 0
    drafts: list[ChunkDraft] = []

    def flush_section() -> None:
        nonlocal ordinal, section_lines, section_line_pages
        raw_body = "\n".join(section_lines)
        line_pages = section_line_pages
        section_lines = []
        section_line_pages = []
        body = raw_body.strip()
        if not body:
            return
        section_path = " > ".join(h for _, h in heading_stack)
        chunk_texts = _split_section(body)
        pages = _pages_for_chunks(raw_body, body, line_pages, chunk_texts)
        for chunk_text, page in zip(chunk_texts, pages, strict=True):
            drafts.append(
                ChunkDraft(
                    section_path=section_path,
                    page_number=page,
                    content=chunk_text.strip(),
                    ordinal=ordinal,
                )
            )
            ordinal += 1

    for raw_line in text.split("\n"):
        heading_match = _HEADING_RE.match(raw_line)
        page_match = _PAGE_MARKER_RE.match(raw_line.strip())

        if heading_match:
            # A new heading always starts a new section -- never split
            # across it in either direction.
            flush_section()
            level = len(heading_match.group(1))
            heading_text = heading_match.group(2)
            while heading_stack and heading_stack[-1][0] >= level:
                heading_stack.pop()
            heading_stack.append((level, heading_text))
            continue

        if page_match:
            current_page = int(page_match.group(1))
            continue

        section_lines.append(raw_line)
        # Tag every content line with the page active when it was read
        # (F6): a page marker mid-section changes `current_page` for every
        # subsequent line, not just the section's first one, so page
        # attribution has to be tracked per line rather than once per
        # section. See `_pages_for_chunks`.
        section_line_pages.append(current_page)

    flush_section()
    return drafts
