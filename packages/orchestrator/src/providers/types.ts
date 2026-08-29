/**
 * Provider interfaces.
 *
 * Every external dependency (Azure AI Search, Azure OpenAI, Cosmos DB, Storage
 * Queues) sits behind one of these interfaces. Azure-backed implementations live in
 * `src/providers/azure/`; deterministic in-memory implementations used by the
 * local harness, unit tests and the eval suite live in `src/providers/memory/`.
 *
 * This is a published contract: the eval harness and the tests depend on these
 * signatures. Treat changes as breaking.
 */
import type {
  AuditRecord,
  Chunk,
  DailySummary,
  DocumentClassification,
  DocumentStatus,
  ConversationTurn,
  Role,
  ScoredChunk,
} from '@trialpulse/shared';

export interface HybridSearchOptions {
  queryText: string;
  queryVector: number[];
  /** OData filter from buildSearchFilter(role); null means unrestricted. */
  filter: string | null;
  top: number;
  /** Optional extra filter for version comparison / document scoping. */
  documentIds?: string[];
}

export interface SearchProvider {
  hybridSearch(options: HybridSearchOptions): Promise<ScoredChunk[]>;
  upsertChunks(chunks: Chunk[]): Promise<{ upserted: number; skipped: number }>;
  deleteByDocumentId(documentId: string): Promise<number>;
  /** Documents visible under `filter`, for the Browse tab. */
  listDocuments(filter: string | null): Promise<DocumentStatus[]>;
  getChunk(chunkId: string): Promise<Chunk | null>;
  countChunks(): Promise<number>;
}

export interface EmbeddingResult {
  vector: number[];
  tokens: number;
  model: string;
}

export interface EmbeddingProvider {
  embed(text: string): Promise<EmbeddingResult>;
}

export interface GenerationRequest {
  system: string;
  user: string;
  model: string;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface GenerationResult {
  text: string;
  tokensInput: number;
  tokensOutput: number;
  model: string;
}

export interface GenerationProvider {
  generate(request: GenerationRequest): Promise<GenerationResult>;
}

export interface AuditSink {
  write(record: AuditRecord): Promise<void>;
  /** Audit records for a UTC date range, newest first. */
  query(options: {
    from?: string;
    to?: string;
    role?: Role;
    limit?: number;
  }): Promise<AuditRecord[]>;
  upsertDailySummary(summary: DailySummary): Promise<void>;
  getDailySummaries(from: string, to: string): Promise<DailySummary[]>;
}

export interface ConversationStore {
  append(turn: ConversationTurn): Promise<void>;
  /** Most recent turns first, paginated. */
  list(
    conversationId: string,
    userPrincipalName: string,
    options?: { limit?: number; continuation?: string },
  ): Promise<{ turns: ConversationTurn[]; continuation: string | null }>;
  recordFeedback(
    turnId: string,
    userPrincipalName: string,
    feedback: 'up' | 'down',
  ): Promise<boolean>;
}

export interface CacheProvider {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
}

export interface QueueProvider {
  enqueue(queueName: string, message: unknown): Promise<void>;
  /** Test/local affordance; Azure Queue implementation returns []. */
  drain(queueName: string): Promise<unknown[]>;
}

export interface Clock {
  now(): Date;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
}

/** Emitted per query for Application Insights / OpenTelemetry. */
export interface TelemetrySpan {
  name: string;
  durationMs: number;
  attributes: Record<string, string | number | boolean>;
}

export interface TelemetrySink {
  recordSpan(span: TelemetrySpan): void;
}

export interface DocumentMetadataStore {
  upsert(status: DocumentStatus): Promise<void>;
  list(classifications: readonly DocumentClassification[] | null): Promise<DocumentStatus[]>;
  get(documentId: string): Promise<DocumentStatus | null>;
}
