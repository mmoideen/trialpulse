# TrialPulse Ingestion Pipeline

Azure Functions (Python) pipeline that turns clinical documents into
`Chunk` records in Azure AI Search, per PRD sections 2.3 (decision 2),
3.3.1, 4.2, 4.3, and 8. See `../TRIALPULSE-PRD.md` for the full spec.

```
download -> extract -> chunk -> hash -> embed -> index
```

Every stage is offline-testable: the real Azure SDKs (`azure-identity`,
`azure-search-documents`, `openai`, `python-docx`, `pypdf`) are imported
lazily, so the entire test suite runs with no network access and no Azure
resources provisioned.

## Layout

```
ingestion/
  function_app.py           Azure Functions (Python v2 model) entry points
  host.json                 Functions host configuration
  requirements.txt          Pinned runtime + dev dependencies
  local.settings.example.json  Copy to local.settings.json for `func start`
  pyproject.toml            ruff + pytest configuration
  trialpulse_ingest/        The pipeline package (see module docstrings)
  schema/search-index.json  Azure AI Search index definition
  schema/README.md          Why the index has fields beyond the PRD's JSON
  scripts/generate_corpus.py   Generates data/synthetic/*.md from the manifest
  scripts/create_index.py      Creates/updates the Azure AI Search index
  tests/                    pytest suite (runs fully offline)
```

## Run locally

```bash
cd ingestion
python3 -m venv .venv
./.venv/bin/pip install -q -r requirements.txt

# Regenerate the synthetic corpus (writes into ../data/synthetic/*.md).
./.venv/bin/python scripts/generate_corpus.py

# Run the full test suite (no network access required).
./.venv/bin/python -m pytest -q

# Lint.
./.venv/bin/ruff check .
```

`scripts/generate_corpus.py --check` verifies the committed `.md` files
still match `corpus-manifest.json` without rewriting them (useful in CI to
catch drift between the frozen manifest and the generated fixtures).

### Ingesting the local corpus without any Azure resources

```python
from pathlib import Path
from trialpulse_ingest.embedding import LocalFakeEmbedder
from trialpulse_ingest.indexing import InMemorySearchIndex
from trialpulse_ingest.pipeline import IngestionPipeline, ingest_local_corpus

repo_root = Path("..").resolve()
pipeline = IngestionPipeline(embedder=LocalFakeEmbedder(), index=InMemorySearchIndex())
results = ingest_local_corpus(
    repo_root / "data" / "synthetic" / "corpus-manifest.json",
    repo_root / "data" / "synthetic",
    pipeline,
)
for r in results:
    print(r.document_id, r.chunks_upserted, r.chunks_skipped, r.chunks_tombstoned)
```

This is exactly what `tests/test_end_to_end_corpus.py` does; it is the
fastest way to sanity-check a chunking or hashing change against the real
corpus without touching Azure.

### Running the Azure Functions host locally

```bash
cp local.settings.example.json local.settings.json   # gitignored
# Edit local.settings.json; leave TRIALPULSE_LOCAL_DEV=true to use the
# in-memory index + fake embedder with zero Azure resources provisioned.
func start
```

With `TRIALPULSE_LOCAL_DEV=true`, `get_embedder()`/`get_index()` return
`LocalFakeEmbedder`/`InMemorySearchIndex` instead of real Azure clients (see
`function_app.py`). Set it to `false` (and fill in the real endpoint
settings) to run against actual Azure OpenAI and Azure AI Search resources.

## Run against Azure

1. Provision Azure OpenAI (an embedding deployment of
   `text-embedding-3-large`), Azure AI Search, and an Azure Storage account
   for the Functions queues (see `infra/` for Bicep, owned by the
   infrastructure workstream).
2. Create the search index:
   ```bash
   AZURE_SEARCH_ENDPOINT=https://<service>.search.windows.net \
       ./.venv/bin/python scripts/create_index.py
   ```
   Authenticates via `DefaultAzureCredential` (managed identity in Azure,
   `az login` locally) -- no API keys.
3. Set the remaining app settings from `local.settings.example.json`
   (`AZURE_OPENAI_EMBEDDING_ENDPOINT`, `SHAREPOINT_SITE_ID`,
   `SHAREPOINT_DRIVE_ID`, `SHAREPOINT_WEBHOOK_CLIENT_STATE`, `COSMOS_ENDPOINT`,
   `COSMOS_DATABASE_NAME`, ...) as Function App configuration, pointing
   secrets at Key Vault references rather than literal values (PRD 8.1:
   no secrets in code or plain config).
   `SHAREPOINT_WEBHOOK_CLIENT_STATE` in particular is **required**, not
   optional: `function_app.get_expected_client_state()` reads it with
   `os.environ[...]` (no default), so the webhook endpoint fails loudly on
   its first request rather than silently authenticating every caller if
   the setting is ever unset or a Key Vault reference fails to resolve.
