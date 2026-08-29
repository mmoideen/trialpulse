import type { AuditRecord } from '@trialpulse/shared';
import { COST_SPIKE_MULTIPLIER } from '@trialpulse/shared';
import { describe, expect, it } from 'vitest';
import { COST_DOWNGRADE_CACHE_KEY, COST_HARD_STOP_CACHE_KEY } from '../pipeline/model-router';
import { computeDailySummary, runCostAlertCheck, runDailyAuditCompaction, runSharePointDeltaSyncTrigger } from './timers';
import { buildTestDeps } from './test-support';

function record(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: 'id',
    trace_id: 'trace',
    timestamp: '2026-06-14T12:00:00.000Z',
    user_principal_name: 'user@meridiantx.com',
    entra_role: 'regulatory_affairs',
    role_fallback_applied: false,
    query_text: 'q',
    query_hash: 'hash',
    retrieved_chunks: [],
    response_text: 'a',
    response_status: 'answered',
    refusal_reason: null,
    search_filter: null,
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

describe('computeDailySummary', () => {
  it('computes totals, refusal count, cache hit rate and per-role breakdown', () => {
    const records = [
      record({ latency_ms: 100, estimated_cost_usd: 0.1, entra_role: 'regulatory_affairs', cache_hit: true }),
      record({ latency_ms: 200, estimated_cost_usd: 0.2, entra_role: 'clinical_operations', response_status: 'refused' }),
      record({ latency_ms: 300, estimated_cost_usd: 0.3, entra_role: 'regulatory_affairs' }),
    ];
    const summary = computeDailySummary('2026-06-14', records);
    expect(summary.total_queries).toBe(3);
    expect(summary.total_refusals).toBe(1);
    expect(summary.cache_hit_rate).toBeCloseTo(1 / 3);
    expect(summary.total_cost_usd).toBeCloseTo(0.6);
    expect(summary.breakdown_by_role['regulatory_affairs']).toEqual({ queries: 2, cost: expect.closeTo(0.4, 5) });
    expect(summary.breakdown_by_role['clinical_operations']).toEqual({ queries: 1, cost: expect.closeTo(0.2, 5) });
  });

  it('handles zero records without dividing by zero', () => {
    const summary = computeDailySummary('2026-06-14', []);
    expect(summary.total_queries).toBe(0);
    expect(summary.avg_latency_ms).toBe(0);
    expect(summary.cache_hit_rate).toBe(0);
  });

  it('D8: computes the exact nearest-rank p50/p99 latency, not the off-by-one-rank value', () => {
    // 100 values 1..100: p*n is an exact integer for both 0.5 and 0.99, the
    // precise case the off-by-one bug got wrong. True nearest-rank P50 is
    // the 50th value (50) and P99 is the 99th value (99) -- never the max
    // (100), which the old `floor` formula returned for both.
    const records = Array.from({ length: 100 }, (_, i) => record({ latency_ms: i + 1 }));
    const summary = computeDailySummary('2026-06-14', records);
    expect(summary.p50_latency_ms).toBe(50);
    expect(summary.p99_latency_ms).toBe(99);
  });

  it('D8: a 2-element array reports the true median, not the max', () => {
    const records = [record({ latency_ms: 10 }), record({ latency_ms: 20 })];
    const summary = computeDailySummary('2026-06-14', records);
    expect(summary.p50_latency_ms).toBe(10);
  });
});

describe('runDailyAuditCompaction', () => {
  it('compacts the target date\'s records into a daily summary and persists it', async () => {
    const { deps } = buildTestDeps();
    await deps.audit.write(record({ partition_date: '2026-06-14', timestamp: '2026-06-14T08:00:00.000Z' }));
    await deps.audit.write(record({ partition_date: '2026-06-14', timestamp: '2026-06-14T09:00:00.000Z' }));
    await deps.audit.write(record({ partition_date: '2026-06-15', timestamp: '2026-06-15T08:00:00.000Z' }));

    const summary = await runDailyAuditCompaction(deps, '2026-06-14');
    expect(summary.total_queries).toBe(2);

    const [persisted] = await deps.audit.getDailySummaries('2026-06-14', '2026-06-14');
    expect(persisted?.total_queries).toBe(2);
  });

  it('defaults to compacting "yesterday" relative to the injected clock', async () => {
    const { deps, clock } = buildTestDeps();
    await deps.audit.write(record({ partition_date: '2026-06-14', timestamp: '2026-06-14T08:00:00.000Z' }));
    expect(clock.now().toISOString().slice(0, 10)).toBe('2026-06-15');
    const summary = await runDailyAuditCompaction(deps);
    expect(summary.date).toBe('2026-06-14');
    expect(summary.total_queries).toBe(1);
  });
});

describe('runCostAlertCheck', () => {
  it('notifies the admin when 24h spend exceeds the spike multiplier over the prior 7-day average', async () => {
    const { deps } = buildTestDeps();
    // 7 days of $10/day baseline, ending 1-8 days ago.
    for (let day = 1; day <= 7; day += 1) {
      await deps.audit.write(
        record({
          timestamp: new Date(deps.clock.now().getTime() - (day + 1) * 24 * 60 * 60 * 1000).toISOString(),
          partition_date: new Date(deps.clock.now().getTime() - (day + 1) * 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10),
          estimated_cost_usd: 10,
        }),
      );
    }
    // Today: a spend well above COST_SPIKE_MULTIPLIER x the $10/day average.
    await deps.audit.write(
      record({
        timestamp: deps.clock.now().toISOString(),
        partition_date: deps.clock.now().toISOString().slice(0, 10),
        estimated_cost_usd: 10 * COST_SPIKE_MULTIPLIER + 5,
      }),
    );

    const notified: string[] = [];
    await runCostAlertCheck(deps, { notifyAdmin: async (msg) => void notified.push(msg) });
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatch(/cost spike/i);
  });

  it('does not notify when spend is within normal range', async () => {
    const { deps } = buildTestDeps();
    for (let day = 1; day <= 7; day += 1) {
      await deps.audit.write(
        record({
          timestamp: new Date(deps.clock.now().getTime() - day * 24 * 60 * 60 * 1000).toISOString(),
          partition_date: new Date(deps.clock.now().getTime() - day * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
          estimated_cost_usd: 10,
        }),
      );
    }
    const notified: string[] = [];
    await runCostAlertCheck(deps, { notifyAdmin: async (msg) => void notified.push(msg) });
    expect(notified).toHaveLength(0);
  });

  it('sets the cost-downgrade cache flag when 24h spend exceeds the hard cap', async () => {
    const { deps } = buildTestDeps({ config: { dailyCostCapUsd: 5 } });
    await deps.audit.write(
      record({
        timestamp: deps.clock.now().toISOString(),
        partition_date: deps.clock.now().toISOString().slice(0, 10),
        estimated_cost_usd: 10,
      }),
    );
    await runCostAlertCheck(deps, { notifyAdmin: async () => undefined });
    expect(await deps.cache.get<boolean>(COST_DOWNGRADE_CACHE_KEY)).toBe(true);
  });

  it('clears the cost-downgrade flag once spend drops back under the cap', async () => {
    const { deps } = buildTestDeps({ config: { dailyCostCapUsd: 500 } });
    await deps.cache.set(COST_DOWNGRADE_CACHE_KEY, true, 3600);
    await runCostAlertCheck(deps, { notifyAdmin: async () => undefined });
    expect(await deps.cache.get<boolean>(COST_DOWNGRADE_CACHE_KEY)).toBe(false);
  });

  it('D5(a): sets the cost hard-stop flag once spend exceeds DAILY_COST_HARD_STOP_MULTIPLIER x the cap', async () => {
    const { deps } = buildTestDeps({ config: { dailyCostCapUsd: 10 } });
    await deps.audit.write(
      record({
        timestamp: deps.clock.now().toISOString(),
        partition_date: deps.clock.now().toISOString().slice(0, 10),
        estimated_cost_usd: 25, // > 2x the $10 cap
      }),
    );
    await runCostAlertCheck(deps, { notifyAdmin: async () => undefined });
    expect(await deps.cache.get<boolean>(COST_HARD_STOP_CACHE_KEY)).toBe(true);
  });

  it('D5(a): does not set the hard-stop flag when spend exceeds the cap but not the hard-stop multiplier', async () => {
    const { deps } = buildTestDeps({ config: { dailyCostCapUsd: 10 } });
    await deps.audit.write(
      record({
        timestamp: deps.clock.now().toISOString(),
        partition_date: deps.clock.now().toISOString().slice(0, 10),
        estimated_cost_usd: 15, // > cap, but < 2x cap
      }),
    );
    await runCostAlertCheck(deps, { notifyAdmin: async () => undefined });
    expect(await deps.cache.get<boolean>(COST_DOWNGRADE_CACHE_KEY)).toBe(true);
    expect(await deps.cache.get<boolean>(COST_HARD_STOP_CACHE_KEY)).toBe(false);
  });

  it('D5(a): clears the hard-stop flag once spend drops back under the threshold', async () => {
    const { deps } = buildTestDeps({ config: { dailyCostCapUsd: 500 } });
    await deps.cache.set(COST_HARD_STOP_CACHE_KEY, true, 3600);
    await runCostAlertCheck(deps, { notifyAdmin: async () => undefined });
    expect(await deps.cache.get<boolean>(COST_HARD_STOP_CACHE_KEY)).toBe(false);
  });

  it('D9: does not fire a spike alert off a single prior day of history (previously deflated by dividing by a hardcoded 7)', async () => {
    const { deps } = buildTestDeps();
    // Exactly the reviewer's repro: one prior day at $40, today at $50 (a
    // 25% rise) -- the old `/ 7` baseline computed to $5.71/day and fired.
    await deps.audit.write(
      record({
        timestamp: new Date(deps.clock.now().getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        partition_date: new Date(deps.clock.now().getTime() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        estimated_cost_usd: 40,
      }),
    );
    await deps.audit.write(
      record({
        timestamp: deps.clock.now().toISOString(),
        partition_date: deps.clock.now().toISOString().slice(0, 10),
        estimated_cost_usd: 50,
      }),
    );
    const notified: string[] = [];
    await runCostAlertCheck(deps, { notifyAdmin: async (msg) => void notified.push(msg) });
    expect(notified).toHaveLength(0);
  });

  it('D9: correctly averages over the actual number of distinct prior days, not a hardcoded 7', async () => {
    const { deps } = buildTestDeps();
    // 3 days of prior history at $10/day (a real, if short, baseline);
    // dividing by a hardcoded 7 would compute $30/7 ≈ $4.29/day instead of
    // the correct $10/day, understating the baseline by more than half.
    for (let day = 1; day <= 3; day += 1) {
      await deps.audit.write(
        record({
          timestamp: new Date(deps.clock.now().getTime() - day * 24 * 60 * 60 * 1000).toISOString(),
          partition_date: new Date(deps.clock.now().getTime() - day * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
          estimated_cost_usd: 10,
        }),
      );
    }
    // Today's spend is a real, modest 30% rise over the correct $10/day
    // baseline -- well under COST_SPIKE_MULTIPLIER (1.5x) of the *correct*
    // baseline, but would have been well over 1.5x of the deflated one.
    await deps.audit.write(
      record({
        timestamp: deps.clock.now().toISOString(),
        partition_date: deps.clock.now().toISOString().slice(0, 10),
        estimated_cost_usd: 13,
      }),
    );
    const notified: string[] = [];
    await runCostAlertCheck(deps, { notifyAdmin: async (msg) => void notified.push(msg) });
    expect(notified).toHaveLength(0);
  });
});

describe('runSharePointDeltaSyncTrigger', () => {
  it('D12/F5: is a no-op that never enqueues onto any queue (superseded by ingestion\'s own autonomous daily_delta_sync)', async () => {
    const { deps } = buildTestDeps();
    await runSharePointDeltaSyncTrigger(deps);
    expect(await deps.queue.drain('sharepoint-delta-sync-jobs')).toHaveLength(0);
    expect(await deps.queue.drain(deps.config.ingestQueueName)).toHaveLength(0);
  });

  it('never throws', async () => {
    const { deps } = buildTestDeps();
    await expect(runSharePointDeltaSyncTrigger(deps)).resolves.toBeUndefined();
  });
});
