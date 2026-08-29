"""Headings-aware chunking: heading paths, page numbers, overlap, and
never splitting across a heading."""

from __future__ import annotations

from trialpulse_ingest.chunking import _approx_token_count, chunk_markdown
from trialpulse_ingest.constants import CHUNK_OVERLAP_TOKENS, CHUNK_TARGET_TOKENS


def test_single_heading_short_section_is_one_chunk() -> None:
    text = "## 1. Study Design\n<!-- page: 1 -->\n\nThis is a short section body.\n"
    drafts = chunk_markdown(text)
    assert len(drafts) == 1
    assert drafts[0].section_path == "1. Study Design"
    assert drafts[0].page_number == 1
    assert drafts[0].content == "This is a short section body."
    assert drafts[0].ordinal == 0


def test_multiple_headings_never_split_across_a_heading() -> None:
    text = (
        "## 1. Study Design\n<!-- page: 1 -->\n\nFirst section body.\n\n"
        "## 2. Primary Endpoint\n<!-- page: 3 -->\n\nSecond section body.\n\n"
        "## 3. Inclusion Criteria\n<!-- page: 5 -->\n\nThird section body.\n"
    )
    drafts = chunk_markdown(text)
    assert [d.section_path for d in drafts] == [
        "1. Study Design",
        "2. Primary Endpoint",
        "3. Inclusion Criteria",
    ]
    assert [d.page_number for d in drafts] == [1, 3, 5]
    assert [d.content for d in drafts] == [
        "First section body.",
        "Second section body.",
        "Third section body.",
    ]
    # ordinals are unique and increasing across the whole document
    assert [d.ordinal for d in drafts] == [0, 1, 2]


def test_nested_headings_build_a_to_b_to_c_path() -> None:
    text = (
        "## A\n<!-- page: 1 -->\n\nTop level body.\n\n"
        "### B\n<!-- page: 1 -->\n\nNested body.\n\n"
        "#### C\n<!-- page: 2 -->\n\nDeeply nested body.\n"
    )
    drafts = chunk_markdown(text)
    assert [d.section_path for d in drafts] == ["A", "A > B", "A > B > C"]
    assert drafts[2].page_number == 2


def test_sibling_heading_pops_previous_nested_level() -> None:
    text = (
        "## A\n<!-- page: 1 -->\n\nBody A.\n\n"
        "### B\n<!-- page: 1 -->\n\nBody B.\n\n"
        "## D\n<!-- page: 4 -->\n\nBody D, a sibling of A, not nested under B.\n"
    )
    drafts = chunk_markdown(text)
    assert [d.section_path for d in drafts] == ["A", "A > B", "D"]


def test_content_before_first_heading_becomes_empty_section_path() -> None:
    text = "Some preamble banner text before any heading.\n\n## 1. First\n<!-- page: 1 -->\n\nBody.\n"
    drafts = chunk_markdown(text)
    assert drafts[0].section_path == ""
    assert drafts[0].content == "Some preamble banner text before any heading."
    assert drafts[1].section_path == "1. First"


def test_page_marker_defaults_to_one_when_absent() -> None:
    text = "## 1. No Page Marker\n\nBody with no page marker at all.\n"
    drafts = chunk_markdown(text)
    assert drafts[0].page_number == 1


def test_empty_section_produces_no_chunk() -> None:
    text = "## 1. Empty\n<!-- page: 1 -->\n\n## 2. Has Content\n<!-- page: 2 -->\n\nSome text.\n"
    drafts = chunk_markdown(text)
    assert len(drafts) == 1
    assert drafts[0].section_path == "2. Has Content"


def test_long_section_is_split_with_overlap_and_whole_sentences() -> None:
    # Build a section well over CHUNK_TARGET_TOKENS, made of short, distinct
    # numbered sentences so we can verify sentence boundaries and overlap
    # precisely.
    sentences = [f"Sentence number {i} contains exactly six words here." for i in range(1, 121)]
    body = " ".join(sentences)
    text = f"## Long Section\n<!-- page: 7 -->\n\n{body}\n"

    drafts = chunk_markdown(text)

    assert len(drafts) > 1, "a long section must be split into multiple chunks"

    for draft in drafts:
        assert draft.section_path == "Long Section"
        assert draft.page_number == 7
        # No chunk should exceed target + overlap by more than one sentence's
        # worth of tokens (the packing algorithm may overshoot by the last
        # sentence added before the target is exceeded).
        assert _approx_token_count(draft.content) <= CHUNK_TARGET_TOKENS + CHUNK_OVERLAP_TOKENS + 10

    # Every chunk boundary lands on a whole sentence: every chunk's content,
    # once split back into sentences, exactly reconstructs sentences that
    # were present in the original body (no sentence is truncated mid-way).
    for draft in drafts:
        for chunk_sentence in draft.content.split(". "):
            cleaned = chunk_sentence if chunk_sentence.endswith(".") else chunk_sentence + "."
            assert cleaned in sentences, f"chunk boundary split a sentence: {cleaned!r}"

    # Adjacent chunks overlap: the tail of chunk i shares at least one
    # sentence with the head of chunk i+1.
    for first, second in zip(drafts, drafts[1:], strict=False):
        first_sentences = [s.strip() for s in first.content.split(". ") if s.strip()]
        second_sentences = [s.strip() for s in second.content.split(". ") if s.strip()]
        overlap = set(first_sentences[-10:]) & set(second_sentences[:10])
        assert overlap, "adjacent chunks from a split section should share sentences at the boundary"

    # Chunk ordinals are unique and strictly increasing.
    ordinals = [d.ordinal for d in drafts]
    assert ordinals == sorted(ordinals)
    assert len(set(ordinals)) == len(ordinals)


