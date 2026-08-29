import type {
  Citation,
  ConversationTurn,
  DailySummary,
  DocumentStatus,
  QueryResponse,
} from '@trialpulse/shared';

export function makeCitation(overrides: Partial<Citation> = {}): Citation {
  return {
    index: 1,
    chunk_id: 'chunk-1',
    document_id: 'doc-1',
    document_title: 'AXIOM-HN01 Protocol v4.0',
    document_classification: 'protocol',
    document_version: '4.0',
    heading_path: 'Section 5 > Eligibility Criteria',
    page_number: 12,
    source_url: 'https://meridiantx.sharepoint.com/sites/trials/protocol-v4.pdf',
    similarity_score: 0.87,
    ...overrides,
  };
}

export function makeQueryResponse(overrides: Partial<QueryResponse> = {}): QueryResponse {
  return {
    trace_id: 'trace-1',
    status: 'answered',
    answer: 'The protocol requires monthly monitoring visits [1].',
    citations: [makeCitation()],
    refusal_reason: null,
    role: 'regulatory_affairs',
    redaction_notice: null,
    model_used: 'gpt-4o-mini',
    latency_ms: 900,
    cache_hit: false,
    estimated_cost_usd: 0.002,
    ...overrides,
  };
}

export function makeConversationTurn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    id: 'turn-1',
    conversation_id: 'conv-1',
    user_principal_name: 'dana.whitfield@meridiantx.com',
    role: 'regulatory_affairs',
    question: 'What changed in protocol version 4.0?',
    answer: 'Monitoring frequency increased to monthly [1].',
    citations: [makeCitation()],
    status: 'answered',
    timestamp: '2026-08-01T12:00:00Z',
    feedback: null,
    ttl: 2_592_000,
    ...overrides,
  };
}

export function makeDocumentStatus(overrides: Partial<DocumentStatus> = {}): DocumentStatus {
  return {
    document_id: 'doc-1',
    document_title: 'AXIOM-HN01 Protocol v4.0',
    document_classification: 'protocol',
    document_version: '4.0',
    status: 'indexed',
    chunk_count: 42,
    last_ingested_at: '2026-08-20T10:00:00Z',
    error_message: null,
    source_url: 'https://meridiantx.sharepoint.com/sites/trials/protocol-v4.pdf',
    ...overrides,
  };
}

export function makeDailySummary(overrides: Partial<DailySummary> = {}): DailySummary {
  return {
    id: '2026-08-27',
    date: '2026-08-27',
    total_queries: 100,
    total_refusals: 5,
    avg_latency_ms: 1500,
    p50_latency_ms: 1200,
    p99_latency_ms: 4000,
    total_cost_usd: 1.5,
    cache_hit_rate: 0.3,
    breakdown_by_role: {
      regulatory_affairs: { queries: 40, cost: 0.6 },
      clinical_operations: { queries: 30, cost: 0.5 },
      medical_affairs: { queries: 20, cost: 0.3 },
      site_monitor: { queries: 5, cost: 0.05 },
      executive: { queries: 5, cost: 0.05 },
    },
    ...overrides,
  };
}
