"""Byte-for-byte parity between `hashing.py` and `packages/shared/src/hash.ts`.

Shells out to Node (transpiling the real hash.ts on the fly with the
TypeScript compiler already vendored in the repo's node_modules -- see
`tests/fixtures/ts_hash_runner.cjs`) so this test exercises the actual
TypeScript source, not a hand-copied re-implementation of it.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import unicodedata
from pathlib import Path

import pytest

from trialpulse_ingest.hashing import content_hash, normalize_text

RUNNER_SCRIPT = Path(__file__).resolve().parent / "fixtures" / "ts_hash_runner.cjs"

# F7: NFC vs NFD spellings of visually/semantically identical text.
# `unicodedata.normalize` (rather than typing an NFD string literal
# directly) guarantees these are genuinely the composed/decomposed forms
# regardless of what normal form the editor/source file itself uses.
_NFC_SAMPLE = unicodedata.normalize("NFC", "Caf\u00e9 r\u00e9sum\u00e9 na\u00efve")
_NFD_SAMPLE = unicodedata.normalize("NFD", "Caf\u00e9 r\u00e9sum\u00e9 na\u00efve")

# F8: unpaired UTF-16 surrogates, as real Python `str` code points
# (`chr(0xD800)` unambiguously produces a genuine lone high surrogate
# regardless of file/editor/terminal encoding).
_LONE_HIGH_SURROGATE = f"before{chr(0xD800)}after"
_LONE_LOW_SURROGATE = f"before{chr(0xDC00)}after"

# Tricky fixtures the task calls out explicitly, plus a few more that stress
# the same regex pipeline.
FIXTURES: list[str] = [
    "Hello World",
    "Hello\r\nWorld\r\n\r\nSecond paragraph.",  # CRLF line endings
    "Hello World again",  # non-breaking spaces (U+00A0)
    "Hello\t\t\tWorld",  # tab runs
    "Line one\n\n\n\nLine two\n\n\n\n\n\nLine three",  # 3+ newlines collapse to 2
    "  leading and trailing whitespace   \n   ",  # trailing/leading whitespace
    "HELLO World MiXeD CaSe",  # mixed case, lowercased on both sides
    "Café résumé naïve façade — 中文字符 — emoji 🎉 test",  # unicode
    "line with trailing spaces   \nand a tab\t\nend",
    "\r\rlone CR characters\r only\r",  # lone CR (not CRLF)
    "",  # empty string edge case
    "   \n\n\n   ",  # whitespace-only
    _NFC_SAMPLE,  # F7: precomposed accented characters
    _NFD_SAMPLE,  # F7: decomposed (combining-character) accented characters
    _LONE_HIGH_SURROGATE,  # F8: unpaired UTF-16 high surrogate
    _LONE_LOW_SURROGATE,  # F8: unpaired UTF-16 low surrogate
]


@pytest.fixture(scope="module")
def node_available() -> bool:
    return shutil.which("node") is not None


def _run_ts_runner(hash_ts_path: Path, texts: list[str]) -> list[dict[str, str]]:
    result = subprocess.run(  # noqa: S603 -- fixed, trusted script path, no shell
        ["node", str(RUNNER_SCRIPT), str(hash_ts_path)],
        input=json.dumps(texts),
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    )
    return json.loads(result.stdout)


def test_normalize_and_hash_match_typescript(shared_hash_ts_path: Path, node_available: bool) -> None:
    if not node_available:
        pytest.skip("node is not available on PATH; cannot verify TypeScript parity.")
    assert shared_hash_ts_path.exists(), f"hash.ts not found at {shared_hash_ts_path}"

    ts_results = _run_ts_runner(shared_hash_ts_path, FIXTURES)
    assert len(ts_results) == len(FIXTURES)

    for text, ts_result in zip(FIXTURES, ts_results, strict=True):
        py_normalized = normalize_text(text)
        py_hash = content_hash(text)
        assert py_normalized == ts_result["normalized"], (
            f"normalize_text mismatch for {text!r}: python={py_normalized!r} ts={ts_result['normalized']!r}"
        )
        assert py_hash == ts_result["hash"], (
            f"content_hash mismatch for {text!r}: python={py_hash!r} ts={ts_result['hash']!r}"
        )


def test_hash_is_stable_and_deterministic() -> None:
    assert content_hash("Hello World") == content_hash("Hello World")
    assert content_hash("Hello World") == content_hash("  hello   world  ")
    assert content_hash("Hello\r\nWorld") == content_hash("HELLO\nWORLD")


def test_hash_differs_for_different_content() -> None:
    assert content_hash("Hello World") != content_hash("Goodbye World")


# --- F7: NFC vs NFD must hash identically ---------------------------------


def test_nfc_and_nfd_forms_normalize_identically() -> None:
    assert normalize_text(_NFC_SAMPLE) == normalize_text(_NFD_SAMPLE)


def test_nfc_and_nfd_forms_hash_identically() -> None:
    assert content_hash(_NFC_SAMPLE) == content_hash(_NFD_SAMPLE)


def test_nfc_and_nfd_samples_are_actually_different_byte_sequences() -> None:
    """Sanity check that the fixture itself exercises something real: an
    NFC and NFD encoding of the same text differ in length/code points
    before normalization, or this test would be vacuous."""
    assert _NFC_SAMPLE != _NFD_SAMPLE
    assert len(_NFC_SAMPLE) != len(_NFD_SAMPLE)


# --- F8: lone surrogates must not crash, and must match Node -------------


def test_lone_surrogate_does_not_raise() -> None:
    content_hash(_LONE_HIGH_SURROGATE)  # must not raise UnicodeEncodeError
    content_hash(_LONE_LOW_SURROGATE)  # must not raise UnicodeEncodeError


def test_lone_surrogate_is_substituted_with_the_replacement_character() -> None:
    assert "�" in normalize_text(_LONE_HIGH_SURROGATE)
    assert "�" in normalize_text(_LONE_LOW_SURROGATE)
    # The raw surrogate itself must not survive normalization -- it would
    # crash `.encode("utf-8")` in sha256_hex otherwise.
    assert chr(0xD800) not in normalize_text(_LONE_HIGH_SURROGATE)
    assert chr(0xDC00) not in normalize_text(_LONE_LOW_SURROGATE)


def test_sha256_hex_itself_tolerates_a_raw_lone_surrogate() -> None:
    """`make_chunk_id`'s composite key is hashed via `sha256_hex` directly,
    bypassing `normalize_text` -- if `document_id`/`heading_path` ever
    carried a lone surrogate (e.g. from a malformed source document's
    title), `sha256_hex` itself must not raise."""
    from trialpulse_ingest.hashing import sha256_hex

    sha256_hex(f"doc::{chr(0xD800)}::0::hash")  # must not raise
