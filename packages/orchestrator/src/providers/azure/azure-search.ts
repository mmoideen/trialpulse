/**
 * Azure AI Search-backed `SearchProvider` (PRD section 4.2 index schema).
 *
 * Not exercised in CI (no network access there), but structured exactly
 * like `memory-search.ts` so the two are interchangeable behind the
 * `SearchProvider` interface and a future integration test suite (run
 * against a real or emulated search service) can assert parity.
 */
import { AzureKeyCredential, SearchClient, type SelectFields } from '@azure/search-documents';
import type { Chunk, DocumentClassification, DocumentStatus, ScoredChunk } from '@trialpulse/shared';
import type { TrialPulseConfig } from '../../config';
import type { HybridSearchOptions, SearchProvider } from '../types';
import { getManagedIdentityCredential } from './credential';
import { isLikelyTransientAzureError, withRetry } from './retry';

// Azure AI Search caps a single indexDocuments batch at 1000 actions.
const MAX_BATCH_SIZE = 1000;
const EMBEDDING_FIELD = 'embedding' as const;

function toScoredChunk(document: Chunk, score: number): ScoredChunk {
  return { ...document, similarity_score: score };
}

class AzureSearchProvider implements SearchProvider {
  private readonly client: SearchClient<Chunk>;

  constructor(config: TrialPulseConfig) {
    const credential = config.search.apiKey
      ? new AzureKeyCredential(config.search.apiKey)
      : getManagedIdentityCredential();
    this.client = new SearchClient<Chunk>(config.search.endpoint, config.search.indexName, credential, {
      serviceVersion: config.search.apiVersion,
    });
  }

  async hybridSearch(options: HybridSearchOptions): Promise<ScoredChunk[]> {
    const filterClauses = [options.filter, this.documentIdsFilter(options.documentIds)].filter(
      (c): c is string => Boolean(c),
    );

    const result = await withRetry(
      () =>
        this.client.search(options.queryText, {
          filter: filterClauses.length > 0 ? filterClauses.join(' and ') : undefined,
          top: options.top,
          vectorSearchOptions: {
            queries: [
              {
                kind: 'vector',
                vector: options.queryVector,
                fields: [EMBEDDING_FIELD] as unknown as SelectFields<Chunk>[],
                kNearestNeighborsCount: options.top,
              },
            ],
          },
        }),
      { isRetryable: isLikelyTransientAzureError },
    );

    const scored: ScoredChunk[] = [];
    for await (const r of result.results) {
      scored.push(toScoredChunk(r.document, r.score ?? 0));
    }
    return scored;
  }

  private documentIdsFilter(documentIds: string[] | undefined): string | null {
    if (!documentIds || documentIds.length === 0) return null;
    const clauses = documentIds.map((id) => `document_id eq '${id.replace(/'/g, "''")}'`);
    return clauses.length === 1 ? clauses[0]! : `(${clauses.join(' or ')})`;
  }

  async upsertChunks(chunks: Chunk[]): Promise<{ upserted: number; skipped: number }> {
    let upserted = 0;
    let skipped = 0;

    // Idempotency (PRD decision 2): skip a chunk whose content_hash is
    // unchanged since the last ingestion. Azure AI Search has no
    // conditional-write primitive, so this is a read-then-write per chunk;
    // ingestion volumes here are small enough (corpus in the low thousands
    // of chunks) that this is not a bottleneck.
    const toWrite: Chunk[] = [];
    for (const chunk of chunks) {
      const existing = await this.getChunk(chunk.chunk_id);
      if (existing && existing.content_hash === chunk.content_hash) {
        skipped += 1;
        continue;
      }
      toWrite.push(chunk);
    }

    for (let i = 0; i < toWrite.length; i += MAX_BATCH_SIZE) {
      const batch = toWrite.slice(i, i + MAX_BATCH_SIZE);
      await withRetry(() => this.client.mergeOrUploadDocuments(batch), {
        isRetryable: isLikelyTransientAzureError,
      });
      upserted += batch.length;
    }

    return { upserted, skipped };
  }

  async deleteByDocumentId(documentId: string): Promise<number> {
    const keys: string[] = [];
    const result = await withRetry(
      () =>
        this.client.search('*', {
          filter: `document_id eq '${documentId.replace(/'/g, "''")}'`,
          select: ['chunk_id'] as unknown as SelectFields<Chunk>[],
          top: MAX_BATCH_SIZE,
        }),
      { isRetryable: isLikelyTransientAzureError },
    );
    for await (const r of result.results) {
      keys.push(r.document.chunk_id);
    }
    if (keys.length === 0) return 0;
    await withRetry(() => this.client.deleteDocuments('chunk_id', keys), {
      isRetryable: isLikelyTransientAzureError,
    });
    return keys.length;
  }

  async listDocuments(filter: string | null): Promise<DocumentStatus[]> {
    const result = await withRetry(
      () =>
        this.client.search('*', {
          filter: filter ?? undefined,
          top: MAX_BATCH_SIZE,
        }),
      { isRetryable: isLikelyTransientAzureError },
    );

    const byDocument = new Map<string, { chunks: Chunk[] }>();
    for await (const r of result.results) {
      const doc = r.document;
      const entry = byDocument.get(doc.document_id);
      if (entry) entry.chunks.push(doc);
      else byDocument.set(doc.document_id, { chunks: [doc] });
    }

    return [...byDocument.entries()].map(([documentId, { chunks }]) => {
      const first = chunks[0]!;
      const lastIngested = chunks.reduce<string | null>(
        (latest, c) => (latest === null || c.ingested_at > latest ? c.ingested_at : latest),
        null,
      );
      return {
        document_id: documentId,
        document_title: first.document_title,
        document_classification: first.document_classification as DocumentClassification,
        document_version: first.document_version,
        status: 'indexed',
        chunk_count: chunks.length,
        last_ingested_at: lastIngested,
        error_message: null,
        source_url: first.source_url,
      };
    });
  }

  async getChunk(chunkId: string): Promise<Chunk | null> {
    try {
      return await withRetry(() => this.client.getDocument(chunkId), { isRetryable: isLikelyTransientAzureError });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return null;
      throw err;
    }
  }

  async countChunks(): Promise<number> {
    return withRetry(() => this.client.getDocumentsCount(), { isRetryable: isLikelyTransientAzureError });
  }
}

export function createAzureSearchProvider(config: TrialPulseConfig): SearchProvider {
  return new AzureSearchProvider(config);
}
