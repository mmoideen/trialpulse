"""Smoke test for `function_app.py`.

Importing the Azure Functions app must never touch the network or require
managed identity / real Azure resources -- every real client is constructed
lazily (see `get_embedder`, `get_index`, `get_sharepoint_connector`). This
test just verifies the module imports cleanly and wires up the four
triggers the PRD calls for: webhook (HTTP), queue-driven ingestion, and the
two timer triggers (delta sync, tombstone purge). Deeper behavior of each
trigger's business logic is covered by `test_pipeline_*`, `test_sharepoint`,
and `test_indexing`, which test the same code without needing a real
Azure Functions host.
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest

INGESTION_ROOT = Path(__file__).resolve().parents[1]


def _import_function_app():
    if str(INGESTION_ROOT) not in sys.path:
        sys.path.insert(0, str(INGESTION_ROOT))
    if "function_app" in sys.modules:
        return importlib.reload(sys.modules["function_app"])
    return importlib.import_module("function_app")


def test_function_app_imports_without_network_or_env_vars(monkeypatch) -> None:
    for var in [
        "AZURE_SEARCH_ENDPOINT",
        "AZURE_OPENAI_EMBEDDING_ENDPOINT",
        "AzureWebJobsStorage",
        "SHAREPOINT_SITE_ID",
        "SHAREPOINT_DRIVE_ID",
    ]:
        monkeypatch.delenv(var, raising=False)

    module = _import_function_app()
    assert module.app is not None


def test_four_expected_triggers_are_registered() -> None:
    module = _import_function_app()
    functions = module.app.get_functions()
    names_to_trigger = {f.get_function_name(): f.get_trigger().get_binding_name() for f in functions}

    assert names_to_trigger == {
        "sharepoint_webhook": "httpTrigger",
        "ingest_document_queue": "queueTrigger",
        "daily_delta_sync": "timerTrigger",
        "tombstone_purge": "timerTrigger",
    }


def test_local_dev_flag_selects_in_memory_fakes(monkeypatch) -> None:
    monkeypatch.setenv("TRIALPULSE_LOCAL_DEV", "true")
    module = _import_function_app()
    module.get_embedder.cache_clear()
    module.get_index.cache_clear()

    from trialpulse_ingest.embedding import LocalFakeEmbedder
    from trialpulse_ingest.indexing import InMemorySearchIndex

    assert isinstance(module.get_embedder(), LocalFakeEmbedder)
    assert isinstance(module.get_index(), InMemorySearchIndex)


def test_enqueue_requires_an_identity_based_queue_endpoint(monkeypatch) -> None:
    """The storage account disallows shared-key access, so the delta-sync
    enqueue path must fail loudly when no queue service URI is configured
    rather than silently falling back to a connection string that cannot work.
    """
    function_app = _import_function_app()

    monkeypatch.delenv(function_app.QUEUE_ACCOUNT_URL_SETTING, raising=False)
    monkeypatch.delenv(f"{function_app.STORAGE_CONNECTION_SETTING}__queueServiceUri", raising=False)

    job = function_app.IngestionJob(
        site_id="site-1",
        drive_id="drive-1",
        item_id="item-1",
        reason="delta_sync",
    )

    with pytest.raises((RuntimeError, ModuleNotFoundError, ImportError)) as excinfo:
        function_app._enqueue_via_queue_client(job)

    # When the Azure SDK is installed we get the explicit configuration error;
    # when it is not (the offline test environment) the lazy import raises
    # first. Either way the function never reaches `from_connection_string`.
    if isinstance(excinfo.value, RuntimeError):
        assert function_app.QUEUE_ACCOUNT_URL_SETTING in str(excinfo.value)


def test_enqueue_via_queue_client_sends_a_valid_job_message(monkeypatch) -> None:
    """Regression test: `IngestionJob` is a `slots=True` dataclass, so it
    has no `__dict__` -- `json.dumps(job.__dict__)` raised `AttributeError`
    on every real invocation of this function (the identity-based queue
    client fix this docstring is about never actually got to run). Fixed
    to `json.dumps(asdict(job))`. This also pins down the exact
    `ingestion-work` message shape documented in ingestion/README.md.
    """
    function_app = _import_function_app()
    monkeypatch.setenv(function_app.QUEUE_ACCOUNT_URL_SETTING, "https://fake.queue.core.windows.net")

    import azure.storage.queue as azure_queue_module

    sent_messages: list[str] = []

    class _FakeQueueClient:
        def __init__(self, *, account_url: str, queue_name: str, credential: object) -> None:
            self.account_url = account_url
            self.queue_name = queue_name

        def send_message(self, content: str) -> None:
            sent_messages.append(content)

    monkeypatch.setattr(azure_queue_module, "QueueClient", _FakeQueueClient)

    import azure.identity as azure_identity_module

    monkeypatch.setattr(azure_identity_module, "DefaultAzureCredential", lambda: object())

    job = function_app.IngestionJob(site_id="site-1", drive_id="drive-1", item_id="item-1", reason="delta_sync")
    function_app._enqueue_via_queue_client(job)  # noqa: SLF001

    assert len(sent_messages) == 1
    assert json.loads(sent_messages[0]) == {
        "site_id": "site-1",
        "drive_id": "drive-1",
        "item_id": "item-1",
        "reason": "delta_sync",
    }
