/**
 * TrialPulse shared domain types.
 *
 * These types are the contract between the ingestion pipeline (Python),
 * the orchestrator (TypeScript Azure Functions), the Teams tab (React),
 * and the evaluation harness. Changing a type here is a breaking change
 * for every workstream, so keep it deliberate.
 */

/** Entra app roles recognised by TrialPulse. See docs/adr/0002-rbac-model.md. */
export const ROLES = [
  'regulatory_affairs',
  'clinical_operations',
  'medical_affairs',
  'site_monitor',
  'executive',
  'it_admin',
] as const;

export type Role = (typeof ROLES)[number];

/**
 * Document classifications. These map 1:1 to the SharePoint document
 * libraries listed in the PRD (section 2.2) and are stamped onto every
 * chunk at ingestion time.
 */
export const DOCUMENT_CLASSIFICATIONS = [
  'protocol',
  'investigator_brochure',
  'regulatory_submission',
  'safety_report',
  'site_communication',
  'competitive_intelligence',
] as const;

export type DocumentClassification = (typeof DOCUMENT_CLASSIFICATIONS)[number];

/** A single retrievable unit of a document, as stored in Azure AI Search. */
export interface Chunk {
  chunk_id: string;
  document_id: string;
  document_title: string;
  document_classification: DocumentClassification;
  document_version: string;
  content: string;
  content_hash: string;
  heading_path: string;
  page_number: number;
  source_url: string;
  ingested_at: string;
  /** Site code (e.g. "US-014") for site_communication chunks; null otherwise. */
  site_code: string | null;
  /** SHA-256 of the same heading_path in the previous document version, if any. */
  previous_version_hash: string | null;
  embedding?: number[];
}

/** A chunk returned from search, carrying its relevance score. */
export interface ScoredChunk extends Chunk {
  similarity_score: number;
}

/** A numbered source reference attached to a generated answer. */
export interface Citation {
  index: number;
  chunk_id: string;
  document_id: string;
  document_title: string;
  document_classification: DocumentClassification;
  document_version: string;
  heading_path: string;
  page_number: number;
  /**
   * `null` when the source link itself would disclose something the
   * caller's role/site masking is meant to hide (e.g. a site code embedded
   * in a SharePoint file name or path -- see `redactChunksForRole` in
   * `pipeline/redaction.ts`, D1). Renderers must treat `null` as
   * "source restricted", never fall back to fetching or guessing a URL.
   */
  source_url: string | null;
  similarity_score: number;
}

export type ResponseStatus = 'answered' | 'refused';

export type RefusalReason =
  | 'no_relevant_chunks'
  | 'no_authorized_documents'
  | 'query_rejected';

/** Inbound query from Teams chat or the personal tab. */
export interface QueryRequest {
  query: string;
  conversation_id?: string;
  /** Requests the Executive drill-down view; ignored for non-executive roles. */
  drill_down?: boolean;
}

/** Outbound answer returned to the client. */
export interface QueryResponse {
  trace_id: string;
  status: ResponseStatus;
  answer: string;
  citations: Citation[];
  refusal_reason: RefusalReason | null;
  role: Role;
  /** Present when the role's redaction policy altered the answer. */
  redaction_notice: string | null;
  model_used: string;
  latency_ms: number;
  cache_hit: boolean;
  estimated_cost_usd: number;
}

/** Audit record persisted to Cosmos DB (collection: audit_logs). */
export interface AuditRecord {
  id: string;
  trace_id: string;
  timestamp: string;
  user_principal_name: string;
  entra_role: Role;
  /** True when the caller had no recognised role and was downgraded. */
  role_fallback_applied: boolean;
  query_text: string;
  query_hash: string;
  retrieved_chunks: AuditRetrievedChunk[];
  response_text: string;
  response_status: ResponseStatus;
  refusal_reason: RefusalReason | null;
  /** OData filter actually sent to Azure AI Search, for compliance replay. */
  search_filter: string | null;
  redactions_applied: string[];
  injection_flags: string[];
  tokens_input: number;
  tokens_output: number;
  model_used: string;
  estimated_cost_usd: number;
  latency_ms: number;
  cache_hit: boolean;
  /** Cosmos DB partition key: the UTC date (YYYY-MM-DD). */
  partition_date: string;
}

export interface AuditRetrievedChunk {
  chunk_id: string;
  document_id: string;
  document_title: string;
  document_classification: DocumentClassification;
  similarity_score: number;
  content_hash: string;
}

/** Rolled-up daily telemetry (collection: daily_summaries). */
export interface DailySummary {
  id: string;
  date: string;
  total_queries: number;
  total_refusals: number;
  avg_latency_ms: number;
  p50_latency_ms: number;
  p99_latency_ms: number;
  total_cost_usd: number;
  cache_hit_rate: number;
  breakdown_by_role: Record<string, { queries: number; cost: number }>;
}

export type IngestionStatus = 'pending' | 'indexed' | 'failed' | 'outdated';

/** Per-document ingestion state surfaced in the Browse tab. */
export interface DocumentStatus {
  document_id: string;
  document_title: string;
  document_classification: DocumentClassification;
  document_version: string;
  status: IngestionStatus;
  chunk_count: number;
  last_ingested_at: string | null;
  error_message: string | null;
  source_url: string;
}

/** A single turn stored in conversation history (TTL 30 days). */
export interface ConversationTurn {
  id: string;
  conversation_id: string;
  user_principal_name: string;
  role: Role;
  question: string;
  answer: string;
  citations: Citation[];
  status: ResponseStatus;
  timestamp: string;
  feedback: 'up' | 'down' | null;
  /** Cosmos DB TTL in seconds. */
  ttl: number;
}

/** Identity extracted from a validated Entra JWT. */
export interface CallerIdentity {
  user_principal_name: string;
  object_id: string;
  tenant_id: string;
  name: string;
  role: Role;
  role_fallback_applied: boolean;
  /** Site codes the caller is assigned to, from the `sites` claim. */
  assigned_sites: string[];
}