4. Register the SharePoint webhook subscription against
   `POST https://<THIS ingestion function app>/api/webhooks/sharepoint`
   (see `sharepoint.GraphSharePointClient.create_subscription`); the daily
   `daily_delta_sync` timer trigger renews it automatically before
   expiry and re-syncs anything a missed webhook would have dropped.
   **This ingestion Function App is the one and only owner of the
   SharePoint webhook subscription** -- see "Which app owns the
   SharePoint webhook subscription" below; do not also register the
   subscription against the orchestrator's URL.
5. Deploy the Function App (`func azure functionapp publish <name>`).

## Ingestion queue contract

`ingestion-work` is the single ingestion queue (F5). It is the only queue
this package provisions a trigger for (`ingest_document_queue` in
`function_app.py`) and the only one `infra/modules/storage.bicep`
provisions (`ingestionQueueName`); its poison queue is
`ingestion-work-poison`. `infra/main.bicep` sets `TRIALPULSE_INGEST_QUEUE`
to that same name for both this app and the orchestrator, so the
orchestrator's reindex/admin path enqueuing onto `ingestion-work` reaches
this trigger. **Do not enqueue onto any other queue name** (older drafts of
the orchestrator referenced `reindex-jobs`, `sharepoint-reingest-jobs`, and
`sharepoint-delta-sync-jobs` -- none of those are provisioned and nothing
consumes them; that queue-name fragmentation is the bug F5 exists to fix).

Both producers of ingestion work -- the `sharepoint_webhook` HTTP trigger's
queue output binding, and `daily_delta_sync`'s
`function_app._enqueue_via_queue_client` -- publish this exact JSON shape,
one message per document, matching `sharepoint.IngestionJob` field for
field:

```json
{
  "site_id": "string, Microsoft Graph site id",
  "drive_id": "string, Microsoft Graph drive id",
  "item_id": "string, Microsoft Graph drive item id -- validated against the Graph drive-item id charset before use (see sharepoint.validate_graph_item_id); reject/regenerate rather than hand-crafting one",
  "reason": "\"webhook\" | \"delta_sync\" -- audit/telemetry only, not read for branching logic"
}
```