def test_section_under_target_is_never_split_regardless_of_sentence_count() -> None:
    # Many short sentences, but comfortably under CHUNK_TARGET_TOKENS words total.
    sentences = [f"Short sentence {i}." for i in range(1, 20)]
    body = " ".join(sentences)
    text = f"## Short Section\n<!-- page: 2 -->\n\n{body}\n"
    drafts = chunk_markdown(text)
    assert len(drafts) == 1
    assert drafts[0].content == body


# --- F6: a page marker mid-section must not stamp every resulting chunk
# --- with only the section's first page number.


def test_second_page_marker_mid_section_updates_the_page_for_a_short_section() -> None:
    # Two short paragraphs on different pages within ONE section, well
    # under CHUNK_TARGET_TOKENS -- stays a single chunk, and that chunk's
    # page should be the page of its first (only) contributing line.
    text = "## Mixed Pages\n<!-- page: 5 -->\n\nPage five text.\n\n<!-- page: 6 -->\n\nPage six text.\n"
    drafts = chunk_markdown(text)
    assert len(drafts) == 1
    assert drafts[0].page_number == 5
    assert "Page five text." in drafts[0].content
    assert "Page six text." in drafts[0].content


def test_page_marker_mid_a_long_section_correctly_tags_the_later_chunk() -> None:
    """The reviewer's exact F6 probe: a section over CHUNK_TARGET_TOKENS
    with a page-5 block of prose, a `<!-- page: 6 -->` marker, then a
    page-6 block. Before the fix, every resulting chunk was stamped with
    page 5 -- the section's first marker -- even chunks built entirely
    from page-6 sentences."""
    page_five_sentences = [f"Page five sentence number {i} has exactly six words." for i in range(1, 45)]
    page_six_sentences = [f"Page six sentence number {i} has exactly six words." for i in range(1, 45)]
    text = (
        "## Long Section\n<!-- page: 5 -->\n\n"
        + " ".join(page_five_sentences)
        + "\n\n<!-- page: 6 -->\n\n"
        + " ".join(page_six_sentences)
        + "\n"
    )

    drafts = chunk_markdown(text)

    assert len(drafts) > 1, "the combined section must exceed CHUNK_TARGET_TOKENS and be split"
    assert drafts[0].page_number == 5
    # Every draft whose content is made up ENTIRELY of page-six sentences
    # (no page-five sentence text at all) must be tagged page 6, not page 5.
    page_five_marker = "Page five sentence"
    page_six_only_drafts = [d for d in drafts if page_five_marker not in d.content]
    assert page_six_only_drafts, "expected at least one chunk built entirely from page-six content"
    for draft in page_six_only_drafts:
        assert draft.page_number == 6, (
            f"chunk {draft.ordinal} is built entirely from page-6 sentences but is tagged "
            f"page {draft.page_number} (F6 regression)"
        )


def test_three_page_transitions_in_one_long_section_are_all_tracked() -> None:
    blocks = []
    for page in (10, 11, 12, 13):
        sentences = [f"Page {page} filler sentence number {i} here now." for i in range(1, 25)]
        blocks.append(f"<!-- page: {page} -->\n\n" + " ".join(sentences))
    text = "## Multi Page Section\n" + "\n\n".join(blocks) + "\n"

    drafts = chunk_markdown(text)

    assert len(drafts) > 1
    seen_pages = {d.page_number for d in drafts}
    # Page attribution must have moved off the section's first page (10)
    # for at least one later chunk.
    assert seen_pages != {10}
    assert seen_pages.issubset({10, 11, 12, 13})
    # Pages must be non-decreasing across ordinals (a page transition never
    # goes backwards within a single section).
    pages_in_order = [d.page_number for d in drafts]
    assert pages_in_order == sorted(pages_in_order)
