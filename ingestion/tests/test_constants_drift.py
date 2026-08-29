"""Drift test: `constants.py` must agree with `packages/shared/src/constants.ts`.

Parses the TypeScript source with a regex (no TS toolchain required) and
compares each of the four cross-language constants against the Python
module's values.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from trialpulse_ingest import constants

# Constants that MUST be identical in both languages, per the task's
# explicit list.
SHARED_CONSTANT_NAMES = (
    "CHUNK_TARGET_TOKENS",
    "CHUNK_OVERLAP_TOKENS",
    "EMBEDDING_DIMENSIONS",
    "TOMBSTONE_RETENTION_DAYS",
)


def _parse_ts_constants(ts_source: str) -> dict[str, int]:
    values: dict[str, int] = {}
    for name in SHARED_CONSTANT_NAMES:
        match = re.search(rf"export const {name}\s*:\s*number\s*=\s*(-?\d+)\s*;", ts_source)
        if match is None:
            # Fall back to an un-typed declaration (`export const NAME = 512;`)
            match = re.search(rf"export const {name}\s*=\s*(-?\d+)\s*;", ts_source)
        if match is None:
            raise AssertionError(f"Could not find `export const {name} = <int>;` in constants.ts")
        values[name] = int(match.group(1))
    return values


@pytest.fixture(scope="module")
def ts_constants(shared_constants_ts_path: Path) -> dict[str, int]:
    assert shared_constants_ts_path.exists(), f"constants.ts not found at {shared_constants_ts_path}"
    return _parse_ts_constants(shared_constants_ts_path.read_text(encoding="utf-8"))


@pytest.mark.parametrize("name", SHARED_CONSTANT_NAMES)
def test_constant_matches_typescript(ts_constants: dict[str, int], name: str) -> None:
    python_value = getattr(constants, name)
    ts_value = ts_constants[name]
    assert python_value == ts_value, (
        f"{name} drifted: python constants.py has {python_value}, "
        f"packages/shared/src/constants.ts has {ts_value}. Update whichever is stale."
    )
