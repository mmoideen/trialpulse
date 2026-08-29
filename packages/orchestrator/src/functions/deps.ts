/**
 * Assembles the dependency bag every HTTP function and timer needs: the
 * query pipeline, the raw providers (for the admin/document/webhook
 * endpoints that don't go through the pipeline), config and a clock/logger.
 */
import type { Chunk } from '@trialpulse/shared';
import { loadConfig, type TrialPulseConfig } from '../config';
import { createProviders, type ProviderMode } from '../providers/index';
import { AzureAppInsightsTelemetrySink } from '../providers/azure/azure-telemetry';
import type {
  AuditSink,
  CacheProvider,
  Clock,
  ConversationStore,
  DocumentMetadataStore,
  EmbeddingProvider,
  GenerationProvider,
  Logger,
  QueueProvider,
  SearchProvider,
  TelemetrySink,
} from '../providers/types';
import { createQueryPipeline, type PipelineConfig, type QueryPipeline } from '../pipeline/query-pipeline';

export interface AppDeps {
  config: TrialPulseConfig;
  clock: Clock;
  logger: Logger;
  telemetry: TelemetrySink;
  pipeline: QueryPipeline;
  search: SearchProvider;
  embeddings: EmbeddingProvider;
  generation: GenerationProvider;
  audit: AuditSink;
  conversations: ConversationStore;
  cache: CacheProvider;
  queue: QueueProvider;
  documentMetadata: DocumentMetadataStore;
}

/** Minimal console-backed Logger for real deployments; Application Insights ingests Functions' own console output. */
class ConsoleLogger implements Logger {
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void {
    const line = { level, message, ...fields };
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}

class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Discards every span. Used only when Application Insights is not configured (e.g. local dev/tests). */
class NoopTelemetry implements TelemetrySink {
  recordSpan(): void {
    // intentionally empty; see module doc.
  }
}

/**
 * D12: `functions/index.ts` used to construct deps with no telemetry option
 * at all, so this always fell back to `NoopTelemetry` -- every span was
 * discarded and `infra/modules/alerts.bicep`'s `trialpulse.query.cost_usd`
 * metric was never emitted, so the denial-of-wallet alert could never fire.
 * Picking the real sink here (rather than requiring every caller of
 * `createAppDeps` to opt in) means the fix takes effect without touching
 * `functions/index.ts` at all: whenever
 * `APPLICATIONINSIGHTS_CONNECTION_STRING` is set (already true in every
 * deployed environment per `infra/main.bicep`'s `commonSettings`), telemetry
 * is real; when it is absent (every local/test config), it stays a no-op.
 */
function defaultTelemetryFor(config: TrialPulseConfig, logger: Logger): TelemetrySink {
  return config.telemetry.connectionString ? new AzureAppInsightsTelemetrySink(config, logger) : new NoopTelemetry();
}

function pipelineConfigFrom(config: TrialPulseConfig): PipelineConfig {
  return {
    models: {
      mini: config.azureOpenAI.generationDeploymentMini,
      full: config.azureOpenAI.generationDeploymentFull,
    },
  };
}

export interface CreateAppDepsOptions {
  mode?: ProviderMode;
  config?: TrialPulseConfig;
  clock?: Clock;
  logger?: Logger;
  telemetry?: TelemetrySink;
  /** Only used by the memory provider set, to pre-seed the search index. */
  initialChunks?: readonly Chunk[];
}

export function createAppDeps(options: CreateAppDepsOptions = {}): AppDeps {
  const config = options.config ?? loadConfig();
  const clock = options.clock ?? new SystemClock();
  const logger = options.logger ?? new ConsoleLogger();
  const telemetry = options.telemetry ?? defaultTelemetryFor(config, logger);

  const providers = createProviders({ mode: options.mode, config, clock, initialChunks: options.initialChunks });

  const pipeline = createQueryPipeline({
    search: providers.search,
    embeddings: providers.embeddings,
    generation: providers.generation,
    audit: providers.audit,
    conversations: providers.conversations,
    cache: providers.cache,
    clock,
    logger,
    telemetry,
    config: pipelineConfigFrom(config),
  });

  return {
    config,
    clock,
    logger,
    telemetry,
    pipeline,
    search: providers.search,
    embeddings: providers.embeddings,
    generation: providers.generation,
    audit: providers.audit,
    conversations: providers.conversations,
    cache: providers.cache,
    queue: providers.queue,
    documentMetadata: providers.documentMetadata,
  };
}
