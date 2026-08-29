/**
 * Provider factory: wires the memory-backed or Azure-backed provider set
 * depending on `TRIALPULSE_PROVIDER_MODE`. The memory set is the default --
 * it is what `npm run dev`, `npm run seed`, the unit tests and the eval
 * harness use, and it requires no Azure resources or network access at all.
 * Set `TRIALPULSE_PROVIDER_MODE=azure` to wire the real Azure clients for a
 * deployed environment.
 */
import type { Chunk } from '@trialpulse/shared';
import type { TrialPulseConfig } from '../config';
import { createAzureAuditSink } from './azure/azure-audit';
import { createAzureCacheProvider } from './azure/azure-cache';
import { createAzureConversationStore } from './azure/azure-conversations';
import { createAzureDocumentMetadataStore } from './azure/azure-document-metadata';
import { createAzureEmbeddingProvider } from './azure/azure-embeddings';
import { createAzureGenerationProvider } from './azure/azure-generation';
import { createAzureQueueProvider } from './azure/azure-queue';
import { createAzureSearchProvider } from './azure/azure-search';
import { MemoryAuditSink } from './memory/memory-audit';
import { MemoryCacheProvider } from './memory/memory-cache';
import { MemoryConversationStore } from './memory/memory-conversations';
import { MemoryDocumentMetadataStore } from './memory/memory-document-metadata';
import { MemoryEmbeddingProvider } from './memory/memory-embeddings';
import { MemoryGenerationProvider } from './memory/memory-generation';
import { MemoryQueueProvider } from './memory/memory-queue';
import { MemorySearchProvider } from './memory/memory-search';
import type {
  AuditSink,
  CacheProvider,
  Clock,
  ConversationStore,
  DocumentMetadataStore,
  EmbeddingProvider,
  GenerationProvider,
  QueueProvider,
  SearchProvider,
} from './types';

export type ProviderMode = 'memory' | 'azure';

export interface ProviderSet {
  search: SearchProvider;
  embeddings: EmbeddingProvider;
  generation: GenerationProvider;
  audit: AuditSink;
  conversations: ConversationStore;
  cache: CacheProvider;
  queue: QueueProvider;
  documentMetadata: DocumentMetadataStore;
}

export interface CreateProvidersOptions {
  mode?: ProviderMode;
  config: TrialPulseConfig;
  clock: Clock;
  /** Only used by the memory provider set, to pre-seed the search index. */
  initialChunks?: readonly Chunk[];
}

/**
 * True when this process is running on a real Azure Functions host. Mirrors the
 * guard in `config.ts`, which uses the same signal to refuse development auth.
 */
function isRunningInAzure(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env['WEBSITE_INSTANCE_ID'] || env['FUNCTIONS_WORKER_RUNTIME_VERSION']);
}

/**
 * Resolve which provider set to construct.
 *
 * The default is deliberately asymmetric. Locally, absent configuration means
 * the in-memory providers: that is what makes `npm run dev`, the tests and the
 * eval suite work offline. On a real Azure Functions host, absent configuration
 * must mean AZURE, because the failure mode of getting this wrong silently is
 * the worst one this system has -- an app that deploys cleanly, reports healthy,
 * answers every question with "I cannot find information about that", and writes
 * its compliance audit trail to a Map that dies with the process. A missing app
 * setting must never be able to produce that.
 *
 * `TRIALPULSE_PROVIDER_MODE=memory` still forces memory providers everywhere, so
 * the escape hatch survives for anyone who genuinely wants it -- but they have to
 * ask for it explicitly rather than get it by omission.
 */
function resolveMode(explicit: ProviderMode | undefined, env: NodeJS.ProcessEnv): ProviderMode {
  if (explicit) return explicit;
  const configured = env['TRIALPULSE_PROVIDER_MODE'];
  if (configured === 'azure' || configured === 'memory') return configured;
  return isRunningInAzure(env) ? 'azure' : 'memory';
}

export function createProviders(options: CreateProvidersOptions, env: NodeJS.ProcessEnv = process.env): ProviderSet {
  const mode = resolveMode(options.mode, env);

  if (mode === 'memory') {
    return {
      search: new MemorySearchProvider(options.initialChunks ?? []),
      embeddings: new MemoryEmbeddingProvider(),
      generation: new MemoryGenerationProvider(),
      audit: new MemoryAuditSink(),
      conversations: new MemoryConversationStore(),
      cache: new MemoryCacheProvider(options.clock),
      queue: new MemoryQueueProvider(),
      documentMetadata: new MemoryDocumentMetadataStore(),
    };
  }

  return {
    search: createAzureSearchProvider(options.config),
    embeddings: createAzureEmbeddingProvider(options.config),
    generation: createAzureGenerationProvider(options.config),
    audit: createAzureAuditSink(options.config),
    conversations: createAzureConversationStore(options.config),
    cache: createAzureCacheProvider(options.config),
    queue: createAzureQueueProvider(options.config),
    documentMetadata: createAzureDocumentMetadataStore(options.config),
  };
}
