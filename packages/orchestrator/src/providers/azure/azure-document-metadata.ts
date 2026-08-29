/**
 * Cosmos DB-backed `DocumentMetadataStore`, backing the Browse tab's
 * per-document ingestion status (PRD 6.1, `DocumentStatusBadge`).
 *
 * Written by the ingestion pipeline (Python) as documents are processed;
 * read here for the Browse tab and for `version-compare.ts`'s document
 * lookup. Partitioned by `document_classification` so the Browse tab's
 * "filtered by role" queries hit a single partition per allowed
 * classification rather than a full cross-partition scan.
 */
import { CosmosClient } from '@azure/cosmos';
import type { DocumentClassification, DocumentStatus } from '@trialpulse/shared';
import type { TrialPulseConfig } from '../../config';
import type { DocumentMetadataStore } from '../types';
import { getManagedIdentityCredential } from './credential';
import { isLikelyTransientAzureError, withRetry } from './retry';

const DOCUMENTS_CONTAINER = 'documents';

function createClient(config: TrialPulseConfig): CosmosClient {
  if (config.cosmos.key) {
    return new CosmosClient({ endpoint: config.cosmos.endpoint, key: config.cosmos.key });
  }
  return new CosmosClient({ endpoint: config.cosmos.endpoint, aadCredentials: getManagedIdentityCredential() });
}

class AzureDocumentMetadataStore implements DocumentMetadataStore {
  private readonly client: CosmosClient;
  private readonly databaseName: string;

  constructor(config: TrialPulseConfig) {
    this.client = createClient(config);
    this.databaseName = config.cosmos.databaseName;
  }

  private container() {
    return this.client.database(this.databaseName).container(DOCUMENTS_CONTAINER);
  }

  async upsert(status: DocumentStatus): Promise<void> {
    await withRetry(
      () => this.container().items.upsert({ id: status.document_id, ...status }),
      { isRetryable: isLikelyTransientAzureError },
    );
  }

  async list(classifications: readonly DocumentClassification[] | null): Promise<DocumentStatus[]> {
    const query =
      classifications === null
        ? { query: 'SELECT * FROM c ORDER BY c.document_title ASC' }
        : {
            query: 'SELECT * FROM c WHERE ARRAY_CONTAINS(@classifications, c.document_classification) ORDER BY c.document_title ASC',
            parameters: [{ name: '@classifications', value: [...classifications] }],
          };
    const { resources } = await withRetry(
      () => this.container().items.query<DocumentStatus>(query).fetchAll(),
      { isRetryable: isLikelyTransientAzureError },
    );
    return resources;
  }

  async get(documentId: string): Promise<DocumentStatus | null> {
    const { resources } = await withRetry(
      () =>
        this.container()
          .items.query<DocumentStatus>({
            query: 'SELECT * FROM c WHERE c.document_id = @id',
            parameters: [{ name: '@id', value: documentId }],
          })
          .fetchAll(),
      { isRetryable: isLikelyTransientAzureError },
    );
    return resources[0] ?? null;
  }
}

export function createAzureDocumentMetadataStore(config: TrialPulseConfig): DocumentMetadataStore {
  return new AzureDocumentMetadataStore(config);
}
