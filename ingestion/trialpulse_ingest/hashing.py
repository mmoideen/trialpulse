"""Content hashing, byte-for-byte compatible with `packages/shared/src/hash.ts`.

PRD decision 2 (section 2.3): idempotency depends on both the TypeScript
orchestrator and this Python ingestion pipeline agreeing on the SHA-256 of
*normalized* chunk text. If the two normalisations ever drift, the same
logical chunk would hash differently depending on which language touched it
last, silently breaking idempotency and version comparison.

`normalize_text` below is a line-for-line port of `normalizeText` in
hash.ts. `ingestion/tests/test_hash_parity.py` shells out to Node (using the
TypeScript compiler already vendored in the repo's node_modules) to run the
real hash.ts against a battery of tricky fixtures and asserts this
implementation matches exactly.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata

# Order matters and must match hash.ts exactly:
#   1. NFC normalize
#   2. unpaired UTF-16 surrogates -> U+FFFD
#   3. CRLF -> LF
#   4. lone CR -> LF
#   5. non-breaking space (U+00A0) -> regular space
#   6. runs of spaces/tabs -> single space
#   7. 3+ newlines -> exactly 2 newlines
#   8. trim each line
#   9. trim the whole string
#   10. lowercase
#
# Steps 1-2 (F7/F8) mirror hash.ts's `normalizeText`, which already
# NFC-normalizes and substitutes lone surrogates as its FIRST two steps:
#
# - Step 1 (NFC): text that is visually and semantically identical but
#   encoded with combining characters (NFD -- some authoring tools and
#   operating systems save accented characters this way) must hash the
#   same as its precomposed (NFC) form, or an unchanged section
#   re-ingests as "changed" purely because of which normal form its
#   source happened to use.
# - Step 2 (lone surrogates): text extracted from legacy or OCR tooling
#   can carry unpaired UTF-16 surrogates. Node's encoder silently
#   substitutes U+FFFD for them; Python's `str.encode("utf-8")` raises
#   `UnicodeEncodeError: surrogates not allowed`. Substituting explicitly
#   on the `str` itself, BEFORE encoding, matters for two reasons: (a)
#   Python has no encode-time error handler that emits U+FFFD
#   (`errors="replace"` emits ASCII `?`, which would not match Node's
#   output), and (b) doing the substitution up front is what stops
#   `sha256_hex` from ever raising, rather than merely changing what it
#   raises.
_CRLF_RE = re.compile(r"\r\n")
_CR_RE = re.compile(r"\r")
_NBSP = " "
_SPACE_TAB_RUN_RE = re.compile(r"[ \t]+")
_MULTI_NEWLINE_RE = re.compile(r"\n{3,}")
#: Matches a high surrogate NOT followed by a low surrogate, or a low
#: surrogate NOT preceded by a high surrogate -- i.e. exactly the unpaired
#: surrogates, leaving a genuine (paired) surrogate run untouched. Mirrors
#: `LONE_SURROGATE_RE` in packages/shared/src/hash.ts exactly.
_LONE_SURROGATE_RE = re.compile("[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]")


def normalize_text(text: str) -> str:
    """Normalise text before hashing so cosmetic differences do not change it.

    Mirrors `normalizeText` in packages/shared/src/hash.ts exactly, including
    operation order. See that file's docstring for why this matters.
    """
    normalized = unicodedata.normalize("NFC", text)
    normalized = _LONE_SURROGATE_RE.sub("�", normalized)
    normalized = _CRLF_RE.sub("\n", normalized)
    normalized = _CR_RE.sub("\n", normalized)
    normalized = normalized.replace(_NBSP, " ")
    normalized = _SPACE_TAB_RUN_RE.sub(" ", normalized)
    normalized = _MULTI_NEWLINE_RE.sub("\n\n", normalized)
    normalized = "\n".join(line.strip() for line in normalized.split("\n"))
    return normalized.strip().lower()


def sha256_hex(value: str) -> str:
    """SHA-256 of a UTF-8 encoded string, as a lowercase hex digest.

    Defensively substitutes any lone surrogate that reaches this function
    directly (bypassing `normalize_text` -- e.g. `make_chunk_id`'s
    composite key, built from `document_id`/`heading_path`, which is not
    routed through `normalize_text`) so this function itself can never
    raise `UnicodeEncodeError`, matching `content_hash`/`query_hash`'s
    guarantee for every other caller.
    """
    safe_value = _LONE_SURROGATE_RE.sub("�", value)
    return hashlib.sha256(safe_value.encode("utf-8")).hexdigest()


def content_hash(text: str) -> str:
    """SHA-256 of the normalised chunk text -- the idempotency key."""
    return sha256_hex(normalize_text(text))


def query_hash(query: str) -> str:
    """SHA-256 of the normalised query -- used for cache keys and audit joins."""
    return sha256_hex(normalize_text(query))


def make_chunk_id(document_id: str, heading_path: str, ordinal: int, content_hash_value: str) -> str:
    """Deterministic, stable chunk identifier.

    Derived from document_id + heading_path + ordinal + content_hash (never a
    random UUID) so that re-running ingestion over unchanged content produces
    the exact same chunk_id every time -- otherwise idempotency in
    indexing.py would be unable to recognise "this chunk already exists".

    Using a composite key (rather than content_hash alone) also keeps chunk
    ids stable and unique even in the pathological case where two distinct
    chunks in the same document normalise to identical content (e.g. a
    boilerplate sentence repeated verbatim in two sections).
    """
    composite = f"{document_id}::{heading_path}::{ordinal}::{content_hash_value}"
    return sha256_hex(composite)
