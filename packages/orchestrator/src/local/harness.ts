/**
 * Local harness -- PUBLISHED CONTRACT.
 *
 * The eval harness workstream depends on this module's exact shape. Treat
 * any change here as a breaking change and coordinate before making one.
 *
 * Seeds the in-memory index from `data/synthetic/`, wires every memory
 * provider together with a single fixed `Clock`, and exposes both the raw
 * `QueryPipeline` and a convenience `ask()` for quickly running a query as
 * a given role without hand-building a `CallerIdentity` every time.
 */
import { DOCUMENT_CLASSIFICATIONS, type CallerIdentity, type QueryResponse, type Role } from '@trialpulse/shared';
import { createQueryPipeline, type QueryPipeline } from '../pipeline/query-pipeline';
import type { AuditSink, CacheProvider, Clock, ConversationStore, Logger, SearchProvider, TelemetrySink } from '../providers/types';
import { MemoryAuditSink } from '../providers/memory/memory-audit';
import { MemoryCacheProvider } from '../providers/memory/memory-cache';
import { MemoryConversationStore } from '../providers/memory/memory-conversations';
import { MemoryEmbeddingProvider } from '../providers/memory/memory-embeddings';
import { MemoryGenerationProvider } from '../providers/memory/memory-generation';
import { MemorySearchProvider } from '../providers/memory/memory-search';
import { loadCorpusChunks } from './corpus';

/** A fixed point in time, for fully deterministic TTLs, audit timestamps and partition dates across every run. */
export const HARNESS_FIXED_TIME = '2026-06-15T12:00:00.000Z';

export class FixedClock implements Clock {
  constructor(private readonly iso: string = HARNESS_FIXED_TIME) {}
  now(): Date {
    return new Date(this.iso);
  }
}

/** Discards every log line. The harness is used by tests and the eval suite, which assert on return values, not stdout. */
class SilentLogger implements Logger {
  log(): void {
    // intentionally empty
  }
}

/** Discards every span. Swap for a real sink if a caller wants to inspect telemetry from a harness run. */
class SilentTelemetry implements TelemetrySink {
  recordSpan(): void {
    // intentionally empty
  }
}

export interface LocalHarness {
  pipeline: QueryPipeline;
  search: SearchProvider;
  audit: AuditSink;
  conversations: ConversationStore;
  identityFor(role: Role, overrides?: Partial<CallerIdentity>): CallerIdentity;
  ask(
    role: Role,
    query: string,
    options?: { assignedSites?: string[]; drillDown?: boolean },
  ): Promise<QueryResponse>;
  chunkCount(): Promise<number>;
}

function defaultIdentityFor(role: Role, overrides: Partial<CallerIdentity> = {}): CallerIdentity {
  return {
    user_principal_name: `${role}@meridiantx.com`,
    object_id: `harness-${role}`,
    tenant_id: 'harness-tenant',
    name: `Harness ${role}`,
    role,
    role_fallback_applied: false,
    assigned_sites: [],
    ...overrides,
  };
}

export interface CreateLocalHarnessOptions {
  corpusDir?: string;
}

export async function createLocalHarness(options: CreateLocalHarnessOptions = {}): Promise<LocalHarness> {
  const clock = new FixedClock();
  const chunks = loadCorpusChunks({ corpusDir: options.corpusDir, ingestedAt: clock.now().toISOString() });

  const search = new MemorySearchProvider(chunks);
  const audit = new MemoryAuditSink();
  const conversations = new MemoryConversationStore();

  const pipeline = createQueryPipeline({
    search,
    embeddings: new MemoryEmbeddingProvider(),
    generation: new MemoryGenerationProvider(),
    audit,
    conversations,
    cache: new MemoryCacheProvider(clock),
    clock,
    logger: new SilentLogger(),
    telemetry: new SilentTelemetry(),
    config: {
      models: { mini: 'memory-mini', full: 'memory-full' },
    },
  });

  function identityFor(role: Role, overrides: Partial<CallerIdentity> = {}): CallerIdentity {
    return defaultIdentityFor(role, overrides);
  }

  async function ask(
    role: Role,
    query: string,
    askOptions: { assignedSites?: string[]; drillDown?: boolean } = {},
  ): Promise<QueryResponse> {
    const identity = identityFor(role, { assigned_sites: askOptions.assignedSites ?? [] });
    return pipeline.execute(identity, { query, drill_down: askOptions.drillDown });
  }

  async function chunkCount(): Promise<number> {
    return search.countChunks();
  }

  return { pipeline, search, audit, conversations, identityFor, ask, chunkCount };
}

/** Convenience export for `seed.ts`: chunk counts grouped by classification. */
export async function chunkCountsByClassification(
  harness: Pick<LocalHarness, 'search'>,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const classification of DOCUMENT_CLASSIFICATIONS) {
    const docs = await harness.search.listDocuments(
      `document_classification eq '${classification}'`,
    );
    counts[classification] = docs.reduce((sum, d) => sum + d.chunk_count, 0);
  }
  return counts;
}
