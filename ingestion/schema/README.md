# `search-index.json`

The Azure AI Search index definition for `trialpulse-chunks`, created/updated
by `scripts/create_index.py`.

This file is sent as-is to the Azure AI Search REST API (`PUT
/indexes/trialpulse-chunks`), so it intentionally contains **no** extra
`$comment`-style keys that the API would reject as unknown properties. This
README is the sibling documentation the ingestion task asked for instead.

## Fields that match PRD section 4.2 exactly

`chunk_id`, `document_id`, `document_title`, `document_classification`,
`document_version`, `content`, `content_hash`, `heading_path`,
`page_number`, `source_url`, `ingested_at`, `embedding` -- these are
transcribed directly from the PRD with the flags from PRD section 4.3
applied (`document_classification`, `document_id`, and `content_hash` are
all filterable; `document_id` and `document_version` are also sortable to
support version-comparison queries).

One correction from the PRD's illustrative JSON: the PRD's `embedding`
field uses the legacy `vectorSearchConfiguration` property name. Current
Azure AI Search API versions use `vectorSearchProfile` (pointing at a named
profile under a top-level `vectorSearch` block), which is what this file
implements -- see the `vectorSearch.profiles` / `vectorSearch.algorithms`
blocks. The HNSW parameters (`m: 16`, `efConstruction: 128`) match PRD
section 4.3 exactly.

## Fields added beyond the PRD, and why

The PRD's index schema (section 4.2) predates the full `Chunk` contract in
`packages/shared/src/types.ts`. Four fields exist in this index but not in
the PRD's illustrative JSON:

- **`site_code`** (`Edm.String`, filterable, facetable) -- required by the
  shared `Chunk` type. The `site_monitor` role's redaction rule (PRD 3.1)
  is "site name masked unless assigned to caller's site", which the
  orchestrator can only enforce if `site_code` is a real, filterable field
  on the chunk.

- **`previous_version_hash`** (`Edm.String`, filterable) -- required by the
  shared `Chunk` type and by Feature 3.2.2 (Document Version Comparison):
  "This requires the ingestion pipeline to tag chunks with
  `document_version` and `previous_version_hash`."

- **`is_tombstoned`** (`Edm.Boolean`, filterable) and
  **`tombstone_purge_after`** (`Edm.DateTimeOffset`, filterable, sortable)
  -- not part of the shared `Chunk` type (deliberately: the orchestrator's
  retrieval/citation logic doesn't need to know about tombstone
  bookkeeping, only that "tombstoned chunks stay searchable until purged"
  per PRD decision 2). These two fields are how `indexing.py` and
  `tombstones.py` implement that behavior against a real Azure AI Search
  index, which has no side channel to store bookkeeping outside its
  documents. `ingestion/trialpulse_ingest/indexing.py`'s docstring has the
  full rationale.
