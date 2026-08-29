/**
 * In-memory `SearchProvider` for local dev, unit tests and the eval harness.
 *
 * Two things deserve special care here because a bug in either is an RBAC
 * bypass, not just a quality bug:
 *
 *  1. `parseClassificationFilter` -- `buildSearchFilter()` (the frozen
 *     contract in `@trialpulse/shared`) emits exactly one of: `null`
 *     (unrestricted), a single `document_classification eq '<x>'` clause, a
 *     parenthesised `(... or ... or ...)` disjunction of that clause, or the
 *     defensive "match nothing" expression. This parser accepts *only* those
 *     shapes and throws on anything else. Silently ignoring an unrecognised
 *     filter and returning unfiltered results would be a silent RBAC bypass,
 *     so we fail loudly and closed instead.
 *
 *  2. Relevance scoring -- calibrated so that `RELEVANCE_THRESHOLD` (0.72)
 *     behaves the way the real Azure AI Search cosine threshold is expected
 *     to behave in production: full lexical coverage of the content-bearing
 *     query terms should reliably clear the bar, partial overlap should
 *     land in a middle band, and unrelated content should score low. See
 *     `computeRelevanceScore` for the exact formula and
 *     `memory-search.test.ts` for the pinned real-corpus examples.
 */
import {
  DOCUMENT_CLASSIFICATIONS,
  type Chunk,
  type DocumentClassification,
  type DocumentStatus,
  type ScoredChunk,
} from '@trialpulse/shared';
import type { HybridSearchOptions, SearchProvider } from '../types';
import { embedDeterministic, tokenize } from './memory-embeddings';

function isClassification(value: string): value is DocumentClassification {
  return (DOCUMENT_CLASSIFICATIONS as readonly string[]).includes(value);
}

/** The exact "match nothing" expression `buildSearchFilter` emits for an empty allow-list. */
const MATCH_NOTHING_FILTER = "document_classification eq null and document_classification ne null";

const CLASSIFICATION_CLAUSE_PATTERN = /^document_classification eq '((?:[^']|'')*)'$/;

/**
 * Parse the OData `$filter` string emitted by `buildSearchFilter(role)` into
 * the set of allowed classifications, or `null` for "unrestricted".
 * Throws on any shape it does not recognise -- see module doc.
 */
export function parseClassificationFilter(filter: string | null): DocumentClassification[] | null {
  if (filter === null) return null;
  if (filter === MATCH_NOTHING_FILTER) return [];

  let inner = filter.trim();
  if (inner.startsWith('(') && inner.endsWith(')')) {
    inner = inner.slice(1, -1);
  }

  const clauses = inner.split(' or ');
  const result: DocumentClassification[] = [];
  for (const rawClause of clauses) {
    const clause = rawClause.trim();
    const match = clause.match(CLASSIFICATION_CLAUSE_PATTERN);
    if (!match?.[1]) {
      throw new Error(
        `memory-search: unsupported $filter clause "${clause}". Refusing to silently ignore an ` +
          'RBAC filter -- this would be a leakage vector, not just a quality bug.',
      );
    }
    const value = match[1].replace(/''/g, "'");
    if (!isClassification(value)) {
      throw new Error(`memory-search: unknown document_classification "${value}" in $filter.`);
    }
    result.push(value);
  }
  return result;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'what', 'when', 'how', 'does',
  'do', 'did', 'was', 'were', 'this', 'that', 'with', 'by', 'from', 'as', 'it', 'its', 'be', 'been', 'has', 'have',
  'had', 'can', 'could', 'will', 'would', 'should', 'about', 'into', 'than', 'then', 'there', 'their', 'they',
  'you', 'your', 'we', 'our', 'i', 'my', 'any', 'all', 'which', 'who',
]);

