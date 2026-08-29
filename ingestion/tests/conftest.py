"""Shared pytest fixtures for the ingestion test suite."""

from __future__ import annotations

from pathlib import Path

import pytest

INGESTION_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = INGESTION_ROOT.parent


@pytest.fixture(scope="session")
def repo_root() -> Path:
    return REPO_ROOT


@pytest.fixture(scope="session")
def manifest_path() -> Path:
    return REPO_ROOT / "data" / "synthetic" / "corpus-manifest.json"


@pytest.fixture(scope="session")
def corpus_dir() -> Path:
    return REPO_ROOT / "data" / "synthetic"


@pytest.fixture(scope="session")
def shared_hash_ts_path() -> Path:
    return REPO_ROOT / "packages" / "shared" / "src" / "hash.ts"


@pytest.fixture(scope="session")
def shared_constants_ts_path() -> Path:
    return REPO_ROOT / "packages" / "shared" / "src" / "constants.ts"
