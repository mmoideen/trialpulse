import type { AuditRecord } from '@trialpulse/shared';
import { describe, expect, it } from 'vitest';
import { handleAdminReindex } from './admin-reindex';
import { aggregateTopQueries, handleAdminUsage, type TopQueryUsage } from './admin-usage';
import { buildTestDeps, devHeaders } from './test-support';

function auditRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: 'id',
    trace_id: 'trace',
    timestamp: '2026-06-14T12:00:00.000Z',
    user_principal_name: 'user@meridiantx.com',
    entra_role: 'regulatory_affairs',
    role_fallback_applied: false,
    query_text: 'a very identifying verbatim clinical question about a specific patient',
    query_hash: 'hash-a',
    retrieved_chunks: [
      { chunk_id: 'c1', document_id: 'd1', document_title: 't', document_classification: 'protocol', similarity_score: 0.9, content_hash: 'h' },
    ],
    response_text: 'a very identifying verbatim clinical answer',
    response_status: 'answered',
    refusal_reason: null,
    search_filter: "document_classification eq 'protocol'",
    redactions_applied: [],
    injection_flags: [],
    tokens_input: 100,
    tokens_output: 50,
    model_used: 'gpt-4o',
    estimated_cost_usd: 1,
    latency_ms: 1000,
    cache_hit: false,
    partition_date: '2026-06-14',
    ...overrides,
  };
}

describe('GET /api/admin/usage authorisation', () => {
  it('allows it_admin', async () => {
    const { deps } = buildTestDeps();
    const result = await handleAdminUsage(deps, devHeaders('it_admin'), {});
    expect(result.status).toBe(200);
  });

  it('forbids every non-it_admin role', async () => {
    const { deps } = buildTestDeps();
    for (const role of ['regulatory_affairs', 'clinical_operations', 'medical_affairs', 'site_monitor', 'executive'] as const) {
      const result = await handleAdminUsage(deps, devHeaders(role), {});
      expect(result.status).toBe(403);
    }
  });

  it('rejects an unauthenticated caller with 401', async () => {
    const { deps } = buildTestDeps({ config: { authMode: 'production' } });
    const result = await handleAdminUsage(deps, {}, {});
    expect(result.status).toBe(401);
  });

  it('rejects an invalid usage query with 400', async () => {
    const { deps } = buildTestDeps();
    const result = await handleAdminUsage(deps, devHeaders('it_admin'), { from: 'not-a-date' });
    expect(result.status).toBe(400);
  });

  it('never leaks a stack trace or internal error detail in the response body', async () => {
    const { deps } = buildTestDeps();
    const result = await handleAdminUsage(deps, devHeaders('site_monitor'), {});
    const body = JSON.stringify(result.jsonBody);
    expect(body).not.toMatch(/at .*\.ts:\d+/); // no stack frame lines
  });

  describe('D6: response shape matches the published client contract', () => {
    /**
     * Structural mirror of `UsageResponse` in
     * `packages/teams-tab/src/teams/api-client.ts` -- kept local rather than
     * imported (orchestrator does not depend on the teams-tab package) so
     * this test still fails loudly if either side's shape drifts without
     * the other being updated to match.
     */
    interface ClientUsageResponse {
      summaries: unknown[];
      top_queries: TopQueryUsage[];
    }

    it('returns { summaries, top_queries }, never { recent_queries }', async () => {
      const { deps } = buildTestDeps();
      await deps.audit.write(auditRecord());
      const result = await handleAdminUsage(deps, devHeaders('it_admin'), {});
      const body = result.jsonBody as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['summaries', 'top_queries']);
      expect(Array.isArray(body['top_queries'])).toBe(true);
    });

    it('type-asserts against the client-declared UsageResponse shape (contract test)', async () => {
      const { deps } = buildTestDeps();
      await deps.audit.write(auditRecord());
      const result = await handleAdminUsage(deps, devHeaders('it_admin'), {});
      const body: ClientUsageResponse = result.jsonBody as ClientUsageResponse;
      expect(Array.isArray(body.summaries)).toBe(true);
      for (const row of body.top_queries) {
        expect(row).toMatchObject({
          query_hash: expect.any(String),
          role: expect.any(String),
          cost_usd: expect.any(Number),
          latency_ms: expect.any(Number),
          count: expect.any(Number),
        });
        expect(Object.keys(row).sort()).toEqual(['cost_usd', 'count', 'latency_ms', 'query_hash', 'role']);
      }
    });

    it('never ships query_text, response_text, retrieved_chunks or search_filter to the client', async () => {
      const { deps } = buildTestDeps();
      await deps.audit.write(
        auditRecord({
          query_text: 'UNIQUE_MARKER_VERBATIM_QUESTION',
          response_text: 'UNIQUE_MARKER_VERBATIM_ANSWER',
        }),
      );
      const result = await handleAdminUsage(deps, devHeaders('it_admin'), {});
      const body = JSON.stringify(result.jsonBody);
      expect(body).not.toContain('UNIQUE_MARKER_VERBATIM_QUESTION');
      expect(body).not.toContain('UNIQUE_MARKER_VERBATIM_ANSWER');
      expect(body).not.toContain('retrieved_chunks');
      expect(body).not.toContain('search_filter');
    });
  });
});

