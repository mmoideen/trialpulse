"""Embedding generation: Azure OpenAI `text-embedding-3-large`, plus a
deterministic local fake so tests and local runs never need network access.

PRD decision 4 (section 2.3): embeddings run on a dedicated, high-throughput
Azure OpenAI deployment, separate from the generation model, so ingestion
jobs cannot starve interactive queries. That separation is a deployment
concern (two Azure OpenAI deployments); this module only needs the
embedding deployment's endpoint/name.
"""

from __future__ import annotations

import hashlib
import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from trialpulse_ingest.constants import DEFAULT_EMBEDDING_BATCH_SIZE, EMBEDDING_DIMENSIONS
from trialpulse_ingest.retry import RetryOutcome, classify_exception, with_retry

_TOKEN_RE = re.compile(r"\w+", re.UNICODE)


class Embedder(Protocol):
    """Common interface for the real Azure OpenAI embedder and the local fake."""

    def embed_batch(self, texts: Sequence[str]) -> list[list[float]]:
        """Return one embedding vector per input text, same order as input."""
        ...


class LocalFakeEmbedder:
    """Deterministic, seeded, L2-normalized embedder with no network calls.

    Used for local development and the entire offline test suite. Each
    input's tokens are hashed (via SHA-256, not Python's process-randomised
    `hash()`) into a fixed-size vector, which is then L2-normalized so
    cosine similarity comparisons behave the same way real embeddings would
    for RBAC-threshold-style logic in the orchestrator's tests. Two calls
    with the same seed always produce bit-identical output, which is what
    makes the idempotency tests reliable: re-embedding unchanged content
    must not perturb its embedding.
    """

    def __init__(self, dimensions: int = EMBEDDING_DIMENSIONS, seed: int = 1337) -> None:
        self._dimensions = dimensions
        self._seed = seed

    def embed_batch(self, texts: Sequence[str]) -> list[list[float]]:
        return [self._embed_one(text) for text in texts]

    def _embed_one(self, text: str) -> list[float]:
        tokens = _TOKEN_RE.findall(text.lower()) or [""]
        vector = [0.0] * self._dimensions
        for token in tokens:
            digest = hashlib.sha256(f"{self._seed}:{token}".encode()).digest()
            index = int.from_bytes(digest[0:4], "big") % self._dimensions
            sign = 1.0 if digest[4] % 2 == 0 else -1.0
            magnitude = (digest[5] % 255 + 1) / 255.0
            vector[index] += sign * magnitude
        norm = math.sqrt(sum(component * component for component in vector))
        if norm == 0.0:
            return vector
        return [component / norm for component in vector]


@dataclass(frozen=True, slots=True)
class AzureOpenAIEmbedderConfig:
    endpoint: str
    deployment: str = "text-embedding-3-large"
    api_version: str = "2024-06-01"
    dimensions: int = EMBEDDING_DIMENSIONS
    batch_size: int = DEFAULT_EMBEDDING_BATCH_SIZE
    max_retry_attempts: int = 3


class AzureOpenAIEmbedder:
    """Real Azure OpenAI embedder.

    Authenticates via `azure.identity` managed identity (no API keys in
    code or config, per PRD 8.1) and batches requests according to
    `config.batch_size`. The `openai` and `azure-identity` imports are
    deferred to `__init__`/`embed_batch` so this class can exist in the
    module without those packages being importable -- only instantiating
    it (which only happens in production, never in the offline test suite)
    requires them.
    """

    def __init__(self, config: AzureOpenAIEmbedderConfig, *, credential: object | None = None) -> None:
        self._config = config
        self._credential = credential
        self._client = None  # constructed lazily on first embed_batch call

    def _get_client(self):  # noqa: ANN202 -- return type is the lazily-imported AzureOpenAI class
        if self._client is not None:
            return self._client

        from azure.identity import get_bearer_token_provider  # noqa: PLC0415
        from openai import AzureOpenAI  # noqa: PLC0415

        credential = self._credential
        if credential is None:
            from azure.identity import DefaultAzureCredential  # noqa: PLC0415

            credential = DefaultAzureCredential()

        token_provider = get_bearer_token_provider(
            credential, "https://cognitiveservices.azure.com/.default"
        )
        self._client = AzureOpenAI(
            azure_endpoint=self._config.endpoint,
            azure_ad_token_provider=token_provider,
            api_version=self._config.api_version,
        )
        return self._client

    def embed_batch(self, texts: Sequence[str]) -> list[list[float]]:
        client = self._get_client()
        results: list[list[float]] = []
        batch_size = max(1, self._config.batch_size)

        for start in range(0, len(texts), batch_size):
            batch = list(texts[start : start + batch_size])

            def call_embeddings(batch: list[str] = batch) -> list[list[float]]:
                # Rate-limit awareness: Azure OpenAI returns HTTP 429 with a
                # Retry-After header under throttling; `with_retry` treats
                # 429/5xx/timeouts as transient and backs off with jitter.
                response = client.embeddings.create(
                    model=self._config.deployment,
                    input=batch,
                    dimensions=self._config.dimensions,
                )
                return [item.embedding for item in response.data]

            outcome: RetryOutcome[list[list[float]]] = with_retry(
                call_embeddings,
                operation="azure_openai_embed_batch",
                context={"batch_size": len(batch), "deployment": self._config.deployment},
                max_attempts=self._config.max_retry_attempts,
                classify=classify_exception,
            )
            if not outcome.succeeded:
                assert outcome.dead_letter is not None
                raise RuntimeError(
                    f"Embedding batch failed after {outcome.attempts} attempts: "
                    f"{outcome.dead_letter.last_error_type}: {outcome.dead_letter.last_error_message}"
                )
            results.extend(outcome.result or [])

        return results
