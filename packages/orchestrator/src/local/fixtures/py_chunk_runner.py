#!/usr/bin/env python3
"""Runs the REAL production Python ingestion pipeline over `data/synthetic/`
and writes the resulting chunks as JSON, so
`packages/orchestrator/src/local/chunk-parity.test.ts` can assert the
TypeScript chunker in `local/corpus.ts` produces an identical chunk set.

This is the mirror image of `ingestion/tests/fixtures/ts_hash_runner.cjs`,
which shells out from Python to Node to check hash.ts parity; this shells
out from Node to Python (`ingestion/.venv/bin/python`) to check chunking
parity. It exercises the actual production modules
(`trialpulse_ingest.chunking`, `.pipeline`, `.tombstones`, `.hashing`,
`.extraction`) via `ingest_local_corpus` -- not a hand-copied
reimplementation of them -- with an in-memory index and a local
deterministic embedder (`InMemorySearchIndex` / `LocalFakeEmbedder`, the
same fakes `ingestion/tests/test_end_to_end_corpus.py` uses) so no network
access or real Azure resources are required.

Usage: python py_chunk_runner.py <repo-root-absolute-path> <output-json-path>
Chunk records are written to <output-json-path> (embeddings omitted -- they
are irrelevant to chunk-shape parity and would bloat the file). Nothing
meaningful is written to stdout: the pipeline's own structured JSON logging
writes there too, and interleaving it with a JSON payload would make this
script fragile to parse from the Node side for no benefit.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 3:
        print("usage: py_chunk_runner.py <repo-root-absolute-path> <output-json-path>", file=sys.stderr)
        raise SystemExit(2)

    repo_root = Path(sys.argv[1]).resolve()
    output_path = Path(sys.argv[2]).resolve()
    ingestion_dir = repo_root / "ingestion"

    # `trialpulse_ingest` is not installed into the venv's site-packages
    # (see ingestion/README.md) -- it's importable by running Python with
    # `ingestion/` as the working directory or on sys.path. Since this
    # script does not live under `ingestion/` (this repo's ownership split
    # keeps this fixture under packages/orchestrator/), add it explicitly
    # rather than relying on the caller's cwd.
    sys.path.insert(0, str(ingestion_dir))

    from trialpulse_ingest.embedding import LocalFakeEmbedder
    from trialpulse_ingest.indexing import InMemorySearchIndex
    from trialpulse_ingest.pipeline import IngestionPipeline, ingest_local_corpus

    manifest_path = repo_root / "data" / "synthetic" / "corpus-manifest.json"
    corpus_dir = repo_root / "data" / "synthetic"

    index = InMemorySearchIndex()
    pipeline = IngestionPipeline(embedder=LocalFakeEmbedder(), index=index)
    ingest_local_corpus(manifest_path, corpus_dir, pipeline)

    chunks = [record.chunk for record in index.all_records()]
    payload = [
        {
            "chunk_id": c.chunk_id,
            "document_id": c.document_id,
            "document_title": c.document_title,
            "document_classification": c.document_classification,
            "document_version": c.document_version,
            "content": c.content,
            "content_hash": c.content_hash,
            "heading_path": c.heading_path,
            "page_number": c.page_number,
            "source_url": c.source_url,
            "site_code": c.site_code,
            "previous_version_hash": c.previous_version_hash,
        }
        for c in chunks
    ]
    output_path.write_text(json.dumps(payload), encoding="utf-8")


if __name__ == "__main__":
    main()
