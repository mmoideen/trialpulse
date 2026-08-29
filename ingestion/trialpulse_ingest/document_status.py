"""Per-document ingestion status, written to Cosmos DB's `documents`
container so the orchestrator's Browse tab and version-compare's document
lookup are ever populated.

`infra/modules/cosmos.bicep` provisions the `documents` container
(partition key `/document_classification`) and documents plainly that
nothing writes to it: "the Python ingestion pipeline has no Cosmos client
and no Cosmos role assignment." The ingestion pipeline is the only
component that knows a document's ingestion status, chunk count, and
last-ingested time -- this module is the write side of that contract.

`DocumentStatus` mirrors the `DocumentStatus` interface in
`packages/shared/src/types.ts` field for field; `CosmosDocumentStatusStore`
writes it the same way `packages/orchestrator/src/providers/azure/
azure-document-metadata.ts` reads it (`{ id: status.document_id,
...status }`, partitioned by `document_classification`).

As with `indexing.py`'s `SearchIndex`, the real Cosmos client sits behind
an injectable `DocumentStatusStore` interface with an in-memory fake, so
the whole pipeline stays offline-testable.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Final, Literal, Protocol, get_args

# Mirrors IngestionStatus in packages/shared/src/types.ts.
IngestionStatus = Literal["pending", "indexed", "failed", "outdated"]
INGESTION_STATUSES: Final[tuple[str, ...]] = get_args(IngestionStatus)


@dataclass(frozen=True, slots=True)
class DocumentStatus:
    """Field-for-field mirror of the `DocumentStatus` interface in
    packages/shared/src/types.ts. Do not add ingestion-internal fields
    here -- this is the shared contract the orchestrator reads verbatim
    (see `models.py`'s docstring for why `Chunk` follows the same rule)."""

    document_id: str
    document_title: str
    document_classification: str
    document_version: str
    status: IngestionStatus
    chunk_count: int
    last_ingested_at: str | None
    error_message: str | None
    source_url: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class DocumentStatusStore(Protocol):
    """Common interface implemented by the real Cosmos DB client and the
    in-memory fake used throughout the test suite."""

    def upsert(self, status: DocumentStatus) -> None:
        """Create or replace the status record for `status.document_id`."""
        ...

    def get(self, document_id: str) -> DocumentStatus | None:
        """The current status record for `document_id`, or None if this
        document has never been ingested. Used to preserve `chunk_count`/
        `last_ingested_at` from a prior success when a re-ingestion attempt
        fails (see `pipeline.IngestionPipeline._record_failure`)."""
        ...


class InMemoryDocumentStatusStore:
    """In-memory fake of `DocumentStatusStore`. Used by every offline test
    and by local development runs that don't need a real Cosmos DB
    resource. This is `IngestionPipeline`'s default when no store is
    injected, so every existing call site keeps working unchanged."""

    def __init__(self) -> None:
        self._by_document_id: dict[str, DocumentStatus] = {}

    def upsert(self, status: DocumentStatus) -> None:
        self._by_document_id[status.document_id] = status

    def get(self, document_id: str) -> DocumentStatus | None:
        return self._by_document_id.get(document_id)

    def all(self) -> list[DocumentStatus]:
        return list(self._by_document_id.values())


class CosmosDocumentStatusStore:
    """Real Cosmos DB client for the `documents` container.

    Lazily imports `azure.cosmos` so importing this module never requires
    the package to be installed unless this class is actually instantiated
    (production only -- never the offline test suite). Authenticates via
    managed identity per PRD 8.1 (no keys in code). Partitioned by
    `/document_classification` (`infra/modules/cosmos.bicep`), matching
    the shape `azure-document-metadata.ts` queries.

    `infra/main.bicep` supplies `COSMOS_ENDPOINT`/`COSMOS_DATABASE_NAME`
    to the ingestion Function App, and `infra/modules/rbac.bicep`'s
    `ingestionCosmosDocumentsContributor` scopes its data-plane role to
    the `documents` container alone.
    """

    _CONTAINER_NAME = "documents"

    def __init__(self, *, endpoint: str, database_name: str, credential: object | None = None) -> None:
        self._endpoint = endpoint
        self._database_name = database_name
        self._credential = credential
        self._container = None

    def _get_container(self):  # noqa: ANN202 -- lazily-imported ContainerProxy type
        if self._container is not None:
            return self._container
        from azure.cosmos import CosmosClient  # noqa: PLC0415

        credential = self._credential
        if credential is None:
            from azure.identity import DefaultAzureCredential  # noqa: PLC0415

            credential = DefaultAzureCredential()
        cosmos_client = CosmosClient(url=self._endpoint, credential=credential)
        self._container = cosmos_client.get_database_client(self._database_name).get_container_client(
            self._CONTAINER_NAME
        )
        return self._container

    def upsert(self, status: DocumentStatus) -> None:
        container = self._get_container()
        # Cosmos requires an "id" field; document_id is unique per
        # document, so it doubles as the item id, matching
        # azure-document-metadata.ts's `{ id: status.document_id,
        # ...status }`.
        container.upsert_item({"id": status.document_id, **status.to_dict()})

    def get(self, document_id: str) -> DocumentStatus | None:
        container = self._get_container()
        results = list(
            container.query_items(
                query="SELECT * FROM c WHERE c.document_id = @id",
                parameters=[{"name": "@id", "value": document_id}],
                enable_cross_partition_query=True,
            )
        )
        if not results:
            return None
        doc = results[0]
        return DocumentStatus(
            document_id=doc["document_id"],
            document_title=doc["document_title"],
            document_classification=doc["document_classification"],
            document_version=doc["document_version"],
            status=doc["status"],
            chunk_count=doc["chunk_count"],
            last_ingested_at=doc.get("last_ingested_at"),
            error_message=doc.get("error_message"),
            source_url=doc["source_url"],
        )
