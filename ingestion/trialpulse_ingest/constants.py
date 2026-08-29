"""Tunable thresholds shared with the TypeScript side of TrialPulse.

This module MUST mirror `packages/shared/src/constants.ts` for the four
values below. The two files are read by different language toolchains and
cannot import one another, so `ingestion/tests/test_constants_drift.py`
parses the TypeScript source with a regex and asserts the two stay in sync.
If you change a value here, change it in constants.ts in the same commit (or
vice versa) or the drift test will fail.
"""

from __future__ import annotations

from typing import Final

# Chunking parameters for the ingestion pipeline.
CHUNK_TARGET_TOKENS: Final[int] = 512
CHUNK_OVERLAP_TOKENS: Final[int] = 64

# Embedding dimensions for text-embedding-3-large.
EMBEDDING_DIMENSIONS: Final[int] = 3072

# Tombstoned chunks are purged this many days after supersession.
TOMBSTONE_RETENTION_DAYS: Final[int] = 30

# --- Ingestion-only constants (no TypeScript equivalent) -------------------
# These are internal to the Python pipeline and are not part of the
# cross-language contract, so they are not subject to the drift test.

#: Default batch size for embedding requests. Azure OpenAI batch embedding
#: endpoints accept up to 2048 inputs per request for text-embedding-3-large,
#: but we default much lower to stay comfortably under per-request token
#: limits for long clinical chunks and to keep rate-limit backoff granular.
DEFAULT_EMBEDDING_BATCH_SIZE: Final[int] = 16

#: Retry policy (PRD 3.3.1: "Exponential backoff with 3 retries for
#: transient failures; dead-letter queue after final failure.").
MAX_RETRY_ATTEMPTS: Final[int] = 3
RETRY_BASE_DELAY_SECONDS: Final[float] = 1.0
RETRY_MAX_DELAY_SECONDS: Final[float] = 30.0

#: How long before a Microsoft Graph webhook subscription expires that we
#: proactively renew it. Graph subscriptions on SharePoint lists/drives max
#: out at a ~3-day (4230 minute) expiration, so a 24h renewal buffer leaves
#: ample margin even if the renewal timer job itself slips by a day.
SUBSCRIPTION_RENEWAL_BUFFER_HOURS: Final[int] = 24

#: Maximum lifetime the ingestion pipeline requests for a new Graph
#: subscription, in days. Kept below Graph's hard cap for drive resources.
SUBSCRIPTION_MAX_LIFETIME_DAYS: Final[int] = 3

#: Safety cap on the number of Graph delta pages a single `run_delta_sync`
#: call will follow before giving up. Without this, a response (or a
#: poisoned persisted delta link) that always returns a `next_link` and
#: never a `delta_link` loops forever, growing memory and enqueueing
#: without bound. Real SharePoint drives with normal daily churn are
#: nowhere near this many pages in one sync run; hitting the cap means the
#: delta link itself is broken, not that there is legitimately this much
#: change to process.
MAX_DELTA_SYNC_PAGES: Final[int] = 1000

#: Safety cap on the total number of changed+deleted items a single
#: `run_delta_sync` call will accumulate, for the same reason as
#: MAX_DELTA_SYNC_PAGES above.
MAX_DELTA_SYNC_ITEMS: Final[int] = 100_000