`ingest_document_queue` (`function_app.py`) is the only consumer, and
deserializes the message body with `IngestionJob(**json.loads(...))` --
any producer must send exactly these four string fields, no more, no
fewer, or that call raises `TypeError`. This is the contract any other
producer (e.g. the orchestrator's admin/reindex path) must match exactly.

### Which app owns the SharePoint webhook subscription

`webhooks/sharepoint` is implemented twice in this repository: here
(`function_app.py`'s `sharepoint_webhook`) and in
`packages/orchestrator/src/functions/webhooks-sharepoint.ts` -- two
different apps, two different hostnames. **This ingestion Function App is
the one that should hold the live Microsoft Graph subscription** (step 4
above): it is the app with the SharePoint/Graph credentials and the
`GraphSharePointClient` that actually validates notifications, runs the
catch-up delta sync, and (per F1) enforces the `clientState` shared secret
correctly. The orchestrator's TypeScript twin enqueues onto a
differently-named queue (`sharepoint-reingest-jobs`, per the queue-name
fragmentation noted above) that nothing consumes, and should not be the
subscribed notification URL. Whoever owns the orchestrator's webhook
handler should either point it at this app's queue (matching the exact
shape above) or retire it in favor of this one -- outside this package's
ownership to decide, but the fact needs to be stated plainly somewhere,
and this is that statement.

## Remaining production wiring

Two gaps stand between this repository and a fully working production
ingestion path, both outside `ingestion/`'s own code but worth stating
plainly here since the ingestion pipeline is the component that surfaces
them:

- **SharePoint list item metadata schema (blocks `ingest_document_queue`).**
  `function_app.ingest_document_queue`'s `do_ingest` now does real work --
  download the item's bytes, materialize a temp file, and call
  `IngestionPipeline.ingest_document` -- but it needs a resolved
  `DocumentMetadata` (title, classification, version, supersedes,
  effective_date, site_code) first, and that has to come from the real
  TrialPulse SharePoint document library's list item metadata columns.
  Nothing in this repository documents those columns' real *internal*
  names (which are frequently not the same as the display names shown in
  the library UI). `function_app.get_metadata_resolver()` therefore
  defaults to `sharepoint.unconfigured_metadata_resolver`, which raises a
  specific, non-retried `DocumentMetadataResolutionError` naming exactly
  what's missing rather than guessing at a column mapping that could
  silently misclassify a clinical document. **To finish wiring this up:**
  confirm the real column schema against the SharePoint site, write a
  `GraphItemMetadataResolver` that maps `GraphClient.get_item_metadata`'s
  response through it, and point `get_metadata_resolver()` at it. No other
  code in this package needs to change.
- **Cosmos DB `documents` container app settings + RBAC (blocks F4's
  status writes in Azure mode).** `document_status.CosmosDocumentStatusStore`
  is fully implemented and wired into `IngestionPipeline` (see
  `function_app.get_document_status_store()`), but `infra/main.bicep`
  does not yet pass `COSMOS_ENDPOINT`/`COSMOS_DATABASE_NAME` app settings,
  nor a Cosmos DB data-plane role assignment, to *this* Function App
  (only to the orchestrator's -- see `infra/modules/cosmos.bicep`'s
  `documents` container comment). Until that infra change lands, a real
  Azure deployment's first ingestion attempt fails loudly with
  `KeyError: 'COSMOS_ENDPOINT'` rather than silently doing nothing. This
  is a small, symmetric infra change (the same two setting names already
  used by the orchestrator) outside this package's ownership.

## Design notes and ambiguities resolved

- **Token counting.** The PRD does not specify a tokenizer, and a real BPE
  tokenizer (`tiktoken`) downloads its encoding files over the network on
  first use, which conflicts with "everything must pass with no network
  access." `chunking.py` approximates one token as one whitespace-delimited
  word. This is applied consistently for both `CHUNK_TARGET_TOKENS` sizing
  and `CHUNK_OVERLAP_TOKENS` overlap, so relative chunk boundaries behave
  the same as they would with a real tokenizer, even though the absolute
  count differs from Azure OpenAI's actual tokenizer.
- **`heading_path` vs. version matching.** `heading_path` is stored as
  `"<document_title> > <section path>"`. Because a superseding document
  necessarily has a different title (e.g. "...v3.0" vs "...v4.0"),
  `pipeline.py` matches chunks across versions on the bare *section path*
  (`tombstones.section_path_of`), not the full `heading_path`, when
  stamping `previous_version_hash`.
- **Tombstone bookkeeping lives in the index, not in `Chunk`.** The shared
  `Chunk` type (`packages/shared/src/types.ts`) has no tombstone fields --
  the orchestrator's retrieval logic doesn't need them, since "tombstoned
  chunks stay searchable until purged" (PRD decision 2). `is_tombstoned`
  and `tombstone_purge_after` are real fields on the Azure AI Search index
  (`schema/search-index.json`) and on `indexing.IndexedChunkRecord`, kept
  separate from `Chunk` itself. See `schema/README.md` for the full list of
  fields added beyond the PRD's illustrative JSON and why.
- **`chunk_id` derivation.** Deterministic, not a random UUID: SHA-256 of
  `document_id :: heading_path :: ordinal :: content_hash`. This is what
  makes idempotent upsert possible -- re-ingesting unchanged content always
  produces the same `chunk_id`.
- **Extraction is format-agnostic beyond the extractor.** `.docx` and
  `.pdf` extractors both convert their source format into the same
  markdown-with-page-markers shape `.md` uses natively, so `chunking.py`
  never needs to know which format a document came from.
- **`tombstoned_at` is not a real Azure AI Search index field.** It is
  fully derivable from `tombstone_purge_after -
  TOMBSTONE_RETENTION_DAYS` (`pipeline.py` always tombstones with that
  fixed retention window), so `AzureAISearchIndex.tombstone_document`
  does not write it -- Azure AI Search rejects an entire batch containing
  a field absent from the index schema. `indexing._derive_tombstoned_at`
  reconstructs it on read; `InMemorySearchIndex` (local dev, every
  offline test) stores the real value directly since it has no index
  schema to violate. `tests/test_indexing_azure.py` guards against this
  drifting back: it asserts every field `AzureAISearchIndex` writes
  exists in `schema/search-index.json`, and every field it reads is
  `retrievable`.
- **Page numbers are tracked per source line, not once per section.** A
  section can contain more than one `<!-- page: N -->` marker (a long
  section spanning a page break); `chunking.chunk_markdown` tags every
  content line with the page active when it was read and recovers the
  correct page for each resulting chunk even after a section is split
  into several chunks, rather than stamping every chunk from a section
  with only its first page.
- **`supersedes` is validated before it is allowed to tombstone
  anything.** `tombstones.validate_supersession` rejects an ingesting
  document whose version is not strictly newer than the document it
  claims to supersede (when both parse as dotted-numeric, e.g. "3.0" ->
  "4.0"), and rejects a direct two-document `supersedes` cycle. Without
  this, an older or malformed document could silently tombstone a newer,
  correct one.
- **Content hashing is Unicode-normalized before hashing.** `hashing.py`
  NFC-normalizes and substitutes unpaired UTF-16 surrogates with U+FFFD as
  the first two steps of `normalize_text`, mirroring
  `packages/shared/src/hash.ts`'s `normalizeText` exactly (same order).
  Without this, NFC vs. NFD spellings of identical text -- or a lone
  surrogate from OCR/legacy-tool output, which crashes Python's
  `str.encode("utf-8")` outright -- would hash differently or crash
  ingestion depending on which language (or which normal form) touched
  the text last, breaking the idempotency guarantee PRD decision 2 relies
  on.