/** Very light suffix stripping so "disorder"/"disorders", "report"/"reported" line up for coverage purposes. */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('es')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function contentBearingTerms(query: string): string[] {
  return tokenize(query)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

/** Fraction of the query's content-bearing terms that appear (after stemming) in `text`. */
function lexicalCoverage(query: string, text: string): number {
  const queryTerms = contentBearingTerms(query);
  if (queryTerms.length === 0) return 0;
  const textTerms = new Set(tokenize(text).map(stem));
  const hits = queryTerms.filter((t) => textTerms.has(t)).length;
  return hits / queryTerms.length;
}

function dotProduct(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

// Weights chosen so that full lexical coverage (1.0) guarantees a score
// >= 0.8 regardless of the cosine term (0.8*1 + 0.2*0 = 0.8), while
// unrelated content (near-zero coverage and low cosine) stays well under
// 0.3. See memory-search.test.ts for pinned real-corpus examples across all
// three bands.
const COVERAGE_WEIGHT = 0.8;
const COSINE_WEIGHT = 0.2;

/**
 * Combine deterministic vector cosine with lexical term coverage into a
 * single [0, 1] relevance score, searching across a chunk's content, title
 * and heading path (mirroring Azure AI Search's searchable fields).
 */
export function computeRelevanceScore(queryText: string, queryVector: readonly number[], chunk: Chunk): number {
  const searchableText = `${chunk.content} ${chunk.document_title} ${chunk.heading_path}`;
  const coverage = lexicalCoverage(queryText, searchableText);
  const chunkVector = chunk.embedding ?? embedDeterministic(searchableText);
  const cosine = Math.max(0, Math.min(1, dotProduct(queryVector, chunkVector)));
  return Math.max(0, Math.min(1, COVERAGE_WEIGHT * coverage + COSINE_WEIGHT * cosine));
}

function statusFromChunks(documentId: string, chunks: readonly Chunk[]): DocumentStatus {
  const first = chunks[0];
  if (!first) {
    throw new Error(`memory-search: cannot build a DocumentStatus for "${documentId}" with zero chunks.`);
  }
  return {
    document_id: documentId,
    document_title: first.document_title,
    document_classification: first.document_classification,
    document_version: first.document_version,
    status: 'indexed',
    chunk_count: chunks.length,
    last_ingested_at: chunks.reduce<string | null>(
      (latest, c) => (latest === null || c.ingested_at > latest ? c.ingested_at : latest),
      null,
    ),
    error_message: null,
    source_url: first.source_url,
  };
}

export class MemorySearchProvider implements SearchProvider {
  private readonly chunksById = new Map<string, Chunk>();

  constructor(initialChunks: readonly Chunk[] = []) {
    for (const chunk of initialChunks) {
      this.chunksById.set(chunk.chunk_id, { ...chunk, embedding: chunk.embedding ?? this.embedChunk(chunk) });
    }
  }

  private embedChunk(chunk: Chunk): number[] {
    return embedDeterministic(`${chunk.content} ${chunk.document_title} ${chunk.heading_path}`);
  }

  hybridSearch(options: HybridSearchOptions): Promise<ScoredChunk[]> {
    const allowed = parseClassificationFilter(options.filter);
    const documentIdSet = options.documentIds ? new Set(options.documentIds) : null;

    const candidates: ScoredChunk[] = [];
    for (const chunk of this.chunksById.values()) {
      if (allowed !== null && !allowed.includes(chunk.document_classification)) continue;
      if (documentIdSet && !documentIdSet.has(chunk.document_id)) continue;
      const similarity_score = computeRelevanceScore(options.queryText, options.queryVector, chunk);
      candidates.push({ ...chunk, similarity_score });
    }

    candidates.sort((a, b) => b.similarity_score - a.similarity_score);
    return Promise.resolve(candidates.slice(0, options.top));
  }

  upsertChunks(chunks: Chunk[]): Promise<{ upserted: number; skipped: number }> {
    let upserted = 0;
    let skipped = 0;
    for (const chunk of chunks) {
      // Idempotency per PRD decision 2: a chunk with an already-seen content
      // hash under the same chunk_id is a no-op re-ingestion, not a new write.
      const existing = this.chunksById.get(chunk.chunk_id);
      if (existing && existing.content_hash === chunk.content_hash) {
        skipped += 1;
        continue;
      }
      this.chunksById.set(chunk.chunk_id, { ...chunk, embedding: chunk.embedding ?? this.embedChunk(chunk) });
      upserted += 1;
    }
    return Promise.resolve({ upserted, skipped });
  }

  deleteByDocumentId(documentId: string): Promise<number> {
    let deleted = 0;
    for (const [id, chunk] of this.chunksById.entries()) {
      if (chunk.document_id === documentId) {
        this.chunksById.delete(id);
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }

  listDocuments(filter: string | null): Promise<DocumentStatus[]> {
    const allowed = parseClassificationFilter(filter);
    const byDocument = new Map<string, Chunk[]>();
    for (const chunk of this.chunksById.values()) {
      if (allowed !== null && !allowed.includes(chunk.document_classification)) continue;
      const list = byDocument.get(chunk.document_id);
      if (list) list.push(chunk);
      else byDocument.set(chunk.document_id, [chunk]);
    }
    const statuses = [...byDocument.entries()].map(([documentId, chunks]) => statusFromChunks(documentId, chunks));
    statuses.sort((a, b) => a.document_title.localeCompare(b.document_title));
    return Promise.resolve(statuses);
  }

  getChunk(chunkId: string): Promise<Chunk | null> {
    return Promise.resolve(this.chunksById.get(chunkId) ?? null);
  }

  countChunks(): Promise<number> {
    return Promise.resolve(this.chunksById.size);
  }
}