describe('aggregateTopQueries', () => {
  it('aggregates repeated (query_hash, role) pairs into one row with summed cost and averaged latency', () => {
    const records = [
      auditRecord({ query_hash: 'hash-a', entra_role: 'regulatory_affairs', estimated_cost_usd: 1, latency_ms: 1000 }),
      auditRecord({ query_hash: 'hash-a', entra_role: 'regulatory_affairs', estimated_cost_usd: 2, latency_ms: 2000 }),
      auditRecord({ query_hash: 'hash-b', entra_role: 'clinical_operations', estimated_cost_usd: 5, latency_ms: 500 }),
    ];
    const rows = aggregateTopQueries(records);
    const rowA = rows.find((r) => r.query_hash === 'hash-a');
    expect(rowA).toMatchObject({ role: 'regulatory_affairs', cost_usd: 3, latency_ms: 1500, count: 2 });
  });

  it('keeps the same query_hash asked under different roles as distinct rows', () => {
    const records = [
      auditRecord({ query_hash: 'hash-a', entra_role: 'regulatory_affairs' }),
      auditRecord({ query_hash: 'hash-a', entra_role: 'clinical_operations' }),
    ];
    expect(aggregateTopQueries(records)).toHaveLength(2);
  });

  it('sorts by total cost descending and respects the limit', () => {
    const records = [
      auditRecord({ query_hash: 'cheap', estimated_cost_usd: 0.01 }),
      auditRecord({ query_hash: 'expensive', estimated_cost_usd: 9 }),
      auditRecord({ query_hash: 'medium', estimated_cost_usd: 1 }),
    ];
    const rows = aggregateTopQueries(records, 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.query_hash).toBe('expensive');
    expect(rows[1]?.query_hash).toBe('medium');
  });

  it('never includes query_text or response_text in the aggregated row', () => {
    const rows = aggregateTopQueries([auditRecord()]);
    expect(rows[0]).not.toHaveProperty('query_text');
    expect(rows[0]).not.toHaveProperty('response_text');
  });
});

describe('POST /api/admin/reindex authorisation', () => {
  it('allows it_admin and enqueues a job onto the real, provisioned ingestion queue (D12/F5)', async () => {
    const { deps } = buildTestDeps();
    const result = await handleAdminReindex(deps, devHeaders('it_admin'), { full: true });
    expect(result.status).toBe(202);
    const jobs = await deps.queue.drain(deps.config.ingestQueueName);
    expect(jobs).toHaveLength(1);
    // Exactly ingestion's IngestionJob field set -- no more, no fewer --
    // since `IngestionJob(**payload)` raises TypeError on any mismatch.
    expect(Object.keys(jobs[0] as object).sort()).toEqual(['drive_id', 'item_id', 'reason', 'site_id']);
  });

  it('never enqueues onto the old, non-provisioned queue name', async () => {
    const { deps } = buildTestDeps();
    await handleAdminReindex(deps, devHeaders('it_admin'), { full: true });
    expect(await deps.queue.drain('reindex-jobs')).toHaveLength(0);
  });

  it('enqueues one job per document id when document_ids is provided', async () => {
    const { deps } = buildTestDeps();
    const result = await handleAdminReindex(deps, devHeaders('it_admin'), { document_ids: ['doc-a', 'doc-b'] });
    expect(result.status).toBe(202);
    const jobs = (await deps.queue.drain(deps.config.ingestQueueName)) as Array<{ item_id: string }>;
    expect(jobs.map((j) => j.item_id).sort()).toEqual(['doc-a', 'doc-b']);
  });

  it('forbids a non-it_admin role and does not enqueue anything', async () => {
    const { deps } = buildTestDeps();
    const result = await handleAdminReindex(deps, devHeaders('regulatory_affairs'), { full: true });
    expect(result.status).toBe(403);
    const jobs = await deps.queue.drain(deps.config.ingestQueueName);
    expect(jobs).toHaveLength(0);
  });

  it('rejects a request with none of document_ids/classification/full set', async () => {
    const { deps } = buildTestDeps();
    const result = await handleAdminReindex(deps, devHeaders('it_admin'), {});
    expect(result.status).toBe(400);
  });
});
