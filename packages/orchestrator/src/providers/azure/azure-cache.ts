/**
 * `CacheProvider` backed by a Cosmos DB container with per-item TTL.
 *
 * PRD section 9 suggests Azure Cache for Redis for the embedding cache. We
 * deliberately do not add a Redis client dependency for this: Cosmos DB is
 * already a required dependency for TrialPulse (audit logs, conversations),
 * its native per-item `ttl` field maps directly onto `CacheProvider.set`'s
 * `ttlSeconds` parameter, and it keeps the provider list to one Azure data
 * store instead of two. This is an intent-equivalent substitution (get/set
 * with expiry), not a functional gap -- if TrialPulse's query volume ever
 * grows enough that Cosmos RU cost for cache traffic dominates, a
 * Redis-backed implementation can be dropped in behind the same
 * `CacheProvider` interface without touching `query-pipeline.ts`.
 *
 * Keys collide across cache *uses* (embedding cache, cost-downgrade flag)
 * only by construction, not by container: `embeddingCacheKey()` and
 * `COST_DOWNGRADE_CACHE_KEY` are already distinct, non-overlapping strings.
 */
import { CosmosClient } from '@azure/cosmos';
import type { TrialPulseConfig } from '../../config';
import type { CacheProvider } from '../types';
import { getManagedIdentityCredential } from './credential';
import { isLikelyTransientAzureError, withRetry } from './retry';

const CACHE_CONTAINER = 'cache_entries';

interface CacheDocument {
  id: string;
  value: unknown;
  ttl: number;
}

function createClient(config: TrialPulseConfig): CosmosClient {
  if (config.cosmos.key) {
    return new CosmosClient({ endpoint: config.cosmos.endpoint, key: config.cosmos.key });
  }
  return new CosmosClient({ endpoint: config.cosmos.endpoint, aadCredentials: getManagedIdentityCredential() });
}

/** Cosmos item ids must not contain '/', '\\', '?' or '#'; cache keys are otherwise arbitrary strings. */
function sanitizeId(key: string): string {
  return encodeURIComponent(key);
}

class AzureCacheProvider implements CacheProvider {
  private readonly client: CosmosClient;
  private readonly databaseName: string;

  constructor(config: TrialPulseConfig) {
    this.client = createClient(config);
    this.databaseName = config.cosmos.databaseName;
  }

  private container() {
    return this.client.database(this.databaseName).container(CACHE_CONTAINER);
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const { resource } = await withRetry(
        () => this.container().item(sanitizeId(key), sanitizeId(key)).read<CacheDocument>(),
        { isRetryable: isLikelyTransientAzureError },
      );
      // Cosmos purges expired items asynchronously, so a read can still
      // briefly return a document whose TTL has technically elapsed; the
      // pipeline only ever needs "was this fresh enough a moment ago",
      // matching how any distributed cache behaves under eventual expiry.
      return resource ? (resource.value as T) : null;
    } catch (err) {
      if ((err as { code?: number }).code === 404) return null;
      throw err;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    const doc: CacheDocument = { id: sanitizeId(key), value, ttl: ttlSeconds };
    await withRetry(() => this.container().items.upsert(doc), { isRetryable: isLikelyTransientAzureError });
  }
}

export function createAzureCacheProvider(config: TrialPulseConfig): CacheProvider {
  return new AzureCacheProvider(config);
}
