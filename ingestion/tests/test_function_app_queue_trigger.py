"""`function_app.py`'s webhook shared-secret handling (F1) and the
queue-triggered `ingest_document_queue` handler's real wiring (F10):
resolve metadata -> download -> materialize -> `IngestionPipeline.
ingest_document` -> clean up the temp file, all via injected fakes so no
real Azure Functions host, network access, or managed identity is needed.
"""

from __future__ import annotations

import importlib
import json
import sys
from dataclasses import asdict
from pathlib import Path

import azure.functions as func
import pytest

from trialpulse_ingest.embedding import LocalFakeEmbedder
from trialpulse_ingest.indexing import InMemorySearchIndex
from trialpulse_ingest.models import DocumentMetadata
from trialpulse_ingest.pipeline import IngestionPipeline
from trialpulse_ingest.sharepoint import DocumentMetadataResolutionError, IngestionJob

INGESTION_ROOT = Path(__file__).resolve().parents[1]


def _import_function_app():
    if str(INGESTION_ROOT) not in sys.path:
        sys.path.insert(0, str(INGESTION_ROOT))
    if "function_app" in sys.modules:
        return importlib.reload(sys.modules["function_app"])
    return importlib.import_module("function_app")


class _FakeOut:
    """Minimal stand-in for `azure.functions.Out`, which is abstract and
    cannot be instantiated directly."""

    def __init__(self) -> None:
        self._value: object = None

    def set(self, value: object) -> None:
        self._value = value

    def get(self) -> object:
        return self._value


# --- F1: the shared secret must be required, not defaulted ---------------


def test_get_expected_client_state_requires_the_env_var(monkeypatch: pytest.MonkeyPatch) -> None:
    function_app = _import_function_app()
    monkeypatch.delenv("SHAREPOINT_WEBHOOK_CLIENT_STATE", raising=False)
    function_app.get_expected_client_state.cache_clear()

    with pytest.raises(KeyError):
        function_app.get_expected_client_state()


def test_get_expected_client_state_returns_the_configured_value(monkeypatch: pytest.MonkeyPatch) -> None:
    function_app = _import_function_app()
    monkeypatch.setenv("SHAREPOINT_WEBHOOK_CLIENT_STATE", "real-secret")
    function_app.get_expected_client_state.cache_clear()

    assert function_app.get_expected_client_state() == "real-secret"


# --- F10: the queue trigger's real wiring ---------------------------------


class _FakeGraphClientForQueue:
    def __init__(self, content: bytes) -> None:
        self._content = content
        self.download_calls: list[tuple[str, str]] = []

    def download_item_content(self, drive_id: str, item_id: str) -> bytes:
        self.download_calls.append((drive_id, item_id))
        return self._content


def test_ingest_document_queue_resolves_downloads_ingests_and_cleans_up_temp_file(
    monkeypatch: pytest.MonkeyPatch, corpus_dir: Path
) -> None:
    function_app = _import_function_app()

    job = IngestionJob(site_id="site-1", drive_id="drive-1", item_id="item-1", reason="webhook")
    msg = func.QueueMessage(body=json.dumps(asdict(job)).encode("utf-8"))

    real_content = (corpus_dir / "protocol-axiom-hn01-v3.0.md").read_bytes()
    fake_graph = _FakeGraphClientForQueue(real_content)
    doc_meta = DocumentMetadata(
        document_id="item-1",
        filename="protocol-axiom-hn01-v3.0.md",
        title="AXIOM-HN01 Protocol v3.0",
        classification="protocol",
        version="3.0",
        effective_date="2025-11-14",
        site_code=None,
        supersedes=None,
        source_url="https://example.com/protocol-v3.md",
    )
    index = InMemorySearchIndex()
    real_pipeline = IngestionPipeline(embedder=LocalFakeEmbedder(), index=index)

    monkeypatch.setattr(function_app, "get_metadata_resolver", lambda: (lambda _job: doc_meta))
    monkeypatch.setattr(function_app, "get_graph_client", lambda: fake_graph)
    monkeypatch.setattr(function_app, "get_pipeline", lambda: real_pipeline)

    captured_temp_paths: list[Path] = []
    original_materialize = function_app._materialize_to_temp_file  # noqa: SLF001

    def spying_materialize(content: bytes, filename: str) -> Path:
        path = original_materialize(content, filename)
        captured_temp_paths.append(path)
        return path

    monkeypatch.setattr(function_app, "_materialize_to_temp_file", spying_materialize)

    deadletter = _FakeOut()
    function_app.ingest_document_queue(msg, deadletter)

    assert fake_graph.download_calls == [("drive-1", "item-1")]
    assert deadletter.get() is None, "a successful ingest must not dead-letter"
    assert len(index.get_chunks_for_document("item-1")) > 0

    # The temp file must be cleaned up after ingestion.
    assert len(captured_temp_paths) == 1
    assert not captured_temp_paths[0].exists()


def test_ingest_document_queue_dead_letters_immediately_when_metadata_resolver_unconfigured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The default resolver (`unconfigured_metadata_resolver`) must fail
    with a specific, legible error, classified as permanent so the queue
    trigger dead-letters after one attempt rather than burning three
    retries on a config problem that will never fix itself."""
    function_app = _import_function_app()
    function_app.get_metadata_resolver.cache_clear()
    monkeypatch.delenv("TRIALPULSE_LOCAL_DEV", raising=False)

    call_count = 0

    def counting_resolver(job: IngestionJob) -> DocumentMetadata:
        nonlocal call_count
        call_count += 1
        raise DocumentMetadataResolutionError(f"no schema for {job.item_id}")

    monkeypatch.setattr(function_app, "get_metadata_resolver", lambda: counting_resolver)

    job = IngestionJob(site_id="site-1", drive_id="drive-1", item_id="item-1", reason="webhook")
    msg = func.QueueMessage(body=json.dumps(asdict(job)).encode("utf-8"))
    deadletter = _FakeOut()

    function_app.ingest_document_queue(msg, deadletter)

    assert call_count == 1, "a PermanentError must not be retried"
    dead_letter_payload = deadletter.get()
    assert dead_letter_payload is not None
    assert "DocumentMetadataResolutionError" in dead_letter_payload
