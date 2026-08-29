"""Azure Functions (Python v2 model) entry points for the ingestion pipeline.

Four triggers, per PRD workflow 3.3.1 and the "Optimization Recommendations"
queue-based-ingestion note:

1. `sharepoint_webhook` (HTTP) -- receives SharePoint change notifications and
   validates the Graph subscription handshake, then ENQUEUES a re-ingestion
   job per notification. It never ingests inline, so a webhook flood cannot
   overwhelm the pipeline.
2. `ingest_document_queue` (Queue trigger) -- ingests exactly one document per
   message, with retry + dead-letter on failure.
3. `daily_delta_sync` (Timer trigger) -- the catch-up safety net for missed or
   out-of-order webhooks (PRD risk 11.3), plus subscription renewal.
4. `tombstone_purge` (Timer trigger) -- permanently removes chunks whose
   `TOMBSTONE_RETENTION_DAYS` grace period has elapsed.

All Azure SDK clients are constructed lazily (see the `get_*` functions
below), so importing this module -- which the ingestion test suite does, to
sanity-check the wiring -- never touches the network or requires managed
identity to be available. Configuration comes entirely from environment
variables / Key Vault references (PRD 8.1: no secrets in code).
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path

import azure.functions as func

from trialpulse_ingest.document_status import (
    CosmosDocumentStatusStore,
    DocumentStatusStore,
    InMemoryDocumentStatusStore,
)
from trialpulse_ingest.embedding import AzureOpenAIEmbedder, AzureOpenAIEmbedderConfig, Embedder, LocalFakeEmbedder
from trialpulse_ingest.indexing import AzureAISearchIndex, InMemorySearchIndex, SearchIndex
from trialpulse_ingest.models import DocumentMetadata
from trialpulse_ingest.pipeline import IngestionPipeline
from trialpulse_ingest.retry import with_retry
from trialpulse_ingest.sharepoint import (
    GraphClient,
    GraphItemMetadataResolver,
    GraphSharePointClient,
    IngestionJob,
    InMemoryDeltaLinkStore,
    SharePointConnector,
    unconfigured_metadata_resolver,
)
from trialpulse_ingest.telemetry import get_logger, log_event, traced_span

_logger = get_logger("trialpulse.ingestion.function_app")

# "ingestion-work" is the one and only ingestion queue name (F5): the sole
# consumer of this queue is `ingest_document_queue` below, and it is the only
# queue name provisioned by infra/modules/storage.bicep
# (`ingestionQueueName`). `infra/main.bicep` sets TRIALPULSE_INGEST_QUEUE to
# that same value for both the ingestion and orchestrator Function Apps, so
# the orchestrator's reindex path enqueues onto the queue this trigger
# actually reads. See ingestion/README.md, "Ingestion queue contract".
INGEST_QUEUE_NAME = os.environ.get("TRIALPULSE_INGEST_QUEUE", "ingestion-work")
DEAD_LETTER_QUEUE_NAME = os.environ.get("TRIALPULSE_DEAD_LETTER_QUEUE", "ingestion-work-poison")
STORAGE_CONNECTION_SETTING = "AzureWebJobsStorage"
# Identity-based queue endpoint; see `_enqueue_via_queue_client` for why a
# connection string is not usable against this storage account.
QUEUE_ACCOUNT_URL_SETTING = "AZURE_STORAGE_QUEUE_ACCOUNT_URL"

# Local development / CI escape hatch: when set, use in-memory fakes instead
# of real Azure clients so `func start` can run against the synthetic corpus
# with no Azure resources provisioned. Never set in production.
_LOCAL_DEV = os.environ.get("TRIALPULSE_LOCAL_DEV", "").lower() in {"1", "true", "yes"}


@lru_cache(maxsize=1)
def get_embedder() -> Embedder:
    if _LOCAL_DEV:
        return LocalFakeEmbedder()
    endpoint = os.environ["AZURE_OPENAI_EMBEDDING_ENDPOINT"]
    deployment = os.environ.get("AZURE_OPENAI_EMBEDDING_DEPLOYMENT", "text-embedding-3-large")
    return AzureOpenAIEmbedder(AzureOpenAIEmbedderConfig(endpoint=endpoint, deployment=deployment))


@lru_cache(maxsize=1)
def get_index() -> SearchIndex:
    if _LOCAL_DEV:
        return InMemorySearchIndex()
    endpoint = os.environ["AZURE_SEARCH_ENDPOINT"]
    index_name = os.environ.get("AZURE_SEARCH_INDEX_NAME", "trialpulse-chunks")
    return AzureAISearchIndex(endpoint=endpoint, index_name=index_name)


@lru_cache(maxsize=1)
def get_document_status_store() -> DocumentStatusStore:
    """F4: the orchestrator's Cosmos DB `documents` container (Browse tab
    + version-compare's document lookup). See `document_status.py` and
    `infra/modules/cosmos.bicep`'s "documents" container comment.

    `infra/main.bicep` sets `COSMOS_ENDPOINT`/`COSMOS_DATABASE_NAME` on this
    Function App and `infra/modules/rbac.bicep` grants it a data-plane role
    scoped to the `documents` container.
    """
    if _LOCAL_DEV:
        return InMemoryDocumentStatusStore()
    endpoint = os.environ["COSMOS_ENDPOINT"]
    database_name = os.environ.get("COSMOS_DATABASE_NAME", "trialpulse")
    return CosmosDocumentStatusStore(endpoint=endpoint, database_name=database_name)


@lru_cache(maxsize=1)
def get_pipeline() -> IngestionPipeline:
    return IngestionPipeline(
        embedder=get_embedder(), index=get_index(), document_status_store=get_document_status_store()
    )


@lru_cache(maxsize=1)
def get_expected_client_state() -> str:
    """The shared secret SharePoint's `clientState` must match on every
    change notification (F1).

    Required, not merely defaulted to `""`: an unset value must never
    silently authenticate every caller.
    `sharepoint.SharePointConnector.handle_webhook_notification` already
    rejects unconditionally when the expected value is falsy as defense
    in depth, but the fix starts here -- read via `os.environ[...]` (not
    `.get`), exactly like `get_embedder()`/`get_index()` above, so a
    misconfigured deployment (an unresolved Key Vault reference, an RBAC
    propagation delay, a setting dropped in an edit) fails loudly the
    first time the webhook fires instead of quietly authenticating
    nobody -- or, before this fix, everybody.
    """
    return os.environ["SHAREPOINT_WEBHOOK_CLIENT_STATE"]


@lru_cache(maxsize=1)
def get_graph_client() -> GraphClient:
    return GraphSharePointClient()


@lru_cache(maxsize=1)
def get_metadata_resolver() -> GraphItemMetadataResolver:
    """Resolves a queued `IngestionJob` into `DocumentMetadata` (F10).

    Defaults to `unconfigured_metadata_resolver`, which fails loudly and
    specifically -- see its docstring and ingestion/README.md, "Remaining
    production wiring", for why there is no default SharePoint
    column-name mapping to fall back to.
    """
    return unconfigured_metadata_resolver


@lru_cache(maxsize=1)
def get_sharepoint_connector() -> SharePointConnector:
    delta_link_store = InMemoryDeltaLinkStore()  # production: back this with durable storage (e.g. Table Storage)
    return SharePointConnector(get_graph_client(), delta_link_store, enqueue=_enqueue_via_queue_client)


def _enqueue_via_queue_client(job: IngestionJob) -> None:
    """Send an `IngestionJob` onto the ingest queue outside an HTTP/queue
    trigger context (used by the timer-driven delta sync). Azure Functions
    output bindings only work inside a triggered function, so the delta sync
    handler uses this direct Queue Storage client instead.

    The client authenticates with the function app's managed identity, not a
    connection string: the storage account is provisioned with
    `allowSharedKeyAccess: false` (infra/modules/storage.bicep), so
    `QueueClient.from_connection_string` cannot work against it. The account
    URL arrives as `AZURE_STORAGE_QUEUE_ACCOUNT_URL`; the host's own
    identity-based `AzureWebJobsStorage__queueServiceUri` setting is accepted
    as a fallback so the two stay interchangeable.
    """
    from azure.identity import DefaultAzureCredential  # noqa: PLC0415 -- lazy, only needed in production
    from azure.storage.queue import QueueClient  # noqa: PLC0415 -- lazy, only needed in production

    account_url = os.environ.get(QUEUE_ACCOUNT_URL_SETTING) or os.environ.get(
        f"{STORAGE_CONNECTION_SETTING}__queueServiceUri"
    )
    if not account_url:
        raise RuntimeError(
            f"Neither {QUEUE_ACCOUNT_URL_SETTING} nor "
            f"{STORAGE_CONNECTION_SETTING}__queueServiceUri is set; the delta sync "
            "cannot enqueue ingestion jobs."
        )

    client = QueueClient(
        account_url=account_url,
        queue_name=INGEST_QUEUE_NAME,
        credential=DefaultAzureCredential(),
    )
    client.send_message(json.dumps(asdict(job)))


app = func.FunctionApp()


@app.route(route="webhooks/sharepoint", auth_level=func.AuthLevel.ANONYMOUS, methods=["GET", "POST"])
@app.queue_output(arg_name="outmsg", queue_name=INGEST_QUEUE_NAME, connection=STORAGE_CONNECTION_SETTING)
def sharepoint_webhook(req: func.HttpRequest, outmsg: func.Out[list[str]]) -> func.HttpResponse:
    """SharePoint change notification endpoint (PRD 5.3).

    Handles the Graph subscription validation handshake (a GET/POST with a
    `validationtoken` query parameter must be echoed back as plain text
    within 5 seconds) and, for real notifications, validates `clientState`
    per notification before enqueueing a re-ingestion job for each accepted
    one.
    """
    validation_token = req.params.get("validationtoken")
    if validation_token is not None:
        return func.HttpResponse(validation_token, status_code=200, mimetype="text/plain")

    try:
        payload = req.get_json()
    except ValueError:
        return func.HttpResponse("Malformed JSON body", status_code=400)

    expected_client_state = get_expected_client_state()
    site_id = os.environ.get("SHAREPOINT_SITE_ID", "")
    drive_id = os.environ.get("SHAREPOINT_DRIVE_ID", "")

    connector = get_sharepoint_connector()
    with traced_span("sharepoint_webhook"):
        result = connector.handle_webhook_notification(
            payload, expected_client_state=expected_client_state, site_id=site_id, drive_id=drive_id
        )

    log_event(_logger, "webhook_received", accepted=len(result.accepted), rejected=len(result.rejected))

    outmsg.set(
        [
            json.dumps(
                {"site_id": site_id, "drive_id": drive_id, "item_id": n.resource, "reason": "webhook"}
            )
            for n in result.accepted
        ]
    )
    return func.HttpResponse(
        json.dumps({"accepted": len(result.accepted), "rejected": len(result.rejected)}),
        status_code=202,
        mimetype="application/json",
    )


@app.queue_trigger(arg_name="msg", queue_name=INGEST_QUEUE_NAME, connection=STORAGE_CONNECTION_SETTING)
@app.queue_output(arg_name="deadletter", queue_name=DEAD_LETTER_QUEUE_NAME, connection=STORAGE_CONNECTION_SETTING)
def ingest_document_queue(msg: func.QueueMessage, deadletter: func.Out[str]) -> None:
    """Ingest exactly one document per queue message.

    Retries transient failures (PRD 3.3.1: "Exponential backoff with 3
    retries for transient failures; dead-letter queue after final
    failure."). The queue-based design (rather than ingesting directly from
    the webhook) is what prevents a SharePoint webhook flood from
    overwhelming the pipeline -- Azure Functions' queue trigger naturally
    rate-limits concurrent processing.
    """
    job_payload = json.loads(msg.get_body().decode("utf-8"))
    job = IngestionJob(**job_payload)

    def do_ingest() -> None:
        # F10: download -> extract -> chunk -> hash -> embed -> index is
        # fully wired below and exercised by
        # tests/test_function_app_queue_trigger.py against fakes. The one
        # remaining gap is `get_metadata_resolver()`: resolving a queued
        # job into full DocumentMetadata (title, classification, version,
        # supersedes, effective_date, site_code) requires knowing the real
        # TrialPulse SharePoint document library's list column schema,
        # which nothing in this repository documents (see
        # ingestion/README.md, "Remaining production wiring"). By default
        # that raises a specific, non-retried
        # `DocumentMetadataResolutionError` rather than guessing at column
        # names.
        doc_meta: DocumentMetadata = get_metadata_resolver()(job)
        content = get_graph_client().download_item_content(job.drive_id, job.item_id)
        temp_path = _materialize_to_temp_file(content, doc_meta.filename)
        try:
            get_pipeline().ingest_document(doc_meta, temp_path)
        finally:
            temp_path.unlink(missing_ok=True)

    outcome = with_retry(do_ingest, operation="ingest_document_queue", context={"job": asdict(job)})
    if not outcome.succeeded:
        assert outcome.dead_letter is not None
        log_event(_logger, "ingestion_dead_lettered", **asdict(outcome.dead_letter))
        deadletter.set(json.dumps(asdict(outcome.dead_letter)))


@app.timer_trigger(schedule="0 0 3 * * *", arg_name="timer", run_on_startup=False)
def daily_delta_sync(timer: func.TimerRequest) -> None:
    """Daily catch-up sync against Microsoft Graph delta, plus subscription
    renewal (PRD risk 11.3: webhooks can miss events; this is the safety
    net)."""
    site_id = os.environ.get("SHAREPOINT_SITE_ID", "")
    drive_id = os.environ.get("SHAREPOINT_DRIVE_ID", "")
    initial_delta_url = (
        f"https://graph.microsoft.com/v1.0/sites/{site_id}/drives/{drive_id}/root/delta"
    )
    connector = get_sharepoint_connector()
    with traced_span("daily_delta_sync", site_id=site_id, drive_id=drive_id):
        result = connector.run_delta_sync(site_id=site_id, drive_id=drive_id, initial_delta_url=initial_delta_url)
    log_event(
        _logger,
        "delta_sync_completed",
        changed=len(result.changed),
        deleted=len(result.deleted),
        enqueued=result.enqueued,
    )


@app.timer_trigger(schedule="0 30 3 * * *", arg_name="timer", run_on_startup=False)
def tombstone_purge(timer: func.TimerRequest) -> None:
    """Permanently remove chunks whose tombstone retention window has elapsed
    (PRD decision 2: "old hashes are tombstoned after 30 days")."""
    index = get_index()
    now = datetime.now(UTC)
    with traced_span("tombstone_purge"):
        purged = index.purge_tombstones(as_of=now)
    log_event(_logger, "tombstones_purged", count=purged)


def _materialize_to_temp_file(content: bytes, filename: str) -> Path:
    """Write downloaded document bytes to a temp path for `extraction.py`,
    which operates on `Path` rather than raw bytes."""
    suffix = Path(filename).suffix
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
        handle.write(content)
        return Path(handle.name)


__all__ = ["app"]
