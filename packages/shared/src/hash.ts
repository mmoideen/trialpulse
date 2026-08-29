import { createHash } from 'node:crypto';

/**
 * Normalise text before hashing so that cosmetic differences (line endings,
 * runs of whitespace, non-breaking spaces from Word exports) do not produce a
 * new content hash and therefore a duplicate chunk.
 *
 * The Python ingestion pipeline implements the identical normalisation in
 * `ingestion/trialpulse_ingest/hashing.py`; the two must stay in lockstep or
 * idempotency breaks across languages. `ingestion/tests/test_hash_parity.py`
 * asserts the parity, and any change here needs a matching change there plus a
 * new parity fixture.
 */
/**
 * Unpaired UTF-16 surrogates. Text extracted from legacy or OCR tooling can
 * carry these. Node's Buffer encoder silently substitutes U+FFFD for them
 * while Python's raises `UnicodeEncodeError`, so we substitute explicitly in
 * both languages rather than relying on either runtime's default -- otherwise
 * one side crashes on a document the other side hashes happily.
 */
const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function normalizeText(text: string): string {
  return text
    // NFC first, so that text which is visually and semantically identical but
    // encoded with combining characters (as some authoring tools and operating
    // systems save accented characters) hashes to the same value. Without this
    // the same unchanged section re-ingests as a new chunk, and a version diff
    // reports it as "changed".
    .normalize('NFC')
    .replace(LONE_SURROGATE_RE, '\uFFFD')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim()
    .toLowerCase();
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** SHA-256 of normalised chunk text — the idempotency key for ingestion. */
export function contentHash(text: string): string {
  return sha256(normalizeText(text));
}

/** SHA-256 of the normalised query — used for cache keys and audit joins. */
export function queryHash(query: string): string {
  return sha256(normalizeText(query));
}

/** Cache key for a query embedding, scoped by role so caches cannot cross roles. */
export function embeddingCacheKey(query: string, role: string): string {
  return `emb:${role}:${queryHash(query)}`;
}
