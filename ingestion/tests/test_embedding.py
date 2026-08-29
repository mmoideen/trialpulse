"""LocalFakeEmbedder: deterministic, seeded, L2-normalized, no network."""

from __future__ import annotations

import math

from trialpulse_ingest.constants import EMBEDDING_DIMENSIONS
from trialpulse_ingest.embedding import LocalFakeEmbedder


def test_embedding_has_configured_dimensions() -> None:
    embedder = LocalFakeEmbedder()
    [vector] = embedder.embed_batch(["hello world"])
    assert len(vector) == EMBEDDING_DIMENSIONS


def test_embedding_is_l2_normalized() -> None:
    embedder = LocalFakeEmbedder()
    [vector] = embedder.embed_batch(["Revarafusp alfa is a bifunctional antibody."])
    norm = math.sqrt(sum(component * component for component in vector))
    assert math.isclose(norm, 1.0, abs_tol=1e-9)


def test_embedding_is_deterministic_across_calls_and_instances() -> None:
    text = "The primary endpoint is overall survival."
    first = LocalFakeEmbedder().embed_batch([text])[0]
    second = LocalFakeEmbedder(seed=1337).embed_batch([text])[0]
    assert first == second


def test_different_text_yields_different_embedding() -> None:
    embedder = LocalFakeEmbedder()
    a, b = embedder.embed_batch(["hello world", "goodbye moon"])
    assert a != b


def test_different_seed_yields_different_embedding() -> None:
    text = "consistent text input"
    default_seed = LocalFakeEmbedder(seed=1337).embed_batch([text])[0]
    other_seed = LocalFakeEmbedder(seed=99).embed_batch([text])[0]
    assert default_seed != other_seed


def test_embed_batch_preserves_order() -> None:
    embedder = LocalFakeEmbedder()
    texts = ["alpha text", "beta text", "gamma text"]
    batch_result = embedder.embed_batch(texts)
    individual_results = [embedder.embed_batch([t])[0] for t in texts]
    assert batch_result == individual_results


def test_empty_string_still_produces_a_vector() -> None:
    embedder = LocalFakeEmbedder()
    [vector] = embedder.embed_batch([""])
    assert len(vector) == EMBEDDING_DIMENSIONS
