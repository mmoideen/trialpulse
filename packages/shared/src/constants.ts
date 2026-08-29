/** Tunable thresholds and limits shared across TrialPulse services. */

/** PRD decision 3: chunks below this cosine similarity are discarded. */
export const RELEVANCE_THRESHOLD = 0.72;

/** PRD section 8.1: query length cap. */
export const MAX_QUERY_LENGTH = 1000;

/** Minimum query length worth searching for. */
export const MIN_QUERY_LENGTH = 3;

/** Number of candidates requested from Azure AI Search before thresholding. */
export const SEARCH_TOP_K = 20;

/** Embedding dimensions for text-embedding-3-large. */
export const EMBEDDING_DIMENSIONS = 3072;

/** Conversation history TTL, in seconds (30 days). */
export const CONVERSATION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Query embedding cache TTL, in seconds (1 hour). */
export const EMBEDDING_CACHE_TTL_SECONDS = 60 * 60;

/** Conversation history page size for the Ask tab. */
export const CONVERSATION_PAGE_SIZE = 20;

/** Cost guardrails (USD). */
export const DAILY_COST_HARD_CAP_USD = 500;
export const COST_SPIKE_MULTIPLIER = 1.5;
/**
 * D5(a): the "hard cap" being crossed (`spend24h > dailyCostCapUsd`) forces
 * the cheaper model (see `COST_DOWNGRADE_CACHE_KEY`), but non-zero spend
 * continues either way, and re-evaluation only happened hourly -- a burst
 * could exceed the cap by an unbounded multiple within that detection lag,
 * with no code path that ever actually refused a query for cost. Crossing
 * this second, higher threshold sets `COST_HARD_STOP_CACHE_KEY`, which
 * `query-pipeline.ts` checks before any billable work happens at all and
 * refuses outright -- a genuine hard stop, not an advisory one.
 */
export const DAILY_COST_HARD_STOP_MULTIPLIER = 2;

/** Circuit breaker on the Azure OpenAI generation call. */
export const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3;
export const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000;

/** Chunking parameters for the ingestion pipeline. */
export const CHUNK_TARGET_TOKENS = 512;
export const CHUNK_OVERLAP_TOKENS = 64;

/** Tombstoned chunks are purged this many days after supersession. */
export const TOMBSTONE_RETENTION_DAYS = 30;

/** Audit retention (PRD 8.5): 7 years hot+cold, 90 days before archive. */
export const AUDIT_ARCHIVE_AFTER_DAYS = 90;
export const AUDIT_RETENTION_YEARS = 7;

/** Terms that force the higher-reasoning model regardless of query length. */
export const HIGH_REASONING_KEYWORDS = [
  'safety',
  'regulatory',
  'adverse',
  'serious adverse',
  'sae',
  'ind',
  'nda',
  'fda',
  'submission',
  'deviation',
  'protocol amendment',
] as const;

/** Queries shorter than this (in tokens, approximated) may use the mini model. */
export const MINI_MODEL_TOKEN_THRESHOLD = 100;
